import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { digest } from './tokens.js';
import { WorkflowError, defaultTools, adminTools } from './contracts.js';

const positive = z.number().int().positive();
const targets = z.strictObject({ status_id: positive, resolution_id: positive });
const actions = z.strictObject({
  accept_issue: z.strictObject({ status_id: positive, assigned_status_id: positive, resolution: z.literal('preserve') }).nullable().optional(),
  submit_fix: targets.nullable().optional(),
  close_issue: z.strictObject({ status_id: positive, resolution: z.literal('preserve') }).nullable().optional(),
  reopen_issue: z.strictObject({ source: z.literal('project_reopen_config') }).nullable().optional(),
  reject_issue: z.strictObject({ status_id: positive, resolutions_by_reason: z.strictObject({ not_a_bug: positive, wont_fix: positive,
    cannot_reproduce: positive, cannot_fix: positive }) }).nullable().optional(),
  postpone_issue: targets.nullable().optional(),
});
const lifecycleNames = z.enum(['report_issue', 'accept_issue', 'assign_issue', 'submit_fix', 'close_issue', 'reopen_issue', 'reject_issue', 'postpone_issue']);
const layer = z.strictObject({ note_visibility: z.enum(['instance_default', 'public', 'private']).optional(), actions: actions.optional(),
  custom_fields_by_action: z.partialRecord(lifecycleNames, z.array(z.strictObject({ id: positive, required: z.boolean() }))
    .refine(list => new Set(list.map(f => f.id)).size === list.length, '字段编号重复')).optional() });
export const bindingSchema = z.strictObject({ schema_version: z.literal(1), defaults: layer.default({}),
  projects: z.record(z.string().regex(/^[1-9]\d*$/), layer).default({}) });
export type BindingConfig = z.infer<typeof bindingSchema>;
export type EffectiveBinding = ReturnType<Bindings['forProject']>;
export interface ProjectRules { values: Record<string, unknown>; enums: Record<string, Array<{ id: number; name: string; label?: string }>> }
export function numberConfig(rules: ProjectRules, name: string): number {
  const value = rules.values[name];
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', `项目配置 ${name} 不可用`);
  }
  return Number(value);
}
export function enumValue(rules: ProjectRules, key: string, id: number) {
  const value = rules.enums[key]?.find(e => e.id === id);
  if (!value) throw new WorkflowError('WORKFLOW_MAPPING_INVALID', `项目 ${key} 枚举不含所需编号 ${id}`);
  return value;
}
export class Bindings {
  readonly revision: string;
  constructor(readonly config: BindingConfig) { this.revision = digest(config); }
  static async load(path?: string): Promise<Bindings> {
    if (!path) return new Bindings(bindingSchema.parse({ schema_version: 1 }));
    try { return new Bindings(bindingSchema.parse(JSON.parse(await readFile(path, 'utf8')))); }
    catch { throw new WorkflowError('WORKFLOW_MAPPING_INVALID', 'MANTIS_WORKFLOW_CONFIG 无法读取或不符合严格配置 schema'); }
  }
  forProject(id: number) {
    const override = this.config.projects[String(id)];
    return { note_visibility: override?.note_visibility ?? this.config.defaults.note_visibility ?? 'instance_default',
      actions: { ...this.config.defaults.actions, ...override?.actions },
      custom_fields_by_action: { ...this.config.defaults.custom_fields_by_action, ...override?.custom_fields_by_action } };
  }
  target(projectId: number, action: string, rules: ProjectRules): Record<string, any> {
    const b = this.forProject(projectId).actions;
    let config: Record<string, any> | null | undefined = b[action as keyof typeof b];
    if (!config) throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', `项目未绑定 ${action}`);
    if (action === 'reopen_issue') config = { status_id: numberConfig(rules, 'bug_reopen_status'), resolution_id: numberConfig(rules, 'bug_reopen_resolution') };
    if (config.status_id) enumValue(rules, 'status', config.status_id);
    if (config.assigned_status_id) enumValue(rules, 'status', config.assigned_status_id);
    if (config.resolution_id) enumValue(rules, 'resolution', config.resolution_id);
    for (const value of Object.values(config.resolutions_by_reason ?? {})) enumValue(rules, 'resolution', Number(value));
    const threshold = numberConfig(rules, 'bug_resolved_status_threshold');
    if (['accept_issue', 'reopen_issue'].includes(action) && (config.status_id >= threshold || config.assigned_status_id >= threshold)
      || ['submit_fix', 'postpone_issue', 'reject_issue'].includes(action) && config.status_id < threshold) {
      throw new WorkflowError('WORKFLOW_MAPPING_INVALID', '动作目标与项目解决阈值冲突');
    }
    const closedThreshold = numberConfig(rules, 'bug_closed_status_threshold');
    if (action === 'close_issue' ? config.status_id < closedThreshold
      : config.status_id >= closedThreshold || config.assigned_status_id >= closedThreshold) {
      throw new WorkflowError('WORKFLOW_MAPPING_INVALID', '动作目标与项目关闭阈值冲突；只有验收关闭动作可进入关闭状态');
    }
    if (['reject_issue', 'postpone_issue'].includes(action)) {
      const fixed = b.submit_fix;
      if (!fixed || (config.status_id === fixed.status_id && [config.resolution_id, ...Object.values(config.resolutions_by_reason ?? {})].includes(fixed.resolution_id))) {
        throw new WorkflowError('WORKFLOW_MAPPING_INVALID', '非修复处置与修复映射缺失或冲突');
      }
      if (action === 'reject_issue') {
        const values = Object.values(config.resolutions_by_reason);
        if (new Set(values).size !== values.length) {
          throw new WorkflowError('WORKFLOW_MAPPING_INVALID', '拒绝原因映射重复');
        }
      }
      const rejected = b.reject_issue, postponed = b.postpone_issue;
      if (rejected && postponed && rejected.status_id === postponed.status_id
        && Object.values(rejected.resolutions_by_reason).includes(postponed.resolution_id)) {
        throw new WorkflowError('WORKFLOW_MAPPING_INVALID', '拒绝与延期结果映射冲突，两侧动作均不可用');
      }
    }
    return config;
  }
  availability(projectId: number, rules: ProjectRules | undefined, admin: boolean) {
    const supported: string[] = [], unconfigured: Array<{ action: string; error_code: string }> = [];
    for (const action of [...defaultTools, ...(admin ? adminTools : [])]) {
      const mapped = ['accept_issue', 'submit_fix', 'reopen_issue', 'reject_issue', 'postpone_issue', 'close_issue'].includes(action);
      const needsRules = mapped || ['report_issue', 'assign_issue', 'add_note'].includes(action);
      if (!needsRules) { supported.push(action); continue; }
      try {
        if (!rules) throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', '项目配置不可用');
        if (mapped) this.target(projectId, action, rules);
        if (action !== 'report_issue' && this.forProject(projectId).note_visibility === 'instance_default') {
          enumValue(rules, 'view_state', numberConfig(rules, 'default_bugnote_view_status'));
        }
        supported.push(action);
      } catch (e) { unconfigured.push({ action, error_code: e instanceof WorkflowError ? e.code : 'WORKFLOW_MAPPING_INVALID' }); }
    }
    return { supported_actions: supported, unconfigured_actions: unconfigured };
  }
}
