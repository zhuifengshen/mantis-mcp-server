import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { adminTools } from '../workflow/contracts.js';
import type { Context } from '../workflow/context.js';
import type { Executor } from '../workflow/executor.js';
import type { AdapterCapabilities } from '../workflow/query.js';
import { registerWorkflowTool } from './workflow.js';

export function registerAdminTools(server: McpServer, context: Context, executor: Executor, capabilities: AdapterCapabilities) {
  if (!context.admin) return;
  for (const name of adminTools) registerWorkflowTool(server, name, context, executor, capabilities);
}
