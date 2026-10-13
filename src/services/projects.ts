import { join } from 'node:path';
import { MantisClient } from '../client.js';
import type { ProjectRules } from '../workflow/bindings.js';
import { WorkflowError } from '../workflow/contracts.js';
import { Tokens } from '../workflow/tokens.js';
import { ScopedMetadataCache } from '../cache.js';

export type Entity = Record<string, any>;
export interface Session { user: { id: number; name: string; real_name?: string }; tokens: Tokens; dir: string; baseUrl: string; mantisVersion: string }
export const minimalUser = (v: Entity | undefined) => v ? { id: v.id, name: v.name, ...(v.real_name ? { real_name: v.real_name } : {}) } : null;
export class Projects {
  private subjectCache?: ScopedMetadataCache;
  constructor(readonly client: MantisClient, private cacheDir: string, private cacheTtl = 3600) {}
  async authenticate(): Promise<Session> {
    const response = await this.client.request<Entity>('GET', 'users/me');
    const user = minimalUser(response.body?.user ?? response.body);
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new WorkflowError('MANTIS_FORBIDDEN', '无法确认当前 API Key 身份');
    const domain = await this.client.getCredentialDomain();
    const dir = join(this.cacheDir, 'workflow', domain.instance, String(user.id), domain.credential);
    this.subjectCache = new ScopedMetadataCache(dir, this.cacheTtl);
    return { user, tokens: new Tokens(domain.key, user.id), dir,
      baseUrl: await this.client.getBaseUrl(), mantisVersion: response.headers.mantisVersion ?? 'unknown' };
  }
  async cacheDisplay(projectId: number, sections: Record<string, unknown>) {
    // 展示快照只作本机辅助；当前公共入口均实时确认可见性和区块读取，不用缓存掩盖失败。
    await this.subjectCache?.save(projectId, sections).catch(() => {});
  }
  async list(): Promise<Entity[]> {
    const body = (await this.client.request<Entity>('GET', 'projects')).body;
    if (!Array.isArray(body?.projects)) throw new WorkflowError('SERVICE_UNAVAILABLE', '项目列表响应不完整');
    const flatten = (items: Entity[]): Entity[] => items.flatMap(p => [p, ...flatten(p.subprojects ?? [])]);
    return [...new Map(flatten(body.projects).map(p => [p.id, p])).values()];
  }
  async get(projectId: number): Promise<Entity> {
    const body = (await this.client.request<Entity>('GET', `projects/${projectId}`)).body;
    const project = body?.projects?.find((p: Entity) => p.id === projectId) ?? body?.project;
    if (!project || project.id !== projectId) throw new WorkflowError('NOT_FOUND_OR_NOT_VISIBLE', '项目不存在或不可见');
    return project;
  }
  async versions(projectId: number, inherit = false): Promise<Entity[]> {
    const body = (await this.client.request<Entity>('GET', `projects/${projectId}/versions`, undefined, { params: { obsolete: 1, inherit: inherit ? 1 : 0 } })).body;
    if (!Array.isArray(body?.versions)) throw new WorkflowError('SERVICE_UNAVAILABLE', '项目版本响应不完整');
    if (!inherit) await this.subjectCache?.patchVersions(projectId, body.versions).catch(() => {});
    return body.versions;
  }
  async members(projectId: number): Promise<Entity[]> {
    const body = (await this.client.request<Entity>('GET', `projects/${projectId}/users`)).body;
    if (!Array.isArray(body?.users)) throw new WorkflowError('SERVICE_UNAVAILABLE', '项目成员响应不完整');
    return body.users.map(minimalUser) as Entity[];
  }
  async feedbackRules(projectId: number): Promise<Record<string, unknown>> {
    // 只用于回读时核查备注引起的自动流转，不改变旧操作的绑定或写入计划。
    const options = ['reassign_on_feedback', 'bug_feedback_status', 'bug_assigned_status', 'bug_submit_status',
      'bug_resolved_status_threshold', 'bug_closed_status_threshold'];
    const params: Record<string, string | number> = { project_id: projectId };
    options.forEach((option, index) => { params[`option[${index}]`] = option; });
    const body = (await this.client.request<Entity>('GET', 'config', undefined, { params })).body;
    if (!Array.isArray(body?.configs)) throw new WorkflowError('VERIFICATION_UNAVAILABLE', '无法核查项目反馈自动流转配置');
    return Object.fromEntries(body.configs.map((c: Entity) => [c.option, c.value]));
  }
  async rules(projectId?: number): Promise<ProjectRules> {
    const keys = ['status', 'resolution', 'priority', 'severity', 'reproducibility', 'view_state'];
    const options = [...keys.map(k => `${k}_enum_string`), 'bug_resolved_status_threshold', 'bug_closed_status_threshold',
      'bug_reopen_status', 'bug_reopen_resolution', 'bug_submit_status', 'default_bugnote_view_status'];
    const params: Record<string, string | number | undefined> = { project_id: projectId };
    options.forEach((option, index) => { params[`option[${index}]`] = option; });
    const body = (await this.client.request<Entity>('GET', 'config', undefined, { params })).body;
    if (!Array.isArray(body?.configs)) throw new WorkflowError('WORKFLOW_MAPPING_UNCONFIGURED', '项目配置响应不可用');
    const values = Object.fromEntries(body.configs.map((c: Entity) => [c.option, c.value]));
    const enums: ProjectRules['enums'] = {};
    for (const key of keys) {
      const value = values[`${key}_enum_string`];
      const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(entry => {
        const split = entry.indexOf(':'); return { id: Number(entry.slice(0, split)), name: entry.slice(split + 1) };
      }) : [];
      enums[key] = entries.filter(e => Number.isSafeInteger(e.id) && typeof e.name === 'string');
    }
    return { values, enums };
  }
}
