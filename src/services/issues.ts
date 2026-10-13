import { MantisClient, buildIssueViewUrl } from '../client.js';
import { WorkflowError } from '../workflow/contracts.js';
import { minimalUser, type Entity } from './projects.js';

export class Issues {
  constructor(readonly client: MantisClient) {}
  async get(id: number) {
    const response = await this.client.request<Entity>('GET', `issues/${id}`);
    const issue = response.body?.issues?.find((i: Entity) => i.id === id) ?? response.body?.issue;
    if (!issue || issue.id !== id || !Number.isSafeInteger(issue.project?.id)) throw new WorkflowError('NOT_FOUND_OR_NOT_VISIBLE', '缺陷不存在、不可见或响应缺失归属');
    // MantisBT 2.26.2 的完整序列化在结尾移除空数组；这里恢复当前账号可见的空集合。
    // 不对 tags/monitors 推断可读性，也不适用于 select 投影视图。
    return { issue: issue as Entity, etag: response.headers.etag, emptyArraysOmitted: response.headers.mantisVersion === '2.26.2' };
  }
  async page(projectId: number, page: number, filter?: number | 'assigned'): Promise<Entity[]> {
    const body = (await this.client.request<Entity>('GET', 'issues', undefined, { params: { project_id: projectId, filter_id: filter, page, page_size: 100,
      select: 'id,summary,project,priority,severity,handler,reporter,status,resolution,updated_at' } })).body;
    if (!Array.isArray(body?.issues)) throw new WorkflowError('SERVICE_UNAVAILABLE', '缺陷列表响应不完整');
    return body.issues;
  }
}
export function visibleCollection(issue: Entity, key: string, emptyArraysOmitted: boolean): Entity[] | undefined {
  if (Array.isArray(issue[key])) return issue[key];
  if (!(key in issue) && emptyArraysOmitted && ['attachments', 'notes', 'relationships'].includes(key)) return [];
  return undefined;
}
export function facts(issue: Entity, baseUrl: string): Entity {
  const keys = ['id', 'summary', 'project', 'category', 'priority', 'severity', 'status', 'resolution', 'version', 'fixed_in_version', 'target_version', 'updated_at'];
  return { ...Object.fromEntries(keys.map(key => [key, issue[key] ?? null])), reporter: minimalUser(issue.reporter), handler: minimalUser(issue.handler),
    view_url: buildIssueViewUrl(baseUrl, issue.id) };
}
