import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink, open, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readUpload, reserveUpload, uploadPolicy } from '../../src/services/files.js';
import { harness } from '../helpers/workflow.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.cleanup(); });
describe('单文件政策与上传归因', () => {
  it.each(uploadPolicy.allowed_extensions)('接受白名单大小写扩展名 %s', async ext => {
    const file = join(h.dir, `测试.${ext.toUpperCase()}`); await writeFile(file, 'x');
    expect((await readUpload(file)).info.size).toBe(1);
  });
  it('40 MiB 本身可读，超出一字节与空文件拒绝', async () => {
    const file = join(h.dir, 'boundary.txt'); const fd = await open(file, 'w');
    await expect(readUpload(file)).rejects.toMatchObject({ code: 'FILE_EMPTY' });
    await fd.truncate(41943040);
    expect((await readUpload(file)).bytes.length).toBe(41943040);
    await fd.truncate(41943041); await fd.close();
    await expect(readUpload(file)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
  it('拒绝目录、扩展名伪装、覆盖名称、非法字符与目录前缀混淆', async () => {
    const root = join(h.dir, 'allowed'); await mkdir(root);
    const directory = join(root, 'folder.pdf'); await mkdir(directory);
    await expect(readUpload(directory)).rejects.toMatchObject({ code: 'FILE_NOT_REGULAR' });
    const outside = join(h.dir, 'allowed-else'); await mkdir(outside);
    const file = join(outside, 'proof.pdf'); await writeFile(file, 'data');
    await symlink(file, join(root, 'link.pdf'));
    await expect(readUpload(join(root, 'link.pdf'), undefined, undefined, root)).rejects.toMatchObject({ code: 'FILE_OUTSIDE_UPLOAD_DIR' });
    await expect(readUpload(file, '../file.pdf')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(readUpload(file, 'file.png')).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    await expect(readUpload(file, 'a\nb.pdf')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const ext of ['chls', 'docx', 'xlsx', 'pptx', 'zip', 'log', 'json', '']) await expect(readUpload(join(root, `a.${ext}`))).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    await expect(readUpload(file, undefined, '0'.repeat(64))).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    const release = reserveUpload(); expect(() => reserveUpload()).toThrow(); release();
  });
  it('201 空响应后唯一回读得到附件；结果和账本无 Base64 或本地路径', async () => {
    const file = join(h.dir, 'proof.txt'); await writeFile(file, '合成验收证据');
    const input = { issue_id: 1, file_path: file, operation_id: randomUUID(), expected_revision: await h.revision() };
    const result = await h.executor.execute('upload_file', input);
    expect(result.outcome).toBe('succeeded');
    expect(result.result?.attachment).toMatchObject({ id: 1, filename: 'proof.txt' });
    expect(JSON.stringify(result)).not.toContain(file);
    const session = await h.context.projects.authenticate();
    const ledger = await readFile(join(session.dir, 'operations', `${input.operation_id}.json`), 'utf8');
    expect(ledger).not.toContain(Buffer.from('合成验收证据').toString('base64')); expect(ledger).not.toContain(file);
    expect((await stat(join(session.dir, 'operations', `${input.operation_id}.json`))).mode & 0o777).toBe(0o600);
    const again = await h.executor.execute('upload_file', { ...input, operation_id: randomUUID(), expected_revision: result.result!.expected_revision });
    expect(again.result?.attachment).toMatchObject({ filename: 'proof-2.txt', server_renamed: true });
  });
  it('上传超时即使可见同名同大小也 unknown，禁止自动重传', async () => {
    const file = join(h.dir, 'proof.txt'); await writeFile(file, '合成内容');
    const input = { issue_id: 1, file_path: file, operation_id: randomUUID(), expected_revision: await h.revision() };
    h.rest.intercept = r => { if (r.method === 'POST') { h.rest.apply(r); throw new Error('断线'); } return undefined; };
    expect((await h.executor.execute('upload_file', input)).outcome).toBe('unknown');
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('unknown');
    expect(checked.current_observation?.attachment_candidates).toHaveLength(1);
    await h.executor.execute('upload_file', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('上传被 HTTP 413 拒绝时保存状态及请求阶段，核查不会重传', async () => {
    const file = join(h.dir, 'proof.txt'); await writeFile(file, '合成内容');
    const input = { issue_id: 1, file_path: file, operation_id: randomUUID(), expected_revision: await h.revision() };
    h.rest.intercept = r => r.method === 'POST' ? h.rest.response({}, 413) : undefined;
    const result = await h.executor.execute('upload_file', input);
    expect(result.outcome).toBe('rejected');
    expect(result.steps[0]).toMatchObject({ state: 'failed', http_status: 413, request_sent: true });
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.steps[0]).toMatchObject({ state: 'failed', http_status: 413, request_sent: true });
    expect(h.rest.writes()).toHaveLength(1);
  });
  it.each(['2.26.2', 'unknown'])('省略空附件集合时按已核对版本 %s 处理，不改变原始快照', async version => {
    const file = join(h.dir, 'proof.txt'); await writeFile(file, '合成内容');
    h.rest.intercept = r => {
      if (r.method === 'GET' && r.path === 'issues/1') {
        const issue = structuredClone(h.rest.issues.get(1)!);
        if (!issue.attachments.length) delete issue.attachments;
        return new Response(JSON.stringify({ issues: [issue] }), { headers: { 'X-Mantis-Version': version } });
      }
      return undefined;
    };
    const before = (await h.context.issues.get(1)).issue;
    const result = await h.executor.execute('upload_file', { issue_id: 1, file_path: file, operation_id: randomUUID(), expected_revision: await h.revision() });
    expect(before).not.toHaveProperty('attachments');
    expect(result.outcome).toBe(version === '2.26.2' ? 'succeeded' : 'rejected');
    expect(h.rest.writes()).toHaveLength(version === '2.26.2' ? 1 : 0);
  });
  it('上传确认后回读失败为 partial_success，核查成功后不再上传', async () => {
    const file = join(h.dir, 'proof.txt'); await writeFile(file, '合成内容');
    const input = { issue_id: 1, file_path: file, operation_id: randomUUID(), expected_revision: await h.revision() };
    let uploaded = false;
    h.rest.intercept = r => { if (r.method === 'POST') uploaded = true; if (uploaded && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503); return undefined; };
    expect((await h.executor.execute('upload_file', input)).outcome).toBe('partial_success');
    h.rest.intercept = undefined;
    expect((await h.executor.getOperation(input.operation_id)).outcome).toBe('succeeded');
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('项目配置不可读时附件仍由 Mantis 判定权限，不误依赖生命周期映射', async () => {
    const file = join(h.dir, 'proof.txt'); await writeFile(file, '合成内容');
    h.rest.intercept = r => r.path === 'config' ? h.rest.response({}, 403) : undefined;
    const result = await h.executor.execute('upload_file', { issue_id: 1, file_path: file, operation_id: randomUUID(), expected_revision: await h.revision() });
    expect(result.outcome).toBe('succeeded');
    expect(h.rest.writes()).toHaveLength(1);
  });
});
