import { describe, it, expect } from 'vitest';
import { registerPrompts } from '../../src/prompts/index.js';
import { MockMcpServer } from '../helpers/mock-server.js';
const make = (admin = false) => { const s = new MockMcpServer(); registerPrompts(s as never, admin); return s; };
describe('工作流提示词', () => {
  it('五个提示词只指向实际注册入口', () => {
    const server = make();
    expect(server.registeredPromptNames()).toHaveLength(5);
    for (const name of server.registeredPromptNames()) {
      const text = server.callPrompt(name, { project_id: '44', issue_id: '1', category: '测试', summary: '标题', description: '描述' }).messages[0].content.text;
      expect(text).not.toMatch(/\b(create_issue|update_issue|get_issue|get_issue_enums|list_projects|close_issue)\b/);
    }
  });
  it('连续修复明确授权、刷新和自测门槛，扩展开启后才提到关闭工具', () => {
    const args = { project_id: '44', max_issues: '3' };
    const text = make().callPrompt('fix-assigned-issues', args).messages[0].content.text;
    for (const expected of ['最多处理 3 条', 'passed', 'previous_revision', '第一页刷新', 'partial_success/unknown', '不例行重读', '不强制 Git 提交']) expect(text).toContain(expected);
    expect(make(true).callPrompt('fix-assigned-issues', args).messages[0].content.text).toContain('close_issue');
    expect(() => make().callPrompt('fix-assigned-issues', { max_issues: '-1' })).toThrow();
  });
  it('创建与附件分别报告结果；需求不自动变成缺陷', () => {
    const args = { project_id: '44', category: '测试', summary: '事实标题', description: '原始描述' };
    expect(make().callPrompt('create-bug-report', args).messages[0].content.text).toContain('附件失败或 unknown 不重复建单');
    expect(make().callPrompt('create-feature-request', args).messages[0].content.text).not.toContain('report_issue');
  });
});
