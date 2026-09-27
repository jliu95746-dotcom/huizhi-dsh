# WeKnora P0 源码基线与验收记录

记录日期：2026-09-27

阶段状态：**进行中；未通过 P0 阶段验收**。本记录只确认已检查的源码和本机工具状态，不表示原版服务、模型 API 或真实资料已验证。

## 1. 本阶段目标与已完成内容

P0 的目标是固定可复现的 WeKnora 基础，建立真实资料评测和接口冻结所需的证据，然后才能开始 P1 权限与版本实现。阶段任务和通过条件以[开发文档](weknora-development-plan.md#p0基线样本和接口冻结)为准。

本轮完成：

1. 将上游 `v0.8.2` 检出到忽略目录 `.runtime/weknora-upstream-v0.8.2`，固定完整 commit，并记录主要源码入口与迁移版本。
2. 新增[源码和镜像锁定清单](../config/weknora-upstream-source.lock.json)和只读命令 `npm run weknora:p0:audit`。命令比对 commit、工作树、Go 版本、许可证、必要路径、最新迁移、Compose 声明和已记录的镜像 digest；不读取 `.env`、不启动容器、不调用模型 API。
3. 新增 6 个针对错误 commit、脏检出目录、迁移/镜像漂移、缺少 digest、许可证/源码缺失的用例；纳入 `npm test`。
4. 核对当前仓库的 `knowledge.search_knowledge` 契约与上游源码边界，并按用户决定将知识库定为完整 DSH `knowledge` 插件；列出尚不能冻结的接口与外部决策。

## 2. 固定源码与部署组件

| 项目 | 已核验事实 | 证据 |
| --- | --- | --- |
| 上游仓库 | Tencent/WeKnora，tag `v0.8.2` | [官方 tag](https://github.com/Tencent/WeKnora/tree/v0.8.2)；`git ls-remote` 与本机 `git rev-parse HEAD` |
| 源码 commit | `3e8b0bfc80b845b2d4b2ed683994748741450a97` | [固定 commit](https://github.com/Tencent/WeKnora/commit/3e8b0bfc80b845b2d4b2ed683994748741450a97)；只读检查命令 |
| 主项目许可证 | `LICENSE` 声明 MIT，第三方组件另有许可及通知 | 固定源码的 `LICENSE`、`THIRD_PARTY_NOTICES.md`；正式分发前仍需逐项合规审查 |
| Go 版本 | `go.mod` 声明 `go 1.26.0` | 固定源码 `go.mod`；本机未安装 Go CLI |
| 迁移上限 | `migrations/versioned/000110_im_channel_locale.up.sql` | 固定源码目录扫描；迁移执行尚未验证 |
| 核心镜像声明 | `weknora-ui`、`weknora-app`、`weknora-docreader` 和可选 `weknora-sandbox` 均取 `WEKNORA_VERSION`，未设置时回退 `latest` | 固定源码 `docker-compose.yml`；发布时必须使用锁定 digest |
| 镜像仓库 digest | 上述四个 WeKnora 镜像及 ParadeDB、Redis 的 manifest digest 已记录在锁定清单 | 2026-09-27 读取 Docker Hub 对应 tag API；未实际拉取和启动 |
| 数据与队列 | Compose 核心包含 `paradedb/paradedb:v0.22.6-pg17` 与 `redis:7.0-alpine` | 固定源码 `docker-compose.yml`、镜像仓库 digest |
| 检索默认值 | `RETRIEVE_DRIVER=postgres` | 固定源码 `.env.example`；OpenSearch 驱动配置存在，但不是默认部署服务 |
| MCP 服务 | Compose 中的 `mcp` 使用 `full` profile，按本地 `mcp-server` 构建 | 固定源码 `docker-compose.yml`；它尚未证明满足本项目的 `knowledge` 契约 |

上游扩展入口已经在该 commit 找到：`internal/infrastructure/docparser/`、`internal/infrastructure/chunker/`、`internal/application/service/knowledge_process.go`、`internal/application/access/`、`internal/models/embedding/`、`internal/models/rerank/`、`cli/internal/mcp/`。这仅证明源码位置存在，不证明企业级权限、版本失效或引用闭环已实现。

**运行与部署配置未冻结。** 上游 Compose 使用固定 `container_name`，直接启动会占用全局名称；本机 Docker Engine 未运行，未启动任何容器。`docker buildx imagetools inspect` 首次访问仓库遇到 `TLS handshake timeout`；随后通过 Docker Hub tag API 分别取得并记录了六个镜像的 manifest digest。四个 WeKnora tag 在仓库元数据中均列出 `linux/amd64`、`linux/arm64`，但平台拉取、原版启动和 ARM64 实机均未验证。后续在隔离环境按 digest 拉取并验证镜像平台，使用独立 Compose 配置消除全局名称与端口冲突；不得把 `latest` 当作发布基线。

## 3. 模型与解析边界的源码核对

| 能力 | 固定源码观察 | 本项目待确定 |
| --- | --- | --- |
| OCR/版面解析 | `docparser` 中存在 PaddleOCR-VL、MinerU 等转换入口，`docreader` 作为独立服务 | 具体 OCR API、版面/表格输出协议、失败回退、费用和资料外发规则 |
| 语义切分 | `chunker` 中已有多种切分实现与测试 | 是否能导入预切分结构、语义切点模型、表格和条款完整性闸门 |
| Embedding | `internal/models/embedding/protocol.go` 可按 provider 选择 OpenAI、DashScope、Ark、Google 等协议并处理批量 | 供应商/模型、维度、速率、价格、同一索引的版本一致性 |
| Rerank | `internal/models/rerank/` 有模型协议与批量处理 | 供应商、重排条数、超时、降级及原文权限复核 |
| 检索 | 默认 PostgreSQL；源码和 Compose 具有 OpenSearch 配置项 | 中文检索质量、权限过滤能力、资源占用对比后选择正式后端 |

模型 API 协议兼容只由源码证明到**接入路径存在**。没有供应商、账号、模型版本和真实样本，就不能声称准确率、成本或“高质量解析”已经达标。

## 4. 真实样本的安全准备与评测口径

真实业务原件、合同、标注答案和 API 凭据均不得进入 Git。建议由资料负责人把脱敏或授权使用的样本放在受控目录，向开发提供该目录路径及读取范围；`.runtime/` 可以用于本机临时验证，但原件备份、权限和留存期限须由资料负责人确定。

建议每份资料记录：稳定文档 ID、类型、文字层/扫描状态、是否含表格、页数、权威来源、资料负责人、适用部门、保密级别、生效/失效时间、版本关系、预期关键字段和已知错误。建议每道题记录：题目 ID、使用身份/部门、提问时间、标准答案或不可回答原因、必须引用的来源位置、不得采用的旧版本、问题类型、调参集或验收集。标注人应复核关键数字、单位、否定词、表头和条款适用条件。

建议规模是 100～200 份资料和 300～500 道题，可随实际资料调整。至少分层覆盖制度、合同、原生 PDF、扫描 PDF、Word、表格，以及正常、无答案、过期、矛盾、越权和恶意文档指令问题。按文档或规则簇分离调参与验收，避免同一制度的近重复问题同时出现两边。记录每类的解析完整率、关键字段准确率、引用定位、授权正确性、检索命中、回答正确性、P50/P95 延迟和 API 用量/费用；不得只报总体平均值。

当前仓库只有 `fixtures/knowledge/服务流程.txt` 演示文本，没有上述代表性资料。**原版解析、检索、回答和 API 费用均未测量**。样本路径已向用户询问；在取得资料、供应商和外发规则前，只能做离线源码与合成数据检查。

## 5. 接口冻结状态

交付形态已明确：`knowledge` 是完整 DSH 业务插件，包含员工 MCP 搜索入口、插件自己的治理/反馈 API 与中文管理页面、处理 Worker、WeKnora 引擎和运维能力。当前仓库只有插件契约和模拟服务，未实现该插件。管理 API 不直接暴露为模型工具，仍属于同一个插件交付单元。

| 契约 | 现阶段状态 | P0 后续验证 |
| --- | --- | --- |
| 慧智中枢 MCP 工具面 | 既有协议固定为 `describe_capability` 和 `search_knowledge`；搜索输入 `query`，输出 `hits`、`sourceRef`、`version` | 本项目 `npm test` 及正式 MCP 服务联调 |
| 证据包 | [技术文档第 13 节](weknora-technical-design.md#13-mcp-适配与可信身份)已有结构草案；位置、原文、文档版本与查询快照含义已定义 | 对照真实上游 API 和样本来源位置，形成 JSON Schema 与错误映射 |
| 员工身份/部门映射 | `X-Huizhi-*` / `HUIZHI_TASK_CONTEXT_B64` 仅传上下文，不能自行证明身份 | 确定主程序可信认证、授权服务和撤权时效；无法验证时拒绝读取 |
| 插件包与管理入口 | 完整插件边界已确定；模型侧仍沿用 v1 只读工具面 | 冻结插件包版本、服务发现、安装/升级/回退、健康检查、中文页面挂载及管理 API 认证 |
| 模型协议 | 上游模型客户端具备多种适配路径 | 选定 OCR、Embedding、Rerank、LLM 的实际提供方与 API 形状，再固定超时、并发、限额和预算 |
| 治理 API | [技术文档第 19 节](weknora-technical-design.md#19-管理-api-与配置边界)是目标草案 | 以固定上游路由/错误格式和企业认证方式完成接口 Schema |

上述后四项尚未冻结。不能因现有示例 JSON 或上游自带 MCP 服务存在，就将 P0 接口验收标为通过。

## 6. 阶段闸门与下一步

| 闸门 | 状态 | 缺口 |
| --- | --- | --- |
| 固定上游源码与仓库镜像 digest | **已通过静态检查** | 实际镜像拉取、迁移和运行仍待验证 |
| 原版服务在隔离环境可重现 | **未通过** | Docker Engine 不可访问；部署镜像与 Compose 隔离方案待落实 |
| 代表性资料及标注集 | **未通过** | 真实样本路径与业务标注人未确定 |
| 原版质量、延迟和 API 成本基线 | **未通过** | 依赖服务运行、真实资料、模型供应商及预算 |
| 插件包、身份、证据、模型及管理接口冻结 | **未通过** | 依赖插件交付协议、主程序身份服务、真实接口和供应商协议 |

P0 后续仍须让隔离 Docker 环境可用并按已记录 digest 拉取/启动，然后按授权范围导入样本、测量原版基线，完成完整插件的接口 Schema。不能将本轮静态检查当作完整 P0 验收，也不能在这些缺口未关闭时宣布 P1 集成验收通过。

后续说明：用户于同日明确要求先开发 P1，已形成 [P1 实施记录](weknora-p1-implementation.md)。这是开发顺序调整，P0 上述验收缺口仍然存在。

复核命令：`npm run weknora:p0:test`、`npm run weknora:p0:audit`、`npm test`、`git diff --check`。Windows 使用 `npm.cmd`。本次完整套件在 WSL Ubuntu 下通过；Windows 本机运行时，请求账本的目录 `fsync` 返回 `EPERM: operation not permitted, fsync`，因此 Windows 全量测试失败不能视作业务代码回归。部署目标是 Ubuntu，后续仍应在目标 Ubuntu 主机重测。
