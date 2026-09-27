# 外部 MCP 插件契约 v1

`knowledge` 业务插件由本项目按阶段开发；文件、员工任务和 BI 插件由对应团队实现。本项目负责选择和连接插件，并提供 `huizhi-dsh plugins check` 自动验收。该命令连接 `plugins.json` 中已启用的外部 MCP 服务，读取工具列表并调用只读的 `describe_capability`；不调用 DeepSeek API，也不提交业务写操作。

每个服务的 MCP server `version` 使用语义版本，例如 `1.0.0`。`describe_capability` 不接受参数，返回 JSON 对象：

```json
{ "contractVersion": 1, "capability": "files" }
```

`capability` 分别取 `files`、`knowledge`、`employeeTasks`、`bi`。所有工具都必须声明 `inputSchema` 和 `outputSchema`（object JSON Schema），且声明下表所列的必填字段与类型。工具名在服务内不能重复；未列出的额外工具会导致验收失败，避免未经审查的工具暴露给模型。额外字段可以扩充，但不得改变约定字段的意义。

| 插件 | 工具名 | 必填输入 | 必填输出 |
| --- | --- | --- | --- |
| files | `search_documents` | `query: string` | `items: array`, `sourceRef: string`, `version: string` |
| files | `read_document` | `path: string` | `content: string`, `sourceRef: string`, `version: string` |
| knowledge | `search_knowledge` | `query: string` | `hits: array`, `sourceRef: string`, `version: string` |
| employeeTasks | `list_tasks` | 无 | `tasks: array`, `sourceRef: string`, `version: string` |
| employeeTasks | `submit_task` | `title: string`, `idempotencyKey: string` | `externalTaskId: string`, `status: string`, `sourceRef: string`, `version: string` |
| employeeTasks | `get_task_status` | `externalTaskId: string` | `externalTaskId: string`, `status: string`, `sourceRef: string`, `version: string` |
| employeeTasks | `cancel_task` | `externalTaskId: string` | `externalTaskId: string`, `status: string`, `sourceRef: string`, `version: string` |
| bi | `list_metrics` | 无 | `metrics: array`, `sourceRef: string`, `version: string` |
| bi | `get_metrics` | `metricId: string` | `metricId: string`, `value: number`, `asOf: string`, `sourceRef: string`, `version: string` |

`sourceRef` 是调用方可再次定位的来源编号；`version` 是该条数据的版本，不是 MCP server 软件版本。文件和知识库服务应在 `items`/`hits` 内补充资源编号、引用位置、摘录及版本，供正式答案引用。BI 服务应补充指标定义、单位、时间口径和组织过滤条件。以上子字段的最终业务细节需要与负责团队联调冻结。

完整 DSH `knowledge` 插件以 WeKnora 为内部引擎，实施与验收遵循 [开发文档](weknora-development-plan.md)，证据字段与身份处理遵循 [技术文档的 MCP 适配约定](weknora-technical-design.md#13-mcp-适配与可信身份)。插件自己的治理/反馈 API 与页面不属于此面向模型的工具列表。该目标设计保持上表的工具名和必填字段：搜索外层 `version` 表示查询结果快照的数据版本，`hits` 内每条 `version` 表示准确的文档版本；外层 `sourceRef` 可解析到本次证据清单。新增字段仍需实现 Schema 和联调测试，当前契约检查通过不代表这些业务校验已经完成。

员工任务的 `submit_task` 必须按 `idempotencyKey` 去重，避免调用方重试造成重复提交。`cancel_task` 返回 `cancelled` 仅表示外部服务已确认取消；尚未确认时应返回可查询的中间状态。DSH 停止运行不等于外部任务已取消。

插件应对传入的任务上下文自行做身份与资源授权验证。stdio 插件从 `HUIZHI_TASK_CONTEXT_B64` 获取上下文；Streamable HTTP 插件从 `X-Huizhi-*` 请求头获取。模型输入里的姓名、组织或权限描述不得改变这份可信上下文。

`plugins check` 检查声明的格式与版本，无法证明真实业务数据正确，也不会主动调用有副作用的工具。其他团队接入时还需用授权测试账号核对实际工具结果、权限拒绝、超时、限流和幂等行为。
