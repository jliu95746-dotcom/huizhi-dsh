# WeKnora P1 权限、版本与任务基础实施记录

记录日期：2026-09-27  
阶段状态：**基础代码已完成；P1 尚未通过集成验收**。用户明确要求先实施 P1，P0 的原版运行、真实资料基线和完整接口冻结仍未通过，见 [P0 记录](weknora-p0-baseline.md)。

## 1. 本次开发目标

按[开发文档 P1](weknora-development-plan.md#p1权限版本与任务基础)实现可独立测试的 `knowledge` 插件领域基础：文档不可变版本、构建任务代次、拒绝优先权限、暂存与活动发布、所有读取面统一授权、幂等与并发控制、撤销、事务 Outbox 和基础审计。此阶段不开发 P2 解析、切分、向量化，也不将合成测试视为正式服务验收。

## 2. 实施内容

| 领域 | 已实现的基础能力 | 位置 |
| --- | --- | --- |
| 插件数据 | 独立 `hz_*` 表及可回退迁移；文档版本、发布记录、撤销记录和审计记录禁止原位修改/删除 | [迁移](../plugins/knowledge/migrations/0001_p1_foundation.up.sql)、[回退](../plugins/knowledge/migrations/0001_p1_foundation.down.sql) |
| 可信身份边界 | 服务凭据必须由 `KnowledgeIdentityVerifier` 验证；验证后的组织、用户和请求上下文必须一致；无权限默认拒绝 | [领域服务](../src/knowledge/foundation.ts) |
| ACL | 用户、部门、用户组和所有人规则；拒绝优先；增加/撤销规则时递增 ACL 修订号并写事件/审计 | [领域服务](../src/knowledge/foundation.ts) |
| 构建与发布 | 幂等构建、代次 fencing、失败状态、可信索引校验接口、`expectedReleaseId` 并发发布检查、活动发布指针；同一文档可保留互不重叠的历史与当前有效区间 | [领域服务](../src/knowledge/foundation.ts) |
| 统一读取闸门 | 对 `search`、`original`、`parent`、`citation`、`download` 采用同一版本、有效期、撤销和 ACL 判定；显式 `asOf` 要求历史读取权限 | [领域服务](../src/knowledge/foundation.ts) |
| 事务与事件 | PostgreSQL `pg` 同连接事务适配；Outbox 租约、确认和重试，旧租约不能确认新投递 | [数据库适配](../src/knowledge/postgres.ts) |

原件 `objectRef` 只是受保护对象引用；本阶段没有实现对象存储、真实索引、WeKnora MCP 服务或治理页面。`KnowledgeIndexVerifier` 是必须注入的可信接口；测试中的模拟实现不能替代正式索引完整性检查。

## 3. 验证与证据边界

- `npm.cmd run build`：Windows 本机 TypeScript 编译通过。
- `node --test dist/test/knowledge-p1.test.js dist/test/knowledge-postgres.test.js`：使用 PGlite 和模拟连接，12 个测试通过。覆盖不可变版本、跨租户/伪造身份、拒绝优先、五个读取面、有效期区间、旧快照/紧急撤销、半成品拒发、代次隔离、并发发布、Outbox 重试与迁移回退。
- `wsl.exe bash -lc 'cd /mnt/e/慧智中枢项目 && npm test'`：Ubuntu 环境全量 52/52 通过；测试使用合成资料。
- 没有运行正式 PostgreSQL、WeKnora 服务、真实企业身份服务或真实索引。不能据此证明生产路径已被统一闸门覆盖，也不能声明 P1 阶段通过。

## 4. P1 剩余验收闸门

| 闸门 | 当前状态 | 完成条件 |
| --- | --- | --- |
| 企业身份与服务鉴权 | **未完成** | 接入真实主程序认证/部门映射，验证撤权时效、服务凭据和管理操作权限 |
| WeKnora 全读取面接入 | **未完成** | 搜索、原文、父块、引用、下载、缓存和派生路径实际调用统一闸门；展示前复核来源 |
| 真实索引校验 | **未完成** | 适配暂存索引清单及完整性检查，校验 `buildId` 与任务代次后允许发布 |
| PostgreSQL 与上游集成 | **未完成** | 在固定 WeKnora 版本的隔离环境执行迁移、回退和并发/故障演练 |
| Outbox 投递 | **未完成** | 实际消费者、重试上限/死信、事件消费幂等、监控与告警 |
| P0 依赖 | **未完成** | 原版运行、代表样本、身份及插件接口冻结 |

下次继续 P1 集成验收；上述路径未接通前不得把 `knowledge` 插件部署为可供员工查询的正式服务。

后续说明：用户于同日要求先开发 P2，已形成 [P2 实施记录](weknora-p2-implementation.md)。本记录列出的 P1 集成闸门仍未关闭。
