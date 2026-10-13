import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

export function registerMonitorTools(server: McpServer, client: MantisClient): void {

  // ---------------------------------------------------------------------------
  // add_monitor
  // ---------------------------------------------------------------------------

  server.registerTool(
    'add_monitor',
    {
      title: "添加缺陷关注人",
      description: "将用户添加为缺陷关注人，由 Mantis 通知配置决定是否发送邮件；不会改变处理人。已关注用户再次添加不会产生重复关注。issue_id 来自 list_issues 或 get_issue；username 必须是登录名，可通过 find_project_member 或 get_project_users 查询。取消关注使用 remove_monitor。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号，使用 list_issues 或 get_issue 查询"),
        username: z.string().min(1).describe("要添加为关注人的 Mantis 登录名，不是显示名称；使用 find_project_member 或 get_project_users 查询"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ issue_id, username }) => {
      try {
        const body = { name: username };
        const result = await client.post<unknown>(`issues/${issue_id}/monitors`, body);
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? { success: true }, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // remove_monitor
  // ---------------------------------------------------------------------------

  server.registerTool(
    'remove_monitor',
    {
      title: "移除缺陷关注人",
      description: "将用户从缺陷关注列表移除，停止该缺陷的关注订阅。",
      inputSchema: z.object({
        issue_id: z.coerce.number().int().positive().describe("缺陷编号（数字）"),
        username: z.string().min(1).describe("要取消关注的用户登录名"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ issue_id, username }) => {
      try {
        await client.delete<unknown>(`issues/${issue_id}/monitors/${username}`);
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
