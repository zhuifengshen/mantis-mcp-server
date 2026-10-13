import { RestError } from '../client.js';
import { Context } from './context.js';
import { WorkflowError, type Input } from './contracts.js';
import { digest } from './tokens.js';
import { numberConfig } from './bindings.js';
import { facts } from '../services/issues.js';
import type { Entity, Session } from '../services/projects.js';

export interface AdapterCapabilities { nativeAssigned: boolean; verifiedUpdatedSort: boolean; conditionalRequests: boolean }
export const conservativeCapabilities: AdapterCapabilities = { nativeAssigned: false, verifiedUpdatedSort: false, conditionalRequests: false };

export async function queryIssues(context: Context, input: Input, session: Session, capabilities: AdapterCapabilities): Promise<Entity> {
  await context.projects.get(input.project_id);
  const rules = await context.projects.rules(input.project_id);
  const binding = context.bindingRevision(rules);
  const { cursor: _cursor, ...query } = input;
  const queryHash = digest(query);
  const c = input.cursor ? session.tokens.open(input.cursor) : undefined;
  if (c && (c.kind !== 'query_cursor' || c.subject !== `project:${input.project_id}` || c.query !== queryHash || c.binding !== binding)) {
    throw new WorkflowError('STALE_CURSOR', '列表游标与查询或项目配置不符');
  }
  const person = (value: unknown) => value === 'me' ? session.user.id : value;
  const assignee = person(input.assignee), reporter = person(input.reporter);
  const threshold = input.queue === 'unresolved' ? numberConfig(rules, 'bug_resolved_status_threshold') : undefined;
  const target = input.queue === 'awaiting_verification' ? context.bindings.target(input.project_id, 'submit_fix', rules)
    : input.queue === 'postponed' ? context.bindings.target(input.project_id, 'postpone_issue', rules) : undefined;
  const wantsNative = input.assignee === 'me' && input.queue === 'unresolved' && !input.filter_id;
  let native = c ? c.native === true : wantsNative && capabilities.nativeAssigned;
  let page = Number(c?.page ?? 1), offset = Number(c?.offset ?? 0);
  const warnings: string[] = ['DYNAMIC_SOURCE_NOT_SNAPSHOT'];
  if (wantsNative && !native) warnings.push('NATIVE_FILTER_UNAVAILABLE');
  let scanned = 0, matched = 0, exhausted = false;
  const items: Entity[] = [], seen = new Set<number>();
  while (scanned < 500 && items.length < input.limit) {
    let source: Entity[];
    try { source = await context.issues.page(input.project_id, page, input.filter_id ?? (native ? 'assigned' : undefined)); }
    catch (e) {
      if (native && !c && scanned === 0 && e instanceof RestError && [400, 404, 422].includes(e.status ?? 0)) {
        native = false; page = 1; offset = 0; warnings.push('NATIVE_FILTER_UNAVAILABLE'); continue;
      }
      if (!scanned) throw e;
      warnings.push('SOURCE_READ_FAILED'); break;
    }
    if (native && source.some(i => i.project?.id !== input.project_id || i.handler?.id !== session.user.id || !(i.status?.id < threshold!))) {
      if (c || scanned) throw new WorkflowError('NATIVE_FILTER_UNAVAILABLE', '原生筛选返回不符合契约，须从首页重新查询');
      native = false; warnings.push('NATIVE_FILTER_UNAVAILABLE'); continue;
    }
    if (!source.length) { exhausted = true; break; }
    for (; offset < source.length && scanned < 500 && items.length < input.limit; offset++) {
      const issue = source[offset]; scanned++;
      if (!Number.isSafeInteger(issue.id) || !Number.isSafeInteger(issue.project?.id) || !Number.isSafeInteger(issue.status?.id)
        || !Number.isSafeInteger(issue.resolution?.id)) throw new WorkflowError('SERVICE_UNAVAILABLE', '源列表缺少必需过滤字段，不能报告完整查询');
      if (issue.project.id !== input.project_id || assignee && issue.handler?.id !== assignee || reporter && issue.reporter?.id !== reporter) continue;
      if (threshold !== undefined && issue.status.id >= threshold) continue;
      if (target && (issue.status.id !== target.status_id || issue.resolution.id !== target.resolution_id)) continue;
      const date = Date.parse(issue.updated_at);
      if ((input.updated_after || input.updated_before) && !Number.isFinite(date)) throw new WorkflowError('SERVICE_UNAVAILABLE', '源列表缺少有效更新时间');
      if (input.updated_after && date < Date.parse(input.updated_after) || input.updated_before && date > Date.parse(input.updated_before)) continue;
      matched++;
      if (!seen.has(issue.id)) { items.push(facts(issue, session.baseUrl)); seen.add(issue.id); }
    }
    if (offset >= source.length) {
      if (source.length < 100) { exhausted = true; break; }
      page++; offset = 0;
    }
  }
  return { schema_version: 1, items, returned_count: items.length, scanned_count: scanned, matched_in_scan_count: matched,
    scan_limit_reached: scanned >= 500 && !exhausted, source_exhausted: exhausted,
    next_cursor: exhausted ? null : session.tokens.seal({ kind: 'query_cursor', subject: `project:${input.project_id}`, binding,
      query: queryHash, page, offset, native }),
    filter_execution: { server: input.filter_id ? 'saved_filter' : native ? 'assigned' : 'project', client: 'intersection', native_assigned_verified: native },
    sort_execution: native && capabilities.verifiedUpdatedSort ? 'verified_updated_desc' : 'source_order_unverified',
    warnings, total_count: null, snapshot_consistent: false };
}
