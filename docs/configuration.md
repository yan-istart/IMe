# 配置与操作说明

插件导出 Standard Schema Config，在加载时校验配置；JSON Schema 供编辑器使用：[config.schema.json](config.schema.json)。实际校验还会检查金额精度、币种一致性、重复模型路由和上下文限制。所有权限与价格配置由用户在 Cordis 层控制，模型没有对应修改工具。

最小配置在 cordis.patch.yml；额外配置写入相应 Profile 的用户 patch，勿覆盖已有内容：

```yaml
- id: ime-core
  config:
    dataDir: ~/.dsh/ime-v1
    allowApps: []
    taskDefaultLimit: '1000000'
    budgetTimezone: Asia/Shanghai
    dashboard:
      enabled: true
      port: 0
    context:
      maxCharacters: 8000
      recentActions: 8
      memoryLimit: 5
      skillLimit: 2
    vision:
      threshold: 0.12
      maxKeyframesPerMinute: 12
      retentionMs: 86400000
      storeFrames: false
```

不要把设计书中的 `ime.storage` 等拟议字段直接复制进此实现。Cordis 使用 disabled 来禁用插件，不使用独立的 enabled 根配置。秘密不写入 patch，余额适配器只读取现有 DEEPSEEK_API_KEY 环境变量；未配置则报告 unavailable。余额来自 [官方 GET /user/balance](https://api-docs.deepseek.com/api/get-user-balance/)，与模型账本独立。

## 预算

modelBudget 字段详见 model-gateway.md。budgetCaps 可设置 session/day/account 多级限额，例如测试报价无关的账户限额：

```yaml
    budgetCaps:
      - scope: account
        key: '*'
        currency: USD
        limit: '5000000'
```

day 的 key 为配置时区中的日期，或 * 作为每日默认值；修改 day * 同时影响今天的限额。session 的 * 用于以后新建的会话桶，已有会话可通过具体 Session ID 修改；account * 是该币种的总账户桶。不能将限额调到已计入及预留金额之下。跨午夜的请求仍按预留时对应日期结算。

设置页与独立控制台都可以管理限额。设置页的修改写入 `<dataDir>/settings.json`（权限 0600，字段 allowApps、taskDefaultLimit、budgetTimezone、modelBudget），同名项优先于插件配置并跨重启保留；删除该文件即可回到插件配置。模型报价必须是 modelBudget 结构（见 [model-gateway.md](model-gateway.md)），留空表示恢复宿主配置；修改只影响之后的请求。模型没有修改限额、白名单或报价的工具，这些写入只能由已登录的同源界面发起。

对话回复末尾显示「本次回复」费用：按会话与轮次汇总 `usage_entries` 中的实际结算金额；仍有预留时显示计费中，未知用量显示不超过预留上限，未配置报价时只显示 token 数。

控制台提供限额管理与 unknown 预留对账。对账输入总量已包含缓存，cachedInputTokens 是其子集，切勿将 DSH 的未缓存输入字段直接当作总量。恢复预算任务前先核对 outstanding 请求；未结算预留不会自动释放。

## 桌面映射

IMe 不创建 Provider，只读取现有 computerUse.providerName 并调用已注册工具。desktopAdapter 必须声明：

- provider、toolPrefix、observeTool、executeTools(click/input/scroll)。这些工具名必须共享明确的前缀；挂载期间同前缀的直接调用会被单调 guard 拒绝，只有 IMe 拥有的调用 ID 可以通过。
- targets：应用名与其静态 observeArgs、fingerprintPath、statePath、actions。路径是结构化 canonical output 中的字符串键数组，结果必须包含字符串环境指纹和状态；不解析未知截图或 OCR 格式。
- actions：用户预先核定的目标名称，每项包含 kind、固定 args、risk、expectedState 和可选 precondition。模型只能选择名称，不能向 Provider 传递任意参数或降低风险。
- 可选 framePath 指向灰度帧对象(width/height/pixels/timestamp)，用于本地视觉筛选；不包含 PNG 解码器。vision.roi / vision.redact 是矩形数组/矩形配置；长期保存仅保留处理后的帧，默认不保存。
- 仅独立测试应用可配置 targets.<app>.evaluation：resetTool 与 cases 参数字典，再在根 evaluation 指定 app 和至少三个不同 case ID。控制台“验证”会重置测试环境并独立执行，不接收模型提交的“通过报告”。不得将生产破坏性操作配置为测试重置。

敏感动作审批绑定完整 Action(含 taskId、actionId、风险、目标、指纹、预期状态)，五分钟过期且单次消耗。批准后可在控制台执行原动作；不要用新的动作 ID 替代已审批对象。环境变化或验证失败产生 uncertain，人工核对后才能恢复。确认未执行的动作也不会自动重放，需建立新的受控动作。

## 记忆、技能与复盘

模型只能提出 candidate 记忆；用户确认和工具证据记录才能进入 active 检索。同主题 factKey 对应不同事实时进入冲突列表，需要人工选择。删除同时清理 FTS 与冲突/主题索引。

成功轨迹可提炼候选技能，但不能直接发布。技能 ID 由“应用 + 归一化目标”稳定派生，同一目标的重复成功运行会累积到同一技能的观测记录，而不是每次新建候选。候选技能有两种发布路径：

1. 配置独立测试环境后，通过至少三个不同用例，再在控制台发布。
2. 累积至少 `learning.minSuccesses`（默认 3）次真实成功运行，且来自至少两个不同 Session、失败比例不高于 20%，然后在控制台“复核发布”。发布仍必须由用户或显式自动发布策略执行，模型没有对应工具。

同一可执行步骤图重复成功时不会新增版本，只增加观测；步骤图变化才产生新候选版本。旧发布版保留，复用失败自动回滚。版本 JSON 文件是发布内容投影，是否可用以数据库状态为准。

学习配置（默认不改变既有行为）：

```yaml
    learning:
      minSuccesses: 3
      autoPublish: false
      captureHostExperience: true
      captureToolPrefixes: []
```

`autoPublish: true` 是用户显式配置的自动发布策略，仍需满足上述累积与失败率门槛。`captureHostExperience` 只记录官方 Computer Use / `cua-driver-native` 等工具的工具名、成功/失败与应用提示，不读取或保存提示词、输入文本、截图和工具参数正文；每个成功或失败回合最多生成一条去重的 `procedure`/`failure` 记忆。可在“经验轨迹”页查看和导出。

规则自审不调用模型，触发于任务成功提炼、两次失败或人工要求。可选模型复盘需由内部受信任 reporter 接口绑定实际模型调用，并提供报价，受单任务 10% 预算、两次上限约束；报告只保存提案，不执行修改。该 reporter 没有默认绑定生产模型。

## 备份与恢复

先禁用插件，等待 dashboard.url 和 runtime.lock 清除，再复制整个 dataDir。保留 SQLite 文件及可能仍存在的 WAL/SHM，不能在运行中只复制主库。恢复到新目录后更改 dataDir，先检查诊断页。v3/v4 增量增加独立表，不删除已有任务/账本；旧版不能理解新模块的状态，所以回滚应用应同时使用对应备份。

## 产品改进日志默认关闭

插件 bundle 为宿主的 `session-log-deepseek` 配置 `enabled: false`。安装后仍应核对 DSH 通用设置中的“在使用官方模型 API 时上传 Session Log”处于关闭状态，已有用户 patch 可能覆盖 bundle 默认值。开启必须由用户明确选择。关闭额外 Session Log 不会阻止正常模型推理发送必要上下文；本机 IMe 审计和费用账本不受影响。

## 自动续跑

`recovery` 支持 `enabled`（默认 true）、`maxConsecutive`（1–16，默认 3）、`minIntervalMs`（0–600000，默认 1500）。仅响应宿主 max-tokens；不会自动恢复暂停或审批任务。详见 [插件整合记录](plugin-integration.md)。
