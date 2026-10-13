# 迁移到 Workflow MCP 6.0

本包是基于 mantisbt-mcp-server 的工作流分支，不是公共 npm 上同名无 scope 包的升级。使用发布页和 README 中明确的 scope 包名与版本，避免安装到其他项目。

## 配置

1. 安装支持的 Node.js 与6.0包，将 MCP 客户端改为启动 `mantis-mcp-server` 或固定版本的 `npx` 命令。
2. 使用 `MANTIS_BASE_URL`、个人 `MANTIS_API_KEY`；基地址不包含 `index.php`，服务只使用 `/api/rest/` 和 stdio。
3. 复制并核对 `workflow-config.example.json`，设置 `MANTIS_WORKFLOW_CONFIG` 的绝对路径；状态和解决结果不是跨部署常量。
4. 删除旧 HTTP、语义搜索、模型下载及 `MANTIS_USE_INDEX_PHP` 配置。默认无需开启关闭/删除扩展。

源码开发时可以使用包根目录 `.env.local`；npm/npx 用户应使用环境变量，不要编辑安装目录或 npx 缓存中的文件。

## 工具变化

| 旧调用 | 6.0 调用 |
|---|---|
| `get_issue`、区块读取工具 | `get_issue_context` |
| 项目与枚举查询工具 | `get_project_context`，只读资源作为辅助 |
| `create_issue` | `report_issue`，明确填写预期/实际行为 |
| `update_issue` | `accept_issue`、`assign_issue`、`submit_fix`、`reopen_issue`、`reject_issue`、`postpone_issue` |
| 任意状态更新为关闭 | 可选 `close_issue`，需要测试验收事实 |
| `add_note.view_state` | `add_note.note_view_state` |
| 附件 Base64 输入 | `upload_file.file_path`，绝对路径的单个普通文件 |

`submit_fix` 需要 `self_test.result=passed` 及实际自测摘要；工具不会替调用者运行测试。延期使用独立映射与队列，恢复延期使用 `reopen_issue(reason_code="resume_postponed")`。

## 操作记录

真实写入必须带 UUID `operation_id`。修改已有缺陷先读取 `expected_revision`，版本修改先读取 `versions_revision`。记录过期、对象改变或部署绑定改变时重新核对。

`partial_success` 和 `unknown` 不能当作“没执行”。用原编号调用 `get_workflow_operation`；仅收到 `retry_same_operation` 时，以原参数和 `resume=true` 继续。主写入成功但回读失败时，证据不足的旧记录保持 `manual_review`，不能删除账本或换 UUID 绕过。

6.0前的无主体缓存不自动导入或删除。账本按实例、用户和凭据域隔离，换 Key、设备或丢失账本后不承诺重复抑制。

## 部署验证

使用已应用官方安全修复的 MantisBT，分别验证普通用户的允许与拒绝路径、自定义字段及工作流映射。上传为 JSON/Base64，确认完整请求体能够通过 Mantis、PHP 和代理限额。本包的40 MiB本地政策不是对任意部署上传能力的承诺。
