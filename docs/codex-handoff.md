# Codex 协同开发交接

本文件是另一个开发同事及其 Codex 打开项目后的入口。先读根目录 [AGENTS.md](../AGENTS.md)，**确认被分配的工作属于主程序、某组业务插件，还是 DSH 执行层**，再按下文阅读对应接口。本文记录 2026-09-27 开发机状态；接手时应重新运行适用的检查，不能把旧结果当作新环境的验收。

## 1. 项目要做什么、做到哪里

企业智慧中枢的调用链是：**主程序 → 统一分流入口 → 普通业务／电脑 Agent／DSH 插件任务**。手机普通业务进入企业入口直接处理；手机自然语言交给 DSH；电脑普通业务由主程序或其他 Agent 处理；两端的 DSH 插件功能都必须交给 DSH。具体接口、权限和重复请求约定先看 [电脑与手机分流](command-routing.md)。MCP 是让 Agent 调用外部业务工具的协议。主程序和 DSH 计划运行在同一台 Ubuntu 设备上。

本项目已固定 DSH、SDK 和官方 MCP 插件版本为 `0.1.5-rc.3`，提供 CLI、供 Node.js 程序调用的 `runTask`、任务隔离、插件装配和检查、事件与结果、取消和超时处理，以及一个中文 Markdown 周报插件。`knowledge` 正式插件纳入本项目后续阶段开发，文件、员工任务和 BI 插件仍待对应团队实现；目前四组能力都只有契约、配置入口和模拟服务，正式运行配置中默认关闭。

原 DSH 的配置位于 Ubuntu `~/.dsh`，企业执行层使用独立的 `~/.dsh-huizhi`。首次 `setup` 会把已有 DSH 凭据复制到企业目录，原配置不改；两个目录可能含真实 API 凭据，不属于交接源码。

知识库专项已确认以完整 DSH `knowledge` 插件交付，WeKnora 是插件内部引擎：企业内部 100 名员工、10 人同时提问，首期为制度、合同、PDF、Word、扫描件和表格，模型能力通过 API 调用。插件负责治理、检索、反馈和管理入口，DSH 负责最终生成；模型侧沿用 `knowledge.search_knowledge` 契约。详细依据为 [开发文档](weknora-development-plan.md)、[技术文档](weknora-technical-design.md)、[P0 基线记录](weknora-p0-baseline.md)、[P1 实施记录](weknora-p1-implementation.md)、[P2 实施记录](weknora-p2-implementation.md)、[P3 实施记录](weknora-p3-implementation.md)、[P4 实施记录](weknora-p4-implementation.md)、[P5 实施记录](weknora-p5-implementation.md)和 [P6 实施记录](weknora-p6-implementation.md)。P1～P5 阶段内核及 P6 候选验收内核已开发，正式 WeKnora 适配、真实模型、资料评测、监控部署、主程序接线及正式试点尚未完成。

## 2. 十分钟阅读顺序

| 顺序 | 文件 | 读完应知道 |
| --- | --- | --- |
| 0 | [电脑与手机分流](command-routing.md) | 新入口、功能清单、可信来源、普通业务处理器、电脑 Agent、请求去重 |
| 1 | [主程序与插件接入契约](integration.md) | 任务 JSON、`runTask`、事件、结果、插件启用与身份传递 |
| 2 | [外部 MCP 插件契约 v1](plugin-contract-v1.md) | 四组插件必须提供的工具名、输入输出、版本与权限要求 |
| 3 | [任务样例](../examples/echo-task.json)、[报表样例](../examples/report-task.json)、[插件配置样例](../config/plugins.example.json) | 调用方具体提交什么、部署方具体配置什么 |
| 4 | [Ubuntu 安装与运行](ubuntu-setup.md) | Ubuntu 环境、两套配置、启动与回退 |
| 5 | [测试、验收和排错](testing-troubleshooting.md) | 哪些已验证、哪些调用付费 API、哪些仍待正式联调 |
| 知识库专项必读 | [WeKnora 开发文档](weknora-development-plan.md)、[WeKnora 技术文档](weknora-technical-design.md) | 已确认范围、任务、权限与版本、处理链路、证据接口和发布验收 |

需要追源码时，先看 `src/command-dispatcher.ts`（统一入口）、`src/command-contracts.ts`（命令和来源）、`src/operation-catalog.ts`（功能清单）、`src/request-ledger.ts`（持久化去重）。底层 DSH 在 `src/contracts.ts`、`src/runner.ts`；命令行在 `src/cli.ts`；插件验收在 `src/plugin-contract.ts`、`src/check-plugins.ts`。周报实现位于 `src/report.ts`、`src/report-mcp.ts`。`test/mock-business-mcp.ts` 只提供模拟数据。

## 3. 主程序如何对接

主程序先完成用户登录、组织归属和资源权限判断，然后提交版本为 `1` 的任务：`taskId`、`organizationId`、`requesterId`、可选 `authorizationRef`、`prompt`、`capabilities`。字段示例见 [任务样例](../examples/echo-task.json)；完整约束见 [接入契约](integration.md)。`authorizationRef` 是由可信调用方提供的引用，不能把模型文字当成授权依据，也不要把 API Key 放进任务 JSON。

主程序按新规则接入 `src/command-dispatcher.ts` 的 `createCommandDispatcher`；命令行使用 `dispatch --input ... --context ... --adapter ...`。主程序必须提供真实 `authorize`、`businessHandlers` 和电脑自然语言所需的 `desktopAgent`；入口不能代替业务鉴权。只有模型路径会调用底层 `runTask` 并创建独立 DSH 进程。普通业务路径不启动 DSH。模型结果保留答复、产物、工具和来源。输入校验可能直接抛错，执行中失败会发事件并抛错；必须同时处理异常和事件。

员工任务等写操作要使用业务服务的幂等键。若提交后取消，检查错误事件的 `externalStatus` 和 `externalTasks`；`pending_confirmation` 表示还须向业务服务查询，不能视为已取消。主程序应保存任务状态和产物引用，不能把 DSH 会话目录当成自己的任务队列。

## 4. 业务插件如何对接

四个能力名固定为 `files`、`knowledge`、`employeeTasks`、`bi`。每组是一个 MCP 服务，可用本机 `stdio` 或 Streamable HTTP 接入。正式服务必须提供 `describe_capability`，按 [插件契约](plugin-contract-v1.md) 声明工具及 JSON Schema 输入输出，并用收到的任务上下文在**服务端**再次检查身份、组织和资源权限。DSH 的字段格式检查不能替代业务授权。

插件团队交付服务后，部署方在 `~/.dsh-huizhi/plugins.json` 填写命令或端点，并启用对应能力；示例在 [配置样例](../config/plugins.example.json) 和 [接入契约](integration.md)。密钥通过 `envFrom` 或 `headersFrom` 引用部署环境变量，不写入项目文件。先运行 `node dist/src/cli.js plugins check` 检查连接、名称、版本和 Schema，再用带真实任务身份的调用验证授权允许与拒绝、数据来源、超时和幂等。独立的 `plugins check` 使用 `diagnostic` 身份，服务需允许其只读调用 `describe_capability`；实际任务还会按当次身份做启动前检查。

报表能力名是 `reports`，当前由本项目实现 `create_weekly_report`，输出中文 Markdown。它要求每条内容有 `sourceRefs`，但字段非空不等于事实已被核实；正式周报应使用可信业务插件的来源。新增报表格式可沿同一能力扩展，并需同步更新契约、测试和调用方。

## 5. 分工与联调顺序

| 负责方 | 负责内容 | 交给下一方的东西 |
| --- | --- | --- |
| 主程序团队 | 页面、登录、可信客户端来源、权限、调度、电脑 Agent 和业务服务 | 新入口的 command/context、authorize、businessHandlers、desktopAgent，稳定 requestId |
| 本项目知识插件团队 | 完整 `knowledge` 插件、WeKnora 内部引擎、治理/反馈/检索与服务端权限 | 插件包、MCP 端点、治理 API/页面、证据 Schema、版本与审计 |
| 其他业务插件团队 | 文件、员工任务、BI 服务及服务端权限 | MCP 服务命令或端点、工具 Schema、来源字段、错误与幂等语义 |
| DSH 执行层 | 统一入口、分流、请求去重、DSH profile、CLI/`runTask`、插件装配与周报 | 功能清单、分流/任务接口、插件验收结果、故障证据 |

建议先确认某一组插件的工具与权限语义，再接入其服务并跑 `plugins check`；通过后用一个授权任务、一个无权任务和一个故障任务联调。四组插件逐组完成，再验证组合任务。修改共同接口前先与主程序和插件负责方同步 `version`、字段、错误及回退方式；不要让各端自行猜测不一致的字段。

## 6. 当前验证范围与交接边界

开发机为 Windows 项目目录 `E:\慧智中枢项目`，在 WSL Ubuntu 中路径是 `/mnt/e/慧智中枢项目`，既有验证记录使用 Node.js `v22.22.1`。2026-09-27 本次文档更新已确认该目录为 Git 仓库；接手时用 `git status --short --branch` 核验当前分支和工作区，按实际授权获取远端地址与提交，不能沿用早期“不是 Git 仓库”的记录。给另一台机器交接时，请提供源码、文档、样例、`package.json` 和 `package-lock.json`，在 Ubuntu 上重新运行 `npm ci`；不要复制 `node_modules`、`dist`、`~/.dsh`、`~/.dsh-huizhi`、`.env` 或任何真实密钥。

已在 Ubuntu WSL x86_64 验证：扩展统一入口后的 34 项自动测试，以及新入口的真实模型周报路由、手机自然语言和重复请求保护。原 DSH 层还验证过企业 profile 工具禁用、四组模拟插件组合、资料不足回答、任务隔离、插件错误/超时/退出、模拟 HTTP 401/429、任务取消与员工外部取消、父进程异常退出后的子进程回收。详细命令和证据边界见 [测试文档](testing-troubleshooting.md)。正式主程序接线、真实电脑 Agent、业务插件权限和生产数据仍待各团队联调；树莓派 Ubuntu ARM64 目前没有实机，正式 HTTP MCP 端点也尚未联调。

## 7. 可直接发给接手 Codex 的起始任务

把下面文字复制给负责主程序或某组插件的 Codex，并将方括号内容换成实际职责：

> 你要对接“企业智慧中枢 DSH 执行层”，项目源码在你本机收到的 `慧智中枢项目` 目录。你的职责是【主程序 / files / knowledge / employeeTasks / bi / DSH 执行层】。先读 README.md、docs/codex-handoff.md、docs/command-routing.md，再读底层接口与插件契约。规则是手机业务统一进入企业入口，电脑普通业务走主程序或其他 Agent，DSH 插件功能两端都强制进入 DSH。主程序使用 createCommandDispatcher，接入真实 authorize、businessHandlers 和 desktopAgent，从已认证会话构造 source/身份；其他 Agent 的动作必须通过 executeAction。不要把旧 runTask 当作具备分流/去重的新入口。先检查已有实现与职责，列出缺口和验证计划再开发；完成后报告真实测试结果，区分模拟服务、模型 API、正式业务服务和 ARM64 实机。

涉及 `knowledge` 时同时加入：

> 先读根目录 AGENTS.md、docs/weknora-development-plan.md、docs/weknora-technical-design.md 和 docs/weknora-p0-baseline.md。知识库作为完整 DSH knowledge 插件交付，WeKnora 是内部引擎。按已确认的 100 人、10 并发及制度/合同混合文档范围工作，先核验当前阶段的实现证据。保持既有面向模型的 MCP 契约；插件治理 API 属于同一插件但不默认暴露给模型。执行服务端身份验证、文档权限、有效期和发布版本检查；每条证据保留准确来源。文档中的新增接口和数据表是目标设计，需按阶段实现和验证。
