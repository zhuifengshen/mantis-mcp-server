import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Context } from '../workflow/context.js';

export function registerResources(server: McpServer, context: Context): void {
  const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data) }] });
  server.registerResource('current-user', 'mantis://me', { title: '当前用户', description: '实时验证当前个人 Key 的最小身份。', mimeType: 'application/json' },
    async uri => json(uri, (await context.projects.authenticate()).user));
  server.registerResource('projects', 'mantis://projects', { title: '项目列表', description: '当前主体可访问项目，实时读取；不读取旧共享缓存。', mimeType: 'application/json' },
    async uri => { await context.projects.authenticate(); return json(uri, await context.projects.list()); });
  server.registerResource('issue-enums', 'mantis://enums', { title: '缺陷枚举', description: '当前主体的全局枚举；具体动作使用项目 context。', mimeType: 'application/json' },
    async uri => { await context.projects.authenticate(); return json(uri, { source: 'mantis_rest', enums: (await context.projects.rules()).enums }); });
  server.registerResource('project-detail', new ResourceTemplate('mantis://projects/{id}', { list: async () => {
    await context.projects.authenticate(); return { resources: (await context.projects.list()).map(p => ({ uri: `mantis://projects/${p.id}`, name: p.name })) };
  } }), { title: '项目详情', description: '与 get_project_context 共用主体验证、区块边界和项目配置。', mimeType: 'application/json' },
  async (uri, { id }) => {
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw new Error('项目编号无效');
    return json(uri, await context.project({ project_id: Number(id), limit: 100 }, await context.projects.authenticate()));
  });
}
