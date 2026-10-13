import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

export function registerTagTools(server: McpServer, client: MantisClient): void {

  // ---------------------------------------------------------------------------
  // attach_tags
  // ---------------------------------------------------------------------------

  server.registerTool(
    'attach_tags',
    {
      title: "关联标签",
      description: "为缺陷关联一个或多个标签，每项可用 id 或 name 指定。名称不存在时 Mantis 会尝试创建标签，需要 tag_create_threshold 权限；关联需要 tag_attach_threshold 权限，实际权限以实例配置为准。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号（数字）"),
        tags: z.array(
          z.object({
            id: z.coerce.number().int().positive().optional().describe('标签编号'),
            name: z.string().min(1).optional().describe('标签名称'),
          }).refine(t => t.id !== undefined || t.name !== undefined, {
            message: 'Each tag must have at least an id or a name',
          })
        ).min(1).describe("需要关联的标签，每项至少包含 id 或 name"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ issue_id, tags }) => {
      try {
        await client.post<unknown>(`issues/${issue_id}/tags`, { tags });
        return {
          content: [{ type: 'text', text: `Tags successfully attached to issue #${issue_id}.` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // detach_tag
  // ---------------------------------------------------------------------------

  server.registerTool(
    'detach_tag',
    {
      title: "移除标签关联",
      description: "从缺陷移除指定标签。移除自己添加的标签需要 tag_detach_own_threshold 权限，移除他人添加的标签需要 tag_detach_threshold 权限。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号（数字）"),
        tag_id: z.coerce.number().int().positive().describe("待移除的标签编号"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ issue_id, tag_id }) => {
      try {
        await client.delete<unknown>(`issues/${issue_id}/tags/${tag_id}`);
        return {
          content: [{ type: 'text', text: `Tag #${tag_id} successfully removed from issue #${issue_id}.` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
