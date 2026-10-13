import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, deployment } from '../helpers/workflow.js';
import { Bindings, bindingSchema, type BindingConfig } from '../../src/workflow/bindings.js';
import { schemas } from '../../src/workflow/contracts.js';
import { Context } from '../../src/workflow/context.js';
import { Executor } from '../../src/workflow/executor.js';
import { queryIssues } from '../../src/workflow/query.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.cleanup(); });
function configured(actions: BindingConfig['defaults']['actions']) {
  const bindings = new Bindings(bindingSchema.parse({ ...deployment,
    defaults: { ...deployment.defaults, actions: { ...deployment.defaults.actions, ...actions } } }));
  const context = new Context(h.context.projects, h.context.issues, bindings, false, h.context.version);
  return { bindings, context, executor: new Executor(context, h.capabilities),
    async revision() { return (await context.issue(schemas.get_issue_context.parse({ issue_id: 1 }), await context.projects.authenticate())).expected_revision; } };
}
describe('严格业务输入与部署绑定', () => {
  it.each(['submit_fix', 'reject_issue', 'postpone_issue'] as const)('%s 映射到关闭状态时零写入拒绝', async action => {
    const mapped = configured({ [action]: { ...deployment.defaults.actions![action], status_id: 90 } });
    const result = await mapped.executor.execute(action, { issue_id: 1, expected_revision: await mapped.revision(), operation_id: randomUUID(),
      ...(action === 'submit_fix' ? { fix_summary: '修复说明', self_test: { result: 'passed', summary: '合成验证' } }
        : action === 'reject_issue' ? { reason_code: 'not_a_bug', reason: '合成处置' } : { reason: '合成延期' }) });
    expect(result.error?.code).toBe('WORKFLOW_MAPPING_INVALID');
    expect(h.rest.writes()).toHaveLength(0);
    const context = await mapped.context.issue(schemas.get_issue_context.parse({ issue_id: 1 }), await h.context.projects.authenticate());
    expect(context.supported_actions).not.toContain(action);
    expect(context.supported_actions).not.toContain('close_issue');
  });
  it.each(['submit_fix', 'reject_issue', 'postpone_issue'] as const)('项目关闭阈值降到80时禁用共享映射 %s', async action => {
    h.rest.values.bug_closed_status_threshold = 80;
    const rules = await h.context.projects.rules(44);
    expect(() => h.context.bindings.target(44, action, rules)).toThrow('关闭阈值');
  });
  it.each(['accept_issue', 'reopen_issue'] as const)('关闭阈值低于解决阈值时 %s 也不能关闭缺陷', async action => {
    h.rest.values.bug_closed_status_threshold = 20;
    const rules = await h.context.projects.rules(44);
    expect(() => h.context.bindings.target(44, action, rules)).toThrow('关闭阈值');
  });
  it.each([70, 90, 40, 50])('延期与任一拒绝结果 %s 重叠时两侧均拒绝，队列和延期恢复不能使用歧义映射', async resolution => {
    const mapped = configured({ postpone_issue: { status_id: 80, resolution_id: resolution } });
    const session = await h.context.projects.authenticate(), rules = await h.context.projects.rules(44);
    for (const action of ['postpone_issue', 'reject_issue']) expect(() => mapped.bindings.target(44, action, rules)).toThrow();
    const result = await mapped.executor.execute('postpone_issue', { issue_id: 1, reason: '计划延期', operation_id: randomUUID(), expected_revision: await mapped.revision() });
    expect(result.error?.code).toBe('WORKFLOW_MAPPING_INVALID');
    h.rest.issues.get(1)!.status = { id: 80 }; h.rest.issues.get(1)!.resolution = { id: resolution };
    await expect(queryIssues(mapped.context, schemas.list_issues.parse({ project_id: 44, queue: 'postponed' }), session, h.capabilities)).rejects.toMatchObject({ code: 'WORKFLOW_MAPPING_INVALID' });
    const resumed = await mapped.executor.execute('reopen_issue', { issue_id: 1, reason_code: 'resume_postponed', reason: '恢复处理', operation_id: randomUUID(), expected_revision: await mapped.revision() });
    expect(resumed.error?.code).toBe('WORKFLOW_MAPPING_INVALID');
    expect(h.rest.writes()).toHaveLength(0);
  });
  it('关闭扩展仍可使用关闭目标；显式禁用拒绝后延期不再产生该映射冲突', async () => {
    const mapped = configured({ reject_issue: null, postpone_issue: { status_id: 80, resolution_id: 70 } });
    const rules = await h.context.projects.rules(44);
    expect(mapped.bindings.target(44, 'close_issue', rules).status_id).toBe(90);
    expect(mapped.bindings.target(44, 'postpone_issue', rules).resolution_id).toBe(70);
  });
  it('未知字段、伪造身份、失败自测与 duplicate 在 schema 拒绝', () => {
    const base = { project_id: 44, category_id: 1, summary: '标题', description: '现象', expected_behavior: '预期', actual_behavior: '实际' };
    for (const key of ['status', 'resolution', 'reporter', 'fields', 'handler']) expect(schemas.report_issue.safeParse({ ...base, [key]: {} }).success).toBe(false);
    expect(schemas.report_issue.safeParse({ ...base, custom_fields: [{ id: 1 }] }).success).toBe(false);
    expect(schemas.reject_issue.safeParse({ issue_id: 1, reason_code: 'duplicate', reason: '重复' }).success).toBe(false);
    for (const key of ['content', 'description', 'content_type', 'note_view_state', 'custom_fields']) expect(schemas.upload_file.safeParse({ issue_id: 1, file_path: '/tmp/a.txt', [key]: 'x' }).success).toBe(false);
  });
  it('按动作整体替换，null 禁用；配置无数字兜底或权限/脚本逃生口', async () => {
    const bindings = new Bindings(bindingSchema.parse({ ...deployment, projects: { '44': { actions: { submit_fix: null } } } }));
    const rules = await h.context.projects.rules(44);
    expect(() => bindings.target(44, 'submit_fix', rules)).toThrow();
    expect(bindings.target(45, 'submit_fix', rules)).toEqual({ status_id: 80, resolution_id: 20 });
    for (const bad of [{ roles: {} }, { script: 'run' }, { url: 'https://external.invalid' }, { transitions: {} }]) expect(bindingSchema.safeParse({ ...deployment, ...bad }).success).toBe(false);
    const empty = await Bindings.load(); expect(() => empty.target(44, 'submit_fix', rules)).toThrow();
  });
  it('枚举冲突、项目重开配置缺失零写入', async () => {
    delete h.rest.values.bug_reopen_status;
    const revision = await h.revision();
    const result = await h.executor.execute('reopen_issue', { issue_id: 1, expected_revision: revision, operation_id: randomUUID(), reason_code: 'recurrence', reason: '复发', actual_behavior: '再次出现', verification_context: { environment: '测试环境' } });
    expect(result.error?.code).toBe('WORKFLOW_MAPPING_UNCONFIGURED'); expect(h.rest.writes()).toHaveLength(0);
  });
  it('预览无写入账本，创建不接收任意必填自定义字段', async () => {
    const preview = await h.executor.execute('accept_issue', { issue_id: 1, reason: '有效', dry_run: true });
    expect(preview.outcome).toBe('preview'); expect(preview.plan?.note).toMatchObject({ view_state: { name: 'public' } });
    expect(preview.operation_id).toBeTruthy(); expect(h.rest.writes()).toHaveLength(0);
    const result = await h.executor.execute('report_issue', { project_id: 44, category_id: 1, summary: '标题', description: '原文', expected_behavior: '预期', actual_behavior: '实际', custom_fields: [{ id: 99, value: '' }], operation_id: randomUUID() });
    expect(result.error?.code).toBe('INVALID_INPUT'); expect(h.rest.writes()).toHaveLength(0);
  });
});
