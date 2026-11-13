# DSH 兼容性记录

核查日期：2026-11-04。

- 本机实际安装：`/Applications/DeepSeek Harness.app`，DSH **0.2.1-rc.5**，内置 Node.js **24.21.0**、Cordis **4.0.5**。
- 初始源码参考：https://github.com/deepseek-ai/deepseek-harness ，commit `8bd073392eef6f54e921a093b95076248eb08cbb`（0.2.2-alpha.3）。不将它的 API 自动视为本机可用。
- 本机接入位置：`~/.dsh/profiles/desktop/package.json`，新增 dsh-ime 链接依赖与 bundle；原有 bundle 保留。
- 本次安装前备份：项目 `.ime-v1/integration-backups/desktop/`，包含原 package.json、cordis.patch.yml，不纳入发布包。

| 项目 | 实测结果 |
| --- | --- |
| bundle install | 本机 CLI 链接安装成功；实际 Electron 桌面启动加载成功 |
| 工具注册 | `ctx.tools.register()` 接受原始 JSON Schema 与必填 output.schema/render |
| 工具实际分发 | 真实宿主 `ctx.tools.execute()` 成功，输出通过宿主规范验证 |
| 模型端调用 | 桌面会话“IMe 插件状态验证”，DeepSeek-V4.1-Flash 实际调用一次 ime_status，轨迹显示成功结果 |
| session/event | 桌面真实会话触发，数据库落元数据事件；不保存原始消息 |
| tools/result | 实际工具执行触发，审计持久化工具名称 |
| 禁用/重载 | 真实 Loader 禁用移除工具、关闭 SQLite、释放锁；重载后可再次调用 |
| 自动回归 | npm run test:host 在独立 ime-smoke Profile 通过；无 LLM 推理 |

## 实际修正

1. Cordis 的服务属性受 inject 保护。可选能力探测改为 `ctx.get('computerUse')` 等显式查询，避免直接读取未声明的 ctx 属性导致插件激活失败。探测位于数据库创建前，探测错误不会留下运行时锁。
2. 自定义资源用 `ctx.effect(() => cleanup)` 注册生命周期清理；`ctx.on('dispose')` 不能代替 Cordis 资源处置器。Mock 测试也改为触发 effect 的清理函数。
3. 本机 Loader 的 entry.update(disabled) 不等待卸载完成；集成测试显式等待 fiber.await()，包括重载稳定后再二次禁用，避免把生命周期中间态当成清理失败。

适配层仍使用隔离的结构类型，真实行为由本机运行测试验证，尚未建立 SDK 编译契约。支持范围暂锁定 `0.2.1-rc.5`，不能外推到其他版本。

## 当前能力边界

首次接入验证的 `hostCapabilities` 四项均为 false；本轮桌面重新加载后，tokenMeter 和 modelGateway 为 true，computerUse 和 compaction 为 false，详见 model-gateway-desktop-report.json。computerUse/tokenMeter/compaction 表示插件加载作用域当时未探测到相应可选服务，不代表 DSH 产品完全没有这些能力，Agent 局部服务与之后加载的服务尚未桥接。此前验证时 modelGateway=false；本轮接入官方 llm/stream 后为 true，默认 observe，可配置 guarded。hardLimit 仍为 false，不能宣称请求受不可绕过的硬预算保护。

不注册第二个 Computer Use Provider，不更改权限/模型凭据，不替换原生 Compaction。桌面控制、余额和 Provider 传输边界硬预算仍待后续开发。宿主计费流入口已实现，说明见 model-gateway.md。

报告：[宿主自动验证](host-smoke-report.json)、[桌面真实模型验证](desktop-integration-report.json)。

本轮宿主回归增加真实 preparedCall.stream 路径测试：记录 usage、预留和结算、预算不足在 Adapter 运行前拒绝。报告使用专用 Mock Adapter 和虚拟测试报价，不代表已核实真实 Provider 价格。

## MVP/V1 模块补充（当前）

本轮增加 Standard Schema Config、受保护本机 Dashboard、Memory/Skill 工具、有限桌面映射与 tools.guard、完整 Agent Loop 测试、原生压缩显式委派、schema v3。测试使用临时 DSH_HOME，不污染日常配置。desktop 实例保持 observe，computerUse 仍未激活。完整结论见 acceptance.md；早期接入报告属于历史证据。
