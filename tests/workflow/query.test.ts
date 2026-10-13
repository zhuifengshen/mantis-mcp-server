import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { harness, makeIssue } from '../helpers/workflow.js';
import { schemas } from '../../src/workflow/contracts.js';
import { queryIssues } from '../../src/workflow/query.js';
import { capabilitiesFor } from '../../src/workflow/adapter.js';
let h: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.cleanup(); });
const query = async (args = {}) => queryIssues(h.context, schemas.list_issues.parse({ project_id: 44, ...args }), await h.context.projects.authenticate(), h.capabilities);
describe('查询与上下文边界', () => {
  it('公开部署的2.26.2本人队列不依赖固定域名，也不被前500条他人缺陷截断', async () => {
    h.rest.issues.clear();
    for (let id = 1; id <= 600; id++) h.rest.issues.set(id, makeIssue(id, { handler: { id: id === 600 ? 7 : 8 } }));
    const session = await h.context.projects.authenticate();
    expect(session.baseUrl).toBe('https://mantis.invalid');
    const result = await queryIssues(h.context, schemas.list_issues.parse({ project_id: 44, assignee: 'me', queue: 'unresolved' }), session, capabilitiesFor(session));
    expect(result.items.map((i: any) => i.id)).toEqual([600]);
    expect(result.filter_execution.server).toBe('assigned');
    expect(h.rest.calls.filter(r => r.path === 'issues')).toHaveLength(1);
  });
  it.each(['不支持', '返回他人缺陷'])('原生本人筛选%s时仍降级到项目扫描', async mode => {
    h.rest.intercept = r => r.path === 'issues' && r.url.searchParams.get('filter_id') === 'assigned'
      ? mode === '不支持' ? h.rest.response({}, 400) : h.rest.response({ issues: [makeIssue(2, { handler: { id: 8 } })] })
      : undefined;
    const session = await h.context.projects.authenticate();
    const result = await queryIssues(h.context, schemas.list_issues.parse({ project_id: 44, assignee: 'me', queue: 'unresolved' }), session, capabilitiesFor(session));
    expect(result.items.map((i: any) => i.id)).toEqual([1]);
    expect(result.filter_execution.server).toBe('project');
    expect(result.warnings).toContain('NATIVE_FILTER_UNAVAILABLE');
    expect(h.rest.calls.filter(r => r.path === 'issues').map(r => r.url.searchParams.get('filter_id'))).toEqual(['assigned', null]);
  });
  it('500 条他人缺陷不影响原生本人队列，不逐条读详情', async () => {
    h.rest.issues.clear(); for (let id = 1; id <= 600; id++) h.rest.issues.set(id, makeIssue(id, { handler: { id: id === 600 ? 7 : 8 } }));
    const result = await query({ assignee: 'me', queue: 'unresolved' });
    expect(result.items.map((i: any) => i.id)).toEqual([600]); expect(result.scanned_count).toBe(1);
    expect(h.rest.calls.filter(r => r.path === 'issues')).toHaveLength(1);
    expect(h.rest.calls.some(r => /^issues\//.test(r.path))).toBe(false);
  });
  it('预算耗尽的空页保留游标，页内剩余匹配不丢失', async () => {
    h.rest.issues.clear(); for (let id = 1; id <= 520; id++) h.rest.issues.set(id, makeIssue(id, { handler: { id: id > 500 ? 7 : 8 } }));
    const first = await query({ assignee: 7, limit: 7 });
    expect(first.items).toHaveLength(0); expect(first.scan_limit_reached).toBe(true); expect(first.source_exhausted).toBe(false);
    const second = await query({ assignee: 7, limit: 7, cursor: first.next_cursor });
    expect(second.items.map((i: any) => i.id)).toEqual([501, 502, 503, 504, 505, 506, 507]);
    const third = await query({ assignee: 7, limit: 7, cursor: second.next_cursor });
    expect(third.items[0].id).toBe(508);
    await expect(query({ assignee: 8, limit: 7, cursor: second.next_cursor })).rejects.toMatchObject({ code: 'STALE_CURSOR' });
  });
  it('显式 filter 保留语义，延期与待验收按状态及结果共同区分', async () => {
    h.rest.issues.set(2, makeIssue(2, { status: { id: 80 }, resolution: { id: 80 } }));
    h.rest.issues.set(3, makeIssue(3, { status: { id: 80 }, resolution: { id: 20 } }));
    expect((await query({ queue: 'postponed' })).items.map((i: any) => i.id)).toEqual([2]);
    expect((await query({ queue: 'awaiting_verification' })).items.map((i: any) => i.id)).toEqual([3]);
    await query({ assignee: 'me', queue: 'unresolved', filter_id: 3 });
    expect(h.rest.calls.at(-1)?.url.searchParams.get('filter_id')).toBe('3');
  });
  it('未验收的原生路径显式降级，排序未经确认不作日期早停', async () => {
    h.capabilities.nativeAssigned = false;
    h.rest.issues.get(1)!.updated_at = '2025-01-01T00:00:00Z';
    h.rest.issues.set(2, makeIssue(2));
    const result = await query({ assignee: 'me', queue: 'unresolved', updated_after: '2026-01-01T00:00:00Z' });
    expect(result.items.map((i: any) => i.id)).toEqual([2]); expect(result.warnings).toContain('NATIVE_FILTER_UNAVAILABLE');
    expect(result.sort_execution).toBe('source_order_unverified');
  });
  it('按 Unicode 码点续读长正文，快照变化拒绝拼接', async () => {
    h.rest.issues.get(1)!.description = '测试😀'.repeat(3000);
    const session = await h.context.projects.authenticate();
    const first = await h.context.issue(schemas.get_issue_context.parse({ issue_id: 1, sections: ['description'], max_chars: 2000 }), session);
    expect(first.sections.description.complete).toBe(false);
    const cursor = first.sections.description.next_cursor;
    const second = await h.context.issue(schemas.get_issue_context.parse({ issue_id: 1, cursor, max_chars: 2000 }), session);
    expect(second.sections.description.items[0].text_offset).toBeGreaterThan(0);
    h.rest.issues.get(1)!.summary = '变更';
    await expect(h.context.issue(schemas.get_issue_context.parse({ issue_id: 1, cursor }), session)).rejects.toMatchObject({ code: 'STALE_CURSOR' });
  });
  it('配置读取失败与缺少绑定不会伪装空队列；区块失败单独报告', async () => {
    h.rest.intercept = r => r.path === 'config' ? h.rest.response({}, 403) : undefined;
    await expect(query({ queue: 'unresolved' })).rejects.toThrow();
    const result = await h.context.project(schemas.get_project_context.parse({ project_id: 44 }), await h.context.projects.authenticate());
    expect(result.sections.workflow.availability).toBe('unavailable');
    expect(result.sections.versions.availability).toBe('available');
    expect(result.supported_actions).not.toContain('close_issue');
  });
});
