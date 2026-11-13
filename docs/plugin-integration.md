# 插件按需整合记录

核查日期：2026-11-05；目标宿主：本机 DSH 0.2.1-rc.5。本文将用户提供的插件清单对应到现有设计能力，区分直接复用、机制参考和待验收能力。不是把社区插件全部安装到同一 Profile。

| 预设能力 | 整合决定 | 当前验证及边界 |
| --- | --- | --- |
| Agent Loop / 会话恢复 | 保留官方 Runtime；OpenCode、Codex 作为设计参考，不引入另一执行框架 | 原生 Agent Loop 和装卸回归通过；未复制两个框架源码 |
| 输出上限自动续跑 | 参考 aqiu817/dsh-plugin-continue-on-limit 的宿主事件机制，独立实现 HostRecovery | 真实 max-tokens → 空闲 → followup → 次数熔断已验证；不自动重试网络错误或重放桌面动作 |
| 会话持久化 / 上下文 | 复用宿主 Checkpoint Policy、Compaction Basic、Tool Result Pruner、Image Offload、Token Meter | Checkpoint 与 Token Meter 在真实组合中确认；压缩与裁剪沿用宿主配置，不将包存在等同于当前 Agent 服务可用 |
| 桌面与权限 | 复用已安装官方 macOS CUA；保留工具适配和审批、白名单、租约 | Provider 保持之前用户停止验收时的禁用状态；不启用 Windows Provider，不重试真实桌面任务 |
| 视觉优化 | 现有 VisionPipeline 保留 ROI、变化筛选、脱敏与 TTL；参考 See Now 的按需采样思路 | 模拟帧验证通过；尚未把原生图片解码接入灰度管线，也未引入 See Now 常驻采集或拼图 |
| 请求计量 / 成本 | 保留 IMe 的 llm/stream 账本、报价快照、预留结算；不叠加 dsh-cost 计费器 | 实际宿主请求和预算不足阻断通过；未知报价不推算费用，hardLimit=false |
| 长期记忆 | 保留 SQLite FTS5、按应用召回、来源分级与候选审核 | 已有回归通过；kovey/dsh-memory 根目录 LICENSE / LICENSE.md / LICENSE.txt 未找到，未复制代码 |
| 技能演化 / 自审 | 保留现有独立验证、不可变版本、复核发布与失败回滚；Continual Harness 作为机制参考 | 已有回归通过，不引入第二个记忆注入器或自动发布器 |
| 模型路由 | 保留现有能力/隐私/预算筛选的路由建议 | 未引入 Alice-Marx 路由器；自动换模型和 V2 学习路由仍未实现 |
| 防循环 / 沙箱 / 子 Agent | 继续沿用官方组合中的相应策略 | 不安装第二套同类底层服务；`ime_status.hostComponents` 报告组合条目是否配置、是否启用，不能代替运行时权限或功能验收 |

## 自动续跑的配置与运行

```yaml
- id: ime-core
  config:
    recovery:
      enabled: true
      maxConsecutive: 3
      minIntervalMs: 1500
# 已安装 qwert702 的界面续写插件时，保留其配置接口，关闭自动发送：
- id: ui-continue-on-limit
  config:
    enabled: false
```

仅接受宿主 `turn/end.data.reason.kind = max-tokens`。默认同一截断链最多自动继续 3 次，间隔至少 1500ms；间隔不足时跳过，不创建定时补发。`maxConsecutive` 范围 1–16，不接受无限续跑；关闭用 `enabled: false`。配置修改在插件重载后生效。

发送必须等 Agent 空闲；随后重新检查 Agent 身份、排队输入、暂停、待审批任务、未验证动作与任务预算。等待期间新输入、新轮次、会话释放或插件卸载均使发送失效。提示标记为 `cordis-host-runner`，不冒充人工授权。每次续跑仍经过原模型预算入口；observe 模式仍只有计量，guarded 才执行报价与预留检查，不新增硬预算承诺。

次数和最后处理轮次写入现有 SQLite 审计事件，重载后读取，但启动时不主动扫描历史截断或自动恢复暂停任务。派发前先消耗一次额度，派发失败不自动返还，避免不确定派发造成重复。正常结束会重置连续次数。`ime_status.autoRecovery` 返回开关、上限、待发送数和已识别冲突。已配置且开启的已知自动续写插件会阻止 IMe 发送，防止双发；未知第三方自动化仍需避免同时启用。

## 源码与许可证核查

具体参考版本、许可证文件哈希见 [integration-sources.json](integration-sources.json)。这是源码研究记录，不是运行时依赖清单；没有把这些社区包加入 package.json。恢复机制参考 aqiu817 项目；其 MIT 声明保留在 [continue-on-limit-LICENSE.txt](continue-on-limit-LICENSE.txt)。其余社区项目未复制实现代码。官方服务仍由宿主提供，版本范围不扩展到最新版。

关键来源：[宿主续跑插件](https://github.com/aqiu817/dsh-plugin-continue-on-limit)、[官方 Session 组件](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session)、[See Now](https://github.com/SAOS-3624/dsh-see-now)、[dsh-cost](https://github.com/zydg/dsh-cost)、[Continual Harness](https://github.com/jasen215/dsh-continual-harness)。

## 本轮验证

`npm run check`：79 项自动测试通过，包含 7 项新增恢复行为测试；严格类型检查与构建通过。

`npm run test:host`：真实 DSH 0.2.1-rc.5 的 13 项检查通过，新增连续截断续跑/熔断和官方 Checkpoint/Token Meter 组合确认。使用隔离 Profile 和模拟 Provider，没有付费推理或真实桌面操作。

原始设计中的真实桌面长任务、真实成本 A/B、Provider 最内层硬预算及 V2 动态学习路由仍待完成，不能因本次整合宣称全部预设能力已完成生产验收。
