# 模型请求入口与预算检查

新增宿主 `llm/stream` 适配，已在本机 DSH 0.2.1-rc.5 的真实 LlmRuntime 中验证，包含 preparedCall.stream 路径。保留原宿主 Adapter，不修改已准备请求的 maxTokens 或其他模型配置。

## 默认行为：observe

未配置 `modelBudget` 时，记录请求 ID、Session、Provider、Model、请求状态和最终用量，不记录提示词、工具参数、响应正文或凭据。请求在开始前进入 SQLite；同一事务迁移建立 `model_requests` 与 `model_sessions`，模型请求迁移初始版本为 2，本轮 v3 补充聚合预算与请求关联表，旧的 v1 数据保留。重启将未完成请求标记为 interrupted，预算预留不会因此自动释放。

`ime_status` 新增 `modelGateway`：connected、mode、hardLimit，以及最近 50 条请求。成功完成且有可信用量、但没有价格时，certainty 为 `unpriced`；缺失或无效用量、失败、中途取消则为 `unknown`。不会把未知费用当成零，也不会自动套用测试报价。

DSH 的 inputTokens 是未缓存输入，cacheReadTokens / cacheWriteTokens 是额外的独立输入。转换为 IMe 的输入总量时三者相加，cacheReadTokens 单独作为折扣子集。usage 快照按累计值替换，不相加。reasoningTokens 已包含在 outputTokens 中，不额外计费。

## 配置行为：guarded

`modelBudget` 由用户在 Cordis 配置中提供，也可以在「设置 → IMe 设置 → 模型报价」里以 JSON 修改；保存后写入数据目录的 `settings.json` 并立即对之后的请求生效，已发生的请求保留原报价快照。模型没有修改它的工具。字段：

| 字段 | 含义 |
| --- | --- |
| sessionLimit | 单 Session 限额，币种百万分之一，整数字符串 |
| routes | 精确 provider + model 白名单，不做模糊匹配 |
| routes[].price | version、currency、inputPerMillion、cachedPerMillion、outputPerMillion |
| routes[].inputUpperBound | 由部署者核定的输入 token 上界 |
| routes[].maxOutput | 允许请求声明的最大 maxTokens |
| routes[].validUntil | 可选报价失效时间，过期即在分发前拒绝；用于限定峰谷价格有效窗口 |

每个 Session 自动关联一个持久预算任务；同时在同一事务内检查适用的会话、日、账户聚合限额。未带 sessionId 的辅助请求共用 `ime:auxiliary` 预算，避免无 Session 的请求不计费。自动标题、压缩、自审等只要经过同一宿主入口都会纳入记录；启用 guarded 时，其路由也必须有报价。多币种不能在同一配置中混加。

每次流迭代前：路由精确匹配 → 检查请求 maxTokens 为正整数且不高于配置 → 按保守输入报价预留 → 调用下游。缺失价格、缺失/过大输出上限和预算不足均在调用下游前拒绝。拒绝预算后暂停关联预算任务，不在内部自动重试。宿主重新发出的请求会重新进入门禁。

正常收到 usage 和成功 finish 时结算；缓存写入暂未提供单独定价，所以出现 cacheWriteTokens 时保守维持 unknown 费用。失败或中断按完整预留计为 unknown，不会因部分 usage 提前释放可能已发生的费用。Token 数超出声明上界时，即使金额仍低于预留，也记录越界并暂停预算任务。

## 保证范围

`hardLimit` 始终为 false。官方 middleware 验证了正常宿主分发入口的请求前阻断，但不是 Provider HTTP 传输的不可绕过边界：其他插件可能直接调用 Adapter，后续 middleware 也可能改变请求或绕过当前链。输入上界由配置声明，尚未结合 Provider 精确 tokenizer、视觉 token 与 contextWindow 建立证明。内部重试、非 token 费用、动态路由和 Provider 不遵守上限仍需逐一适配。

因此当前名称是“预算检查 / guarded”，不声称实现绝对硬预算。未配置价格的部署默认 observe；本机微信验收另行配置了当前 DeepSeek 官方路由的 CNY 空闲时报价及失效时间。账本中 actual 表示使用 Provider 用量和配置报价计算，不等于已核对账户扣款。预算管理、恢复及未知费用对账已在管理面板实现；更换报价可由你在设置页完成，模型没有对应工具。对话回复末尾的「本次回复」费用行按 `usage_entries` 汇总该轮实际结算金额；待结算显示计费中，未知用量显示不超过预留上限，未配置报价时只显示 token 数。

## 验证与使用

```sh
npm run check
npm run test:host
```

真实宿主测试使用专门注册的 `ime-smoke-model` Adapter，不进行付费模型推理。测试报价只用于计算断言：首个请求预留 200，最终结算 82；第二个请求因余量不足被拒绝，并断言 Adapter 调用次数没有增长。输出报告位于 `docs/host-smoke-report.json`。

启用真实 guarded 前，应先核实实际 Provider/Model 标识、价格单位、缓存字段和输出控制。不要直接把测试 Provider 或测试价格粘贴进正式桌面配置。模型预算任务中断后保留 paused，需要人工核对账本，再通过管理面板进行验证恢复；没有模型可调用的提额或自动解锁入口。

request_trace 将主请求关联到 IMe taskId、turn、step 和最近 actionId；辅助 purpose 请求不冒用主任务步骤。没有可用关联时字段为 null，不能伪造关联身份。


## 受管模型执行入口

`models.enabled` 打开后，`ime_model_call`、配置的模型复盘和按需视觉通过 `HostModelPort` 调用宿主现有 `prepareCall` / `prepared.stream`。IMe 为每次尝试单独预留、记录 model_requests、结算与写入反馈。由受管执行器拥有的请求对象在 `llm/stream` 中跳过第二次计费；真实 DSH 回归验证只进入 Adapter 一次、只结算一笔。

这不扩大 hardLimit 的声明范围：宿主内层 Provider 的隐藏重试和完整输入计费边界仍由目标适配器决定。配置不足时明确拒绝，不自动改写普通对话模型、凭据或未知上界。


## 自有 HTTP 请求边界

可配置的 `models.http` 为指定文本模型提供一次性预算凭据门禁。它在创建原生 HTTP request/socket 之前校验报价快照、输入字节与 framing 预算、输出上限、任务及祖先状态，并持久化凭据消费；不调用隐式重试 SDK、不跟随重定向。网络失败和中断保留未知账单，只有可证明未进入传输的预检失败可以释放任务/祖先/聚合预留。Provider 违反已配置上界后持久化阻断该路由，只有本机用户可复核解除。

诊断分别列出 requestBoundaryGuard 和作用域 ime-managed-http；hardLimit 仍为 false，因为远端的隐藏处理、超约定收费和其他插件的直接请求不在此发送器控制中。视觉 HTTP 请求在无法证明计费输入边界时明确拒绝，不通过回退旁路发送。
