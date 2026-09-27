# 电脑与手机指令分流：主程序接入约定

本模块把已经确认的分流规则实现为服务端函数和 CLI。手机业务操作统一经过企业入口；电脑普通业务由主程序或其他 Agent 执行；DSH 插件功能在两端都必须通过 DSH。主程序提供登录权限、可信设备来源、业务服务和电脑 Agent；本目录提供判断、执行封装、任务记录和重复请求保护。

## 执行路径

| 命令 | 来源 | 返回的 route | 行为 |
| --- | --- | --- | --- |
| 普通业务 action | desktop | `desktop_direct` | 调用已登记的业务处理器，不启动 DSH |
| 普通业务 action | mobile | `enterprise_direct` | 进入企业入口，再调用同一业务处理器，不启动 DSH |
| DSH 插件 action | 任意 | `enterprise_dsh` | 启动 DSH 模型任务并核对目标工具确实被调用 |
| 自然语言 instruction | mobile | `enterprise_dsh` | 交给 DSH，只开放本次授权的插件能力 |
| 自然语言 instruction | desktop | `desktop_agent` | 交给主程序接入的其他 Agent；其动作逐步重新分流 |

“经过企业入口”与“启动 DSH 模型”是两个步骤。手机保存表单等明确操作只经过前者。手机页面绘制、静态资源和登录认证仍由主程序完成。自然语言只能使用已经接入且获准的 DSH 插件；登记为普通业务处理器不会自动变成模型工具。

## 主程序需要接入的接口

主入口是 `src/command-dispatcher.ts` 的 `createCommandDispatcher`，编译后位于 `dist/src/command-dispatcher.js`。完整类型位于 `src/command-contracts.ts` 和 `src/command-dispatcher.ts`。

```js
const dispatcher = createCommandDispatcher(serverDependencies)
const result = await dispatcher.dispatchCommand(commandBody, trustedContext, {
  signal: abortController.signal,
  timeoutMs: 600000,
  onEvent: event => saveTaskEvent(event),
})
```

上例中的 `serverDependencies`、`abortController` 和 `saveTaskEvent` 由主程序提供。可运行示例见 [routing-demo-adapter.mjs](../examples/routing-demo-adapter.mjs)，其中只有虚构身份与模拟保存，不能直接用作正式鉴权。

| serverDependencies 字段 | 接入要求 |
| --- | --- |
| `stateDirectory` | 必填，专用的 Ubuntu 本地持久化目录，例如 `~/.dsh-huizhi/requests` 的绝对路径；所有主程序进程使用同一目录 |
| `catalog` | 用 `parseOperationCatalog` 读取 [功能配置样例](../config/operations.example.json)；省略时只有内置插件操作 |
| `authorize` | 必填，异步接收 `{ context, command, operation, route }`，返回 `{ allowed: boolean, capabilities?: Capability[] }`；检查用户、资源和实际操作权限 |
| `businessHandlers` | 按 operationId 登记异步函数；接收 `{ operationId, parameters, context, requestId, idempotencyKey, signal }`，返回 JSON 数据 |
| `desktopAgent` | 电脑自然语言需要；接收 `{ prompt, context, signal, operations, executeAction }`，返回 JSON 数据；内部每个动作调用 `executeAction(stepId, operationId, parameters)` |
| `dshHome` | 可选，默认沿用 `~/.dsh-huizhi` |
| `readPlugins`、`runDsh` | 用于集成替换或测试的服务端注入项；默认读取真实配置、调用现有 `runTask`，不能由客户端传入 |

`listOperations()` 返回功能清单，供主程序和电脑 Agent 展示可识别操作；看到操作不代表有权限。`dispatchEnterpriseCommand()` 提供只接收企业路径的入口；把电脑普通业务或电脑自然语言发到它会得到 `WRONG_ENTRY`。统一主程序一般直接使用 `dispatchCommand()` 即可。

## 命令与可信上下文分开传递

前端只提交业务内容，不得在命令中指定 `source`、`executor`、`capabilities` 或用户身份。带这些额外顶层字段会被拒绝。明确操作示例：

```json
{
  "version": 1,
  "requestId": "save-20260927-001",
  "kind": "action",
  "operationId": "employee.profile.update",
  "parameters": { "employeeId": "employee-001", "name": "示例员工" }
}
```

自然语言使用 `{ "version": 1, "requestId": "instruction-001", "kind": "instruction", "prompt": "请生成周报" }`。完整示例见 [普通操作](../examples/command-save.json) 和 [插件操作](../examples/command-report.json)。

`trustedContext` 是主程序从已认证的客户端会话构造的 `{ source: "desktop" | "mobile", organizationId, requesterId, authorizationRef? }`。不能把前端 JSON、User-Agent 或模型声称的身份直接当作这个上下文。业务处理器须使用传入的 `context` 校验权限；`parameters` 内即使出现同名字段也只是业务数据。身份字段继续遵守原 v1 的 ASCII 标识符约束。

每次请求和重复请求都调用 `authorize`。明确插件操作必须获得对应 capability；手机自然语言只暴露 `authorize` 返回的能力，未返回即为空。业务插件仍要逐次校验各工具和资源授权：现有 DSH 的能力开关粒度为插件组，不等于单个工具的安全隔离。

## 功能清单与电脑 Agent

内置清单覆盖现有四组业务插件工具和 `reports.create_weekly_report`，这些功能不能被改登记为 `business`，也不能注册普通业务处理器。`files.*`、`knowledge.*`、`employeeTasks.*`、`bi.*`、`reports.*` 是保留命名空间。普通业务使用其他明确名称，例如 `employee.profile.update`。插件可增加业务别名，例如样例的 `weekly.generate`；别名依然绑定真实插件工具并强制经过 DSH。

电脑 Agent 通过 `executeAction` 请求执行。每个 `stepId` 在一项任务中应稳定，例如 `save-profile` 和 `generate-report`；入口为步骤派生独立的请求编号，重新做鉴权和路由，再把步骤结果返回 Agent，供下一步使用。每项任务最多 64 次步骤调用。任何步骤失败都会使父任务失败，Agent 的文字回答不能掩盖它。

这些限制能约束**经过本模块的调用**。主程序团队还必须把所有客户端业务命令接到此入口，禁止给电脑 Agent 暴露绕过入口的 DSH 插件凭据或直连接口。业务服务端须校验授权来源。本模块无法拦截其他进程自行发出的网络请求。

## 返回结果、事件和失败处理

成功返回 `{ version: 1, requestId, route, value, replayed }`。业务路径的 `value` 是业务处理器的 JSON 返回值；DSH 路径的 `value` 保留原 `completed` 结果（答复、工具、来源、产物路径、会话编号）；电脑 Agent 路径则为该 Agent 返回的 JSON。

入口事件包括 `accepted`、`routed`、`enterprise_entered`、`dsh_event`、`completed`、`failed`、`replayed`。`dsh_event` 包含原 DSH 事件；父子任务用各自的 requestId 区分。CLI 最后另输出 `type: "result"` 的完整结果。观察回调抛错不会重新执行业务；主程序应自行保障事件日志的存储。

失败抛出 `DispatchError`，含 `code`、`message`、`pendingConfirmation`。必须捕获函数异常或 CLI 非零退出码，不能只依赖事件；输入格式错误可能在事件回调之前发生。

| code | 主程序处理方式 |
| --- | --- |
| `INVALID_COMMAND`、`INVALID_CONTEXT`、`UNKNOWN_OPERATION` | 修正输入或服务端功能登记 |
| `FORBIDDEN` | 拒绝操作，不改走另一条执行路径 |
| `PLUGIN_DISABLED`、`BUSINESS_HANDLER_MISSING`、`DESKTOP_AGENT_MISSING` | 提示对应功能尚未接入；不自动更换执行方 |
| `REQUIRED_TOOL_NOT_CALLED`、`EXECUTION_FAILED` | 记录失败，必要时向业务服务确认实际状态 |
| `REQUEST_CONFLICT` | 同一 requestId 的内容、设备来源、清单版本或授予能力发生变化，不能当作原请求重试 |
| `REQUEST_IN_PROGRESS`、`REQUEST_STATE_UNAVAILABLE`、`PERSISTENCE_FAILED` | 保留原编号，核查已有请求及业务结果，禁止自动重新提交 |
| `CANCELLED`、`TIMED_OUT` | 停止等待并确认写操作状态；收到取消信号不等于业务事务已撤回 |

超时默认 10 分钟。业务处理器和电脑 Agent 应遵守 `signal`。DSH 取消后入口会额外等待最多 15 秒清理；外部业务若忽略取消信号，入口无法撤回它已经提交的写操作。原 DSH 的员工任务外部取消结果通过 `dsh_event` 传递；主程序仍需处理 `pending_confirmation`。

## 重复请求与持久化约定

主程序在第一次提交时生成 requestId，同一逻辑请求重试必须保留原编号。编号按企业和用户划分，设备来源与内容绑定；不能在重试时自动生成新编号。成功请求重新鉴权后返回已有结果，`replayed` 为 `true`；复合任务还会重新检查每个步骤的权限。失败请求保留原错误，不自动再次执行。进行中或进程崩溃后的请求保留占用状态，不能因为等待超时就删除记录并重跑。

记录通过本地文件系统的原子目录创建、同步写入和替换保存，目录权限 `0700`、文件 `0600`。记录含结果，复合任务还保存用于重新鉴权的步骤参数，可能包含业务信息；由部署方制定访问、备份和保留期限。当前保证建立在**同机 Ubuntu 本地持久化目录**上，不包含多机、临时容器目录、NFS 或人工删记录后的去重。

业务处理器收到稳定的 `idempotencyKey`，须原样交给业务服务做事务级去重。员工任务的 `submit_task` 也会把派生键写入给模型的参数。模型最终生成的工具参数仍须由插件校验；新 requestId、上游擅自重试或同一次模型任务重复提交同类动作，需要业务端的幂等规则配合，不能仅依赖入口记录。

## 启动、验收与双方交接

Ubuntu 项目目录下执行 `npm test` 验证路由、鉴权、并发去重、崩溃保护和 CLI；执行 `npm run routing-demo` 体验手机普通操作，全程使用虚构身份及业务处理器，不调用模型。`npm run routing-smoke` 使用真实 DeepSeek API 验证插件路由和手机自然语言，会产生模型费用并创建隔离测试目录，结束后清理测试目录。

命令行支持：

```bash
node dist/src/cli.js dispatch --input examples/command-save.json --context examples/context-mobile.json --adapter examples/routing-demo-adapter.mjs --format text
```

`--adapter` 是会执行代码的服务端模块，`--context` 是服务端确认后的上下文文件，路径必须由部署方控制，不能允许终端用户在 HTTP 参数中选择。示例重复执行会返回缓存结果；要测试一个新操作，请使用新的 requestId。

主程序团队负责替换真实 `authorize`、`businessHandlers`、`desktopAgent`，把电脑和手机的业务入口接过来，确认源设备及每步授权，并管理业务侧幂等和任务状态。DSH 团队提供的分流模块已可接入；真实主程序、业务服务和其他 Agent 的生产联调仍须在对应项目完成。

原 `TaskRequest v1`、`runTask` 和 CLI `run` 保留给底层调用与诊断；它们本身不提供设备分流和请求去重。采用本规则的用户业务入口应统一调用 `dispatchCommand`，避免公开旧接口绕过主程序策略。
