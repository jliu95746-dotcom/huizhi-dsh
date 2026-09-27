# Ubuntu 安装与运行

本项目只交付企业智慧中枢的 DSH 执行层：命令行入口、可供主程序调用的函数、插件装配、示例报表。其他团队负责业务数据和身份鉴权。运行时调用 DeepSeek 云端 API，不下载本地模型，也不启动网页界面。

## 环境

- Ubuntu x86_64 用于开发；树莓派 Ubuntu ARM64 需要另行实机验收。
- Node.js 22.19.0 或更新的 22.x；也支持项目 `package.json` 所列的 24.x 范围。
- 能访问 npm registry 和 DeepSeek API。
- 一个已配置在 DSH 默认目录 `~/.dsh` 的 DeepSeek API Key；不要把 Key 写入仓库、任务 JSON 或聊天。

在 Ubuntu 终端进入项目根目录：

```bash
node --version
npm ci
npm test
npm run setup
npm run doctor
npm run audit-profile
node dist/src/cli.js plugins check
```

`npm run setup` 在 `~/.dsh-huizhi` 创建独立运行目录，初次安装时把 `~/.dsh/.credentials.yaml` 和 `settings.yaml` 复制到该目录。源密钥不会输出到终端，目标文件权限为 `0600`，目录权限为 `0700`。原 DSH 配置不受影响。若源 DSH 尚未配置 Key，先用 DSH 官方方法完成配置，再运行 `setup`。以后轮换 Key 时，需要在独立运行目录同步新凭据；`setup` 不会覆盖已存在的凭据。

本项目的插件开关在 `~/.dsh-huizhi/plugins.json`，默认四组外部业务能力关闭，`reports` 打开。不要直接修改 `~/.dsh-huizhi/profiles/huizhi-enterprise` 里的生成文件。源码 profile 更新后，`setup` 遇到差异会报错，以免悄悄覆盖手工改动；核对差异后再更新运行目录中的对应文件。

## 最小调用

电脑／手机统一入口见 [分流接入约定](command-routing.md)。运行 `npm run routing-demo` 可验证手机普通业务的直通路径，无需模型 Key，使用模拟员工数据。主程序正式接入时必须替换示例鉴权与业务处理器。以下 `run` 示例是底层 DSH 模型调用，不包含新增的设备分流或请求去重。

先运行只使用模型 API 的示例：

```bash
node dist/src/cli.js run --input examples/echo-task.json
```

再运行报表示例：

```bash
node dist/src/cli.js run --input examples/report-task.json
node dist/src/cli.js run --input examples/report-task.json --format text
```

输出是逐行 JSON 事件，最后一条 `completed` 包含模型答复、工具名称和生成文件绝对路径。示例报表位于 `~/.dsh-huizhi/outputs`。这个示例把事实写在任务输入中，没有读取示例文件；要实际读取文件，需接入 `files` 插件。

DSH 的会话记录会保存在独立运行目录下的 `sessions`，其中可能包含任务文本和插件返回的数据。`outputs` 中的报表也可能包含业务信息。部署时应对这个目录设置备份、访问权限和保留期限；不要把它提交到 Git。

正常任务结束会删除 `tasks/run-*` 下的临时插件补丁。进程被强制结束时，下一次 `setup` 或任务启动会清理超过一分钟、且所属进程已不存在的临时任务目录；生成的报表不在此范围内。若需回退，可从备份恢复对应临时目录，但其中可能含短期使用的插件凭据，请限制访问。

## WSL 和树莓派

当前开发机的 Windows 项目目录通过 `/mnt/e/慧智中枢项目` 进入 WSL。该路径在 WSL 上加载大量 Node 包可能较慢；正式部署宜把项目复制到 Ubuntu 原生文件系统后重新执行 `npm ci`，不要复制 Windows 的 `node_modules`。

树莓派上应使用 Ubuntu ARM64、同一份源码和锁文件，执行 `npm ci`、`npm test`、`npm run setup`、`npm run doctor`，再用测试 Key 和示例任务做实机运行。当前尚未在树莓派实机验证，不能把 x86_64/WSL 结果当作 ARM64 验收。

## 回退

停止 `huizhi-dsh` 任务进程即可停止 DSH 子进程和 stdio 插件。企业运行目录在 `~/.dsh-huizhi`，与原 `~/.dsh` 分开；需要回退时，先保存自己编辑过的 `plugins.json` 和输出文件，再删除独立运行目录。删除动作会同时删除其凭据副本和生成报表。
