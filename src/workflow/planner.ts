import { Context } from './context.js';
import { enumValue, numberConfig, type ProjectRules } from './bindings.js';
import { WorkflowError, type Input } from './contracts.js';
import { digest } from './tokens.js';
import { operationMarker } from '../services/notes.js';
import { readUpload, type FileInfo } from '../services/files.js';
import { facts, visibleCollection } from '../services/issues.js';
import type { Entity, Session } from '../services/projects.js';

export interface Plan {
  project_id: number; issue_id?: number; version_id?: number; kind: 'issue' | 'version'; method: 'POST' | 'PATCH' | 'DELETE';
  path: string; body?: Entity; expected: Entity; primary: string; before_hash: string; before_facts: Entity;
  revision: Entity; etag?: string | null; note?: { text: string; view_state: { name: string } };
  file?: FileInfo; attachment_ids?: number[]; next_version?: string; unchanged_versions_hash?: string; binding: string;
}
const labels: Record<string, string> = { accept_issue: '受理缺陷', assign_issue: '指派缺陷', submit_fix: '登记修复及研发自测（待测试验收）',
  close_issue: '测试验收通过并关闭', reopen_issue: '重开缺陷', reject_issue: '拒绝本次缺陷处置', postpone_issue: '延期处理' };
export class Planner {
  constructor(private context: Context, private uploadDir?: string) {}
  private async version(project: number, id: number): Promise<string> {
    const version = (await this.context.projects.versions(project, true)).find(v => v.id === id);
    if (!version) throw new WorkflowError('PROJECT_MISMATCH', '版本不属于当前项目的可用版本');
    return version.name;
  }
  async prepare(action: string, input: Input, session: Session): Promise<{ plan: Plan; bytes?: Buffer }> {
    if (action.endsWith('_version')) return { plan: await this.versionPlan(action, input, session) };
    const c = this.context;
    const state = action === 'report_issue' ? undefined : await c.state(input.issue_id);
    const issue = state?.issue;
    const projectId = issue?.project.id ?? input.project_id;
    const project = await c.projects.get(projectId);
    const rules = state?.rules ?? (action === 'report_issue' ? await c.projects.rules(projectId) : undefined);
    const binding = c.bindingRevision(rules);
    if (input.expected_revision && issue) session.tokens.check(input.expected_revision, `issue:${issue.id}`, binding, issue);
    const plan: Plan = { project_id: projectId, issue_id: issue?.id, kind: 'issue', method: 'PATCH', path: `issues/${issue?.id}`,
      primary: 'update_issue', expected: {}, body: {}, before_hash: digest(issue ?? null), before_facts: issue ? facts(issue, session.baseUrl) : {},
      revision: issue ? c.revision(session, issue, binding, state?.etag) : {}, etag: state?.etag, binding };
    if (action === 'upload_file') {
      const file = await readUpload(input.file_path, input.filename, input.expected_file_sha256, this.uploadDir);
      const latest = (await c.issues.get(issue!.id)).issue;
      if (digest(latest) !== plan.before_hash) throw new WorkflowError('REVISION_CONFLICT', '读取附件期间缺陷发生变化', true);
      plan.method = 'POST'; plan.path += '/files'; plan.primary = 'upload_file'; plan.body = undefined;
      plan.file = file.info; plan.attachment_ids = visibleCollection(issue!, 'attachments', state!.emptyArraysOmitted)?.map((a: Entity) => a.id);
      if (!Array.isArray(plan.attachment_ids)) throw new WorkflowError('SERVICE_UNAVAILABLE', '无法取得附件比较基线');
      return { plan, bytes: file.bytes };
    }
    if (['delete_issue', 'delete_note', 'remove_relationship', 'remove_monitor', 'detach_tag'].includes(action)) {
      plan.method = 'DELETE'; plan.primary = action; plan.body = undefined;
      const target = action === 'delete_note' ? ['notes', 'note_id'] : action === 'remove_relationship' ? ['relationships', 'relationship_id']
        : action === 'remove_monitor' ? ['monitors', 'username'] : action === 'detach_tag' ? ['tags', 'tag_id'] : undefined;
      if (target) {
        const [section, key] = target;
        const entry = issue![section]?.find((v: Entity) => key === 'username' ? v.name === input[key] : v.id === input[key]);
        if (!entry) throw new WorkflowError('NOT_FOUND_OR_NOT_VISIBLE', '删除对象不属于该缺陷或当前不可见');
        plan.path += `/${section}/${encodeURIComponent(String(input[key]))}`;
        plan.expected = { removed_section: section, removed_id: input[key] };
        if (action === 'remove_monitor') {
          // 2.26.2 没有 DELETE monitors 路由；mc_issue_update 支持显式 monitors 集合。
          // 只移除已核对的目标，保留其余 ID，仍受完整快照前置检查保护。
          plan.method = 'PATCH'; plan.path = `issues/${issue!.id}`;
          plan.body = { monitors: issue!.monitors.filter((v: Entity) => v.id !== entry.id).map((v: Entity) => ({ id: v.id })) };
          plan.expected.remaining_monitor_ids = plan.body.monitors.map((v: Entity) => v.id);
        }
      }
      return { plan };
    }
    if (!rules) throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', '该动作依赖的项目配置不可读取');
    if (action === 'report_issue') {
      if (!project.categories?.some((v: Entity) => v.id === input.category_id)) throw new WorkflowError('PROJECT_MISMATCH', '分类不属于当前项目');
      plan.method = 'POST'; plan.path = 'issues'; plan.primary = 'create_issue';
      plan.body = { project: { id: projectId }, category: { id: input.category_id }, summary: input.summary,
        description: [input.description, `【预期行为】\n${input.expected_behavior}`, `【实际行为】\n${input.actual_behavior}`,
          ...(input.environment ? [`【环境】\n${input.environment}`] : [])].join('\n\n'),
        additional_information: operationMarker(input.operation_id) };
      if (input.steps_to_reproduce) plan.body.steps_to_reproduce = input.steps_to_reproduce;
      if (input.version_id) plan.body.version = { name: await this.version(projectId, input.version_id) };
    } else if (action === 'add_note') {
      plan.method = 'POST'; plan.path += '/notes'; plan.primary = 'append_note';
      plan.body = { text: `${input.text}\n\n${operationMarker(input.operation_id)}`, view_state: { name: this.noteVisibility(projectId, rules, input) } };
    } else {
      const target = action === 'assign_issue' ? {} : c.bindings.target(projectId, action, rules);
      if (action === 'accept_issue') {
        if (issue!.status?.id >= numberConfig(rules, 'bug_resolved_status_threshold')) throw new WorkflowError('INVALID_INPUT', '已解决缺陷须按实际原因重开后再受理');
        plan.body!.status = { id: input.assignee ? target.assigned_status_id : issue!.status?.id === target.assigned_status_id ? target.assigned_status_id : target.status_id };
      } else if (action !== 'assign_issue') {
        plan.body!.status = { id: target.status_id };
        if (target.resolution_id) plan.body!.resolution = { id: target.resolution_id };
      }
      if (action === 'reject_issue') plan.body!.resolution = { id: target.resolutions_by_reason[input.reason_code] };
      if (action === 'close_issue') {
        const fixed = c.bindings.target(projectId, 'submit_fix', rules);
        if (issue!.resolution?.id !== fixed.resolution_id) throw new WorkflowError('INVALID_INPUT', '验收关闭仅用于修复结果，不得关闭拒绝或延期问题');
      }
      if (action === 'reopen_issue' && input.reason_code === 'resume_postponed') {
        const postponed = c.bindings.target(projectId, 'postpone_issue', rules);
        if (issue!.status?.id !== postponed.status_id || issue!.resolution?.id !== postponed.resolution_id) throw new WorkflowError('INVALID_INPUT', '只有延期缺陷可使用恢复延期分支');
      }
      if (input.assignee) {
        const userId = input.assignee === 'me' ? session.user.id : input.assignee;
        if (!(await c.projects.members(projectId)).some(u => u.id === userId)) throw new WorkflowError('PROJECT_MISMATCH', '负责人不是当前可见项目成员');
        plan.body!.handler = { id: userId };
      }
      if (input.fixed_in_version_id) plan.body!.fixed_in_version = { name: await this.version(projectId, input.fixed_in_version_id) };
      if (input.target_version_id) plan.body!.target_version = { name: await this.version(projectId, input.target_version_id) };
      const verificationVersion = input.verification?.version_id ?? input.verification_context?.version_id;
      if (verificationVersion) await this.version(projectId, verificationVersion);
      const sections = [`【${labels[action]}】`];
      if (input.reason_code) sections.push(`处置类型：${input.reason_code}`);
      for (const [key, label] of Object.entries({ reason: '原因', fix_summary: '修复说明', root_cause: '根因', actual_behavior: '实际现象', review_on: '计划复查日期（不自动提醒）' })) {
        if (input[key]) sections.push(`${label}：${input[key]}`);
      }
      if (input.self_test) sections.push(`研发自测（调用者提供，MCP 未执行测试）：${input.self_test.summary}\n结果：passed`, ...this.evidence(input.self_test.evidence));
      if (input.verification) sections.push(`测试验收：${input.verification.summary}\n结果：passed`, `验收环境/版本：${JSON.stringify(input.verification.environment ?? input.verification.version_id)}`, ...this.evidence(input.verification.evidence));
      if (input.verification_context) sections.push(`验证环境/版本：${JSON.stringify(input.verification_context)}`);
      if (input.code_refs) sections.push(`代码引用：${JSON.stringify(input.code_refs)}`);
      sections.push(...this.evidence(input.evidence), operationMarker(input.operation_id));
      plan.note = { text: sections.join('\n\n'), view_state: { name: this.noteVisibility(projectId, rules, input) } };
    }
    for (const key of ['priority', 'severity', 'reproducibility']) {
      if (input[`${key}_id`]) { enumValue(rules, key, input[`${key}_id`]); plan.body![key] = { id: input[`${key}_id`] }; }
    }
    const registered = c.bindings.forProject(projectId).custom_fields_by_action;
    const allowed = registered[action as keyof typeof registered] ?? [];
    const provided = input.custom_fields ?? [];
    if (new Set(provided.map((f: Entity) => f.id)).size !== provided.length || provided.some((f: Entity) => !allowed.some(a => a.id === f.id))
      || allowed.some(f => f.required && !provided.some((p: Entity) => p.id === f.id))) throw new WorkflowError('INVALID_INPUT', '自定义字段未登记、重复或缺少必填值');
    if (provided.length) plan.body!.custom_fields = provided.map((f: Entity) => ({ field: { id: f.id }, value: f.value }));
    if (action !== 'add_note') plan.expected = { ...plan.body };
    return { plan };
  }
  private evidence(e?: Entity[]) { return (e ?? []).map(v => `证据（${v.kind}）：${v.value}`); }
  private noteVisibility(projectId: number, rules: ProjectRules, input: Input): string {
    if (input.note_view_state) return input.note_view_state;
    const policy = this.context.bindings.forProject(projectId).note_visibility;
    if (policy !== 'instance_default') return policy;
    const value = numberConfig(rules, 'default_bugnote_view_status');
    const name = enumValue(rules, 'view_state', value).name;
    if (!['public', 'private'].includes(name)) throw new WorkflowError('WORKFLOW_MAPPING_INVALID', '项目默认备注可见性无法可靠解析');
    return name;
  }
  private async versionPlan(action: string, input: Input, session: Session): Promise<Plan> {
    const c = this.context;
    await c.projects.get(input.project_id);
    const versions = await c.projects.versions(input.project_id);
    if (action !== 'create_version' && !versions.some(v => v.id === input.version_id)) throw new WorkflowError('PROJECT_MISMATCH', '版本不属于该项目，继承版本请使用所属项目编号');
    if (input.expected_revision) session.tokens.check(input.expected_revision, `versions:${input.project_id}`, c.bindings.revision, versions);
    const body: Entity = {};
    for (const key of ['name', 'description', 'released', 'obsolete', 'timestamp']) if (input[key] !== undefined) body[key] = input[key];
    if (action === 'release_version') { body.released = true; body.timestamp = input.timestamp ?? new Date().toISOString(); }
    return { kind: 'version', project_id: input.project_id, version_id: input.version_id,
      path: `projects/${input.project_id}/versions${action === 'create_version' ? '' : `/${input.version_id}`}`,
      method: action === 'create_version' ? 'POST' : action === 'delete_version' ? 'DELETE' : 'PATCH', primary: action,
      body: action === 'delete_version' ? undefined : body, expected: body, before_hash: digest(versions), before_facts: {},
      unchanged_versions_hash: digest(versions.filter(v => v.id !== input.version_id)),
      revision: session.tokens.revision(`versions:${input.project_id}`, c.bindings.revision, versions), binding: c.bindings.revision,
      next_version: input.next_version };
  }
}
