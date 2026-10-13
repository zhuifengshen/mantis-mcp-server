# Mantis Workflow MCP Server

通过 MCP 将 MantisBT 缺陷处理接入 Coding Agent：查询缺陷、读取上下文、登记修复与自测、延期与重开、追加备注、上传附件，并按原操作编号核查和恢复部分成功的操作。服务使用本地 **stdio**，REST 路径为 `/api/rest/`。

[调用手册](docs/cookbook.md) · [场景示例](docs/examples.md) · [6.0 迁移说明](docs/migration-v6.md) · [GitHub Releases](https://github.com/zhuifengshen/mantis-mcp-server/releases)

## 安装

需要 Node.js 22.12+（22.x）、24.x 或26+，以及已启用 REST API 的 MantisBT 和个人 API Key。已验证 MantisBT 2.26.2 的工作流；部署方需使用已包含官方安全修复的服务端，并核对自身状态流转、枚举和权限配置。

通过 npm 安装固定版本：

```bash
npm install --global @youcloud/mantis-mcp-server@6.0.0
```

也可以从 GitHub Releases 下载 `.tgz` 及 `.sha256` 文件，核对摘要后安装。安装时需要联网下载生产依赖；无需自行编译 TypeScript。

```bash
npm install --global ./下载的安装包.tgz
```

安装后命令为 `mantis-mcp-server`。这是由 MCP 客户端启动的 stdio 服务，直接在终端运行会等待协议输入。

## 配置凭据与业务映射

在启动 MCP 客户端的环境中设置 `MANTIS_BASE_URL` 和 `MANTIS_API_KEY`。基地址示例为 `https://mantis.example.org`，不要添加 `index.php`。API Key 使用当前操作者自己的账号权限，不写入仓库或共享配置文件。

将[工作流配置示例](docs/workflow-config.example.json)另存到稳定的绝对路径，例如 `/绝对路径/mantis-workflow.json`，核对项目状态、解决结果和必填业务字段后设置 `MANTIS_WORKFLOW_CONFIG`。示例中的编号是配置样例，不是对所有 Mantis 部署的假设。

| 环境变量 | 用途 |
|---|---|
| `MANTIS_BASE_URL` | Mantis 基地址 |
| `MANTIS_API_KEY` | 当前使用者的个人 Key |
| `MANTIS_WORKFLOW_CONFIG` | 动作绑定 JSON 的绝对路径；修改后重启服务 |
| `MANTIS_MCP_ENABLE_DESTRUCTIVE_TOOLS` | 默认 `false`；设为 `true` 后开放关闭、删除和版本管理，仍由 Mantis 授权 |
| `MANTIS_CACHE_DIR` | 本机账本与缓存目录，默认 `~/.cache/mantisbt-mcp` |
| `MANTIS_CACHE_TTL` | 展示缓存秒数，默认3600；写前始终实时读取 |
| `MANTIS_UPLOAD_DIR` | 可选的附件读取范围；按真实路径限制 |

没有凭据时可以发现工具，实际调用需要凭据。缺少业务映射的动作会明确拒绝。`supported_actions` 表示已配置能力，不是账号权限清单。

### Codex

在 `~/.codex/config.toml` 中添加以下配置。`env_vars` 转发环境变量名称；实际值来自启动 Codex 的环境，Key 不必写进 TOML。参见 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

```toml
[mcp_servers.mantis]
command = "npx"
args = ["-y", "@youcloud/mantis-mcp-server@6.0.0"]
env_vars = ["MANTIS_BASE_URL", "MANTIS_API_KEY", "MANTIS_WORKFLOW_CONFIG"]
startup_timeout_sec = 60
tool_timeout_sec = 180
```

已全局安装时，也可以将 `command` 改为 `mantis-mcp-server` 并移除 `args`。桌面客户端须能找到 Node.js/npm，且能读取上述环境；通过 nvm 安装 Node.js 时，可使用命令的绝对路径。

### 其他 MCP 客户端

支持 `mcpServers` JSON 配置的客户端可以使用以下命令配置，并通过该客户端的环境或凭据设置传入前述变量。变量插值方式由客户端定义，不假定所有客户端支持相同的 `${...}` 语法。

```json
{
  "mcpServers": {
    "mantis": {
      "command": "npx",
      "args": ["-y", "@youcloud/mantis-mcp-server@6.0.0"]
    }
  }
}
```

## 工具目录

| 分类 | 工具 |
|---|---|
| 默认只读 | `get_project_context`、`list_issues`、`get_issue_context`、`get_workflow_operation` |
| 默认业务写入 | `report_issue`、`accept_issue`、`assign_issue`、`submit_fix`、`reopen_issue`、`reject_issue`、`postpone_issue`、`add_note`、`upload_file` |
| 可选扩展 | `close_issue`、`delete_issue`、`delete_note`、`remove_relationship`、`remove_monitor`、`detach_tag`、`create_version`、`update_version`、`release_version`、`delete_version` |

默认13个工具，扩展启用后23个。提供5个提示词，包括 `fix-assigned-issues` 连续修复流程，以及 `mantis://me`、`mantis://projects`、`mantis://enums` 和项目资源模板。

## 使用与恢复

推荐流程：查询本人未解决缺陷 → `get_issue_context` → Agent 修改代码并自测 → `submit_fix`。只在自测实际通过后登记；研发提交修复不代表测试验收，默认由测试人员在 Mantis 中关闭。

真实写入提供独立 UUID `operation_id`，修改已有对象还需 context 返回的 `expected_revision`；版本修改使用 `versions_revision`。`dry_run=true` 仅预览，不证明写权限。

- `succeeded`：所有必要步骤及核查完成。
- `partial_success`：保留已成功步骤，按原编号核查，不重复已成功主写入。
- `unknown`：执行效果未知，不换 UUID 或盲目重发，先调用 `get_workflow_operation`。

只有返回 `retry_same_operation` 时，才用原工具、原参数和原编号加 `resume=true` 恢复。若主写入后首次回读失败，须匹配持久化的完整响应摘要才能补建恢复快照；并发变化或证据不足时返回 `manual_review`。

账本按实例、用户和凭据域隔离，恢复窗口为7天；目录0700、文件0600。账本包含恢复所需的原备注正文，不保存 API Key 或附件 Base64。查询有扫描预算和游标，不承诺数据库快照或精确总数；多次 REST 写入也不是原子事务。

## 附件与部署边界

一次上传一个普通文件，使用绝对路径；大小范围为1至41,943,040字节。具体扩展名见工具说明或项目 `uploads` 区块，目录和特殊文件不受支持。

REST 上传使用 JSON/Base64，编码后约增加三分之一体积。40 MiB 原文件仅 Base64 就需要55,924,056字节，还需加上 JSON 开销。Mantis、PHP 和反向代理的请求体限制须容纳实际请求；本地40 MiB政策不等于所有部署都支持该大小。上传结果未知时先核查原操作，不能直接重传。

不同项目的权限、必填字段和自定义工作流需在对应部署验收。通过工具发现或离线测试不代表线上写权限已通过验证。

## 开发与许可证

```bash
npm ci
npm run typecheck
npm test
npm run test:package
```

`test:package` 会构建、打包，并在独立目录仅安装生产依赖后通过真实命令入口验证13/23工具及 stdio 握手，输出安装包、SHA-256和验证记录到 `artifacts/`。贡献方式见 [CONTRIBUTING.md](https://github.com/zhuifengshen/mantis-mcp-server/blob/main/CONTRIBUTING.md)。

本项目基于 [Dominik Pesch 的 mantisbt-mcp-server](https://github.com/dpesch/mantisbt-mcp-server) 开发，保留 [MIT 许可证](LICENSE)及原作者版权声明。6.0 工具协议与上游旧版本不同，升级前请阅读迁移说明。
