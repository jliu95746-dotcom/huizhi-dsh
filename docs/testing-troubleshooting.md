# 测试、验收和排错

## 测试层级

| 命令 | 验证范围 | 是否调用 DeepSeek API |
| --- | --- | --- |
| `npm test` | 任务字段、插件开关和装配、来源提取、周报输入与模板 | 否 |
| `npm run routing-demo` | 手机普通业务通过统一入口直接处理，虚构身份和数据 | 否 |
| `npm run routing-smoke` | 新入口转交真实 DSH 周报任务和手机自然语言，重复请求不重复调用模型 | 是 |
| `npm run doctor` | Ubuntu/Node、独立 profile、凭据文件、插件配置 | 否 |
| `npm run audit-profile` | DSH 实际组合后的 SDK 入口和默认模型工具禁用状态 | 否 |
| `node dist/src/cli.js plugins check` | 已启用外部插件的连接、工具名、输入输出声明和契约版本 | 否 |
| `npm run cancel-smoke` | 任务取消与 DSH 子进程回收 | 否 |
| `npm run employee-cancel-smoke` | 员工任务提交后取消并取得外部确认 | 是 |
| `npm run failure-smoke` | 工具报错、缺失插件、调用超时、插件进程退出时失败并清理进程 | 是 |
| `npm run provider-error-smoke` | 本机模拟 HTTP 401/429，验证 API 鉴权与限流失败路径 | 否；请求发往本机模拟服务 |
| `npm run parent-exit-smoke` | 父进程异常退出后 DSH 子进程跟随退出 | 否 |
| `node dist/src/cli.js run --input examples/echo-task.json` | 企业 profile 与真实模型 API | 是 |
| `node dist/src/cli.js run --input examples/report-task.json` | 真实模型调用报表 MCP 并生成 Markdown | 是 |
| `npm run smoke` | 四组模拟业务插件和报表在同一任务中组合 | 是 |

`npm run smoke` 会创建临时 DSH 目录，复制本机 DSH 凭据，测试结束后删除临时目录。它会发起真实 API 调用并产生费用。模拟文件、知识、待办和指标是虚构数据，只证明插件管线和任务隔离，不证明生产业务逻辑、权限或检索质量。

`provider-error-smoke` 使用临时独立运行目录，把模型请求指向 `127.0.0.1` 的模拟接口；模拟接口不记录请求头或密钥。401 应在一次请求后失败；429 可能按 DSH 自带策略重试，最终仍须报 `failed`，不能报 `completed`。该测试不验证真实 DeepSeek 平台的账号状态或限流额度。

`plugins check` 使用 `diagnostic` 测试身份调用各服务的 `describe_capability`。正式插件需允许该身份只读查看契约，或由主程序实际任务的启动前检查完成验收；每个任务会携带真实任务上下文再次检查所选服务。

验收时分别记录：命令退出码、`completed.toolCalls`、报表文件内容、报表来源、任务结束后是否残留 DSH/MCP 子进程。`HTTP 200`、测试通过和模型文字回答不能互相替代。

## 当前开发机结果（2026-09-27）

知识插件 P6 候选验收内核加入后，WSL Ubuntu x86_64 的 `npm test` 全量 **110/110 通过**；P6 PGlite 合成测试 **3/3 通过**。这只验证本仓库逻辑与迁移模拟，真实 WeKnora、企业身份、资料评测、备份恢复和生产试点尚未验收，见[P6 实施记录](weknora-p6-implementation.md)。下文 34 项与 15 项是较早的 DSH 基线记录，勿当成当前全量计数。

新增统一入口后，`npm test` 共 34 项通过，包含五类分流、插件别名与授权、可信上下文、复合步骤鉴权、并发请求、结果重放、写入后子进程崩溃保护、取消清理和新 CLI 接入。`routing-smoke` 已用真实 DeepSeek API 验证电脑周报插件任务、重复请求不重复调用模型、手机自然语言；普通保存路径的模型任务数为 0。原 `cancel-smoke` 回归通过。以下 15 项指扩展前的原 DSH 测试集；正式主程序、真实业务接口和其他电脑 Agent 仍需在其项目中接入验证。

Ubuntu WSL x86_64、Node.js `v22.22.1` 下，15 项自动测试通过；`doctor`、`audit-profile`、完整插件组合、取消、员工任务提交后外部取消确认、工具错误与超时、缺失插件、插件进程退出检查均通过。真实 DeepSeek API 的 CLI 纯文本模式返回了结果；本机模拟的 HTTP 401 和 429 均以 `failed` 结束。完整组合调用了四组模拟业务插件和报表插件，生成了带模拟来源的周报；无资料问答明确说明资料不足。父进程异常退出测试确认 DSH 子进程在 60 秒观察窗口内退出，遗留的私有补丁在后续 `setup` 中被清理。

这些结果只覆盖当前开发机及模拟业务数据。树莓派 Ubuntu ARM64、正式业务插件的权限与数据正确性、正式 HTTP MCP 端点仍待相应环境联调。

## 常见故障

- `credentials: false`：独立运行目录还没有凭据。确认 `~/.dsh/.credentials.yaml` 已按 DSH 官方方式配置，再运行 `npm run setup`。不要在命令行明文打印 Key。
- `插件未启用`：检查任务的 `capabilities` 和 `~/.dsh-huizhi/plugins.json`。默认四组外部能力关闭。
- `缺少环境变量`：`envFrom` 或 `headersFrom` 引用了部署机未设置的变量。检查变量名和服务部署，不把值写入项目文件。
- `initialize timed out`：检查 Node 版本、profile 一致性、WSL `/mnt/e` 文件系统的启动耗时，以及 DSH 子进程。当前首次启动可能较慢；项目给初始化留 120 秒。
- `cannot create effect on inactive context`：曾由本项目早期自定义策略插件引起，现已移除。若再次出现，先运行 `npm run doctor` 并检查运行目录 profile 是否与源码一致。
- 报表没生成：检查 `completed.toolCalls` 是否包含 `mcp__reports__create_weekly_report`、报表输入是否给每条内容带来源、输出目录权限是否可写。
- `cancelled` 或 `timed_out`：主程序可以重试幂等的查询任务；带写操作的外部插件需自行提供幂等键和状态查询，避免重试造成重复业务动作。

## 仍需外部验收

- 树莓派 Ubuntu ARM64 实机：`npm ci`、启动、一个真实 API 任务、一个插件任务、停止后的进程与文件权限。
- 其他团队的正式 MCP 服务：身份/组织权限、数据口径、故障和幂等联调。
- Streamable HTTP 路径已做配置校验测试，仍需在正式 MCP 端点上验证连接、认证和错误处理。
- 生产密钥的轮换、监控、预算和告警由部署方接入。

DSH 当前锁定 `0.1.5-rc.3`。升级版本时先在隔离环境复查 profile 的禁用工具和插件装配，再运行全部测试；不要直接把通过旧版本的结果视为新版本验收。
