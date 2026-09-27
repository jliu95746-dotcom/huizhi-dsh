# 企业智慧中枢 DSH 执行层

本目录提供供企业主程序调用的 Ubuntu 统一入口，按客户端来源和功能选择普通业务直通、电脑 Agent 或 DSH 模型任务。模型路径基于固定版本的 DeepSeek Harness（DSH）并调用 DeepSeek API；本目录不包含企业管理页面、登录系统或四组业务插件的正式实现。

## 给接手项目的同事和 Codex

**先读 [Codex 协同开发交接](docs/codex-handoff.md)。** 其中列明项目现状、职责分界、接口入口、接入顺序、测试证据和可复制给另一个 Codex 的任务说明。

之后按工作内容选择文档：

| 要做什么 | 先看什么 |
| --- | --- |
| 电脑／手机分流、普通业务直通、DSH 插件强制路由 | [统一入口接入约定](docs/command-routing.md) 与 [可运行适配示例](examples/routing-demo-adapter.mjs) |
| 主程序调用 DSH、处理事件和结果 | [主程序与插件接入契约](docs/integration.md) 与 [任务样例](examples/echo-task.json) |
| 开发文件、知识库、员工任务或 BI 插件 | [外部 MCP 插件契约 v1](docs/plugin-contract-v1.md) 与 [插件配置样例](config/plugins.example.json) |
| 在 Ubuntu 安装和运行 | [Ubuntu 安装与运行](docs/ubuntu-setup.md) |
| 测试、验收和排错 | [测试、验收和排错](docs/testing-troubleshooting.md) |

不需要模型 API Key 即可在 Ubuntu 项目目录执行 `npm ci`、`npm test`。`npm run smoke` 等真实模型联调会调用 DeepSeek API，运行前先阅读测试文档。

运行 `npm run routing-demo` 可体验手机普通业务经过企业入口而不调用模型；示例不会修改真实员工资料。正式主程序通过 `createCommandDispatcher` 接入真实权限、业务服务和电脑 Agent。旧 `runTask` 保留，用户业务分流请使用新入口。

交接给另一台机器时，需提供项目源码和 `package-lock.json`；不要传递 `node_modules`、`dist`、运行目录或任何真实密钥。
