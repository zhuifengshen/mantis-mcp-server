import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient, buildIssueViewUrl, buildNoteViewUrl } from '../client.js';
import { MetadataCache } from '../cache.js';
import type { MantisIssue, MantisUser, MantisPaginatedIssues } from '../types.js';
import { MANTIS_CANONICAL_ENUM_NAMES, MANTIS_RESOLVED_STATUS_ID, resolveEnumId } from '../constants.js';
import { dateFilterSchema, matchesDateFilter, hasDateFilter, type DateFilter } from '../date-filter.js';
import { fetchIssueEnumsWithCache } from './config.js';
import { postNote } from './notes.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

// issueId: fallback when a select projection excluded the id field from the response
function enrichIssue(issue: MantisIssue, baseUrl: string, issueId?: number): MantisIssue {
  const id = issue.id ?? issueId;
  if (id === undefined) return issue;
  return {
    ...issue,
    view_url: buildIssueViewUrl(baseUrl, id),
    notes: issue.notes?.map(note => ({
      ...note,
      view_url: buildNoteViewUrl(baseUrl, id, note.id),
    })),
  };
}

// MantisBT reference shape: at least one of id or name must be provided
const ref = z.object({ id: z.number().optional(), name: z.string().optional() })
  .refine(o => o.id !== undefined || o.name !== undefined, { message: "At least one of 'id' or 'name' must be provided" });

// Custom field entry in MantisBT REST format: { field: {id|name}, value: "<string>" }
const customFieldEntry = z.object({
  field: ref.describe("自定义字段引用：{ id } 或 { name }"),
  value: z.preprocess(
    value => value === undefined ? undefined : String(value),
    z.string(),
  ).describe("字段值必须提供；数字会转为字符串，空字符串用于清空字段"),
});

const GET_ISSUES_CONCURRENCY = 5;

// Worker-pool: runs `fn` over all `items` with at most `concurrency` in-flight at once.
// nextIndex is only incremented inside microtasks, so the ++ is safe without a lock.
async function runWithConcurrency<T>(
  items: number[],
  concurrency: number,
  fn: (item: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

// Resolves an enum name (canonical or localized) to { id } or returns an error string.
async function resolveEnum(
  group: keyof typeof MANTIS_CANONICAL_ENUM_NAMES,
  value: string,
  client: MantisClient,
): Promise<{ id: number } | string> {
  const id = resolveEnumId(group, value);
  if (id !== undefined) return { id };

  try {
    const enums = await fetchIssueEnumsWithCache(client);
    const entries = enums[group] ?? [];
    const lower = value.toLowerCase();
    const entry = entries.find(
      e => e.name.toLowerCase() === lower ||
           (e.label !== undefined && e.label.toLowerCase() === lower),
    );
    if (entry !== undefined) return { id: entry.id };
  } catch {
    // localized lookup unavailable — fall through to static error
  }

  const valid = Object.values(MANTIS_CANONICAL_ENUM_NAMES[group]).join(', ');
  return `Invalid ${group} "${value}". Valid canonical names: ${valid}. Call get_issue_enums to see localized labels.`;
}

export function registerIssueTools(server: McpServer, client: MantisClient, cache: MetadataCache): void {

  // ---------------------------------------------------------------------------
  // get_issue
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_issue',
    {
      title: "读取缺陷详情",
      description: "按编号读取单条缺陷。默认包含备注、附件和关联等完整字段；传入 select 时仅返回选定字段。需要备注时将 notes 加入 select，或省略 select。",
      inputSchema: z.object({
        id: z.coerce.number().int().positive().describe("缺陷编号（数字）"),
        select: z.string().optional().describe("以逗号分隔的返回字段列表，由服务端裁剪。例如 id,summary,status,notes；可减少响应体积"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id, select }) => {
      try {
        const result = await client.get<{ issues: MantisIssue[] }>(`issues/${id}`, { select });
        const issue = result.issues?.[0] ?? result;
        const baseUrl = await client.getBaseUrl();
        return {
          content: [{ type: 'text', text: JSON.stringify(enrichIssue(issue, baseUrl, id), null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_issues
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_issues',
    {
      title: "批量读取缺陷",
      description: '一次查询 1～50 条缺陷，最多并发 5 个 REST 请求。不存在或无权访问的编号在对应位置返回 null；单项错误不会中断整批。返回 requested、found、failed 计数。',
      inputSchema: z.object({
        ids: z
          .array(z.coerce.number().int().positive())
          .min(1)
          .max(50)
          .describe("待查询缺陷编号数组，1～50 项。单项遇到 404、403 或其他错误时返回 null，不中断整个查询"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ ids }) => {
      const [rawResults, baseUrl] = await Promise.all([
        runWithConcurrency(
          ids,
          GET_ISSUES_CONCURRENCY,
          async (id): Promise<MantisIssue | null> => {
            try {
              const result = await client.get<{ issues: MantisIssue[] }>(`issues/${id}`);
              return result.issues?.[0] ?? (result as unknown as MantisIssue);
            } catch {
              return null;
            }
          },
        ),
        client.getBaseUrl(),
      ]);
      const results = rawResults.map(issue => issue !== null ? enrichIssue(issue, baseUrl) : null);
      const found = results.filter((r) => r !== null).length;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            { issues: results, requested: ids.length, found, failed: ids.length - found },
            null,
            2,
          ),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_issues
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_issues',
    {
      title: "查询缺陷列表",
      description: "分页查询 Mantis 缺陷，可按项目或已保存的筛选器查询。select 用于裁剪返回字段。\n\nassigned_to、reporter_id、status 和日期条件在客户端筛选，最多扫描 500 条缺陷；page 和 page_size 表示筛选后列表的分页。结果受扫描上限约束，不能将其当作完整项目统计。使用 select 时必须包含筛选所需字段：status、handler、reporter、updated_at 或 created_at。",
      inputSchema: z.object({
        project_id: z.coerce.number().int().positive().optional().describe("按项目编号筛选"),
        page: z.coerce.number().int().positive().default(1).describe("页码，默认 1"),
        page_size: z.coerce.number().int().min(1).max(50).default(50).describe("每页缺陷数，默认 50，最大 50"),
        assigned_to: z.coerce.number().int().positive().optional().describe("按处理人用户编号筛选"),
        reporter_id: z.coerce.number().int().positive().optional().describe("按报告人用户编号筛选"),
        filter_id: z.coerce.number().int().positive().optional().describe("使用已保存的 Mantis 筛选器编号"),
        sort: z.string().optional().describe("排序字段，例如 last_updated、id"),
        direction: z.enum(['ASC', 'DESC']).optional().describe("排序方向"),
        select: z.string().optional().describe("以逗号分隔的返回字段列表，由服务端裁剪。例如 id,summary,status,priority,handler,updated_at"),
        status: z.string().optional().describe("按状态名称筛选，例如 new、assigned、resolved、closed；open 表示状态编号小于 80。筛选在客户端执行，受扫描上限约束"),
        ...dateFilterSchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id, page, page_size, assigned_to, reporter_id, filter_id, sort, direction, select, status, updated_after, updated_before, created_after, created_before }) => {
      try {
        const baseParams: Record<string, string | number | boolean | undefined> = {
          project_id,
          assigned_to,
          reporter_id,
          filter_id,
          sort,
          direction,
          select,
        };

        const dateFilter: DateFilter = { updated_after, updated_before, created_after, created_before };
        const needsClientFilter = status !== undefined || assigned_to !== undefined || reporter_id !== undefined || hasDateFilter(dateFilter);

        const baseUrl = await client.getBaseUrl();

        if (!needsClientFilter) {
          // No client-side filtering — single API call, pass pagination as-is
          const result = await client.get<MantisPaginatedIssues>('issues', { ...baseParams, page, page_size });
          const enriched = { ...result, issues: result.issues?.map(i => enrichIssue(i, baseUrl)) };
          return {
            content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }],
          };
        }

        // Client-side filtering active: scan multiple API pages until we have
        // enough matching results for the requested logical page.
        const API_PAGE_SIZE = 50; // always fetch max to minimise round-trips
        const MAX_API_PAGES = 10; // hard cap: scan at most 500 issues
        const neededTotal = page * page_size; // need this many matches to serve page N

        const matching: MantisIssue[] = [];
        let serverPage = 1;
        let hasMore = true;

        const statusLower = status?.toLowerCase();
        const statusId = status ? resolveEnumId('status', status) : undefined;
        // Pre-parse date thresholds once — avoids repeated new Date() inside the scan loop
        const updatedAfterMs = updated_after ? new Date(updated_after).getTime() : undefined;

        while (matching.length < neededTotal && serverPage <= MAX_API_PAGES && hasMore) {
          const batch = await client.get<MantisPaginatedIssues>('issues', {
            ...baseParams,
            page: serverPage,
            page_size: API_PAGE_SIZE,
          });

          const issues = batch.issues ?? [];
          hasMore = issues.length === API_PAGE_SIZE;

          let stopAfterBatch = false;
          for (const issue of issues) {
            if (statusLower) {
              if (!issue.status) continue;
              if (statusLower === 'open') {
                if ((issue.status.id ?? 0) >= MANTIS_RESOLVED_STATUS_ID) continue;
              } else if (statusId !== undefined) {
                if (issue.status.id !== statusId) continue;
              } else if (issue.status.name?.toLowerCase() !== statusLower) {
                continue;
              }
            }
            if (assigned_to !== undefined && issue.handler?.id !== assigned_to) continue;
            if (reporter_id !== undefined && issue.reporter?.id !== reporter_id) continue;
            if (!matchesDateFilter(issue, dateFilter)) {
              // MantisBT returns results newest-first. Once updated_at drops below
              // updated_after, all subsequent pages are guaranteed to be older too.
              // Finish the current batch first (items within it may still be newer),
              // then stop fetching further pages.
              if (updatedAfterMs && issue.updated_at && new Date(issue.updated_at).getTime() <= updatedAfterMs) {
                stopAfterBatch = true;
              }
              continue;
            }
            matching.push(issue);
          }

          if (stopAfterBatch) break;
          serverPage++;
        }

        const start = (page - 1) * page_size;
        const pageIssues = matching.slice(start, start + page_size).map(i => enrichIssue(i, baseUrl));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ issues: pageIssues }, null, 2),
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // create_issue
  // ---------------------------------------------------------------------------

  server.registerTool(
    'create_issue',
    {
      title: "创建缺陷",
      description: "创建 Mantis 缺陷，返回包含编号和 view_url 的缺陷对象。summary、description、project_id、category 必填；priority 默认 normal，severity 默认 minor。\n\n先用 get_project_categories 查询分类，可用 get_project_versions 查询版本，用 find_project_member 查询处理人登录名。priority、severity 和 reproducibility 支持标准英文名或当前实例的本地化名称、标签，使用 get_issue_enums 查询。处理人通过 handler 登录名或 handler_id 编号指定，二选一。",
      inputSchema: z.object({
        summary: z.string().min(1).describe("缺陷标题，必填"),
        description: z.string().min(1).describe("详细描述，必填，不允许省略。支持纯文本或 Markdown"),
        project_id: z.coerce.number().int().positive().describe("所属项目编号，使用 list_projects 查询"),
        category: z.string().min(1).describe("分类名称，必填，使用 get_project_categories 查询有效值"),
        priority: z.string().default('normal').describe("优先级：none、low、normal、high、urgent、immediate，默认 normal；也支持实例本地化名称或标签，使用 get_issue_enums 查询"),
        severity: z.string().default('minor').describe("严重程度：feature、trivial、text、tweak、minor、major、crash、block，默认 minor；也支持实例本地化名称或标签，使用 get_issue_enums 查询"),
        handler_id: z.coerce.number().int().positive().optional().describe("处理人用户编号，与 handler 二选一"),
        handler: z.string().optional().describe("处理人的 Mantis 登录名，服务端从项目成员中解析用户编号；使用 find_project_member 或 get_project_users 查询"),
        version: z.string().optional().describe("受影响版本名称，使用 get_project_versions 查询"),
        target_version: z.string().optional().describe("计划修复版本名称，使用 get_project_versions 查询"),
        fixed_in_version: z.string().optional().describe("实际修复版本名称，使用 get_project_versions 查询"),
        steps_to_reproduce: z.string().optional().describe("复现步骤，支持纯文本或 Markdown"),
        additional_information: z.string().optional().describe("补充信息，支持纯文本或 Markdown"),
        reproducibility: z.string().optional().describe("复现频率：always、sometimes、random、have not tried、unable to reproduce、N/A；也支持本地化名称或标签，使用 get_issue_enums 查询"),
        view_state: z.enum(['public', 'private']).optional().describe("可见性：public（公开，默认）或 private（私有，访问权限由 Mantis 配置决定）"),
        custom_fields: z.array(customFieldEntry).optional().describe("自定义字段值：[{field: {id 或 name}, value: \"字符串\"}]；字段编号和可选值应以项目实际配置为准"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ summary, description, project_id, category, priority, severity, handler_id, handler, version, target_version, fixed_in_version, steps_to_reproduce, additional_information, reproducibility, view_state, custom_fields }) => {
      // Resolve handler username to handler_id when only a name is given
      let resolvedHandlerId = handler_id;
      if (resolvedHandlerId === undefined && handler !== undefined) {
        const metadata = await cache.loadIfValid();
        let users: MantisUser[] = metadata?.byProject[project_id]?.users ?? [];
        if (users.length === 0) {
          try {
            const usersResult = await client.get<{ users: MantisUser[] }>(`projects/${project_id}/users`);
            users = usersResult.users ?? [];
          } catch {
            users = [];
          }
        }
        const user = users.find(u => u.name === handler || u.real_name === handler);
        if (!user) {
          const names = users.map(u => u.name).join(', ');
          return {
            content: [{ type: 'text', text: errorText(`User "${handler}" not found in project ${project_id}. Available users: ${names || 'none (run sync_metadata or check project_id)'}`) }],
            isError: true,
          };
        }
        resolvedHandlerId = user.id;
      }

      try {
        const body: Record<string, unknown> = {
          summary,
          description,
          project: { id: project_id },
          category: { name: category },
        };
        const priorityResolved = await resolveEnum('priority', priority, client);
        if (typeof priorityResolved === 'string') return { content: [{ type: 'text', text: errorText(priorityResolved) }], isError: true };
        body.priority = priorityResolved;
        const severityResolved = await resolveEnum('severity', severity, client);
        if (typeof severityResolved === 'string') return { content: [{ type: 'text', text: errorText(severityResolved) }], isError: true };
        body.severity = severityResolved;
        if (resolvedHandlerId) body.handler = { id: resolvedHandlerId };
        if (version !== undefined) body.version = { name: version };
        if (target_version !== undefined) body.target_version = { name: target_version };
        if (fixed_in_version !== undefined) body.fixed_in_version = { name: fixed_in_version };
        if (steps_to_reproduce !== undefined) body.steps_to_reproduce = steps_to_reproduce;
        if (additional_information !== undefined) body.additional_information = additional_information;
        if (reproducibility !== undefined) {
          const reproducibilityResolved = await resolveEnum('reproducibility', reproducibility, client);
          if (typeof reproducibilityResolved === 'string') return { content: [{ type: 'text', text: errorText(reproducibilityResolved) }], isError: true };
          body.reproducibility = reproducibilityResolved;
        }
        if (view_state !== undefined) body.view_state = { name: view_state };
        if (custom_fields !== undefined) body.custom_fields = custom_fields;

        const raw = await client.post<Record<string, unknown>>('issues', body);
        const partial = ('issue' in raw && typeof raw['issue'] === 'object' && raw['issue'] !== null)
          ? raw['issue'] as MantisIssue
          : raw as unknown as MantisIssue;
        let issue: MantisIssue = partial;
        if (!('summary' in (partial as unknown as Record<string, unknown>))) {
          // Older MantisBT returned only { id: N } — fetch the full issue.
          // Suppress GET errors: the issue was already created.
          try {
            const fetched = await client.get<{ issues: MantisIssue[] }>(`issues/${partial.id}`);
            issue = fetched.issues?.[0] ?? partial;
          } catch {
            // unable to fetch details — return minimal object
          }
        }
        const baseUrl = await client.getBaseUrl();
        return {
          content: [{ type: 'text', text: JSON.stringify(enrichIssue(issue, baseUrl), null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // update_issue
  // ---------------------------------------------------------------------------

  const coerceBool = (val: unknown) =>
    val === 'true' ? true : val === 'false' ? false : val;

  server.registerTool(
    'update_issue',
    {
      title: "更新缺陷",
      description: "通过 PATCH 部分更新缺陷，仅修改 fields 中传入的字段。\n\n文本字段：summary、description、steps_to_reproduce、additional_information。引用字段：status、resolution、handler、priority、severity、reproducibility、category、version、target_version、fixed_in_version、view_state，使用 {id} 或 {name}。custom_fields 格式为 [{field:{id 或 name},value:\"字符串\"}]，只修改列出的自定义字段。\n\n设为已解决时需同时设置 status 和 resolution，例如 status:{id:80}、resolution:{id:20}，避免解决结果仍为未处理；实际取值先查询 get_issue_enums。\n\ndry_run=true 只预览参数，不访问更新接口。note 可在更新成功后追加备注；若备注失败，返回 note_error，缺陷更新已完成，应只重试 add_note。仅添加备注使用 add_note。",
      inputSchema: z.object({
        id: z.coerce.number().int().positive().describe("待更新的缺陷编号"),
        dry_run: z.preprocess(coerceBool, z.boolean().optional()).describe("设为 true 时只返回更新参数预览，不发送 PATCH，也不验证服务端写入权限或工作流"),
        note: z.string().min(1).optional().describe("更新成功后追加的可选备注，例如状态变更原因，无需另行调用 add_note"),
        note_view_state: z.enum(['public', 'private']).default('public').describe("追加备注的可见性：public（默认）或 private，仅在提供 note 时生效"),
        fields: z.preprocess(
          (v) => {
            if (typeof v !== 'string') return v;
            try { return JSON.parse(v); } catch { return v; }
          },
          z.object({
            summary: z.string().optional(),
            description: z.string().optional(),
            steps_to_reproduce: z.string().optional(),
            additional_information: z.string().optional(),
            status: ref.optional(),
            resolution: ref.optional(),
            priority: ref.optional(),
            severity: ref.optional(),
            reproducibility: ref.optional(),
            handler: ref.optional(),
            category: ref.optional(),
            version: ref.optional(),
            target_version: ref.optional(),
            fixed_in_version: ref.optional(),
            view_state: ref.optional(),
            custom_fields: z.array(customFieldEntry).optional(),
          }).strict().describe("需要更新的字段，仅修改传入字段；未知字段将被拒绝")
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ id, fields, dry_run, note, note_view_state }) => {
      if (dry_run) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ dry_run: true, id, would_patch: fields, would_add_note: note ?? null }, null, 2) }],
        };
      }
      try {
        const patch: Record<string, unknown> = { ...fields };
        for (const field of ['status', 'priority', 'severity', 'resolution', 'reproducibility'] as const) {
          const val = (fields as Record<string, { id?: number; name?: string } | undefined>)[field];
          if (val?.name !== undefined && val.id === undefined) {
            const resolved = await resolveEnum(field, val.name, client);
            if (typeof resolved !== 'string') patch[field] = resolved;
          }
        }
        const [result, baseUrl] = await Promise.all([
          client.patch<{ issue: MantisIssue }>(`issues/${id}`, patch),
          client.getBaseUrl(),
        ]);
        const issue = result.issue ?? (result as unknown as MantisIssue);
        const response: Record<string, unknown> = { ...enrichIssue(issue, baseUrl, id) };

        if (note !== undefined) {
          // The PATCH already succeeded — a note failure must not look like a failed
          // update, or the caller would retry the whole update. Report it inline instead.
          try {
            response['note'] = await postNote(client, id, note, note_view_state);
          } catch (noteError) {
            const noteMsg = noteError instanceof Error ? noteError.message : String(noteError);
            response['note_error'] = `Issue #${id} was updated successfully, but adding the note failed: ${noteMsg}. Retry with add_note.`;
          }
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // delete_issue
  // ---------------------------------------------------------------------------

  server.registerTool(
    'delete_issue',
    {
      title: "删除缺陷",
      description: "永久删除 Mantis 缺陷，此操作不可恢复。",
      inputSchema: z.object({
        id: z.coerce.number().int().positive().describe("待删除的缺陷编号"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }) => {
      try {
        await client.delete<unknown>(`issues/${id}`);
        return {
          content: [{ type: 'text', text: `Issue #${id} deleted successfully.` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
