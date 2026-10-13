import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import { RELATIONSHIP_NAME_TO_ID } from '../constants.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

export function registerRelationshipTools(server: McpServer, client: MantisClient): void {

  // ---------------------------------------------------------------------------
  // add_relationship
  // ---------------------------------------------------------------------------

  server.registerTool(
    'add_relationship',
    {
      title: "添加缺陷关联",
      description: '在两条缺陷间建立关联。type_id 与 type_name 二选一。类型：0=duplicate_of（重复于），1=related_to（相关），2=parent_of / depends_on（源缺陷依赖目标缺陷），3=child_of / blocks（源缺陷阻塞目标缺陷），4=has_duplicate（目标缺陷重复于源缺陷）。',
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("源缺陷编号，关联会添加到该缺陷"),
        target_id: z.coerce.number().int().positive().describe("目标缺陷编号"),
        type_id: z.coerce.number().int().min(0).max(4).optional().describe(
          "关联类型编号：0=duplicate_of，1=related_to，2=parent_of（依赖），3=child_of（阻塞），4=has_duplicate；与 type_name 二选一"
        ),
        type_name: z.string().optional().describe(
          "关联类型名称：duplicate_of、related_to、parent_of（别名 depends_on）、child_of（别名 blocks）、has_duplicate；也接受 related-to 等短横线形式"
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ issue_id, target_id, type_id, type_name }) => {
      // Resolve type_id from type_name when type_id is not provided
      let resolvedTypeId = type_id;
      if (resolvedTypeId === undefined) {
        if (type_name === undefined) {
          return { content: [{ type: 'text', text: errorText('Either type_id or type_name must be provided') }], isError: true };
        }
        const normalized = type_name.toLowerCase().replace(/-/g, '_');
        resolvedTypeId = RELATIONSHIP_NAME_TO_ID[normalized];
        if (resolvedTypeId === undefined) {
          return {
            content: [{ type: 'text', text: errorText(`Unknown relationship type name: "${type_name}". Valid values: duplicate_of, related_to, parent_of, child_of, has_duplicate`) }],
            isError: true,
          };
        }
      }

      try {
        const body = {
          issue: { id: target_id },
          type: { id: resolvedTypeId },
        };
        const result = await client.post<unknown>(`issues/${issue_id}/relationships`, body);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // remove_relationship
  // ---------------------------------------------------------------------------

  server.registerTool(
    'remove_relationship',
    {
      title: "移除缺陷关联",
      description: "移除缺陷关联。先用 get_issue 读取 relationships，relationship_id 使用关联记录的 id，不是关联类型编号。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("关联所属的缺陷编号"),
        relationship_id: z.coerce.number().int().positive().describe("待移除关联的记录编号，来自 get_issue 的 relationships 数组，不是关联类型编号"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ issue_id, relationship_id }) => {
      try {
        await client.delete<unknown>(`issues/${issue_id}/relationships/${relationship_id}`);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
