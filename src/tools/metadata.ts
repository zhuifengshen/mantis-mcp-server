import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import { MetadataCache, type CachedMetadata, type CachedProjectMeta } from '../cache.js';
import type { MantisProject, MantisIdName, MantisUser, MantisVersion, MantisCategory, MantisTag, MantisPaginatedIssues } from '../types.js';
import { ALL_PROJECTS_PREFIX } from '../constants.js';

// Fields MantisBT strips from issue responses when the array is empty.
// They are always valid 'select' values even if absent in a sample issue.
const EMPTY_STRIPPED_FIELDS = [
  'attachments',
  'custom_fields',
  'history',
  'monitors',
  'notes',
  'relationships',
  'tags',
];

// Fallback static list used when no issues are available to sample.
const STATIC_ISSUE_FIELDS = [
  'additional_information',
  'attachments',
  'build',
  'category',
  'created_at',
  'custom_fields',
  'description',
  'due_date',
  'eta',
  'fixed_in_version',
  'handler',
  'history',
  'id',
  'monitors',
  'notes',
  'os',
  'os_build',
  'platform',
  'priority',
  'profile',
  'project',
  'projection',
  'relationships',
  'reporter',
  'reproducibility',
  'resolution',
  'severity',
  'status',
  'steps_to_reproduce',
  'sticky',
  'summary',
  'tags',
  'target_version',
  'updated_at',
  'version',
  'view_state',
];

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

async function collectTagsFromIssues(client: MantisClient, projects: MantisProject[]): Promise<MantisTag[]> {
  const tagMap = new Map<number, MantisTag>();
  const PAGE_SIZE = 50;

  for (const project of projects) {
    let page = 1;
    while (true) {
      const result = await client.get<MantisPaginatedIssues>('issues', {
        project_id: project.id,
        select: 'id,tags',
        page,
        page_size: PAGE_SIZE,
      });
      const issues = result.issues ?? [];
      for (const issue of issues) {
        for (const tag of (issue.tags ?? [])) {
          if (!tagMap.has(tag.id)) {
            tagMap.set(tag.id, { id: tag.id, name: tag.name });
          }
        }
      }
      if (issues.length < PAGE_SIZE) break;
      page++;
    }
  }

  return Array.from(tagMap.values()).sort((a, b) => a.id - b.id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIdName(o: any): MantisIdName {
  return { id: o.id, name: o.name, ...(o.label !== undefined && { label: o.label }) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeProject(p: any): MantisProject {
  return {
    id: p.id,
    name: p.name,
    ...(p.description !== undefined && { description: p.description }),
    ...(p.status !== undefined && { status: normalizeIdName(p.status) }),
    ...(p.enabled !== undefined && { enabled: p.enabled }),
    ...(p.view_state !== undefined && { view_state: normalizeIdName(p.view_state) }),
    ...(p.access_level !== undefined && { access_level: { id: p.access_level.id, label: p.access_level.label } }),
    ...(p.subprojects !== undefined && { subprojects: p.subprojects.map(normalizeProject) }),
  };
}

async function fetchAndCacheMetadata(client: MantisClient, cache: MetadataCache): Promise<CachedMetadata> {
  // Fetch all projects
  const projectResult = await client.get<{ projects: MantisProject[] }>('projects');
  const projects = (projectResult.projects ?? []).map(normalizeProject);

  const byProject: Record<number, CachedProjectMeta> = {};

  // For each project, fetch users, versions, categories in parallel
  await Promise.all(
    projects.map(async (project) => {
      const [usersResult, versionsResult, projectDetailResult] = await Promise.allSettled([
        client.get<{ users: MantisUser[] }>(`projects/${project.id}/users`),
        client.get<{ versions: MantisVersion[] }>(`projects/${project.id}/versions`, { obsolete: 1, inherit: 1 }),
        // Categories are embedded in the project detail response — same source as get_project_categories
        client.get<{ projects: Array<{ categories?: MantisCategory[] }> }>(`projects/${project.id}`),
      ]);

      const users: MantisUser[] = usersResult.status === 'fulfilled'
        ? (usersResult.value.users ?? [])
        : [];

      const versions: MantisVersion[] = versionsResult.status === 'fulfilled'
        ? (versionsResult.value.versions ?? [])
        : [];

      const rawCategories: MantisCategory[] = projectDetailResult.status === 'fulfilled'
        ? (projectDetailResult.value.projects?.[0]?.categories ?? [])
        : [];
      const categories = rawCategories.map((cat) => ({
        ...cat,
        name: cat.name.startsWith(ALL_PROJECTS_PREFIX)
          ? cat.name.slice(ALL_PROJECTS_PREFIX.length)
          : cat.name,
      }));

      byProject[project.id] = { users, versions, categories };
    })
  );

  // Fetch all tags — try the dedicated endpoint first, fall back to collecting
  // from issues when the endpoint is not available (e.g. MantisBT < 2.26)
  let tags: MantisTag[] = [];
  try {
    const tagsResult = await client.get<{ tags: MantisTag[] }>('tags');
    tags = tagsResult.tags ?? [];
  } catch {
    tags = await collectTagsFromIssues(client, projects);
  }

  const data: CachedMetadata = {
    timestamp: Date.now(),
    projects,
    byProject,
    tags,
  };

  await cache.save(data);
  return data;
}

export function registerMetadataTools(server: McpServer, client: MantisClient, cache: MetadataCache): void {

  // ---------------------------------------------------------------------------
  // sync_metadata
  // ---------------------------------------------------------------------------

  server.registerTool(
    'sync_metadata',
    {
      title: "同步元数据缓存",
      description: "读取全部项目及其成员、版本、分类和标签，写入本地元数据缓存。优先用 GET /tags 获取标签；接口不存在时扫描各项目的缺陷收集标签。默认缓存有效期为 3600 秒，通过 MANTIS_CACHE_TTL 配置。可用此工具强制刷新缓存。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async () => {
      try {
        const data = await fetchAndCacheMetadata(client, cache);
        const projectCount = data.projects.length;
        const summary = data.projects.map((p) => {
          const meta = data.byProject[p.id];
          return `  - ${p.name} (ID ${p.id}): ${meta?.users.length ?? 0} users, ${meta?.versions.length ?? 0} versions, ${meta?.categories.length ?? 0} categories`;
        }).join('\n');

        return {
          content: [{
            type: 'text',
            text: `Metadata synced successfully.\n\n${projectCount} project(s):\n${summary}\n\nGlobal tags: ${data.tags.length}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_metadata
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_metadata',
    {
      title: "读取元数据摘要",
      description: "返回缓存元数据摘要：项目数、标签数及各项目的成员、版本和分类数量。缓存缺失或过期时自动同步，默认有效期为 3600 秒。强制刷新使用 sync_metadata；完整内容使用 get_metadata_full 或各项目查询工具。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const data: CachedMetadata = await cache.loadIfValid() ?? await fetchAndCacheMetadata(client, cache);

        const summary = {
          projects: data.projects.length,
          tags: data.tags.length,
          byProject: Object.fromEntries(
            data.projects.map((p) => {
              const meta = data.byProject[p.id];
              return [String(p.id), {
                name: p.name,
                users: meta?.users.length ?? 0,
                versions: meta?.versions.length ?? 0,
                categories: meta?.categories.length ?? 0,
              }];
            })
          ),
          cached_at: new Date(data.timestamp).toISOString(),
          ttl_seconds: cache.getRemainingTtlSeconds(data.timestamp),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_metadata_full
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_metadata_full',
    {
      title: "读取完整元数据",
      description: "返回完整元数据缓存，包括项目、各项目成员、版本、分类和标签，以紧凑 JSON 返回。缓存缺失或过期时自动同步，默认有效期为 3600 秒。强制刷新使用 sync_metadata，简要统计使用 get_metadata。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const data: CachedMetadata = await cache.loadIfValid() ?? await fetchAndCacheMetadata(client, cache);
        return {
          content: [{ type: 'text', text: JSON.stringify(data) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_issue_fields
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_issue_fields',
    {
      title: "读取可查询字段",
      description: "返回可用于 list_issues 和 get_issue 的 select 字段名。通过采样缺陷获取实例实际字段，并补充 notes、attachments、relationships 等为空时可能省略的字段。结果按元数据有效期缓存。此工具返回字段名，不提供项目自定义字段的编号或可选值。",
      inputSchema: z.object({
        project_id: z.coerce.number().int().positive().optional().describe("可选项目编号，用于限定字段采样范围"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id }) => {
      try {
        const cached = await cache.loadIssueFields();
        if (cached) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ fields: cached, source: 'cache' }, null, 2) }],
          };
        }

        const params: Record<string, string | number | boolean | undefined> = {
          page: 1,
          page_size: 1,
          project_id,
        };
        const result = await client.get<MantisPaginatedIssues>('issues', params);
        const issues = result.issues ?? [];

        let fields: string[];
        if (issues.length === 0) {
          fields = STATIC_ISSUE_FIELDS;
        } else {
          const discovered = Object.keys(issues[0]);
          fields = Array.from(new Set([...discovered, ...EMPTY_STRIPPED_FIELDS])).sort();
        }

        await cache.saveIssueFields(fields);
        return {
          content: [{ type: 'text', text: JSON.stringify({ fields, source: issues.length > 0 ? 'live' : 'static' }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
