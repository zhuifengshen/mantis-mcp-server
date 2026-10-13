import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import type { MantisUser } from '../types.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

export function registerUserTools(server: McpServer, client: MantisClient): void {

  // ---------------------------------------------------------------------------
  // get_current_user
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_current_user',
    {
      title: "读取当前用户",
      description: "读取当前 API Key 对应的 Mantis 用户信息。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const result = await client.get<MantisUser>('users/me');
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
