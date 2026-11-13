# 本机微信验收记录（2026-11-04）

目标：在微信客户端读取用户指定群聊的喂食记录，分别统计亲喂时长、瓶喂量与日期；只读，不在群中发送消息。用户授权使用当前 DeepSeek-V4.1-Flash 模型，本次人民币总预算 2 元。

## 已验证

- DSH 0.2.1-rc.5，本插件 0.2.0。
- 官方 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.1-rc.5`，SDK `@trycua/cua-driver@0.28.0`，55 个桌面工具正常注册。
- 安装器的 `autoInstallPeers: false` 与桌面 app.asar 内外模块身份冲突需要适配。`scripts/prepare-native-provider.mjs` 生成本机兼容入口，复用宿主 Cordis、MCP client 与 Schema，保留官方 Provider 生命周期和权限检查；原包不修改。生成文件记录源 SHA-256。不能直接安装第二份 scope/tools/system-prompt 等宿主单例包，否则可能导致会话恢复失败。
- 仅对窗口/应用发现工具，把原 canonical structuredContent 附加为有界文本；否则 DSH 0.2.1 的 MCP 投影只有“Found N windows”，模型拿不到窗口身份。保留原结构数据与图片通道；长列表明确标注截断。
- 系统设置和真实模型工具检查确认辅助功能、屏幕录制已授权；调用 `check_permissions(prompt=false)` 不触发权限弹窗。
- 真实模型定位到微信主窗口，调用 `get_window_state`，模型确实收到截图；该截图内容区纯白，AX 树没有聊天消息。Codex 的另一条读取通道也得到白屏。尚不能据此统计聊天历史。
- 用户确认关闭产品改进 Session Log；DSH 通用设置已显示关闭并保存。插件 bundle 同时设置 `session-log-deepseek.enabled: false`，作为新安装默认值。正常云端推理仍发送必要上下文；IMe 审计和账本仅存本机。
- 53 项自动测试通过；真实 DSH fixture 验证 11 项，其中包含默认关闭 Session Log、模型请求预留/结算和预算不足阻断。

## 计费配置与界限

只允许 `deepseek-official/deepseek-flash` 与 `deepseek-account/deepseek-flash`；会话和 CNY 账户总上限均为 2,000,000 micro-CNY（2 元）。报价来自 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，当前空闲时每百万 tokens：未缓存输入 1 元、缓存输入 0.02 元、输出 4 元。以完整 1,048,576 输入 token 上界和至多 8192 输出预留；正常返回后依可信累计用量结算。官方 Adapter 自动重试设为 0，自动标题模型调用暂停。报价于北京时间 2026-11-05 09:00 失效，过期即在分发前拒绝，不能沿用空闲报价跨入高峰。

配置实施的是 guarded 预算检查，`hardLimit: false`；不声称防止恶意第三方插件绕过入口或 Provider 违反约定上限。账本 actual 是用量乘以官方配置单价，不等于已核对账户实际扣款。未完成请求保留保守费用；重启后暂停的预算任务，需要核对 outstanding 再由管理面板恢复。

实际模型用量和累计金额保存在用户本机 `~/.dsh/ime-v1`，不把私人聊天正文、凭据或管理令牌放进发布包。最终画面诊断和全历史统计仍在进行；未获得可读取的真实历史前，不将模拟数据或初始可见的几个记录当成全量结果。
