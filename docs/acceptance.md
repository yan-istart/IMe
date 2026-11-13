# MVP/V1 开发版验收记录

日期：2026-11-04；本机宿主：DeepSeek Harness 0.2.1-rc.5；代码支持范围锁定此版本。

## 执行结果

| 验证 | 结果与证据 |
| --- | --- |
| 严格类型检查 | src、tests、examples、benchmark 均纳入 typecheck |
| 自动测试 | 53 项；覆盖知识/技能、权限、恢复、预算、模型流、视觉、管理 API 和脚本解析 |
| 真实宿主 | 通过：真实 Loader、工具 JSON Schema、LlmRuntime preparedCall、单调 guard、完整 Agent Loop、pre-step 消息持久化、卸载与重载；桌面及模型为隔离测试 Provider，不调用付费模型 |
| 故障恢复 | 实际子进程 SIGKILL 后 WAL 保留动作及预留；重启 task paused、action uncertain，恢复因未对账被拒绝 |
| 压力回归 | 1000 次模拟动作 / 1000 检查点、100 次混合模型请求、20 次正常关闭后重启 |
| 模拟对比 | 20 组相同模拟任务，A/B/C 均成功20次；C 第二次开始复用已发布技能。B 使用上下文长度代理。金额仅为固定测试报价，不是生产降本结论 |
| 浏览器 UI | 实际打开控制台，完成模拟技能的验证→发布，状态显示已发布；修复 hidden 样式；本机真实 DSH 控制台加载与截图通过 |
| 本机接入 | desktop Profile 保持安装；schema v1/v2 数据保留并迁移 v3；通用安装默认 observe、应用白名单为空。本机微信验收另行启用了官方 Provider 与 2 元 CNY guarded 预算 |
| 默认隐私 | 产品改进 Session Log 默认关闭；真实宿主配置断言通过，本机设置页面已确认关闭 |
| 真实 Provider/模型 | 官方 Cua Driver 已激活，权限检查、窗口发现、置前与截图工具实调用通过；DeepSeek 当前模型的真实 usage 已进入 CNY 账本。微信聊天内容在捕获中不可见，统计业务验收仍未通过 |

## 2026-11-05 增量：回复费用与可编辑设置

- 自动测试 59 项通过；新增回复费用按会话+轮次汇总、设置持久化与校验、桥接 `turn-cost` / `set_cap` / `update_settings`、浏览器 bundle 注册冒烟。
- 真实宿主 smoke 重新通过（10 项检查，`hostCapabilities.modelGateway=true`），报告已刷新。
- 新增「本次回复」费用行：读取 `usage_entries` 与 `request_trace`，区分 actual / unknown / pending / unpriced，未配置报价时只显示 token 数。
- 设置页可编辑预算限额、应用白名单、默认任务预算、预算时区与模型报价；写入 `<dataDir>/settings.json`（0600）并立即生效，额度调整受已计入/预留金额约束，模型没有对应工具。
- 未做真实桌面目视验收：客户端模块更新后需重启 Harness 才会加载新界面。

## 2026-11-05 增量：经验技能累积

- schema v4：`skill_observations`、`experience_traces`、`skill_reviews`；迁移不删除已有任务/账本。
- 技能 ID 改为“应用 + 归一化目标”稳定派生；同一步骤图的重复成功只累积观测，不再每次新建候选。
- 观测按 `(skill,version,task)` 幂等；复核发布要求 ≥`minSuccesses` 次成功、≥2 个 Session、失败率 ≤20%；`autoPublish` 默认关闭。
- 宿主 Computer Use 工具回合以仅元数据方式写入经验轨迹并生成去重的 `procedure`/`failure` 记忆；不保存提示词、输入文本、截图或工具参数正文。
- 控制台新增“经验轨迹”页、技能独立成功/会话数、“复核发布”以及 `/api/export?kind=experience`。
- 自动测试 72 项通过（新增 13 项学习累积回归）；未做真实长任务或跨应用 A/B。累积链路不等于生产验收完成。

自动报告：[host-smoke-report.json](host-smoke-report.json)、[benchmark-report.json](benchmark-report.json)。实际桌面面板截图：[dashboard-native.png](dashboard-native.png)；模拟技能发布截图：[dashboard-qa.png](dashboard-qa.png)。

## 设计用例映射

| 用例 | 验证范围 |
| --- | --- |
| T-01 | 模拟任务首次观察→动作→业务验证→检查点→候选 Skill；真实 DSH Agent Loop 的同等工具链通过 |
| T-02 | 经三例独立验证和人工发布，关闭进程内 Runtime 后重新打开数据库，可检索和复用 Skill |
| T-03 | 环境指纹或前置状态改变时，动作前拒绝并回滚已发布版本 |
| T-04 | 同 Runtime 多 Session 串行；跨 Runtime 锁互斥，租约不按时间过期 |
| T-05 | 并发预留与聚合限额防双花；真实宿主 preparedCall 在预算拒绝后 Adapter 次数不增长 |
| T-06 | 失败、缓存、缺失/无效/部分 usage、取消、迭代器中断，保守结算；unknown 可人工对账 |
| T-07 | 30 秒相同灰度帧不入选，ROI 过滤、关键帧强制保留、限频与脱敏/TTL 通过 |
| T-08 | L1 强约束不被配额裁剪；错误压缩摘要被识别；实际 Agent Loop 持久化 IMe 上下文；真实原生压缩只做委派/接口测试 |
| T-09 | 检查点恢复、actual SIGKILL、uncertain 对账、不可重复旧动作 ID |
| T-10 | 未验证不能发布，验证中不能并发发布，内容被改后哈希拒绝，失败与版本回滚通过 |
| T-11 | 记忆候选不自动进入检索；外部引用无策略权限；模型无审批/提额/发布工具，跨 Session 任务拒绝；直接桌面工具调用被 guard 拦截 |
| T-12 | 停止阻断新动作，取消传给在途 Provider，队列不提前释放；没有真实 Provider 的 P95 统计结论 |
| T-13 | 真实临时 Profile 安装、Loader 禁用/重载、工具移除、数据库关闭及锁释放通过；非所有历史版本迁移 |
| T-14 | 缓存不重复计费、调用价格快照不变、币种不混加、日/会话/账户预算分别计算 |

“通过”指上述明确场景，不外推为整个设计用例在任意真实应用均通过。测试里有意拒绝的调用属于预期结果，不是漏计成功。

## 尚未完成的生产验收

1. 本机已激活官方 Computer Use Provider，并验证 OS 权限、窗口定位/置前与真实截图，但微信聊天窗口在捕获中为空白/不可见，尚未完成全历史统计。此次原生工具预检不等于 IMe 有限动作目录的完整业务闭环；真实跨窗口干扰、业务断言和长期运行仍待验收。详见 wechat-acceptance.md。
2. 当前 DeepSeek 官方价格已配置并按真实 usage 结算；精确输入计费上界、内部重试和最内层 HTTP 拦截仍未建立不可绕过证明。hardLimit=false；没有“零超预算新增请求”的生产保证。缓存写入单独价格仍保守标记 unknown。
3. 原生压缩实调用取决于会话是否提供服务；本次覆盖服务委派与任务快照补回，不覆盖生产模型摘要质量。模型复盘 reporter 与自动路由没有默认绑定生产模型。
4. 20 组基准是一个模拟任务的重复回归，不是设计建议的20类异构任务/不同应用。不包含60–120分钟真实桌面长任务、内存长期趋势、P95停止时间或真实成本/成功率 A/B 实验。
5. V2 动态路由学习、云同步、多设备和 OpenTelemetry 未实现；本项目仍为 private 开发包。

以上是保留的验收缺口，不标记为全部完成或正式 V1 发布。主体模块与可自动执行的受控测试已交付，下一次生产验收应围绕已授权的真实 Provider/目标应用及确认的模型报价开展。
