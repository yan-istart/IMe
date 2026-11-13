# 实现进度

当前为 MVP/V1 开发版，范围和外部依赖边界见 README 与 acceptance.md；不能据此宣称全部生产验收通过。

| 设计任务 | 实现与验证 |
| --- | --- |
| P0-01–05 | TypeScript 包、bundle、Standard Schema 配置、JSON Schema、能力探测、版本/许可证记录；本机 DSH 0.2.1-rc.5 装卸通过 |
| IMe-101 | SQLite WAL、schema v1→v2→v3→v4、事务/outbox、JSONL、崩溃恢复、导出 |
| IMe-102 | 实际模型流入口、四级限额、预留/结算/未知费用对账、缓存/币种/价格快照、余额接口；HTTP 最内层硬预算未验证 |
| IMe-103 | 现有 Provider 工具适配、有限动作目录、应用白名单、跨进程租约、审批、停止与取消；直接工具绕过被 guard 阻止 |
| IMe-104 | 可选帧接入、ROI/脱敏/TTL/关键帧/限频；真实采集驱动由已有 Provider 供给 |
| IMe-105 | 状态机、检查点、uncertain 人工对账、恢复前校验；实际 SIGKILL 测试通过 |
| IMe-106 | Agent pre-step L1/L2 + L3/L4 召回、配额、任务不变量；原生压缩委派与独立快照补回 |
| IMe-107 | 受保护的本机控制台，费用/预算/任务/审批/恢复/记忆/技能/审计/诊断 |
| IMe-108 | 模拟闭环、真实 DSH Agent Loop 使用隔离桌面工具、1000 动作/100 请求/20 重启基准、安装操作说明 |
| IMe-201 | Memory FTS5、应用/TTL/信任隔离、同主题冲突、归档/删除/导出 |
| IMe-202–203 | 稳定技能归并、观测累积、候选与版本存储、内容校验、独立验证、前置条件与逐步断言 Runner |
| IMe-204 | 规则复盘/阈值/两次上限；失败经验记忆；可选模型 reporter 的独立 10% 配额 |
| IMe-205 | 人工/累积复核发布、修订/回滚、成功失败统计；宿主 Computer Use 经验轨迹；模拟 A/B 报告，生产实验仍待完成 |
| IMe-206–207 | 上下文配额与不变量、检索工具、管理 UI 和数据导出 |

V2 的动态学习路由、向量混合检索、云同步、多设备和 OTel 尚未实现。当前固定三档路由器提供受约束建议，不自动修改用户当前模型。

业务动作完成以同一事务更新动作状态、检查点和 outbox。模型结算原子更新任务/聚合预算、账本、预留和事件。JSONL 是可重建投影，目前关闭/启动完整导出，未实现在线增量轮转。发布 Skill 文件同样是数据库的内容投影。

验收记录应以当前自动测试、host-smoke-report.json、benchmark-report.json 和 acceptance.md 为准；较早的 desktop-integration-report.json、model-gateway-desktop-report.json 保留为历史接入证据，不反映全部新增功能。

2026-11-05：补充宿主 max-tokens 自动续跑、持久化次数限制、发送前状态检查、外部续写冲突避让和宿主组件诊断。新增 7 项恢复测试和真实宿主截断链测试；插件取舍与未完成验收见 [plugin-integration.md](plugin-integration.md)。
