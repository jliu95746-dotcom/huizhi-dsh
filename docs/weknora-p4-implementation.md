# WeKnora P4 知识治理与发布工作台实施记录

记录日期：2026-09-27  
阶段状态：**治理与发布的插件内核及中文只读工作台已开发；P4 尚未通过正式服务和业务规则验收**。P0～P3 的真实环境闸门仍未关闭，正式配置中的 `knowledge` 保持关闭。

## 1. 本阶段目标

依据[开发文档 P4](weknora-development-plan.md#p4知识治理与发布工作台)和[技术文档第 6、10、19 节](weknora-technical-design.md#6-清洗去重与规则治理)，本阶段按一个可验证的插件内核实现：保留原文证据的治理候选、双人复核、不可绕过的发布审批、影响预览、派生来源失效和历史读取。以企业内部制度、合同、PDF/Word 混合扫描件与表格为首期对象；当前没有真实样本和业务审核人，因此规则冲突仅形成待裁决候选，不擅自确定哪个制度权威。

## 2. 已实现内容

| 目标 | 实现与边界 | 代码 |
| --- | --- | --- |
| 生效、失效、撤销和历史 | 复用 P1 发布条目的业务有效区间、撤销闸门；历史读取要求指定发布快照和 `asOf`、独立 `read_history` 权限，并重新检查当前 ACL 与撤销状态 | [foundation.ts](../src/knowledge/foundation.ts) |
| 标准实体与规则建议 | 标准实体/别名保存来源；同一别名返回多个候选供消歧。模型提交规则建议须有来源原文、时间范围、适用部门/地区、数值与单位；审核人与提交人分离 | [governance-catalog.ts](../src/knowledge/governance-catalog.ts)、[governance-policy.ts](../src/knowledge/governance-policy.ts) |
| 矛盾及近重复 | 业务主体/行为、时间与适用范围可能重叠时才生成冲突候选。近重复候选保留数字、单位、否定词、部门差异；人工判重不能覆盖关键差异；原文变化会拒绝旧裁决 | [governance-policy.ts](../src/knowledge/governance-policy.ts)、[governance.ts](../src/knowledge/governance.ts) |
| 人工裁决 | 候选和不可变裁决记录保存在插件表，审核要求不同操作者、修订号和原因；未解决候选阻止涉及文档的发布。`confirm_supersession` 和 `mark_exception` 因尚无胜出规则及例外范围结构化记录而明确拒绝 | [governance.ts](../src/knowledge/governance.ts)、[0003 迁移](../plugins/knowledge/migrations/0003_p4_governance.up.sql) |
| 发布流程 | 准备发布清单 → 差异与派生影响预览 → 独立审核 → 到期执行；使用预期活动快照和幂等键。数据库触发器阻止直接调用 P1 `publish` 绕过批准，批准后新增未裁决候选也会阻断发布。回退生成新提案并重新批准 | [governance.ts](../src/knowledge/governance.ts)、[0003 迁移](../plugins/knowledge/migrations/0003_p4_governance.up.sql) |
| 派生内容 | FAQ、摘要、Wiki、图谱对象保存完整来源依赖；读取时逐个来源重新检查当前发布、有效期、撤销与 ACL；失效后拒读，可由对账隔离并写 Outbox。发布预览列出受影响对象 | [derived.ts](../src/knowledge/derived.ts) |
| 中文工作台 | 可信身份读取同租户/知识库的审核队列和发布提案，输出 HTML 转义后的中文只读页面；审批和发布操作须走受保护管理接口。可用合成数据生成[静态预览](../examples/knowledge-p4-workbench-preview.html) | [workbench.ts](../src/knowledge/workbench.ts)、[预览脚本](../scripts/knowledge-p4-preview.mjs) |

新增表只在 `plugins/knowledge/migrations/0003_p4_governance.up.sql`，不改 WeKnora 上游表；对应 `down.sql` 用于在迁移演练中验证结构回退。**对含业务数据的环境执行 down 会删除 P4 治理记录，必须先备份并确定回退窗口**。P4 迁移发布后，旧的无审批 P1 `publish` 调用会被数据库触发器拒绝，接入方必须改用提案流程。

## 3. 验证证据

- Windows `npm.cmd run build`：TypeScript 编译通过。
- `node scripts/knowledge-p4-preview.mjs`：在 `examples/knowledge-p4-workbench-preview.html` 生成合成数据的静态页面，可直接在浏览器打开查看布局；它不连接服务或真实资料。
- `node --test dist/test/knowledge-p4-*.test.js`：P4 **12/12** 定向测试通过，覆盖审批绕过、后发冲突、关键文本保护、实体歧义、规则来源、定时发布、幂等时间冲突、回退提案、历史 ACL/撤销、派生隔离、工作台转义与无权限拒绝、迁移回退。
- WSL Ubuntu `npm test`：加入 P4 后全量 **92/92 通过**。
- 所有 P4 数据库用例使用 PGlite 和合成来源；未连接正式 PostgreSQL、WeKnora、OCR/Embedding API、真实身份服务或业务资料。

## 4. 未完成的业务验收与接线

| 闸门 | 所需工作 |
| --- | --- |
| 真实审核与权限 | 将 `KnowledgeIdentityVerifier` 接到主程序的可信身份和知识库级审核/发布职责；目前合成身份只有租户级权限。建立制度、合同的业务权威负责人及双人审批名单。 |
| 替代/例外裁决 | 设计胜出规则 ID、被替代规则 ID、生效时段、部门/地区范围、权威来源和审核证据，并把裁决应用到检索及证据状态；在此之前保持冲突未解决，不能以理由文字放行。 |
| 工作台和管理 API | 当前只有可调用的服务类、读取模型与 HTML 渲染函数；尚未挂载到主程序或 WeKnora 的受保护管理路由，没有可打开的运行页面、裁决交互或定时任务调度。 |
| 派生重建 | 已能拒读、列出影响和隔离，尚无真实 FAQ/Wiki/图谱对象存储适配器、Outbox 消费者与增量重建 Worker。 |
| 规则质量与业务样本 | 需要可授权的制度、合同及跨部门例外样本，由业务审核人标注新旧制度、不同部门、撤销、未来生效、误报和历史时点；完成 PostgreSQL 并发、真实索引及 10 并发联调。 |
| 正式发布 | 需先完成 P0～P3 集成闸门、备份/恢复演练、迁移与回退演练，再按生产授权启用插件；合成测试不构成生产发布依据。 |

本阶段未处理真实资料，也未修改服务器、真实权限或模型凭据。审核页面的数据内容按来源编号显示，不附带合同正文；正式页面若显示原文对照，仍须逐次按文档 ACL 鉴权。
