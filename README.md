# IMe · Intelligent Memory & Execution

面向 DeepSeek Harness 的本地优先记忆与执行插件，依据本目录设计说明书和技术架构图实现。当前为可运行的 **MVP/V1 开发版**，已接入本机 DSH 0.2.1-rc.5；尚不代表生产环境全部验收完成。真实桌面 Provider、精确报价及 Provider 传输层硬预算的验收边界见文末。

## 使用

需要 Node.js ≥ 24.9，本机测试版本 24.14.0；DSH 桌面版内置 24.21.0。

```sh
npm ci
npm run check           # 源码、测试、示例严格类型检查 + 自动测试 + 构建
npm run test:host       # 真实 DSH Agent Loop / 工具 / 模型入口 / 装卸回归
npm run benchmark       # 1000 动作、100 请求、20 重启、20 组重复任务对比
npm run demo            # 无付费调用的模拟任务
npm run demo:dashboard  # 带模拟任务与独立技能验证环境的管理面板
```

`test:host` 自动发现 macOS 桌面版内置 CLI，或使用 `DSH_BIN` 指定入口。在临时 DSH_HOME 创建隔离 Profile，注册测试 Provider，走真实 DSH Agent Loop；不会操作真实桌面、调用付费模型或修改日常 Profile。结束后移除临时目录。报告写入 docs/host-smoke-report.json。

本机 `desktop` Profile 已链接此源码目录。启动 DeepSeek Harness 后，运行：

```sh
npm run dashboard
```

这会读取 `~/.dsh/ime-v1/dashboard.url` 并打开带访问口令的本机控制台。口令只写入权限 0600 的本地文件，不通过模型工具返回。控制台提供概览、费用与预算、任务与执行、记忆、技能、审计与诊断页面。端口默认自动分配，界面只监听 127.0.0.1；API 需要口令并验证 Origin/Host。

Harness 内界面按入口拆分：

- **侧边栏「IMe 状态」**：任务、记忆、技能、审批、预算与最近审计；包含人工的暂停全部/重新允许执行。
- **对话回复末尾的「本次回复」费用行**：按会话与轮次汇总 IMe 账本中的实际结算金额、待对账预留与 token 用量；未配置报价时明确显示“未配置报价”，不猜测金额。
- **设置 →「IMe 设置」**：自动刷新、高级诊断、预算限额新增/调整、宿主配置（应用白名单、默认任务预算、预算时区）、模型报价、独立控制台入口与诊断复制。
- **插件详情 →「打开 IMe 状态」**：从插件详情直接进入状态面板。

预算限额与模型报价默认不启用。现在可以在「设置 → IMe 设置」中直接新增或调整 session/day/account 限额与模型报价：保存后立即生效，并写入数据目录下的 `settings.json`（权限 0600），其同名项优先于插件配置且重启后仍然有效。限额不能低于已计入与预留金额；模型没有修改限额、白名单或报价的工具，只有你在界面上的操作可以改变它们。每个任务仍使用 `taskDefaultLimit` 作为单任务预算保护。修改报价只影响之后的请求，已发生的费用保留原报价快照。新增客户端界面后首次加载需要重启一次 Harness，让客户端模块清单重新扫描。

## 插件整合

按需整合与取舍见 [插件整合记录](docs/plugin-integration.md)。新增宿主输出上限自动续跑，默认每条截断链最多 3 次；发送前检查用户输入、暂停、任务预算和未确认动作。已知外部续写插件开启时会避让，防止重复发送。`ime_status` 新增 `autoRecovery` 和 `hostComponents` 诊断。

## 已有能力

| 模块 | 实现 |
| --- | --- |
| 数据与审计 | SQLite WAL、增量 schema v1→v2→v3→v4、事务检查点、outbox、可重建 JSONL、诊断与账本导出 |
| 费用 | 真实 llm/stream 接入、缓存用量转换、报价快照、单任务/会话/日/账户原子预算、预留结算、未知账单对账、余额适配器；每条回复按轮次汇总账本并在回复下方标识费用 |
| 桌面 | 复用现有 Provider 的有限动作目录、只读观察、应用白名单、跨进程独占锁、取消、前置状态及结果断言、直接 Provider 工具绕过拦截 |
| 权限与恢复 | 敏感动作一次性审批，绑定动作摘要并设过期；uncertain 动作需人工对账；恢复前环境验证；暂停全部与重新允许执行 |
| 视觉 | 可选灰度帧接入、ROI、重复过滤、限频、强制关键帧、保存前脱敏、TTL；不向工具结果泄漏原始帧 |
| 记忆 | FTS5 + 短中文关键词、应用/TTL 过滤、来源分级、候选审核、同主题冲突处理、归档/删除/导出；宿主 Computer Use 成功/失败轨迹去重写入 |
| 技能 | 应用+目标稳定归并、观测累积、候选提炼、内容校验、不可变版本、独立用例验证、人工/累积复核发布、逐步断言复用、失败回滚、修订、成功/失败统计、文件导出 |
| 上下文 | Agent pre-step 接入 L1–L4，按字符配额修剪、保留任务/权限/检查点，引用数据隔离；复用宿主原生压缩并在下一步补回独立任务不变量 |
| 自审与路由 | 成功抽样/重复失败/人工规则复盘，最多两次；可选模型复盘受独立 10% 配额约束；三档模型能力/费用/隐私过滤与路由建议 |

插件不重写 DSH Agent Loop，不注册第二个 Computer Use Provider，不允许模型通过工具审批、提额或发布技能。模型任务的默认限额来自宿主配置，不采用模型提供的限额。不同 Session 不能通过任务工具操作彼此的任务。

学习累积的入口是受管任务：`ime_observe` 先写入环境检查点，技能匹配/复用或首次执行都从这一步开始；同一“应用 + 目标”的重复成功会累积到同一技能，达到门槛后可在控制台“复核发布”。宿主直接调用的 Computer Use 工具则只采集工具名/应用/成败，形成去重的 `procedure`/`failure` 记忆，不会自动生成可执行技能。当前 desktop Profile 若未配置 `desktopAdapter`，受管桌面动作会返回不可用；这不影响宿主 CUA 轨迹的经验采集。详见 [docs/learning.md](docs/learning.md)。

金额是**币种百万分之一**的整数字符串：`1000000` = 1 USD 或记录中指定币种的 1 单位；不会混加不同币种。账本 actual 表示按 Provider 用量及配置报价计算，不代表已经核对账户实扣。

## 安装与卸载

```sh
npm run build
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /absolute/path/to/IMe
```

桌面 Profile 由 Electron 应用启动，CLI 不允许直接启动或 dump desktop；通过桌面插件列表禁用/启用来重载。保留原有 bundle，安装前的本机配置备份位于项目 `.ime-v1/integration-backups/desktop/`。移动源码目录后需要重新建立链接。开发包保持 private，不自动发布 npm。

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-ime
```

卸载保留用户数据。原有旧项目 `.ime/` 不读取、不迁移。新数据默认 `~/.dsh/ime-v1`。备份应在插件禁用、数据库关闭后复制整个目录。异常退出留下 runtime.lock 或 ime-desktop.lock 时，先核对其 PID 对应进程确实已停止，再人工移除锁；重启后任务仍需校验，不自动重放不确定动作。

## 验收边界

- **真实桌面**：本机尚无激活的 Computer Use Provider。适配器、权限、锁与完整流程已经过真实 DSH + 隔离桌面工具和模拟环境验证；未宣称已控制任意真实应用。配置必须提供现有 Provider 名称、工具前缀、有限动作映射及可验证的状态字段。未知输出结构明确拒绝，不猜测坐标或成功状态。
- **硬预算**：默认 observe 记录用量；配置核实后的报价/输入上界/输出上限可启用 guarded。当前 hardLimit=false，尚未证明 Provider HTTP 最内层不可绕过、全部内部重试及输入计费上界。
- **采集与压缩**：灰度帧来自已有采集 Provider；不额外装采集驱动，不申请 OS 权限。原生压缩只在会话实际提供该服务时可用；本机日常 Profile 的压缩能力未单独实测。路由是受限建议，保持用户当前模型选择，不自动改写宿主路由。
- **测试结论**：模拟成本对比不是实测生产降本；B 组使用上下文长度代理，不是实际 DSH 压缩实验。尚无 60–120 分钟真实桌面长任务、20 类异构应用 A/B 或“真实成本下降 30%”结论。V2 动态学习路由、云同步、多设备与 OTel 不属于本次 MVP/V1 开发版。

[配置说明](docs/configuration.md) · [学习与经验累积](docs/learning.md) · [验收报告](docs/acceptance.md) · [模型入口边界](docs/model-gateway.md) · [宿主兼容性](docs/compatibility.md) · [依赖与 SBOM](docs/dependencies.md)

默认关闭 DSH 的产品改进 Session Log 上传（`session-log-deepseek.enabled: false`）。这与执行云端模型推理所需的数据传输不同；IMe 审计和费用账本保存在本机，不自动外传。桌面 Provider 安装见 [本机微信验收记录](docs/wechat-acceptance.md)。
