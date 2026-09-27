# WeKnora P3 问答与慧智中枢接入实施记录

记录日期：2026-09-27  
阶段状态：**检索、证据、MCP 和答案交付的可测试内核已实现；P3 尚未通过正式服务与业务资料集成验收**。P0～P2 的真实环境闸门仍未关闭，当前不能启用员工试用。

## 1. 阶段目标与实现边界

依据[开发文档 P3](weknora-development-plan.md#p3问答与慧智中枢接入)和[技术文档第 12～15 节](weknora-technical-design.md#12-query召回重排与证据包)，本阶段先实现可被真实适配器调用的安全问答链路：可信身份 → 有限查询规划 → 关键词/编号/向量候选 → P1 授权与活动版本检查 → 外发策略 → 重排 → 父块单独鉴权 → 证据包 → MCP → DSH 草稿 → 引用与关键字段校验 → 正式交付。当前项目没有可搜索的 WeKnora 索引、实际 OCR/Embedding/重排 API、业务样本及主程序页面，因此不把这些依赖接口称为已联调服务。

## 2. 已实现内容

| 工作项 | 实施内容 | 源码 |
| --- | --- | --- |
| Query 理解与有限改写 | 保留原问题，识别时间表达、部门、文档编号、金额与解释/比较/统计意图；只替换有限同义词，保留限定条件；无可靠指代或历史/未来时点缺可信授权时澄清 | [query.ts](../src/knowledge/query.ts) |
| 多路检索与权限 | 注入关键词、向量、精确编号检索接口；候选以租户/库/文档/版本/构建/片段完整键去重；分别在候选、重排前、父块、输出时调用 P1 `authorizeRead` | [query.ts](../src/knowledge/query.ts) |
| 模型外发与重排 | 向量查询和重排均要求 `ModelDataPolicy` 明确放行，未配置时关闭；只向重排器发送已授权候选；校验返回键、分数和条数，故障返回 `degraded`，低分返回 `no_evidence` | [query.ts](../src/knowledge/query.ts) |
| 证据与状态 | 每条 hit 返回原文、位置、文档/构建版本、生效区间、来源类型、冲突标志、召回路由与分数；真实 P1 闸门回传的生效区间覆盖索引候选中的旧元数据；区分 `ok`、`no_evidence`、`needs_clarification`、`unresolved_conflict`、`degraded` | [query.ts](../src/knowledge/query.ts)、[foundation.ts](../src/knowledge/foundation.ts) |
| 引用重新打开 | 按 `knowledge:文档:版本:构建:片段` 解析稳定来源；先读元数据并鉴权，再读取原文，返回前复查发布快照和 ACL；不增加模型工具 | [citation.ts](../src/knowledge/citation.ts) |
| 受控表格合计 | 只对可信调用方给出的完整行清单和原始单元格做精确十进制求和；逐格授权，拒绝缺行、混单位、数值与原文不符及未裁决冲突，返回每个单元格来源 | [table.ts](../src/knowledge/table.ts) |
| MCP 搜索入口 | 正式服务工厂只声明 `describe_capability` 和 `search_knowledge`，保持 v1 必填字段；stdio 从任务上下文加独立服务凭据构造身份；诊断身份只可调用能力声明；未授权候选计数等诊断只保留在服务内部，不返回模型 | [mcp.ts](../src/knowledge/mcp.ts) |
| Prompt 与答案校验 | 证据作为不可信数据，使用白名单引用和模板版本；事实句要求引用，数字/单位/日期/编号/否定词必须在所引原文中，生成摘要不能充当权威引用；引用展示前重新鉴权 | [answer.ts](../src/knowledge/answer.ts) |
| DSH 交付封装 | `executeVerifiedKnowledgeTask` 调用现有 `runTask`，拦截其 `completed` 草稿事件；要求知识工具调用及来源白名单，再完成答案校验后返回可展示文本；生成外发仍需单独策略放行 | [dsh-integration.ts](../src/knowledge/dsh-integration.ts) |

插件服务端仍应通过真实的 `KnowledgeIdentityVerifier` 验证服务凭据、员工与组织。`HUIZHI_TASK_CONTEXT_B64` 只传字段，不是签名；测试中的 `synthetic-check-only` 是合成凭据，不代表正式身份系统。治理和反馈仍属于未来同一插件的管理 API，没有暴露成面向模型的新工具。

## 3. 验证记录

- Windows `npm.cmd run build`：TypeScript 编译通过。
- P3 新增 15 项自动测试：包括 MCP v1 工具列表和现有 `plugins check` 真实 stdio 连通性、诊断身份拒绝、P1 活动快照过滤旧向量块、撤销后答案拒绝、跨路去重、重排降级、父块鉴权、引用重新打开、表格精确计算、DSH `completed` 草稿拦截与来源白名单。
- WSL Ubuntu `npm test`：项目全量 **80/80 通过**。
- Windows 全量测试曾有 18 项统一入口用例失败，原始错误为 `EPERM: operation not permitted, fsync`，调用栈位于现有请求账本路径；同一批用例在 WSL Ubuntu 全量运行时通过。这不是正式 Windows 支持结论。
- PGlite 联动测试覆盖 P1 活动发布、ACL、撤销与 P3 查询/答案校验；没有连接实际 PostgreSQL、WeKnora、DeepSeek 或第三方模型服务，没有使用真实合同和员工身份。

## 4. 尚未完成的 P3 验收闸门

| 闸门 | 当前状态与完成条件 |
| --- | --- |
| WeKnora 检索与模型适配 | `CandidateRetrievers`、`CandidateReranker` 及外发策略目前是注入接口；需接入已固定版本的 WeKnora 搜索 API、实际重排供应商，核对来源与版本字段，并完成 10 并发基线。 |
| 查询理解准确率 | 当前识别是保守规则，没有实体消歧、可信会话指代、完整历史时间点解析或中文评测集；需在 P0 标注集上做召回与错误分析，历史查询另加 `read_history` 语义。 |
| 表格统计链路 | 已有受控求和函数，但尚未与 WeKnora 表格检索、列筛选和主问答链路连接；完整行清单必须由可信后端证明，不能由模型自行声明。 |
| 来源重新打开 | 命中引用已有重新鉴权解析服务，但原文存储适配器、受保护的主程序打开 API 与页面仍未接入；`knowledge-query:*` 也没有持久证据清单存储。需把来源映射到实际原件页、段落或单元格。 |
| DSH 与主程序 | 封装已有可调用入口及模拟用例，但未在真实主程序路由与页面接线，也没有真实 DeepSeek 生成测试；主程序必须只展示 `status=ready` 的结果，不能直接转发原 `runTask completed` 文本。 |
| 答案事实准确率 | 当前硬校验覆盖引用白名单和关键 token，并不等于完整语义蕴含证明；需以制度/合同标注问答集验证逐条断言、冲突、无答案和多证据综合。 |
| 部门试用与质量基线 | 尚无获授权资料、业务审核人、真实身份服务、模型供应商和发布配置；因此没有部门试用、可打开引用、检索/问答质量或费用基线。 |

当前配置样例继续关闭 `knowledge`；本阶段没有修改真实权限、服务器或业务资料。后续接线时先完成 P0/P1/P2 实物闸门，再按表中项目逐项验收，不能因合成测试通过而跳过。
