import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MantisClient } from '../client.js';
import type { MantisFilter } from '../types.js';

function errorText(msg: string): string {
  return `Error: ${msg}`;
}

export function registerFilterTools(server: McpServer, client: MantisClient): void {

  // ---------------------------------------------------------------------------
  // list_filters
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_filters',
    {
      title: "列出已保存的筛选器",
      description: "列出当前用户可访问的 Mantis 筛选器，返回的编号可用于 list_issues 的 filter_id。",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const result = await client.get<{ filters: MantisFilter[] } | MantisFilter[]>('filters');
        const filters = Array.isArray(result) ? result : result.filters ?? result;
        return {
          content: [{ type: 'text', text: JSON.stringify(filters, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: errorText(msg) }], isError: true };
      }
    }
  );
}
