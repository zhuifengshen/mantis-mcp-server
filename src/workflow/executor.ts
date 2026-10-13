import { randomUUID } from 'node:crypto';
import { RestError } from '../client.js';
import { Context } from './context.js';
import { Planner, type Plan } from './planner.js';
import { Operations, type Operation } from './operations.js';
import { schemas, failure, WorkflowError, problem, type Input, type ToolName, type WriteResult } from './contracts.js';
import { digest } from './tokens.js';
import { facts, visibleCollection } from '../services/issues.js';
import { locateNote, operationMarker, textHash } from '../services/notes.js';
import { reserveUpload, readUpload } from '../services/files.js';
import type { Entity, Session } from '../services/projects.js';
import type { AdapterCapabilities } from './query.js';

/** 固定执行步骤；不自动重试写请求，不提供任意 REST 或 DAG 执行入口。 */
export class Executor {
  private planner: Planner;
  constructor(readonly context: Context, private capabilities: AdapterCapabilities, private uploadDir?: string) {
    this.planner = new Planner(context, uploadDir);
  }
  async execute(action: ToolName, raw: Input): Promise<WriteResult> {
    let input = raw, operation: Operation | undefined, ledger: Operations | undefined;
    let releaseOperation: (() => Promise<void>) | undefined, releaseTarget: (() => Promise<void>) | undefined, releaseUpload: (() => void) | undefined;
    try {
      input = schemas[action].parse(raw) as Input;
      if (!input.dry_run && !input.operation_id) throw new WorkflowError('INVALID_INPUT', '真实写入必须提供 operation_id');
      if (!input.dry_run && !['report_issue', 'create_version'].includes(action) && !input.expected_revision) throw new WorkflowError('INVALID_INPUT', '修改已有对象必须提供 expected_revision');
      if (input.dry_run && input.resume) throw new WorkflowError('INVALID_INPUT', '预览不能同时请求恢复');
      input = { ...input, operation_id: input.operation_id ?? randomUUID() };
      const session = await this.context.projects.authenticate();
      if (input.dry_run) {
        if (action === 'upload_file') releaseUpload = reserveUpload();
        const { plan } = await this.planner.prepare(action, input, session);
        return { ...failure(action, input, new Error()), outcome: 'preview', error: undefined,
          subject: { project_id: plan.project_id, issue_id: plan.issue_id ?? null }, plan: this.publicPlan(plan),
          warnings: ['PREVIEW_DOES_NOT_CHECK_WRITE_PERMISSION', 'CONCURRENCY_PRECHECK_ONLY'] };
      }
      ledger = new Operations(session.dir);
      const lock = await ledger.lock(`operation-${input.operation_id}`);
      if (!lock) return await this.busy(action, input, session, ledger);
      releaseOperation = lock;
      const { dry_run: _dry, resume: _resume, ...business } = input;
      const requestHash = digest({ action, business });
      operation = await ledger.load(input.operation_id) ?? undefined;
      if (operation && (operation.request_hash !== requestHash || operation.action !== action)) throw new WorkflowError('OPERATION_ID_REUSED', '此操作编号已用于不同动作或业务参数');
      if (!operation && input.resume) throw new WorkflowError('RECOVERY_UNAVAILABLE', '原操作记录不存在，禁止把恢复作为新操作执行');
      if (operation && ledger.expired(operation)) throw new WorkflowError('RECOVERY_UNAVAILABLE', '操作已超过七天恢复保留期，请人工核对');
      const target = operation ? operation.issue_id ? `issue-${operation.issue_id}` : `project-${operation.project_id}`
        : input.issue_id ? `issue-${input.issue_id}` : `project-${input.project_id}`;
      const targetLock = await ledger.lock(target);
      if (!targetLock) throw new WorkflowError('OPERATION_BUSY', '目标对象正由另一个本机操作处理，本次未发送写请求');
      releaseTarget = targetLock;
      let bytes: Buffer | undefined;
      if (operation) {
        const observed = await this.observe(operation, session);
        if (observed.restricted) return this.restricted(operation);
        if (operation.result?.outcome === 'succeeded') return { ...operation.result, current_observation: observed.public };
        if (operation.steps.some(s => s.state === 'in_flight')) {
          operation.steps.filter(s => s.state === 'in_flight').forEach(s => { s.state = 'unknown'; s.error_code = 'WRITE_OUTCOME_UNKNOWN'; });
        }
        await this.reconcile(operation, observed, session);
        // 恢复核查得到的步骤和写后快照必须先落盘，再允许发送剩余写入。
        await ledger.save(operation);
        if (operation.steps.every(s => s.state === 'succeeded')) return await this.finish(operation, session, ledger);
        if (!input.resume || operation.steps.some(s => s.state === 'unknown') || this.needsPrimarySnapshot(operation)) {
          return await this.finish(operation, session, ledger, observed.public);
        }
        const currentBinding = operation.plan.kind === 'version' ? this.context.bindings.revision : this.context.bindingRevision(await this.context.optionalRules(operation.project_id));
        if (currentBinding !== operation.binding || digest(observed.raw) !== (operation.after_hash ?? operation.plan.before_hash)) {
          throw new WorkflowError('RECOVERY_UNAVAILABLE', '绑定或对象已改变，不能继续原操作，请人工核对');
        }
        if (operation.steps[0].state !== 'succeeded' && !['report_issue', 'create_version'].includes(action)) {
          session.tokens.check(input.expected_revision, operation.plan.kind === 'version' ? `versions:${operation.project_id}` : `issue:${operation.issue_id}`, currentBinding, observed.raw);
        }
        if (action === 'upload_file' && operation.steps[0].state !== 'succeeded') {
          releaseUpload = reserveUpload();
          const file = await readUpload(input.file_path, input.filename, operation.plan.file.file_sha256, this.uploadDir);
          if (digest(file.info) !== digest(operation.plan.file)) throw new WorkflowError('FILE_CHANGED', '恢复时附件与已冻结摘要不符');
          bytes = file.bytes;
        }
      } else {
        if (action === 'upload_file') releaseUpload = reserveUpload();
        const prepared = await this.planner.prepare(action, input, session);
        bytes = prepared.bytes;
        const plan = prepared.plan;
        operation = { operation_id: input.operation_id, action, user_id: session.user.id, project_id: plan.project_id, issue_id: plan.issue_id,
          request_hash: requestHash, resolved_hash: digest(plan), binding: plan.binding, created_at: Date.now(), updated_at: Date.now(), plan,
          steps: [{ name: plan.primary, state: 'not_started' }, { name: 'verify_primary', state: 'not_started' },
            ...(plan.note ? [{ name: 'append_note', state: 'not_started' as const }] : []),
            ...(plan.next_version ? [{ name: 'create_next_version', state: 'not_started' as const }] : []),
            { name: 'verify_result', state: 'not_started' }] };
        await ledger.save(operation);
      }
      await this.run(operation, session, ledger, bytes);
      return await this.finish(operation, session, ledger);
    } catch (e) {
      if (operation && ledger && releaseTarget) {
        // 账本失败也必须保留已知步骤；任何在途写入都不能被降级为普通失败。
        const result = this.result(operation);
        result.error = problem(e);
        if (e instanceof WorkflowError && !operation.steps.some(s => ['in_flight', 'unknown'].includes(s.state))) {
          result.recovery = { action: 'manual_review', automatic_retry: false };
          if (!operation.steps.some(s => s.state === 'succeeded')) result.outcome = e.conflict ? 'conflict' : 'rejected';
        } else {
          result.warnings.push('LEDGER_OR_VERIFICATION_UNAVAILABLE');
          if (operation.steps.some(s => ['in_flight', 'unknown'].includes(s.state))) result.outcome = 'unknown';
          result.recovery = { action: 'manual_review', automatic_retry: false };
        }
        return result;
      }
      return failure(action, input, e);
    } finally {
      releaseUpload?.();
      await releaseTarget?.().catch(() => {});
      await releaseOperation?.().catch(() => {});
    }
  }
  private publicPlan(plan: Plan): Entity {
    return { fields: plan.body ?? null, note: plan.note ?? null, file: plan.file ?? null, ...plan.revision,
      concurrency_mode: this.capabilities.conditionalRequests && plan.etag ? 'conditional_request' : 'snapshot_precheck',
      next_version: plan.next_version ?? null };
  }
  private async busy(action: string, input: Input, session: Session, ledger: Operations): Promise<WriteResult> {
    const record = await ledger.load(input.operation_id);
    if (record) {
      const { dry_run: _d, resume: _r, ...business } = input;
      if (record.request_hash !== digest({ action, business })) return failure(action, input, new WorkflowError('OPERATION_ID_REUSED', '操作编号已用于不同请求'));
      const observed = await this.observe(record, session);
      if (observed.restricted) return this.restricted(record);
    }
    return { ...failure(action, input, new Error()), outcome: 'in_progress', error: undefined, steps: record?.steps ?? [],
      recovery: { action: 'read_again', automatic_retry: false } };
  }
  private result(record: Operation): WriteResult {
    const steps = record.steps;
    const uncertain = steps.some(s => ['unknown', 'in_flight'].includes(s.state));
    const done = steps.every(s => s.state === 'succeeded');
    const wrote = steps.some(s => s.state === 'succeeded' && !s.name.startsWith('verify_'));
    const conflict = steps.some(s => s.error_code === 'REVISION_CONFLICT');
    const needsSnapshot = this.needsPrimarySnapshot(record);
    const canResume = !uncertain && !conflict && !needsSnapshot && steps.some(s => s.state !== 'succeeded');
    const mode = this.capabilities.conditionalRequests && record.plan.etag ? 'conditional_request' : 'snapshot_precheck';
    return { schema_version: 1, action: record.action, operation_id: record.operation_id,
      outcome: uncertain ? 'unknown' : done ? 'succeeded' : wrote ? 'partial_success' : conflict ? 'conflict' : 'rejected',
      subject: { project_id: record.project_id, issue_id: record.issue_id ?? null }, result: record.result?.result ?? null,
      steps: steps.map(s => ({ ...s })), verification: { status: done ? 'matched' : 'unverified', scope: Object.keys(record.plan.expected), concurrency_mode: mode },
      recovery: { action: done ? 'none' : uncertain || conflict || needsSnapshot ? 'manual_review' : canResume ? 'retry_same_operation' : 'read_again',
        automatic_retry: false, ...(canResume ? { tool: record.action, resume: true, resume_steps: steps.filter(s => s.state !== 'succeeded').map(s => s.name) } : {}) },
      warnings: mode === 'snapshot_precheck' ? ['CONCURRENCY_PRECHECK_ONLY'] : [] };
  }
  private needsPrimarySnapshot(record: Operation): boolean {
    return record.steps[0].state === 'succeeded' && !record.after_hash
      && record.steps.slice(1).some(s => !s.name.startsWith('verify_') && s.state !== 'succeeded');
  }
  private restricted(record: Operation): WriteResult {
    return { ...this.result(record), result: null, recovery: { action: 'manual_review', automatic_retry: false },
      warnings: ['TARGET_NOT_VISIBLE_HISTORY_REDACTED'], verification: { status: 'unavailable' } };
  }
  private async observe(record: Operation, session: Session): Promise<{ restricted?: boolean; raw?: Entity | Entity[]; public: Entity }> {
    try {
      if (record.plan.kind === 'version' || !record.issue_id) {
        await this.context.projects.get(record.project_id);
        const versions = record.plan.kind === 'version' ? await this.context.projects.versions(record.project_id) : undefined;
        return { raw: versions, public: versions ? { versions } : { project_id: record.project_id } };
      }
      const state = await this.context.issues.get(record.issue_id);
      if (state.issue.project.id !== record.project_id) return { restricted: true, public: {} };
      return { raw: state.issue, public: { issue: facts(state.issue, session.baseUrl) } };
    } catch (e) {
      if (e instanceof RestError && e.status === 401) throw e;
      if (e instanceof RestError && [403, 404].includes(e.status ?? 0) || e instanceof WorkflowError && e.code === 'NOT_FOUND_OR_NOT_VISIBLE') return { restricted: true, public: {} };
      throw e;
    }
  }
  private async run(record: Operation, session: Session, ledger: Operations, bytes?: Buffer) {
    const plan = record.plan as Plan;
    for (const step of record.steps) {
      if (step.state === 'succeeded') continue;
      if (step.state === 'unknown' || step.state === 'in_flight') break;
      if (step.name.startsWith('verify_')) {
        try {
          await this.verify(record, session, step.name === 'verify_result');
          step.state = 'succeeded'; step.evidence = 'observed_target_state'; delete step.error_code;
        } catch (e) { step.state = 'failed'; step.error_code = problem(e).code; await ledger.save(record); break; }
        await ledger.save(record); continue;
      }
      step.state = 'in_flight'; delete step.error_code;
      await ledger.save(record);
      try {
        let method = plan.method, path = plan.path, body = plan.body;
        if (step.name === 'append_note' && plan.note) { method = 'POST'; path = `issues/${record.issue_id}/notes`; body = plan.note; }
        if (step.name === 'create_next_version') { method = 'POST'; path = `projects/${record.project_id}/versions`; body = { name: plan.next_version }; }
        if (step.name === 'upload_file') {
          if (!bytes) throw new RestError(null, false, true);
          body = { files: [{ name: plan.file!.filename, content: bytes.toString('base64'), type: plan.file!.content_type }] };
        }
        const response = await this.context.projects.client.request<Entity>(method, path, body, {
          ifMatch: method === 'PATCH' && this.capabilities.conditionalRequests ? plan.etag ?? undefined : undefined,
          ...(step.name === 'upload_file' ? { timeoutMs: 120000 } : {}) });
        step.state = 'succeeded'; step.evidence = 'confirmed_by_response';
        step.http_status = response.status; step.request_sent = response.requestSent;
        const responseId = step.name === 'append_note' ? response.body?.note?.id
          : plan.kind === 'version' ? response.body?.version?.id
            : response.body?.issue?.id ?? response.body?.issues?.[0]?.id ?? response.body?.id;
        if (Number.isSafeInteger(responseId)) step.server_id = responseId;
        if (step.name === 'create_issue') record.issue_id = step.server_id;
        if (step === record.steps[0] && (plan.note || plan.next_version)) {
          const targetId = plan.kind === 'version' ? plan.version_id ?? step.server_id : record.issue_id;
          const target = plan.kind === 'version' ? response.body?.version
            : (Array.isArray(response.body?.issues) ? response.body.issues.find((i: Entity) => i.id === targetId) : undefined) ?? response.body?.issue;
          // 只保留响应摘要并随成功步骤落盘；不能把稍后读到的对象冒充写入响应。
          if (target?.id === targetId && targetId !== undefined) record.primary_response_hash = digest(target);
        }
      } catch (e) {
        const definite = e instanceof RestError && e.definiteRejection;
        step.state = definite ? 'failed' : 'unknown'; step.error_code = problem(e).code;
        if (e instanceof RestError) { step.http_status = e.status; step.request_sent = e.requestSent; }
        await ledger.save(record); break;
      }
      // 成功响应先单独落盘，再读取快照；读失败不得抹掉已确认的写入。
      await ledger.save(record);
    }
  }
  private matches(actual: Entity, expected: Entity): boolean {
    return Object.entries(expected).every(([key, value]) => {
      if (key === 'custom_fields') return value.every((f: Entity) => actual.custom_fields?.some((v: Entity) => v.field?.id === f.field.id && v.value === f.value));
      if (key === 'timestamp') return /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? String(actual[key]).startsWith(value) : Math.floor(Date.parse(actual[key]) / 1000) === Math.floor(Date.parse(value) / 1000);
      if (value && typeof value === 'object') return value.id !== undefined ? actual[key]?.id === value.id : actual[key]?.name === value.name || actual[key] === value.name;
      return actual[key] === value;
    });
  }
  private async feedbackTransition(record: Operation, issue: Entity, note: Entity): Promise<boolean> {
    const plan = record.plan as Plan;
    const handler = issue.handler?.id ?? 0;
    if (record.action !== 'reopen_issue' || record.steps[0].state !== 'succeeded'
      || record.steps.find(s => s.name === 'verify_primary')?.state !== 'succeeded'
      || record.steps.find(s => s.name === 'append_note')?.state !== 'succeeded'
      || issue.reporter?.id !== record.user_id || plan.before_facts.reporter?.id !== record.user_id
      || handler === record.user_id || handler !== (plan.before_facts.handler?.id ?? 0)
      || !this.matches(issue, { ...plan.expected, status: issue.status }) || !Array.isArray(issue.history)) return false;

    // 唯一本条备注之后紧邻的同作者、同秒状态历史，才可归入官方反馈流转。
    // 后来再次变更状态/结果/负责人时不放宽核查，即使最终编号恰好相同。
    const history = issue.history as Entity[];
    const added = history.flatMap((event, index) => event.type?.name === 'note-added' && event.note?.id === note.id ? [index] : []);
    if (added.length !== 1) return false;
    const index = added[0], entry = history[index], transition = history[index + 1];
    const time = Date.parse(note.created_at);
    if (!Number.isFinite(time) || entry.user?.id !== record.user_id || Date.parse(entry.created_at) !== time
      || transition?.type?.name !== 'field-updated' || transition.field?.name !== 'status'
      || transition.user?.id !== record.user_id || Date.parse(transition.created_at) !== time
      || transition.old_value?.id !== plan.expected.status?.id || transition.new_value?.id !== issue.status?.id
      || history.slice(index + 2).some(event => ['status', 'resolution', 'handler_id', 'reporter_id', 'handler', 'reporter'].includes(event.field?.name))) return false;

    const rules = await this.context.projects.feedbackRules(record.project_id);
    const status = rules[handler === 0 ? 'bug_submit_status' : 'bug_assigned_status'];
    return rules.reassign_on_feedback === 1 && rules.bug_feedback_status === plan.expected.status?.id
      && typeof status === 'number' && Number.isSafeInteger(status) && status > 0 && status === issue.status?.id
      && typeof rules.bug_resolved_status_threshold === 'number' && status < rules.bug_resolved_status_threshold
      && typeof rules.bug_closed_status_threshold === 'number' && status < rules.bug_closed_status_threshold;
  }
  private checkPrimarySnapshot(record: Operation, current: Entity, versions?: Entity[]) {
    // 完整回读必须与当时响应一致；空响应、局部响应和旧账本都不能凭目标字段相符补建基线。
    if (!record.primary_response_hash || digest(current) !== record.primary_response_hash) {
      throw new WorkflowError('RECOVERY_UNAVAILABLE', '缺少匹配的主写入响应快照或对象已改变，不能继续原操作，请人工核对');
    }
    if (versions && digest(versions.filter(v => v.id !== current.id)) !== record.plan.unchanged_versions_hash) {
      throw new WorkflowError('RECOVERY_UNAVAILABLE', '其他版本已改变或缺少原始快照，不能继续原操作，请人工核对');
    }
  }
  private async verify(record: Operation, session: Session, final: boolean, recoverPrimary = false) {
    const plan = record.plan as Plan;
    let result: Entity;
    if (record.action === 'delete_issue') {
      try { await this.context.issues.get(record.issue_id!); throw new WorkflowError('VERIFICATION_MISMATCH', '删除响应成功但对象仍可读取'); }
      catch (e) { if (!(e instanceof RestError && e.status === 404)) throw e; }
      result = { deleted: true, issue_id: record.issue_id, expected_revision: null, revision_expires_at: null };
    } else if (plan.kind === 'version') {
      const versions = await this.context.projects.versions(record.project_id);
      const current = versions.find(v => v.id === (plan.version_id ?? record.steps[0].server_id));
      if (record.action === 'delete_version' ? !!current : !current || !this.matches(current, plan.expected)) throw new WorkflowError('VERIFICATION_MISMATCH', '版本回读与预期不符');
      if (recoverPrimary) this.checkPrimarySnapshot(record, current!, versions);
      if (final && plan.next_version) {
        const next = record.steps.find(s => s.name === 'create_next_version');
        if (!versions.some(v => v.id === next?.server_id && v.name === plan.next_version)) throw new WorkflowError('VERIFICATION_MISMATCH', '后续版本未核对');
      }
      record.after_hash = digest(versions);
      result = { version: current ?? null, versions_revision: session.tokens.revision(`versions:${record.project_id}`, plan.binding, versions).expected_revision };
    } else {
      if (!record.issue_id) throw new WorkflowError('VERIFICATION_UNAVAILABLE', '创建响应未返回可核对的缺陷编号');
      const { issue, etag, emptyArraysOmitted } = await this.context.issues.get(record.issue_id);
      if (issue.project.id !== record.project_id) throw new WorkflowError('PROJECT_MISMATCH', '写入后项目发生变化');
      let expectedMatched = true, feedbackTransition = false;
      if (plan.expected.removed_section) {
        const list = visibleCollection(issue, plan.expected.removed_section, emptyArraysOmitted)
          ?? (emptyArraysOmitted && ['monitors', 'tags'].includes(plan.expected.removed_section) && !(plan.expected.removed_section in issue) ? [] : undefined);
        if (!Array.isArray(list) || list.some((v: Entity) => (plan.expected.removed_section === 'monitors' ? v.name : v.id) === plan.expected.removed_id)) throw new WorkflowError('VERIFICATION_MISMATCH', '移除对象回读不符');
        if (plan.expected.remaining_monitor_ids && digest(list.map(v => v.id).sort()) !== digest([...plan.expected.remaining_monitor_ids].sort())) {
          throw new WorkflowError('VERIFICATION_MISMATCH', '关注人集合与预期不符');
        }
      } else expectedMatched = this.matches(issue, plan.expected);
      const note = plan.note ?? (record.action === 'add_note' ? plan.body : undefined);
      const noteIds: number[] = [];
      if (note && (final || record.action === 'add_note')) {
        const matching = locateNote(issue, record.operation_id, record.user_id, textHash(note.text));
        const allMarkers = (issue.notes ?? []).filter((n: Entity) => n.text?.includes(operationMarker(record.operation_id)));
        if (matching.length !== 1 || allMarkers.length !== 1) throw new WorkflowError('VERIFICATION_MISMATCH', '操作备注缺失、重复或正文/作者不符');
        if (matching[0].view_state?.name !== note.view_state.name) throw new WorkflowError('VERIFICATION_MISMATCH', '备注回读可见性与明确请求不符，禁止降级或重发');
        const responseNoteId = record.steps.find(s => s.name === 'append_note')?.server_id;
        if (responseNoteId !== undefined && matching[0].id !== responseNoteId) throw new WorkflowError('VERIFICATION_MISMATCH', '备注回读编号与响应不符');
        noteIds.push(matching[0].id);
        if (final && !expectedMatched) feedbackTransition = await this.feedbackTransition(record, issue, matching[0]);
      }
      if (!expectedMatched && !feedbackTransition) throw new WorkflowError('VERIFICATION_MISMATCH', '缺陷回读与预期字段不符');
      let attachment: Entity | undefined;
      if (plan.file) {
        const candidates = (issue.attachments ?? []).filter((a: Entity) => !plan.attachment_ids!.includes(a.id) && a.size === plan.file!.size);
        const original = plan.file.filename, dot = original.lastIndexOf('.');
        const renamed = (name: string) => {
          if (name === original) return true;
          const prefix = original.slice(0, dot), suffix = original.slice(dot);
          if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
          const counter = name.slice(prefix.length, name.length - suffix.length);
          return /^-[1-9]\d*$/.test(counter) && Number(counter.slice(1)) >= 2;
        };
        const matches = candidates.filter((a: Entity) => renamed(a.file_name ?? a.filename ?? ''));
        if (matches.length !== 1) throw new WorkflowError('VERIFICATION_UNAVAILABLE', '附件候选不能唯一归因，请只读核查，禁止重新上传');
        const file = matches[0];
        attachment = { id: file.id, filename: file.file_name ?? file.filename, size: file.size, requested_filename: original,
          server_renamed: (file.file_name ?? file.filename) !== original,
          download_url: `${session.baseUrl}/file_download.php?file_id=${file.id}&type=bug` };
      }
      if (recoverPrimary) this.checkPrimarySnapshot(record, issue);
      record.after_hash = digest(issue);
      const minimal = facts(issue, session.baseUrl);
      const changes = Object.fromEntries(['status', 'resolution', 'handler'].filter(k => !(k in plan.expected) && digest(minimal[k]) !== digest(plan.before_facts[k])).map(k => [k, minimal[k]]));
      if (feedbackTransition) changes.status = minimal.status;
      result = { issue: minimal, issue_id: issue.id, view_url: minimal.view_url, ...this.context.revision(session, issue, plan.binding, etag),
        note_ids: noteIds, note_urls: noteIds.map(id => `${minimal.view_url}#bugnote${id}`), attachment: attachment ?? null, server_side_changes: changes,
        ...(feedbackTransition ? { applied_server_rules: ['reassign_on_feedback'] } : {}) };
    }
    record.result = { ...this.result(record), result };
  }
  private async finish(record: Operation, session: Session, ledger: Operations, observation?: Entity): Promise<WriteResult> {
    const result = this.result(record);
    const failed = record.steps.find(s => s.error_code);
    if (failed) result.error = { code: failed.error_code!, message: failed.http_status ? `Mantis 请求返回 HTTP ${failed.http_status}` : '步骤未完成，请按恢复指引核查' };
    if (observation) result.current_observation = observation;
    if (record.plan.note && record.steps[0].state === 'succeeded' && record.steps.some(s => s.name === 'append_note' && s.state !== 'succeeded')) result.warnings.push('STATE_UPDATED_NOTE_MISSING');
    // 不可靠的最终回读不能把主步骤后的旧标识当成新写入前置标识。
    if (result.outcome !== 'succeeded' && result.result) {
      result.result = { ...result.result, expected_revision: null, revision_expires_at: null, versions_revision: null };
    }
    record.result = result;
    if (result.outcome === 'succeeded') record.completed_at ??= Date.now();
    await ledger.save(record);
    return result;
  }
  private async reconcile(record: Operation, observed: { raw?: Entity | Entity[]; public: Entity }, session: Session) {
    const issue = observed.raw as Entity | undefined;
    // PATCH、DELETE、附件的响应未知不能仅凭当前值相同认定本次操作成功。
    for (const step of record.steps) {
      if (step.name !== 'append_note' || step.state !== 'unknown' || !issue) continue;
      const note = record.plan.note ?? record.plan.body;
      const matches = locateNote(issue, record.operation_id, record.user_id, textHash(note.text));
      const markers = (issue.notes ?? []).filter((n: Entity) => n.text?.includes(operationMarker(record.operation_id)));
      if (matches.length === 1 && markers.length === 1) { step.state = 'succeeded'; step.server_id = matches[0].id; step.evidence = 'confirmed_by_operation_marker'; delete step.error_code; }
    }
    const primary = record.steps[0];
    if (record.action === 'report_issue' && ['unknown', 'succeeded'].includes(primary.state) && !record.issue_id) {
      const candidates: Entity[] = [];
      let inspected = 0;
      for (let page = 1; page <= 5; page++) {
        const list = await this.context.issues.page(record.project_id, page);
        for (const candidate of list.filter(i => i.summary === record.plan.body.summary && i.reporter?.id === record.user_id).slice(0, 20 - inspected)) {
          inspected++;
          const current = (await this.context.issues.get(candidate.id)).issue;
          if (current.additional_information === operationMarker(record.operation_id) && this.matches(current, record.plan.expected)) candidates.push(current);
        }
        if (list.length < 100 || inspected >= 20) break;
      }
      if (candidates.length === 1) {
        record.issue_id = candidates[0].id; primary.state = 'succeeded'; primary.server_id = record.issue_id;
        primary.evidence = 'confirmed_by_operation_marker'; delete primary.error_code;
      }
    }
    const primaryVerification = record.steps.find(s => s.name === 'verify_primary');
    if (this.needsPrimarySnapshot(record) && primaryVerification && primaryVerification.state !== 'succeeded') {
      // 补验必须匹配主写入响应；已有快照不能借此重置为后来变化的对象。
      try {
        await this.verify(record, session, false, true);
        primaryVerification.state = 'succeeded'; primaryVerification.evidence = 'observed_target_state';
        delete primaryVerification.error_code;
      } catch (error) {
        primaryVerification.state = 'failed'; primaryVerification.error_code = problem(error).code;
      }
    }
    if (record.steps.filter(s => !s.name.startsWith('verify_')).every(s => s.state === 'succeeded')) {
      try {
        await this.verify(record, session, true);
        record.steps.filter(s => s.name.startsWith('verify_')).forEach(s => { s.state = 'succeeded'; s.evidence = 'observed_target_state'; delete s.error_code; });
      } catch { /* 核对失败继续保留已有步骤，不触发写入。 */ }
    }
  }
  async getOperation(operationId: string): Promise<WriteResult | Entity> {
    const session = await this.context.projects.authenticate();
    const ledger = new Operations(session.dir);
    const release = await ledger.lock(`operation-${operationId}`);
    try {
      const record = await ledger.load(operationId);
      if (!record) throw new WorkflowError('RECOVERY_UNAVAILABLE', '当前主体没有该操作记录');
      const observed = await this.observe(record, session);
      if (observed.restricted) return this.restricted(record);
      if (record.result?.outcome === 'succeeded') return { ...record.result, current_observation: observed.public };
      if (!release) return { ...this.result(record), outcome: 'in_progress', recovery: { action: 'read_again', automatic_retry: false } };
      if (ledger.expired(record)) return { ...this.result(record), current_observation: observed.public,
        recovery: { action: 'manual_review', automatic_retry: false }, warnings: ['OPERATION_RETENTION_EXPIRED'] };
      record.steps.filter(s => s.state === 'in_flight').forEach(s => { s.state = 'unknown'; s.error_code = 'WRITE_OUTCOME_UNKNOWN'; });
      await this.reconcile(record, observed, session);
      if (record.action === 'upload_file' && observed.raw) {
        observed.public.attachment_candidates = ((observed.raw as Entity).attachments ?? []).filter((a: Entity) => !record.plan.attachment_ids.includes(a.id))
          .map((a: Entity) => ({ id: a.id, filename: a.file_name ?? a.filename, size: a.size }));
      }
      return await this.finish(record, session, ledger, observed.public);
    } finally { await release?.().catch(() => {}); }
  }
}
