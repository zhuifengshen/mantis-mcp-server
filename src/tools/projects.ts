import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import type { MantisProject, MantisUser, MantisVersion, MantisCategory } from '../types.js';
import { ALL_PROJECTS_PREFIX } from '../constants.js';
import { normalizeProject } from './metadata.js';
import { MetadataCache } from '../cache.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

const coerceBool = (val: unknown) =>
  val === 'true' ? true : val === 'false' ? false : val;

export function registerProjectTools(server: McpServer, client: MantisClient, cache?: MetadataCache): void {

  // ---------------------------------------------------------------------------
  // list_projects
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_projects',
    {
      title: "列出项目",
      description: "列出当前 API 用户可以访问的所有 Mantis 项目。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const result = await client.get<{ projects: MantisProject[] }>('projects');
        const projects = (result.projects ?? []).map(normalizeProject);
        return {
          content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_project_users
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_project_users',
    {
      title: "读取项目成员",
      description: "列出项目成员，包含 id、name（登录名）、real_name、email、access_level 等字段。按名称查找少量用户时优先用 find_project_member。访问级别：10=查看者、25=报告人、40=更新者、55=开发者、70=管理者、90=管理员。project_id 来自 list_projects。",
      inputSchema: z.object({
        project_id: z.coerce.number().int().positive().describe("项目编号，使用 list_projects 查询"),
        access_level: z.coerce.number().int().optional().describe("仅返回达到该访问级别的用户：10=查看者、25=报告人、40=更新者、55=开发者、70=管理者、90=管理员；省略时返回全部"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id, access_level }) => {
      try {
        const params: Record<string, string | number | boolean | undefined> = {};
        if (access_level !== undefined) params.access_level = access_level;
        const result = await client.get<{ users: MantisUser[] }>(`projects/${project_id}/users`, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.users ?? result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_project_versions
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_project_versions',
    {
      title: "读取项目版本",
      description: "列出项目版本，包括 id、name、released、obsolete 和 timestamp（版本日期）。返回的名称可用于 create_issue 或 update_issue 的 version、target_version、fixed_in_version。默认排除废弃版本和父项目继承版本；obsolete=true、inherit=true 分别启用。project_id 来自 list_projects。创建、修改、发布或删除版本分别使用 create_version、update_version、release_version、delete_version。",
      inputSchema: z.object({
        project_id: z.coerce.number().int().positive().describe("项目编号，使用 list_projects 查询"),
        obsolete: z.preprocess(coerceBool, z.boolean().default(false)).describe("是否包含已废弃版本，默认 false"),
        inherit: z.preprocess(coerceBool, z.boolean().default(false)).describe("是否包含从父项目继承的版本，默认 false"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id, obsolete, inherit }) => {
      try {
        const params: Record<string, number> = {};
        if (obsolete) params.obsolete = 1;
        if (inherit) params.inherit = 1;
        const result = await client.get<{ versions: MantisVersion[] }>(`projects/${project_id}/versions`, params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.versions ?? result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // get_project_categories
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_project_categories',
    {
      title: "读取项目分类",
      description: "列出项目可用分类。返回时去除跨项目分类名称的 [All Projects] 前缀，方便直接用于创建缺陷。",
      inputSchema: z.object({
        project_id: z.coerce.number().int().positive().describe("项目编号（数字）"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id }) => {
      try {
        const result = await client.get<{ projects: Array<{ categories?: MantisCategory[] }> }>(`projects/${project_id}`);
        const raw = result.projects?.[0]?.categories ?? [];
        const categories = raw.map((cat) => ({
          ...cat,
          name: cat.name.startsWith(ALL_PROJECTS_PREFIX)
            ? cat.name.slice(ALL_PROJECTS_PREFIX.length)
            : cat.name,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(categories, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // find_project_member
  // ---------------------------------------------------------------------------

  server.registerTool(
    'find_project_member',
    {
      title: "查找项目成员",
      description: "按登录名 name、显示名 real_name 或 email 查找项目成员，使用不区分大小写的子字符串匹配。limit 默认 10，最大 100；省略 query 时返回前 limit 个用户。优先读取有效缓存，否则调用实时接口。",
      inputSchema: z.object({
        project_id: z.coerce.number().int().positive().describe("项目编号（数字）"),
        query: z.string().optional().describe("匹配 name、real_name 或 email 的子字符串，不区分大小写"),
        limit: z.coerce.number().int().min(1).max(100).default(10).describe("最多返回条数，默认 10，最大 100"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id, query, limit }) => {
      try {
        let users: MantisUser[];
        const cached = cache ? await cache.loadIfValid() : null;
        if (cached?.byProject[project_id]) {
          users = cached.byProject[project_id]!.users;
        } else {
          const result = await client.get<{ users: MantisUser[] }>(`projects/${project_id}/users`);
          users = result.users ?? [];
        }
        if (query) {
          const q = query.toLowerCase();
          users = users.filter((u) =>
            u.name.toLowerCase().includes(q) ||
            (u.real_name?.toLowerCase().includes(q) ?? false) ||
            (u.email?.toLowerCase().includes(q) ?? false)
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(users.slice(0, limit), null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
