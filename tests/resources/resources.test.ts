import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerResources } from '../../src/resources/index.js';
import { MockMcpServer } from '../helpers/mock-server.js';
import { harness } from '../helpers/workflow.js';
let h: Awaited<ReturnType<typeof harness>>;
let server: MockMcpServer;
beforeEach(async () => { h = await harness(); server = new MockMcpServer(); registerResources(server as never, h.context); });
afterEach(async () => { await h.cleanup(); });
describe('工作流资源主体验证', () => {
  it('保留三个固定资源及项目模板，并隐藏邮箱', async () => {
    expect(server.registeredResourceUris()).toHaveLength(4);
    const result = await server.callResource('mantis://me');
    expect(JSON.parse(result.contents[0].text)).toEqual({ id: 7, name: 'tester' });
  });
  it('忽略旧共享缓存，项目详情复用 context 契约', async () => {
    await writeFile(join(h.dir, 'metadata.json'), JSON.stringify({ data: { projects: [{ id: 9, name: '其他用户的私有项目' }] } }));
    expect((await server.callResource('mantis://projects')).contents[0].text).not.toContain('私有项目');
    const detail = JSON.parse((await server.callResource('mantis://projects/44')).contents[0].text);
    expect(detail.sections.versions.availability).toBe('available');
    expect(detail.supported_actions).not.toContain('close_issue');
  });
  it('撤销凭据后所有资源拒绝回放', async () => {
    await server.callResource('mantis://projects/44');
    h.rest.intercept = r => r.path === 'users/me' ? h.rest.response({}, 401) : undefined;
    for (const uri of ['mantis://me', 'mantis://projects', 'mantis://enums', 'mantis://projects/44']) {
      await expect(server.callResource(uri)).rejects.toThrow();
    }
  });
});
