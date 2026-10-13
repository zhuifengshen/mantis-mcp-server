import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness } from '../helpers/workflow.js';
import type { Entity } from '../../src/services/projects.js';
import { Operations } from '../../src/workflow/operations.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => {
  h = await harness();
  Object.assign(h.rest.values, { reassign_on_feedback: 1, bug_feedback_status: 20, bug_assigned_status: 50 });
  Object.assign(h.rest.issues.get(1)!, { status: { id: 80 }, resolution: { id: 80 }, handler: undefined, history: [] });
});
afterEach(async () => { await h.cleanup(); });
const args = async () => ({ issue_id: 1, reason_code: 'resume_postponed', reason: '依赖已就绪',
  operation_id: randomUUID(), expected_revision: await h.revision() });
function simulateFeedback(alter?: (issue: Entity, note: Entity) => void, timeout = false) {
  h.rest.intercept = r => {
    if (r.method !== 'POST' || r.path !== 'issues/1/notes') return undefined;
    const response = h.rest.apply(r), issue = h.rest.issues.get(1)!, note = issue.notes.at(-1);
    const status = issue.handler?.id ? h.rest.values.bug_assigned_status : h.rest.values.bug_submit_status;
    note.created_at = issue.updated_at;
    issue.history.push({ type: { name: 'note-added' }, note: { id: note.id }, user: { id: 7 }, created_at: note.created_at },
      { type: { name: 'field-updated' }, field: { name: 'status' }, old_value: { id: 20 }, new_value: { id: status },
        user: { id: 7 }, created_at: note.created_at });
    issue.status = { id: status };
    alter?.(issue, note);
    if (timeout) throw new Error('备注成功后响应丢失');
    return response;
  };
}

describe('重开后报告者备注触发的官方反馈流转', () => {
  it.each([undefined, 8])('保留负责人 %s，接受项目实际新建/指派状态并展示服务端变化', async handler => {
    if (handler) h.rest.issues.get(1)!.handler = { id: handler };
    // 不能把 Demo 的10/50硬编码为允许状态。
    h.rest.values.bug_submit_status = 30;
    h.rest.values.bug_assigned_status = 40;
    simulateFeedback();
    const input = await args(), result = await h.executor.execute('reopen_issue', input);
    const status = handler ? 40 : 30;
    expect(result.outcome).toBe('succeeded');
    expect(result.result).toMatchObject({ issue: { status: { id: status }, resolution: { id: 30 } },
      server_side_changes: { status: { id: status } }, applied_server_rules: ['reassign_on_feedback'], expected_revision: expect.any(String) });
    expect(h.rest.writes().map(r => r.method)).toEqual(['PATCH', 'POST']);
    expect(h.rest.writes()[0].body).toEqual({ status: { id: 20 }, resolution: { id: 30 } });
    await h.executor.execute('reopen_issue', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(2);
  });

  const invalid: Array<[string, (issue: Entity, note: Entity) => void]> = [
    ['自动流转被禁用', () => { h.rest.values.reassign_on_feedback = 0; }],
    ['配置缺失', () => { delete h.rest.values.reassign_on_feedback; }],
    ['反馈状态不匹配', () => { h.rest.values.bug_feedback_status = 30; }],
    ['目标状态配置不匹配', () => { h.rest.values.bug_submit_status = 40; }],
    ['目标落入已解决区间', issue => { h.rest.values.bug_submit_status = 80; issue.status.id = 80; issue.history[1].new_value.id = 80; }],
    ['目标达到独立关闭阈值', () => { h.rest.values.bug_closed_status_threshold = 10; }],
    ['当前用户不是报告者', issue => { issue.reporter.id = 8; }],
    ['负责人后来被改动', issue => { issue.handler = { id: 8 }; }],
    ['结果同时变化', issue => { issue.resolution.id = 20; }],
    ['备注正文不符', (_issue, note) => { note.text += '被更改'; }],
    ['备注可见性不符', (_issue, note) => { note.view_state.name = 'private'; }],
    ['历史缺失', issue => { delete issue.history; }],
    ['备注历史重复', issue => { issue.history.push(issue.history[0]); }],
    ['不是本条备注的历史', issue => { issue.history[0].note.id = 999; }],
    ['状态历史由别人写入', issue => { issue.history[1].user.id = 8; }],
    ['状态历史不紧邻备注', issue => { issue.history.splice(1, 0, { type: { name: 'note-added' } }); }],
    ['状态历史不是同秒', issue => { issue.history[1].created_at = '2026-10-02T00:00:00Z'; }],
    ['状态历史原值不符', issue => { issue.history[1].old_value.id = 30; }],
    ['后来状态变化又回到相同编号', issue => { issue.history.push({ field: { name: 'status' }, old_value: { id: 10 }, new_value: { id: 30 } },
      { field: { name: 'status' }, old_value: { id: 30 }, new_value: { id: 10 } }); }],
  ];
  it.each(invalid)('%s时不将状态差异当成成功，也不重发', async (_name, alter) => {
    simulateFeedback(alter);
    const input = await args(), result = await h.executor.execute('reopen_issue', input);
    expect(result.outcome).toBe('partial_success');
    expect(result.error?.code).toBe('VERIFICATION_MISMATCH');
    expect(result.result?.expected_revision).toBeNull();
    expect((await h.executor.getOperation(input.operation_id)).outcome).toBe('partial_success');
    await h.executor.execute('reopen_issue', { ...input, resume: true });
    expect(h.rest.writes()).toHaveLength(2);
  });
  it.each(['非报告者', '报告者也是负责人'])('%s不接受相同的状态历史', async mode => {
    if (mode === '非报告者') h.rest.issues.get(1)!.reporter = { id: 8 };
    else h.rest.issues.get(1)!.handler = { id: 7 };
    simulateFeedback();
    expect((await h.executor.execute('reopen_issue', await args())).outcome).toBe('partial_success');
  });
  it('原部分成功操作可在升级后只读完成核查，无需迁移或重写计划', async () => {
    simulateFeedback();
    let unavailable = true;
    const simulate = h.rest.intercept!;
    h.rest.intercept = r => r.path === 'config' && r.url.searchParams.get('option[0]') === 'reassign_on_feedback' && unavailable
      ? h.rest.response({}, 503) : simulate(r);
    const input = await args();
    expect((await h.executor.execute('reopen_issue', input)).outcome).toBe('partial_success');
    const session = await h.context.projects.authenticate(), ledger = new Operations(session.dir);
    const before = await ledger.load(input.operation_id);
    unavailable = false;
    const checked = await h.executor.getOperation(input.operation_id);
    expect(checked.outcome).toBe('succeeded');
    expect(checked.result?.issue.status.id).toBe(10);
    expect((await ledger.load(input.operation_id))?.resolved_hash).toBe(before?.resolved_hash);
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('备注响应丢失后由唯一备注及自动流转历史只读核查完成', async () => {
    simulateFeedback(undefined, true);
    const input = await args();
    expect((await h.executor.execute('reopen_issue', input)).outcome).toBe('unknown');
    expect((await h.executor.getOperation(input.operation_id)).outcome).toBe('succeeded');
    expect(h.rest.writes()).toHaveLength(2);
  });
  it('PATCH未知即使外部状态相同仍不予确认', async () => {
    h.rest.intercept = r => { if (r.method === 'PATCH') { h.rest.apply(r); throw new Error('响应丢失'); } return undefined; };
    const input = await args();
    expect((await h.executor.execute('reopen_issue', input)).outcome).toBe('unknown');
    expect((await h.executor.getOperation(input.operation_id)).outcome).toBe('unknown');
    expect(h.rest.writes()).toHaveLength(1);
  });
});
