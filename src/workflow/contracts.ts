import { z } from 'zod';
import { RestError } from '../client.js';

export const id = z.number().int().positive().describe('正整数编号');
export const text = z.string().refine(v => v.trim().length > 0, '不可为空白').describe('非空正文');
const ref = z.union([z.literal('me'), id]).describe('当前用户 me 或明确的用户编号');
const iso = z.iso.datetime({ offset: true }).describe('含时区的 ISO8601 时间');
const evidence = z.array(z.strictObject({ kind: z.enum(['url', 'text']), value: text }));
const environment = { environment: text.optional(), version_id: id.optional() };
const validationContext = z.strictObject(environment).refine(v => v.environment || v.version_id, '须提供环境或版本');
const common = {
  operation_id: z.uuid().optional().describe('同一次执行及恢复保持不变的 UUID；真实写入必填'),
  dry_run: z.boolean().default(false).describe('只读预览，不验证写入权限'),
  resume: z.boolean().default(false).describe('恢复同一操作；不得变更原业务参数'),
  expected_revision: text.optional().describe('context 返回的并发前置标识；修改已有对象必填'),
};
const notes = { note_view_state: z.enum(['public', 'private']).optional().describe('备注可见性；缺省使用项目策略') };
const fields = { custom_fields: z.array(z.strictObject({ id, value: z.string() })).optional().describe('已登记的业务自定义字段') };
const issue = { ...common, issue_id: id };
const lifecycle = { ...issue, ...notes, ...fields };
const versionFields = { name: text.optional(), description: z.string().optional(), released: z.boolean().optional(),
  obsolete: z.boolean().optional(), timestamp: z.union([iso, z.iso.date()]).optional() };

export const schemas = {
  get_project_context: z.strictObject({ project_id: id.optional(),
    sections: z.array(z.enum(['categories', 'versions', 'members', 'filters', 'enums', 'workflow', 'custom_fields', 'uploads'])).optional(),
    member_query: text.optional(), limit: z.number().int().min(1).max(100).default(20), cursor: text.optional() }),
  list_issues: z.strictObject({ project_id: id, assignee: ref.optional(), reporter: ref.optional(),
    queue: z.enum(['unresolved', 'awaiting_verification', 'postponed']).optional(), filter_id: id.optional(),
    updated_after: iso.optional(), updated_before: iso.optional(), limit: z.number().int().min(1).max(100).default(20),
    cursor: text.optional() }).refine(v => !v.updated_after || !v.updated_before || Date.parse(v.updated_after) <= Date.parse(v.updated_before), '时间区间反向'),
  get_issue_context: z.strictObject({ issue_id: id, sections: z.array(z.enum(['description', 'notes', 'attachments', 'relationships', 'tags', 'monitors'])).optional(),
    max_chars: z.number().int().min(2000).max(80000).default(20000), cursor: text.optional(), previous_revision: text.optional() })
    .refine(v => !(v.cursor && v.previous_revision), '续读和版本比较不能同时使用'),
  get_workflow_operation: z.strictObject({ operation_id: z.uuid() }),
  report_issue: z.strictObject({ ...common, ...notes, ...fields, project_id: id, category_id: id, summary: text,
    description: text, expected_behavior: text, actual_behavior: text, steps_to_reproduce: text.optional(), environment: text.optional(),
    priority_id: id.optional(), severity_id: id.optional(), reproducibility_id: id.optional(), version_id: id.optional() }),
  accept_issue: z.strictObject({ ...lifecycle, reason: text, assignee: ref.optional(), priority_id: id.optional() }),
  assign_issue: z.strictObject({ ...lifecycle, assignee: ref, reason: text }),
  submit_fix: z.strictObject({ ...lifecycle, fix_summary: text,
    self_test: z.strictObject({ result: z.literal('passed'), summary: text, evidence: evidence.optional() }),
    root_cause: text.optional(), code_refs: z.array(z.strictObject({ type: z.enum(['commit', 'merge_request']), value: text })).optional(),
    fixed_in_version_id: id.optional() }),
  close_issue: z.strictObject({ ...lifecycle, verification: z.strictObject({ result: z.literal('passed'), summary: text,
    ...environment, evidence: evidence.optional() }).refine(v => v.environment || v.version_id, '须提供验收环境或版本') }),
  reopen_issue: z.strictObject({ ...lifecycle, reason_code: z.enum(['verification_failed', 'recurrence', 'resume_postponed']), reason: text,
    actual_behavior: text.optional(), verification_context: validationContext.optional(), evidence: evidence.optional() })
    .refine(v => v.reason_code === 'resume_postponed' || (v.actual_behavior && v.verification_context), '复测失败或复发须描述实际现象及验证环境'),
  reject_issue: z.strictObject({ ...lifecycle, reason_code: z.enum(['not_a_bug', 'wont_fix', 'cannot_reproduce', 'cannot_fix']), reason: text }),
  postpone_issue: z.strictObject({ ...lifecycle, reason: text, target_version_id: id.optional(), review_on: z.iso.date().optional() }),
  add_note: z.strictObject({ ...issue, ...notes, text }),
  upload_file: z.strictObject({ ...issue, file_path: text, filename: text.optional(), expected_file_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }),
  delete_issue: z.strictObject(issue),
  delete_note: z.strictObject({ ...issue, note_id: id }),
  remove_relationship: z.strictObject({ ...issue, relationship_id: id }),
  remove_monitor: z.strictObject({ ...issue, username: text }),
  detach_tag: z.strictObject({ ...issue, tag_id: id }),
  create_version: z.strictObject({ ...common, project_id: id, ...versionFields, name: text }),
  update_version: z.strictObject({ ...common, project_id: id, version_id: id, ...versionFields })
    .refine(v => Object.keys(versionFields).some(k => v[k as keyof typeof v] !== undefined), '至少提供一个版本字段'),
  release_version: z.strictObject({ ...common, project_id: id, version_id: id, timestamp: versionFields.timestamp, next_version: text.optional() }),
  delete_version: z.strictObject({ ...common, project_id: id, version_id: id }),
};
export type ToolName = keyof typeof schemas;
export type Input = Record<string, any>;
export const defaultTools = ['get_project_context', 'list_issues', 'get_issue_context', 'report_issue', 'accept_issue', 'assign_issue',
  'submit_fix', 'reopen_issue', 'reject_issue', 'postpone_issue', 'add_note', 'upload_file', 'get_workflow_operation'] as const;
export const adminTools = ['close_issue', 'delete_issue', 'delete_note', 'remove_relationship', 'remove_monitor', 'detach_tag',
  'create_version', 'update_version', 'release_version', 'delete_version'] as const;
export const readTools = new Set<ToolName>(['get_project_context', 'list_issues', 'get_issue_context', 'get_workflow_operation']);

export class WorkflowError extends Error {
  constructor(public code: string, message: string, public conflict = false) { super(message); }
}
export function problem(error: unknown): { code: string; message: string } {
  if (error instanceof WorkflowError) return { code: error.code, message: error.message };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: '输入不符合业务契约，请核对必填字段、类型及额外字段' };
  if (error instanceof RestError) return { code: error.status === 403 || error.status === 401 ? 'MANTIS_FORBIDDEN'
    : error.status === 404 ? 'NOT_FOUND_OR_NOT_VISIBLE' : error.status === 412 ? 'REVISION_CONFLICT'
      : !error.definiteRejection ? error.method === 'GET' ? 'SERVICE_UNAVAILABLE' : 'WRITE_OUTCOME_UNKNOWN' : 'MANTIS_REJECTED', message: error.message };
  return { code: 'SERVICE_UNAVAILABLE', message: '本地服务或读取不可用；未包含敏感错误正文' };
}
const record = z.record(z.string(), z.unknown());
export const stepSchema = z.strictObject({ name: z.string(), state: z.enum(['not_started', 'in_flight', 'succeeded', 'failed', 'unknown']),
  evidence: z.string().optional(), error_code: z.string().optional(), server_id: z.number().optional(),
  http_status: z.number().int().nullable().optional(), request_sent: z.boolean().optional() });
export type Step = z.infer<typeof stepSchema>;
export const writeOutput = z.strictObject({ schema_version: z.literal(1), action: z.string(), operation_id: z.string().nullable(),
  outcome: z.enum(['preview', 'in_progress', 'succeeded', 'rejected', 'conflict', 'partial_success', 'unknown']),
  subject: record, result: record.nullable(), steps: z.array(stepSchema), verification: record,
  recovery: z.strictObject({ action: z.enum(['none', 'retry_same_operation', 'read_again', 'manual_review']), automatic_retry: z.literal(false),
    tool: z.string().optional(), resume: z.boolean().optional(), resume_steps: z.array(z.string()).optional() }),
  warnings: z.array(z.string()), error: z.strictObject({ code: z.string(), message: z.string() }).optional(), plan: record.optional(),
  current_observation: record.optional() });
export type WriteResult = z.infer<typeof writeOutput>;
export const readOutput = z.object({ schema_version: z.literal(1), error: z.strictObject({ code: z.string(), message: z.string() }).optional() }).catchall(z.unknown());
const nullableCursor = z.string().nullable();
const queryResult = z.object({ schema_version: z.literal(1), items: z.array(record), returned_count: z.number().int().nonnegative(),
  scanned_count: z.number().int().min(0).max(500), matched_in_scan_count: z.number().int().nonnegative(), scan_limit_reached: z.boolean(),
  source_exhausted: z.boolean(), next_cursor: nullableCursor, filter_execution: record,
  sort_execution: z.enum(['verified_updated_desc', 'source_order_unverified']), warnings: z.array(z.string()),
  total_count: z.null(), snapshot_consistent: z.literal(false) });
const issueResult = z.object({ schema_version: z.literal(1), issue: record, sections: record, expected_revision: z.string(),
  revision_expires_at: z.iso.datetime(), revision_comparison: z.enum(['not_requested', 'unchanged', 'changed', 'unavailable']),
  concurrency_mode: z.enum(['snapshot_precheck', 'conditional_request']), supported_actions: z.array(z.string()), unconfigured_actions: z.array(record), warnings: z.array(z.string()) });
const projectResult = z.object({ schema_version: z.literal(1), current_user: record, extensions_enabled: z.boolean(),
  project: record.optional(), projects: record.optional(), sections: record.optional() }).refine(v => !!v.project !== !!v.projects);
export function readOutputFor(name: ToolName) {
  const success = name === 'list_issues' ? queryResult : name === 'get_issue_context' ? issueResult : name === 'get_project_context' ? projectResult : writeOutput;
  // 错误同样是 object；成功字段在处理器中强校验，避免 SDK 对 isError 跳过输出校验。
  return readOutput.refine(value => !!value.error || success.safeParse(value).success, '领域输出不符合工具契约');
}
export function failure(action: string, input: Input, error: unknown): WriteResult {
  const info = problem(error);
  return { schema_version: 1, action, operation_id: input.operation_id ?? null,
    outcome: error instanceof WorkflowError && error.conflict || info.code === 'REVISION_CONFLICT' ? 'conflict' : 'rejected',
    subject: { issue_id: input.issue_id ?? null, project_id: input.project_id ?? null }, result: null, steps: [],
    verification: { status: 'unverified', concurrency_mode: 'snapshot_precheck' }, recovery: { action: 'none', automatic_retry: false }, warnings: [], error: info };
}
