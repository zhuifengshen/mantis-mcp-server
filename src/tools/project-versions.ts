import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import type { MantisVersion } from '../types.js';
import { MetadataCache } from '../cache.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

const coerceBool = (val: unknown) =>
  val === 'true' ? true : val === 'false' ? false : val;

/** 过滤未传入的字段，保证 PATCH 仅修改调用方指定的内容。 */
function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const PERMISSION_NOTE = '需要项目的 manage_project_threshold 权限，Mantis 默认要求管理者级别。';

const OWNING_PROJECT_NOTE = '版本必须属于 project_id 对应的项目；继承自父项目的版本需使用父项目编号修改。get_project_versions 默认 inherit=false，仅列出项目自己的版本。';

const projectIdSchema = z.coerce.number().int().positive().describe('版本所属项目的编号，通过 list_projects 查询');
const versionIdSchema = z.coerce.number().int().positive().describe('版本编号，通过 get_project_versions 查询');
const timestampSchema = z.string().min(1).describe('版本日期，使用 ISO 8601，例如 "2026-09-27" 或 "2026-09-27T10:00:00+08:00"；影响路线图和变更记录的排序。');
const boolFlag = z.preprocess(coerceBool, z.boolean());

export function registerProjectVersionTools(server: McpServer, client: MantisClient, cache?: MetadataCache): void {

  // 缓存更新失败不能将已经成功的 REST 写入报告为失败。
  async function patchCachedVersions(mutate: (projectId: number, versions: MantisVersion[]) => MantisVersion[]): Promise<void> {
    try {
      await cache?.patchVersions(mutate);
    } catch {
      // 缓存仅作尽力同步，可通过 sync_metadata 修复。
    }
  }

  async function createVersion(projectId: number, fields: Record<string, unknown>): Promise<MantisVersion> {
    const result = await client.post<{ version: MantisVersion }>(`projects/${projectId}/versions`, definedFields(fields));
    // 新版本只写入所属项目的缓存，子项目是否继承由服务端配置决定。
    await patchCachedVersions((pid, versions) => (pid === projectId ? [...versions, result.version] : versions));
    return result.version;
  }

  async function updateVersion(projectId: number, versionId: number, fields: Record<string, unknown>): Promise<MantisVersion> {
    const result = await client.patch<{ version: MantisVersion }>(`projects/${projectId}/versions/${versionId}`, definedFields(fields));
    // 版本编号全局唯一，同时更新子项目缓存中已有的继承版本。
    await patchCachedVersions((_pid, versions) => versions.map((v) => (v.id === versionId ? result.version : v)));
    return result.version;
  }

  // ---------------------------------------------------------------------------
  // create_version
  // ---------------------------------------------------------------------------

  server.registerTool(
    'create_version',
    {
      title: '创建项目版本',
      description: `在 Mantis 项目中创建版本，返回 id、name、description、released、obsolete、timestamp 等版本信息。

版本名称在项目内必须唯一；省略 timestamp 时由 Mantis 使用当前日期。

${PERMISSION_NOTE}`,
      inputSchema: z.object({
        project_id: projectIdSchema,
        name: z.string().trim().min(1).describe('版本名称，例如 "1.2.0"'),
        description: z.string().optional().describe('可选的版本说明'),
        released: boolFlag.optional().describe('是否已发布；Mantis 默认 false'),
        obsolete: boolFlag.optional().describe('是否已废弃；Mantis 默认 false'),
        timestamp: timestampSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ project_id, ...fields }) => {
      try {
        const created = await createVersion(project_id, fields);
        return {
          content: [{ type: 'text', text: JSON.stringify(created, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // update_version
  // ---------------------------------------------------------------------------

  server.registerTool(
    'update_version',
    {
      title: '更新项目版本',
      description: `更新项目的已有版本，仅修改传入的字段，返回更新后的版本信息。

重命名会同时更新所有引用该版本的缺陷的 version、target_version、fixed_in_version 字段，包括继承该版本的子项目。

单独设置 released=true 不会更新版本日期；需要同时设置 timestamp，或使用 release_version。

${OWNING_PROJECT_NOTE}

${PERMISSION_NOTE}`,
      inputSchema: z.object({
        project_id: projectIdSchema,
        version_id: versionIdSchema,
        name: z.string().trim().min(1).optional().describe('新版本名称，项目内必须唯一'),
        description: z.string().optional().describe('新的版本说明'),
        released: boolFlag.optional().describe('是否已发布'),
        obsolete: boolFlag.optional().describe('是否已废弃'),
        timestamp: timestampSchema.optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ project_id, version_id, ...fields }) => {
      if (Object.keys(definedFields(fields)).length === 0) {
        return {
          content: [{ type: 'text', text: errorText('没有待更新字段，请至少提供 name、description、released、obsolete、timestamp 中的一项。') }],
          isError: true,
        };
      }
      try {
        const updated = await updateVersion(project_id, version_id, fields);
        return {
          content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // release_version
  // ---------------------------------------------------------------------------

  server.registerTool(
    'release_version',
    {
      title: '发布项目版本',
      description: `将版本标记为已发布并设置发布日期，默认使用当前时间；可同时创建后续版本。

仅在提供 next_version 时创建后续版本，名称按原值使用，不自动推算版本号。

返回 released，以及可选的 next_version 或 next_version_error。发布和创建后续版本是两次独立请求；后续创建失败时发布仍然生效，应只重试 create_version，避免重复发布。

${OWNING_PROJECT_NOTE}

${PERMISSION_NOTE}`,
      inputSchema: z.object({
        project_id: projectIdSchema,
        version_id: versionIdSchema,
        timestamp: timestampSchema.optional().describe('发布日期，使用 ISO 8601；默认当前时间'),
        next_version: z.string().trim().min(1).optional().describe('后续未发布版本的名称，例如 "1.2.1"；省略时只发布当前版本'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ project_id, version_id, timestamp, next_version }) => {
      let released: MantisVersion;
      try {
        released = await updateVersion(project_id, version_id, {
          released: true,
          timestamp: timestamp ?? new Date().toISOString(),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }

      const result: { released: MantisVersion; next_version?: MantisVersion; next_version_error?: string } = { released };
      if (next_version !== undefined) {
        try {
          result.next_version = await createVersion(project_id, { name: next_version });
        } catch (error) {
          result.next_version_error = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // delete_version
  // ---------------------------------------------------------------------------

  server.registerTool(
    'delete_version',
    {
      title: '删除项目版本',
      description: `永久删除项目版本，此操作不可恢复。

Mantis 会清空所有引用该版本的缺陷的 version、target_version、fixed_in_version，包括继承该版本的子项目。只需停用版本时，可通过 update_version 设置 obsolete=true。

${OWNING_PROJECT_NOTE}

${PERMISSION_NOTE}`,
      inputSchema: z.object({
        project_id: projectIdSchema,
        version_id: versionIdSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ project_id, version_id }) => {
      try {
        await client.delete<unknown>(`projects/${project_id}/versions/${version_id}`);
        await patchCachedVersions((_pid, versions) => versions.filter((v) => v.id !== version_id));
        return {
          content: [{ type: 'text', text: `版本 ${version_id} 已删除。` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
