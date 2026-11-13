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
- 可选 framePath 指向已有灰度帧对象(width/height/pixels/timestamp)；也可用 pngPath 或 attachmentPath 由 IMe 解码 PNG，三者互斥。脱敏 ROI 可编码为 PNG 用于按需模型检查。vision.roi / vision.redact 是矩形数组/矩形配置；长期保存仅保留处理后的帧，默认不保存。
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

规则自审不调用模型，触发于任务成功提炼、两次失败或人工要求。模型复盘可用 `models.review` 绑定宿主现有模型服务，报价来自 `modelBudget`，受原任务 10% 独立配额与两次上限约束；报告只保存提案，不执行修改。默认不启用付费调用。

## 备份与恢复

先禁用插件，等待 dashboard.url 和 runtime.lock 清除，再复制整个 dataDir。保留 SQLite 文件及可能仍存在的 WAL/SHM，不能在运行中只复制主库。恢复到新目录后更改 dataDir，先检查诊断页。v3–v7 增量增加独立表，不删除已有任务/账本；旧版不能理解新模块的状态，所以回滚应用应同时使用对应备份。

## 产品改进日志默认关闭

插件 bundle 为宿主的 `session-log-deepseek` 配置 `enabled: false`。安装后仍应核对 DSH 通用设置中的“在使用官方模型 API 时上传 Session Log”处于关闭状态，已有用户 patch 可能覆盖 bundle 默认值。开启必须由用户明确选择。关闭额外 Session Log 不会阻止正常模型推理发送必要上下文；本机 IMe 审计和费用账本不受影响。

## 自动续跑

`recovery` 支持 `enabled`（默认 true）、`maxConsecutive`（1–16，默认 3）、`minIntervalMs`（0–600000，默认 1500）。仅响应宿主 max-tokens；不会自动恢复暂停或审批任务。详见 [插件整合记录](plugin-integration.md)。


## 受管模型、复盘和视觉

普通对话的模型选择继续由宿主掌握。下列配置只授权 IMe 受管请求；Provider 凭据仍由宿主管理，不复制到 IMe。能力矩阵 `routes` 与报价目录 `modelBudget.routes` 必须使用相同的 provider/model 名称，填入已核实的价格与输入/输出边界。

```yaml
    models:
      enabled: true
      maxAttempts: 2             # 1..3，每次尝试独立预留
      privacyRegion: local      # 必须与 routes 的 privacyRegion 一致
      vision: false             # 另行允许向视觉模型发送脱敏关键帧
      # review:
      #   provider: 已配置的宿主 Provider
      #   model: 已配置的模型
      #   maxOutput: 1024
    adaptiveTaskBudget: false   # 打开后只在既有任务上限内缩减分配
    context:
      maxInjectedTokens: 2000
    learning:
      maintenance: false       # 可自动提炼候选、合并重复图、淘汰无证据旧候选
```

`ime_model_call` 必须引用本会话运行中的任务。请求成功仅记为待验证反馈，业务任务成功后才计入路由正向质量；传输失败的未知账单保留保守费用。输出截断不会当作完整的结构化复盘报告。

`ime_vision_inspect` 先本地观察/分类；只有本地不足或有具体问题，并且 `models.enabled` / `models.vision` 均开启时才调用支持视觉的模型。传给模型的是已脱敏 ROI PNG，重复关键帧与问题复用缓存。Host 附件服务保存的已脱敏图像受宿主自身附件保留策略管理；IMe 的原始采样帧受本机 TTL 控制，不把像素写入记忆、审计或工具结果。

## 多 Provider、视觉采样与窗口策略

可用 `desktopAdapters` 数组配置多种已安装驱动的有限映射。每个 provider 名称唯一；调用时只选宿主当前激活槽位。`desktopAdapter` 单项仍兼容。每个目标可增加：

```yaml
    # desktopAdapter.targets.<app> 中：
    # window: { path: [windowId], allow: [已授权窗口ID] }
    # permissionPath: [desktopPermissionGranted]
    vision:
      sampleFps: 1
      adaptive: true
      stableWindowMs: 300
      # states:
      #   - name: task-panel
      #     regions:
      #       - roi: { x: 0, y: 0, width: 20, height: 20 }
      #         mean: 128
      #         tolerance: 8
```

状态规则是针对明确 ROI 的小型原型分类器，不是通用 OCR 或预训练神经模型；识别到状态切换会强制保留证据。验证帧不受普通变化帧采样限制。合图需要 `storeFrames: true`，在「同步与扩展」生成时间/动作序号标注的本地 PGM 与图例。

## 加密多设备与云端同步

只有添加 `sync` 配置后才能导出或交换同步包。为同一用户的设备注入相同的 32 字节 Base64 AES 密钥，通过环境变量引用，不把密钥写入配置、仓库或日志。

```yaml
    sync:
      namespace: personal-ime
      keyEnv: IME_SYNC_KEY
      # endpoint: https://your-storage.example/ime/encrypted-snapshot
      # authorizationEnv: IME_SYNC_AUTHORIZATION
```

不配置 endpoint 时可通过控制台交换加密包。云端接口需支持 GET、PUT、ETag，以及 If-Match / If-None-Match 条件更新；412/409 表示发生并发写入，重新交换即可，不会覆盖对端版本。远端资料进入待审区，接收后仍为候选记忆/技能，需再次确认或验证发布。远端删除也要在本机明确确认。多版本冲突保留供用户复核，不自动用某一设备覆盖另一设备的已确认知识。

同步只包含知识和技能，不复制授权、预算、凭据、发布信任或截图。远端地址必须是 HTTPS，本机联调允许回环 HTTP；重定向被拒绝。authorizationEnv 存储完整 Authorization 头值，例如由系统密钥工具注入的 Bearer 令牌。

## OTLP、审计轮转与任务编排

```yaml
    telemetry:
      endpoint: http://127.0.0.1:4318/v1/traces
      serviceName: dsh-ime
      # authorizationEnv: IME_OTLP_AUTHORIZATION
      # autoFlushMs: 30000        # 不设置时仅人工发送
    audit:
      maxBytes: 8388608
      retainedFiles: 3
```

遥测按白名单导出任务/会话/动作/请求标识、状态和费用，不发送提示词、截图或输入正文。Collector 拒收、部分拒收或网络失败时保持游标，以便重试；语义为至少一次投递。审计滚动保留当前文件与最多 retainedFiles 个旧段，完整历史仍在 SQLite，可重建导出。

子任务入口为 `ime_subtasks_create` 与 `ime_subtasks_run`，控制台也可提交子任务与已发布技能分配。依赖索引必须指向前面定义的子任务；每组最多 20 个子任务、并发上限 1..8。子任务共享所有祖先的预算约束，无法通过拆分任务扩大总额度。暂停/取消向后代传播，桌面动作始终共享独占租约。

设计覆盖详见 [design-coverage.md](design-coverage.md)。


## HTTP 请求边界与异常熔断

需要由 IMe 控制实际请求发送时，可在 `models.http` 配置已核实的文本模型端点。仅这些 provider/model 的受管请求走该边界；普通 DSH 对话仍使用宿主适配器。

```yaml
    models:
      enabled: true
      maxAttempts: 2
      http:
        - provider: your-provider
          model: your-text-model
          endpoint: https://your-api.example/chat/completions
          credentialEnv: IME_MODEL_API_KEY
          inputOverheadTokens: 64
          maxResponseBytes: 4194304
```

同名 provider/model 仍须配置 `routes` 能力矩阵和 `modelBudget.routes` 价格/输入/输出上界。credentialEnv 仅引用环境中的 API key，代码在请求头中添加 Bearer；不在 patch 中保存密钥。端点使用 [Chat Completions 请求/用量结构](https://api-docs.deepseek.com/api/create-chat-completion/)。

请求在创建 socket 之前校验并消耗数据库中的一次性预留凭据，固化 `max_tokens` 与请求体；禁止重定向，每次显式重试独立占用预算。输入按 UTF-8 字节数加人工核实的 framing 上界进行准入，`inputOverheadTokens` 不是自动精确 tokenizer。视觉计费边界尚不能在此端点证明，图像请求明确拒绝，不回退绕过门禁。

确认未发送的预检失败释放任务、祖先和聚合限额中的预留，不虚构零费用账单。已进入传输、网络失败、进程中断或未知 usage 的请求保留保守费用；不能释放可能已计费的凭据。Provider 返回超界用量时，任务暂停并持久化阻断该路由，用户重新核实价格与边界后才可在「验收与对账」解除熔断。

此功能提供 IMe 自有请求边界的可审计阻断，不代表能约束远端服务器隐藏处理、额外收费或任意其他插件的直接请求；状态继续保留 `hardLimit=false`，同时单列 `requestBoundaryGuard=true` 与 scope。

## PNG 截图接入与技能依赖

目标观察映射可三选一：`framePath`（已有灰度对象）、`pngPath`（PNG Base64 或 data URL）、`attachmentPath`（宿主 AttachmentStore 的图像引用）。后两者将 PNG 解码为灰度，再进入现有脱敏、ROI 与去重管线，不把原始像素放进工具结果。

```yaml
    # desktopAdapter.targets.<app> 中，路径须按已核实的 canonical output 设置：
    # pngPath: [snapshot, pngBase64]
    # 或 attachmentPath: [snapshot, attachment]
```

PNG 支持非交错、8-bit 灰度、RGB、带 alpha 和索引色；校验 CRC、压缩展开长度及像素上限，拒绝未知关键块、损坏和动画。格式依据 [W3C PNG 规范](https://www.w3.org/TR/png-3/)，不猜测其他编码。

技能文档可声明 `dependencies: [{ id: 已发布技能ID, version: 版本号 }]`。发布与每个动作实际派发前均校验依赖状态；库版本被替换/回滚时，依赖者递归退出发布状态。新版本不能依赖同一技能的旧发布版形成无法共存的链；同步时先审核库，再把远端版本引用映射到本机候选版本，仍需独立验证。

## 长任务验收与账户账单核对

控制台「验收与对账」可为运行中的授权任务启动 60–120 分钟只读观察。它只观察和写检查点，不点击、不输入、不调用付费模型，也不自动把业务任务标为成功。报告记录实际进程 RSS/heap、环境变化、检查点与取消耗时；最多 1000 个近期样本保存在有界集合中，SQLite 定期保存进度。崩溃重启标记 interrupted，保留已测样本，不伪装成完整长测。

也可以使用随包提供的 CLI，它读取本机 dashboard.url 的受保护口令，不启动第二个 Runtime、不打印口令：

```sh
npm run acceptance -- status
npm run acceptance -- observe --task TASK_ID --minutes 60 --interval 1000 --wait
npm run acceptance -- report --id REPORT_ID
npm run acceptance -- stop --id REPORT_ID
npm run acceptance -- compare --baseline A1,A2,A3 --candidate B1,B2,B3
npm run acceptance -- reconcile --statement /absolute/path/to/statement.json
```

可用 `--data-dir` 指定运行实例。成本对比要求每组至少三个、等量且互不重叠的已结束任务；核对应用/目标/环境、币种与报价，用所有成功和失败的已记录费用计算单成功任务成本。用量未知或预留未结算时不判定降本通过。30% 门槛用整数交叉乘法判定，不用浮点金额决定通过。

账户账单输入示例：`[{"requestId":"IMe请求ID","statementRef":"账单行唯一引用","currency":"USD","chargedAmount":"120"}]`。金额仍是百万分之一币种。实扣证据与历史报价账本分开保存，显示差额，不改写用量/报价或自动释放未知账单；同一账单行不能重复分配给多个请求。HTTP 结果中的 Provider 请求 ID 会显示在传输诊断中，便于核对。此流程记录人工提供的账单证据，不假称已自动查询账户。
