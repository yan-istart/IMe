# 学习与经验技能累积：实现状态

日期：2026-11-05。范围：`IMe_插件开发设计说明书_v1.0.md` 的 5.5 Memory、5.6 Skill、5.7 Self-Review、5.4 L4 与 F-05/F-06。

## 结论

设计中的**数据模型、技能生命周期、上下文注入和受控复用**此前已经实现；缺的不是“技能表”，而是把一次次真实运行**归并到同一个技能、累积为可发布证据**的闭环。此前每次成功任务都会生成新的随机技能 ID，候选技能没有独立验证环境就永远停在 `candidate`，因此跨会话复用实际上难以发生。

本次已补上“经验技能累积”链路：

- 技能 ID 由“应用 + 归一化目标”稳定派生，重复任务落到同一技能。
- 新增 `skill_observations`，按任务去重地记录真实成功/失败；相同步骤图不再新建版本。
- 候选技能可在累积足够证据后由用户“复核发布”，或由显式 `learning.autoPublish` 策略自动发布。
- 复用成功/失败写回观测；失败仍自动回滚。
- 宿主 Computer Use 工具（官方 `cua-driver-native` 等）的回合轨迹以**仅元数据**方式写入 `experience_traces`，并生成去重的 `procedure`/`failure` 记忆。
- 管理面板新增“经验轨迹”页、技能独立成功/会话数与“复核发布”按钮。

未实现的部分仍在文末列出，没有把“链路打通”外推为生产验收完成。

## 设计项对照

| 设计项 | 此前 | 现在 |
| --- | --- | --- |
| Memory 五种类型、来源分级、FTS/冲突/TTL/删除 | 已实现 | 保留 |
| 成功 Episode 自动写入 | 已实现但重复任务会产生重复记忆 | 同应用同内容去重 |
| 失败经验自动写入 | 仅宿主轨迹 | 宿主轨迹 + 受管任务连续两次动作失败 |
| 技能候选、内容校验、不可变版本、哈希校验 | 已实现 | 保留 |
| 从成功轨迹提炼候选 | 每次任务随机新 ID | 稳定技能 ID + 同步骤图复用版本 |
| 多次同类轨迹的参数化提炼 | 未实现 | 未实现（见缺口） |
| 独立用例验证（至少 3 例） | 已实现，但需配置测试环境 | 保留 |
| 无测试环境时的发布 | 无法发布 | 累积 ≥ `minSuccesses` 次、≥2 个 Session、失败率 ≤20%，由用户复核发布 |
| 自动发布策略 | 无 | 可选 `learning.autoPublish`，默认关闭 |
| 成功率/失败率统计 | 仅 `skill_runs` | 新增独立 `skill_observations`，按任务幂等 |
| 复用前环境/前置校验、逐步断言、失败回滚 | 已实现 | 保留，并写回复用观测 |
| L4 已验证技能注入 | 仅运行中的受管任务，首个动作前无指纹可匹配 | 新增 `ime_observe` 写观察检查点，首个动作前即可匹配；普通宿主会话仍未注入 |
| 失败/成功自审、次数与 10% 预算 | 规则自审已实现 | 保留；模型 reporter 仍无默认绑定 |
| 宿主 Computer Use 经验采集 | 无 | 仅工具名/应用/成败，生成去重记忆 |
| 视觉关键帧/ROI/脱敏/限频 | 已实现 | 保留，不从宿主轨迹保存画面 |
| 经验轨迹查看/导出 | 无 | 控制台“经验轨迹”页 + `/api/export?kind=experience` |

## 累积流程

```text
受管任务成功
  └─ candidate(taskId)
       ├─ skillId = hash(app + normalized(goal))
       ├─ 步骤图签名相同？ ── 是 ──> 复用现有版本
       │                        └─ 否 ──> 新候选版本
       ├─ recordObservation(success)   // 按 taskId 幂等
       ├─ autoPublish 且满足门槛？ ── 是 ──> publishReviewed
       └─ 写入去重 Episode 记忆

宿主回合结束（turn/end）
  └─ ExperienceRecorder.finalize
       ├─ 仅保留 Computer Use 工具名 + 应用提示 + 成败
       ├─ experience_traces（不保存提示词/输入文本/截图）
       └─ 去重 procedure / failure 记忆（tool_verified + 审计事件证据）
```

复用路径：新建受管任务 → `ime_observe` 读取当前环境并写入检查点 → L4/`ime_skill_search` 匹配已发布技能 → `ime_skill_run` 或按 `ime_execute` 执行 → 环境指纹/前置状态校验 → 逐步断言 → 成功写回观测，失败自动回滚。`ime_observe` 是必要的：它让新任务在第一个动作前就有可匹配的环境指纹，也让模型拿到 `ime_execute` 所需的 fingerprint/expectedState。

## 参考组件的取舍

本地没有 `dsh-see-now`、`dsh-evolution`、`dsh-continual-harness` 的源码副本，网络也不可达，因此没有复制第三方代码；按其公开设计与本仓库既有实现对齐：

- **官方 Computer Use / `dsh-computer-use`**：继续只复用一个已注册 Provider，不注册第二个桌面 Provider；只读取 `tools/result` 的元数据，不接管宿主执行。
- **`dsh-see-now`**：视觉筛选、ROI、关键帧、限频和脱敏沿用 IMe 自有 `vision-pipeline`；不把原始帧写入长期记忆。
- **`dsh-evolution`**：技能不可变版本、候选→验证→发布、修订/回滚；新增观测累积与人工复核发布，避免一次偶然成功形成技能。
- **`dsh-continual-harness`**：`agent/pre-step` 注入、受限复盘、失败回滚、按任务统计；复盘仍最多两次，自动发布默认关闭。

## 数据与接口

schema v4 新增：

- `skill_observations(skill_id, version, task_id, session_id, outcome, evidence_refs, created_at)`，`(skill_id,version,task_id)` 唯一。
- `experience_traces(session_id, turn, app, outcome, tool_count, failure_count, steps, created_at)`。
- `skill_reviews(skill_id, version, decision, note, created_at)`。

控制台命令：

- `skill_review_publish { id, version, note? }`：仅候选、仅满足累积门槛、仅本机已认证控制台。
- `skill_publish { id, version }`：仍要求独立用例验证通过。
- `skill_evaluate { id, version }`：独立测试环境用例验证。

模型工具没有发布、提额、改白名单或修改学习策略的能力。

## 配置

```yaml
learning:
  minSuccesses: 3          # 2..20
  autoPublish: false       # 默认关闭
  captureHostExperience: true
  captureToolPrefixes: []  # 额外的 Computer Use 工具前缀
```

## 验证

```sh
npm run typecheck
npm test                  # 72 项，含 13 项学习累积回归
npm run build
```

## 仍未完成

1. **多轨迹参数化提炼**：目前只归并“相同步骤图”的运行；不同坐标/输入但同一业务目标的轨迹还不会抽象成参数化动作。
2. **A/B 与自动禁用**：没有新版/稳定版并行 A/B；失败会回滚，但没有按成功率的长期监控与自动降级。
3. **普通宿主会话的 L4 注入**：不创建 IMe 任务的会话不会自动注入已发布技能；宿主技能采集也只生成记忆，不生成可执行技能。
4. **模型复盘默认绑定**：`SelfReview` 的模型 reporter 仍是可选接口，没有默认生产模型绑定。
5. **向量检索与跨设备同步**：仍属 V2，未实现。

这些缺口不应被“累积链路已打通”掩盖；真实桌面、长任务和成本结论仍以 `acceptance.md` 的边界为准。
