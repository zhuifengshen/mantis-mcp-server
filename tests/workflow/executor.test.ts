import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from '../helpers/workflow.js';
import { schemas, writeOutput } from '../../src/workflow/contracts.js';
import { Operations } from '../../src/workflow/operations.js';
import { Executor } from '../../src/workflow/executor.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(true); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await h.cleanup(); });
const fixed = { issue_id: 1, fix_summary: '修复边界判断', self_test: { result: 'passed', summary: '已执行针对性回归，边界输入通过' } };
const args = async (extra = {}) => ({ ...fixed, expected_revision: await h.revision(), operation_id: randomUUID(), ...extra });
describe('分步执行、恢复及未知结果', () => {
  it.each([false, true])('主 PATCH 后核查 503，补齐可信快照后只恢复备注（先核查=%s）', async checkFirst => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    const first = await h.executor.execute('submit_fix', input);
    expect(first.outcome).toBe('partial_success');
    expect(first.steps.find(s => s.name === 'verify_primary')?.state).toBe('failed');
    expect(first.recovery.action).toBe('manual_review');
    h.rest.intercept = undefined;
    const session = await h.context.projects.authenticate();
    const record = await new Operations(session.dir).load(input.operation_id);
    expect(record?.primary_response_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.after_hash).toBeUndefined();
    h.executor = new Executor(h.context, h.capabilities);
    if (checkFirst) {
      const checked = await h.executor.getOperation(input.operation_id);
      expect(checked.recovery.action).toBe('retry_same_operation');
      expect(checked.steps.find((s: { name: string }) => s.name === 'verify_primary')?.state).toBe('succeeded');
      expect(h.rest.writes()).toHaveLength(1);
      const session = await h.context.projects.authenticate();
      expect((await new Operations(session.dir).load(input.operation_id))?.after_hash).toBeTruthy();
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60000);
    const result = await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(result.outcome).toBe('succeeded');
    expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH', 'POST']);
    expect(h.rest.issues.get(1)!.notes).toHaveLength(1);
  });
  describe.each([false, true])('补验前发生并发修改（先核查=%s）', checkFirst => {
    it.each([
      { label: '转派', changes: { handler: { id: 8 } } },
      { label: '修改正文', changes: { description: '他人补充的现象' } },
      { label: '追加备注', changes: { notes: [{ id: 9, text: '他人追加的备注', reporter: { id: 8 } }] } },
      { label: '修改自定义字段', changes: { custom_fields: [{ field: { id: 1 }, value: '已改变' }] } },
      { label: '转派后改回但保留历史', changes: { history: [{ type: 'field-updated', field: { name: 'handler' }, old_value: '7', new_value: '8' },
        { type: 'field-updated', field: { name: 'handler' }, old_value: '8', new_value: '7' }] } },
    ])('$label 时保留主成功事实，不将新对象作为恢复基线', async ({ changes }) => {
      const input = await args();
      let patched = false;
      h.rest.intercept = r => {
        if (r.method === 'PATCH') patched = true;
        if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
        return undefined;
      };
      expect((await h.executor.execute('submit_fix', input)).outcome).toBe('partial_success');
      h.rest.intercept = undefined;
      // 特意不更新时间戳：秒级时间戳或未展示的字段不能掩盖并发变化。
      Object.assign(h.rest.issues.get(1)!, changes);
      if (checkFirst) {
        const checked = await h.executor.getOperation(input.operation_id);
        expect(checked.recovery.action).toBe('manual_review');
        expect(checked.recovery).not.toHaveProperty('resume');
      }
      const result = await h.executor.execute('submit_fix', { ...input, resume: true });
      expect(result.outcome).toBe('partial_success');
      expect(result.error?.code).toBe('RECOVERY_UNAVAILABLE');
      expect(result.recovery.action).toBe('manual_review');
      expect(result.steps[0].state).toBe('succeeded');
      expect(result.steps.find(s => s.name === 'append_note')?.state).toBe('not_started');
      expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH']);
      const session = await h.context.projects.authenticate();
      expect((await new Operations(session.dir).load(input.operation_id))?.after_hash).toBeUndefined();
      expect((await h.executor.getOperation(input.operation_id)).recovery.action).toBe('manual_review');
    });
  });
  it.each(['空响应', '局部响应', '其他缺陷响应', '旧账本'])('缺少可信主响应时保持人工核查：%s', async mode => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') {
        patched = true;
        const response = h.rest.apply(r);
        if (mode === '空响应') return h.rest.response(undefined);
        if (mode === '局部响应') return h.rest.response({ issues: [{ id: 1, ...r.body }] });
        if (mode === '其他缺陷响应') return h.rest.response({ issues: [{ ...h.rest.issues.get(1), id: 2 }] });
        return response;
      }
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('partial_success');
    h.rest.intercept = undefined;
    const session = await h.context.projects.authenticate(), ledger = new Operations(session.dir);
    if (mode === '旧账本') {
      const record = (await ledger.load(input.operation_id))!;
      delete record.primary_response_hash;
      await ledger.save(record);
    }
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.recovery.action).toBe('manual_review');
    expect(checked.recovery).not.toHaveProperty('resume');
    const resumed = await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(resumed.outcome).toBe('partial_success');
    expect(resumed.error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect(resumed.recovery.action).toBe('manual_review');
    expect((await ledger.load(input.operation_id))?.after_hash).toBeUndefined();
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('首次观察后、补验回读前转派也不能建立写后快照', async () => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    await h.executor.execute('submit_fix', input);
    let reads = 0;
    h.rest.intercept = r => {
      if (r.method === 'GET' && r.path === 'issues/1' && ++reads === 2) h.rest.issues.get(1)!.handler = { id: 8 };
      return undefined;
    };
    expect((await h.executor.getOperation(input.operation_id)).recovery.action).toBe('manual_review');
    const session = await h.context.projects.authenticate();
    expect((await new Operations(session.dir).load(input.operation_id))?.after_hash).toBeUndefined();
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).recovery.action).toBe('manual_review');
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('主响应使用单个 issue 包装时，核查恢复仍只补原备注', async () => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') {
        patched = true;
        h.rest.apply(r);
        return h.rest.response({ issue: h.rest.issues.get(1) });
      }
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('partial_success');
    h.rest.intercept = undefined;
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).outcome).toBe('succeeded');
    expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH', 'POST']);
  });
  it('主步骤重新核查不符时只给人工处理指引，不补备注或重发 PATCH', async () => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    await h.executor.execute('submit_fix', input);
    h.rest.intercept = undefined;
    h.rest.issues.get(1)!.status = { id: 20 };
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('partial_success');
    expect(checked.error?.code).toBe('VERIFICATION_MISMATCH');
    expect(checked.recovery.action).toBe('manual_review');
    expect(checked.recovery).not.toHaveProperty('resume');
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).recovery.action).toBe('manual_review');
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('主步骤核查持续不可用时不提供恢复写入指引', async () => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    await h.executor.execute('submit_fix', input);
    let reads = 0;
    h.rest.intercept = r => r.method === 'GET' && r.path === 'issues/1' && ++reads % 2 === 0 ? h.rest.response({}, 503) : undefined;
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.recovery.action).toBe('manual_review');
    expect(checked.recovery).not.toHaveProperty('resume');
    const session = await h.context.projects.authenticate();
    expect((await new Operations(session.dir).load(input.operation_id))?.after_hash).toBeUndefined();
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).recovery.action).toBe('manual_review');
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('补齐主步骤核查后冻结写后快照，不接受后续转派作为恢复基线', async () => {
    const input = await args();
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'issues/1') return h.rest.response({}, 503);
      return undefined;
    };
    await h.executor.execute('submit_fix', input);
    h.rest.intercept = undefined;
    await h.executor.getOperation(input.operation_id);
    h.rest.issues.get(1)!.handler = { id: 8 };
    const result = await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(result.error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect(result.recovery.action).toBe('manual_review');
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('版本发布已成功但主步骤核查失败时，只恢复后续版本创建', async () => {
    const project = await h.context.project(schemas.get_project_context.parse({ project_id: 44, sections: ['versions'] }), await h.context.projects.authenticate());
    const input = { project_id: 44, version_id: 1, operation_id: randomUUID(), expected_revision: project.versions_revision, next_version: '2.0' };
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'projects/44/versions') return h.rest.response({}, 503);
      return undefined;
    };
    expect((await h.executor.execute('release_version', input)).outcome).toBe('partial_success');
    h.rest.intercept = undefined;
    expect((await h.executor.execute('release_version', { ...input, resume: true })).outcome).toBe('succeeded');
    expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH', 'POST']);
  });
  it.each(['目标版本改变', '其他版本改变', '新增版本', '删除其他版本'])('发布后补验前%s，不创建后续版本', async change => {
    h.rest.versions.push({ id: 2, name: '0.9', released: true });
    const project = await h.context.project(schemas.get_project_context.parse({ project_id: 44, sections: ['versions'] }), await h.context.projects.authenticate());
    const input = { project_id: 44, version_id: 1, operation_id: randomUUID(), expected_revision: project.versions_revision, next_version: '2.0' };
    let patched = false;
    h.rest.intercept = r => {
      if (r.method === 'PATCH') patched = true;
      if (patched && r.method === 'GET' && r.path === 'projects/44/versions') return h.rest.response({}, 503);
      return undefined;
    };
    expect((await h.executor.execute('release_version', input)).outcome).toBe('partial_success');
    h.rest.intercept = undefined;
    if (change === '目标版本改变') h.rest.versions[0].description = '他人修改';
    if (change === '其他版本改变') h.rest.versions[1].description = '他人修改';
    if (change === '新增版本') h.rest.versions.push({ id: 3, name: '1.1' });
    if (change === '删除其他版本') h.rest.versions.pop();
    expect((await h.executor.getOperation(input.operation_id)).recovery.action).toBe('manual_review');
    const result = await h.executor.execute('release_version', { ...input, resume: true });
    expect(result.outcome).toBe('partial_success');
    expect(result.error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect(result.recovery.action).toBe('manual_review');
    expect(result.steps.find(s => s.name === 'create_next_version')?.state).toBe('not_started');
    const session = await h.context.projects.authenticate();
    expect((await new Operations(session.dir).load(input.operation_id))?.after_hash).toBeUndefined();
    expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH']);
  });
  it('正常修复只写最小状态和一条备注，返回可信标识；重放不重复写', async () => {
    const input = await args();
    const result = await h.executor.execute('submit_fix', input);
    expect(result.outcome).toBe('succeeded');
    expect(writeOutput.safeParse(result).success).toBe(true);
    expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH', 'POST']);
    expect(h.rest.writes()[0].body).toEqual({ status: { id: 80 }, resolution: { id: 20 } });
    expect(result.result).toMatchObject({ issue_id: 1, note_ids: [1], expected_revision: expect.any(String) });
    h.rest.issues.get(1)!.summary = '随后改名';
    const replay = await h.executor.execute('submit_fix', input);
    expect(replay.outcome).toBe('succeeded');
    expect(replay.current_observation).toMatchObject({ issue: { summary: '随后改名' } });
    expect(h.rest.writes()).toHaveLength(2);
    const changed = await h.executor.execute('submit_fix', { ...input, fix_summary: '不同正文' });
    expect(changed.error?.code).toBe('OPERATION_ID_REUSED');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it.each(['failed', 'not_run', undefined])('自测 %s 在任何 REST 请求之前拒绝', async result => {
    const output = await h.executor.execute('submit_fix', { ...fixed, self_test: { result, summary: '实际测试' }, operation_id: randomUUID(), expected_revision: 'invalid' });
    expect(output.error?.code).toBe('INVALID_INPUT'); expect(h.rest.calls).toHaveLength(0);
  });
  it('过期 revision 可只读比较但不能写；有效期内他人备注变化冲突', async () => {
    const input = await args();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60000);
    const refresh = await h.context.issue(schemas.get_issue_context.parse({ issue_id: 1, sections: [], previous_revision: input.expected_revision }), await h.context.projects.authenticate());
    expect(refresh.revision_comparison).toBe('unchanged');
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('conflict');
    vi.restoreAllMocks();
    h.rest.issues.get(1)!.notes.push({ id: 2, text: '他人修改' });
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('conflict');
    expect(h.rest.writes()).toHaveLength(0);
  });
  it('主成功、备注拒绝保留 partial_success，30 分钟后仅恢复原私有备注', async () => {
    const input = await args({ note_view_state: 'private' });
    h.rest.intercept = r => r.method === 'POST' ? h.rest.response({}, 403) : undefined;
    const result = await h.executor.execute('submit_fix', input);
    expect(result.outcome).toBe('partial_success');
    expect(result.steps.find(s => s.name === 'append_note')?.state).toBe('failed');
    expect(h.rest.issues.get(1)!.status.id).toBe(80);
    const count = h.rest.writes().length;
    await h.executor.execute('submit_fix', input);
    expect(h.rest.writes()).toHaveLength(count);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60000);
    h.rest.intercept = undefined;
    const resumed = await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(resumed.outcome).toBe('succeeded');
    expect(h.rest.writes().filter(r => r.method === 'PATCH')).toHaveLength(1);
    expect(h.rest.writes().at(-1)?.body?.view_state).toEqual({ name: 'private' });
  });
  it('恢复期间对象被重开则停止，不重复原状态或说明', async () => {
    const input = await args();
    h.rest.intercept = r => r.method === 'POST' ? h.rest.response({}, 403) : undefined;
    await h.executor.execute('submit_fix', input);
    h.rest.intercept = undefined;
    h.rest.issues.get(1)!.status = { id: 20 };
    const result = await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(result.error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('PATCH 超时即使回读等于目标也保持 unknown，不发成功备注', async () => {
    const input = await args();
    h.rest.intercept = r => { if (r.method === 'PATCH') { h.rest.apply(r); throw new Error('模拟连接中断'); } return undefined; };
    const result = await h.executor.execute('submit_fix', input);
    expect(result.outcome).toBe('unknown');
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('unknown');
    await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('备注超时可由唯一标记、作者和完整正文确认，不重发', async () => {
    const input = await args();
    h.rest.intercept = r => { if (r.method === 'POST') { h.rest.apply(r); throw new Error('响应中断'); } return undefined; };
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('unknown');
    expect((await h.executor.getOperation(input.operation_id)).outcome).toBe('succeeded');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('主请求明确拒绝不追加备注；5xx 不当作未执行', async () => {
    const input = await args();
    h.rest.intercept = r => r.method === 'PATCH' ? h.rest.response({}, 403) : undefined;
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('rejected');
    h.rest.intercept = r => r.method === 'PATCH' ? h.rest.response({}, 500) : undefined;
    expect((await h.executor.execute('submit_fix', { ...input, operation_id: randomUUID() })).outcome).toBe('unknown');
    expect(h.rest.writes().every(r => r.method === 'PATCH')).toBe(true);
  });
  it('私有备注被服务端写成公开时不报成功、不自动重写', async () => {
    const input = await args({ note_view_state: 'private' });
    h.rest.intercept = r => {
      if (r.method === 'POST') {
        const response = h.rest.apply(r);
        h.rest.issues.get(1)!.notes.at(-1).view_state = { name: 'public' };
        return response;
      }
      return undefined;
    };
    const result = await h.executor.execute('submit_fix', input);
    expect(result.outcome).toBe('partial_success');
    expect(result.error?.code).toBe('VERIFICATION_MISMATCH');
    expect(result.result?.expected_revision).toBeNull();
    expect((await h.executor.getOperation(input.operation_id)).outcome).toBe('partial_success');
    await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(2);
  });
  it.each(['timeout', 'empty_response'])('创建后的 %s 通过原标记只读确认，不重复建单', async mode => {
    const input = { project_id: 44, category_id: 1, summary: '创建归因测试', description: '合成现象',
      expected_behavior: '预期', actual_behavior: '实际', operation_id: randomUUID() };
    h.rest.intercept = r => {
      if (r.method === 'POST' && r.path === 'issues') {
        h.rest.apply(r);
        if (mode === 'timeout') throw new Error('创建成功后响应丢失');
        return h.rest.response(undefined, 201);
      }
      return undefined;
    };
    const result = await h.executor.execute('report_issue', input);
    expect(result.outcome).toBe(mode === 'timeout' ? 'unknown' : 'partial_success');
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('succeeded');
    expect(checked.result?.issue_id).toBe(2);
    await h.executor.execute('report_issue', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(1);
  });
  it('冻结计划被篡改后拒绝恢复，不能用旧请求摘要发送新正文', async () => {
    const input = await args();
    h.rest.intercept = r => r.method === 'POST' ? h.rest.response({}, 403) : undefined;
    await h.executor.execute('submit_fix', input);
    const session = await h.context.projects.authenticate();
    const path = join(session.dir, 'operations', `${input.operation_id}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.plan.note.text = '被修改的计划';
    await writeFile(path, JSON.stringify(record));
    h.rest.intercept = undefined;
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('超过七天的未完成操作只给人工核查指引，拒绝恢复', async () => {
    const input = await args();
    h.rest.intercept = r => r.method === 'POST' ? h.rest.response({}, 403) : undefined;
    await h.executor.execute('submit_fix', input);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 8 * 86400_000);
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('partial_success');
    expect(checked.recovery.action).toBe('manual_review');
    expect(checked.warnings).toContain('OPERATION_RETENTION_EXPIRED');
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).error?.code).toBe('RECOVERY_UNAVAILABLE');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('受理保留负责人和重开结果，已分派不降级', async () => {
    h.rest.issues.get(1)!.resolution = { id: 30 };
    const result = await h.executor.execute('accept_issue', { issue_id: 1, reason: '确认有效', operation_id: randomUUID(), expected_revision: await h.revision() });
    expect(result.outcome).toBe('succeeded');
    expect(h.rest.writes()[0].body).toEqual({ status: { id: 50 } });
    expect(h.rest.issues.get(1)!.resolution.id).toBe(30);
  });
  it.each([['not_a_bug', 70], ['wont_fix', 90], ['cannot_reproduce', 40], ['cannot_fix', 50]])('拒绝 %s 写入对应非修复结果', async (reason_code, expected) => {
    const result = await h.executor.execute('reject_issue', { issue_id: 1, reason_code, reason: '有明确处置依据', expected_revision: await h.revision(), operation_id: randomUUID() });
    expect(result.outcome).toBe('succeeded'); expect(h.rest.issues.get(1)!.resolution.id).toBe(expected);
  });
  it('延期恢复不虚构验证失败，关闭不能接受非修复结果', async () => {
    const postponed = await h.executor.execute('postpone_issue', { issue_id: 1, reason: '等待依赖', operation_id: randomUUID(), expected_revision: await h.revision() });
    expect(postponed.outcome).toBe('succeeded');
    const close = await h.executor.execute('close_issue', { issue_id: 1, operation_id: randomUUID(), expected_revision: postponed.result!.expected_revision, verification: { result: 'passed', summary: '验收', environment: '模拟' } });
    expect(close.outcome).toBe('rejected');
    const resumed = await h.executor.execute('reopen_issue', { issue_id: 1, reason_code: 'resume_postponed', reason: '依赖已就绪', expected_revision: postponed.result!.expected_revision, operation_id: randomUUID() });
    expect(resumed.outcome).toBe('succeeded'); expect(h.rest.issues.get(1)!.resolution.id).toBe(30);
    expect(h.rest.issues.get(1)!.notes.at(-1).text).not.toContain('复测失败');
  });
  it('无原账本不能恢复；账本不可持久化时零写入', async () => {
    const input = await args();
    expect((await h.executor.execute('submit_fix', { ...input, resume: true })).error?.code).toBe('RECOVERY_UNAVAILABLE');
    vi.spyOn(Operations.prototype, 'save').mockRejectedValueOnce(new Error('磁盘满'));
    await h.executor.execute('submit_fix', input);
    expect(h.rest.writes()).toHaveLength(0);
    vi.restoreAllMocks();
  });
  it('同操作并发返回 in_progress，不同操作争用对象零写入拒绝', async () => {
    const input = await args();
    let signal!: () => void, continueWrite!: () => void;
    const started = new Promise<void>(r => { signal = r; });
    const wait = new Promise<void>(r => { continueWrite = r; });
    h.rest.intercept = async r => { if (r.method === 'PATCH') { signal(); await wait; } return undefined; };
    const running = h.executor.execute('submit_fix', input); await started;
    expect((await h.executor.execute('submit_fix', input)).outcome).toBe('in_progress');
    const other = await h.executor.execute('submit_fix', { ...input, operation_id: randomUUID() });
    expect(other.error?.code).toBe('OPERATION_BUSY');
    continueWrite(); expect((await running).outcome).toBe('succeeded');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('撤销目标可见性不回放历史私有正文或成功事实', async () => {
    const input = await args({ note_view_state: 'private' }); await h.executor.execute('submit_fix', input);
    h.rest.intercept = r => r.path === 'issues/1' ? h.rest.response({}, 403) : undefined;
    const result = await h.executor.getOperation(input.operation_id);
    expect(result.result).toBeNull(); expect(JSON.stringify(result)).not.toContain('修复边界判断');
    h.rest.intercept = r => r.path === 'users/me' ? h.rest.response({}, 401) : undefined;
    await expect(h.executor.getOperation(input.operation_id)).rejects.toThrow();
  });
  it('版本发布部分成功仅恢复后续版本创建', async () => {
    const project = await h.context.project(schemas.get_project_context.parse({ project_id: 44, sections: ['versions'] }), await h.context.projects.authenticate());
    const input = { project_id: 44, version_id: 1, operation_id: randomUUID(), expected_revision: project.versions_revision, next_version: '2.0' };
    h.rest.intercept = r => r.method === 'POST' ? h.rest.response({}, 403) : undefined;
    expect((await h.executor.execute('release_version', input)).outcome).toBe('partial_success');
    h.rest.intercept = undefined;
    expect((await h.executor.execute('release_version', { ...input, resume: true })).outcome).toBe('succeeded');
    expect(h.rest.writes().filter(r => r.method === 'PATCH')).toHaveLength(1);
  });
});

describe('受控扩展与服务端差异', () => {
  it('备注响应同时包含 issue 和 note 时使用 note ID', async () => {
    const original = h.rest.apply.bind(h.rest);
    h.rest.intercept = r => { if (r.method === 'POST' && r.path.endsWith('/notes')) {
      original(r); h.rest.issues.get(1)!.notes.at(-1).id = 99; return h.rest.response({ issue: { id: 1 }, note: { id: 99 } }, 201);
    } return undefined; };
    const output = await h.executor.execute('add_note', { issue_id: 1, text: '验证备注编号', expected_revision: await h.revision(), operation_id: randomUUID() });
    expect(output.steps[0].server_id).toBe(99);
  });
  it('关注人移除走真实 PATCH 契约并保留其他关注人', async () => {
    h.rest.issues.get(1)!.monitors = [{ id: 7, name: 'tester' }, { id: 8, name: 'other' }];
    const output = await h.executor.execute('remove_monitor', { issue_id: 1, username: 'tester', expected_revision: await h.revision(), operation_id: randomUUID() });
    expect(output.outcome).toBe('succeeded');
    expect(h.rest.writes()).toHaveLength(1);
    expect(h.rest.writes()[0]).toMatchObject({ method: 'PATCH', path: 'issues/1', body: { monitors: [{ id: 8 }] } });
  });
  it('删除操作不追加说明，目标必须属于当前对象', async () => {
    h.rest.issues.get(1)!.notes = [{ id: 4, text: '专用可删除数据', reporter: { id: 7 } }];
    const bad = await h.executor.execute('delete_note', { issue_id: 1, note_id: 9, expected_revision: await h.revision(), operation_id: randomUUID() });
    expect(bad.outcome).toBe('rejected');
    const deleted = await h.executor.execute('delete_note', { issue_id: 1, note_id: 4, expected_revision: await h.revision(), operation_id: randomUUID() });
    expect(deleted.outcome).toBe('succeeded'); expect(h.rest.writes()).toHaveLength(1);
    const issue = await h.executor.execute('delete_issue', { issue_id: 1, expected_revision: await h.revision(), operation_id: randomUUID() });
    expect(issue.outcome).toBe('succeeded'); expect(h.rest.writes()).toHaveLength(2);
  });
  it('条件请求仅使用真实 ETag，412 冲突不追加备注', async () => {
    h.capabilities.conditionalRequests = true;
    h.rest.intercept = r => {
      if (r.method === 'GET' && r.path === 'issues/1') return new Response(JSON.stringify({ issues: [h.rest.issues.get(1)] }), { headers: { ETag: '"original-tag"' } });
      if (r.method === 'PATCH') { expect(r.headers['If-Match']).toBe('"original-tag"'); return h.rest.response({}, 412); }
      return undefined;
    };
    const result = await h.executor.execute('submit_fix', await args());
    expect(result.outcome).toBe('conflict'); expect(h.rest.writes()).toHaveLength(1);
  });
  it('成功写入后的落盘失败保留步骤；重启恢复在途步骤不盲目重发', async () => {
    const input = await args();
    const save = Operations.prototype.save;
    let saves = 0;
    vi.spyOn(Operations.prototype, 'save').mockImplementation(async function(this: Operations, record) {
      if (++saves === 3) throw new Error('成功响应后的磁盘故障');
      return save.call(this, record);
    });
    const result = await h.executor.execute('submit_fix', input);
    expect(result.steps[0].state).toBe('succeeded');
    vi.restoreAllMocks();
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('unknown');
    await h.executor.execute('submit_fix', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(1);
  });
});
