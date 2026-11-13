/* IMe visual interface: sidebar entry and a Status / Settings panel. */
window.__ModuleLoader__.load({
  id: 'dsh-ime',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'ime';

    const CSS = `
.ime-page{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.ime-header{flex:none;padding:calc(26px + var(--dsh-frame-top-clearance,0px)) clamp(24px,4vw,48px) 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.ime-header-inner{max-width:960px;margin:0 auto}
.ime-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ime-title{font-size:20px;font-weight:500;line-height:28px;margin:0}
.ime-subtitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:2px 0 0}
.ime-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px}
.ime-updated{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ime-tabs{display:flex;gap:28px;margin-top:18px}
.ime-tab{position:relative;border:0;background:none;margin:0;padding:9px 0 11px;font:inherit;font-size:14px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ime-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ime-tab[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-.5px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.ime-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;padding:24px clamp(24px,4vw,48px) 48px}
.ime-body{max-width:960px;margin:0 auto}
.ime-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin-bottom:26px}
.ime-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px}
.ime-card-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.ime-card-value{font-size:28px;line-height:36px;font-weight:500;margin-top:2px}
.ime-section{margin-top:28px}
.ime-section:first-child{margin-top:0}
.ime-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.ime-section-title{font-size:15px;font-weight:500;line-height:24px;margin:0}
.ime-section-hint{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0;max-width:640px}
.ime-panel{border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ime-row{display:flex;gap:16px;align-items:flex-start;padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);min-width:0}
.ime-row:last-child{border-bottom:0}
.ime-row-main{flex:1;min-width:0}
.ime-row-title{font-size:14px;line-height:22px;overflow-wrap:anywhere}
.ime-row-sub{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ime-row-side{flex:none;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;padding-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ime-badge{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap}
.ime-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.ime-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.ime-badge[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.ime-badge[data-tone="idle"]{color:var(--dsw-alias-state-idle-primary)}
.ime-empty{padding:26px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.ime-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px}
.ime-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-decoration:none;cursor:pointer}
.ime-button:hover{background:var(--dsw-alias-bg-layer-2)}
.ime-button:disabled{opacity:.5;cursor:default}
.ime-button[data-variant="primary"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ime-button[data-variant="danger"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ime-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.ime-link:hover{text-decoration:underline}
.ime-notice{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;margin-bottom:18px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.ime-notice[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.ime-notice[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.ime-kv{display:grid;grid-template-columns:minmax(120px,180px) 1fr}
.ime-kv>div{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:13px;line-height:20px;min-width:0}
.ime-kv>div:nth-last-child(-n+2){border-bottom:0}
.ime-kv-key{color:var(--dsw-alias-label-secondary)}
.ime-kv-value{overflow-wrap:anywhere}
.ime-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.ime-chips{display:flex;flex-wrap:wrap;gap:6px}
.ime-chip{font-size:12px;line-height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ime-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;padding:16px;border-top:.5px solid var(--dsw-alias-border-l1)}
.ime-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.ime-field>span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.ime-input,.ime-select{box-sizing:border-box;height:32px;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 8px}
.ime-textarea{box-sizing:border-box;width:100%;min-height:132px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;padding:8px;resize:vertical}
.ime-input:focus,.ime-select:focus,.ime-button:focus-visible,.ime-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ime-form-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-end;gap:8px}
.ime-switch{appearance:none;position:relative;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.ime-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.ime-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.ime-switch[aria-checked="true"]::after{transform:translateX(16px);background:var(--dsw-alias-bg-base)}
.ime-advanced{margin-top:24px}
.ime-time{white-space:nowrap}
.ime-settings{padding:0 0 24px}
.ime-settings-intro{max-width:640px;margin:0 0 22px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.ime-turn-cost{display:flex;align-items:center;gap:6px;margin:8px 0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);user-select:none}
.ime-turn-cost[data-certainty="actual"]{color:var(--dsw-alias-label-secondary)}
.ime-turn-cost[data-certainty="unknown"],.ime-turn-cost[data-certainty="pending"]{color:var(--dsw-alias-state-warn-primary)}
.ime-turn-cost-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.ime-form-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:auto}
@media (max-width:560px){.ime-kv{grid-template-columns:1fr}.ime-kv-key{padding-bottom:0;border-bottom:0}.ime-kv-value{padding-top:2px}.ime-row{flex-wrap:wrap}.ime-row-side{width:100%;justify-content:flex-start}}
`;

    const zh = {
      'panel.label': 'IMe',
      'panel.title': 'IMe',
      'panel.subtitle': '本地优先的记忆与执行',
      'panel.status': 'IMe 状态',
      'panel.settings': 'IMe 设置',
      'tab.status': '状态',
      'tab.settings': '设置',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.pauseAll': '暂停全部',
      'action.resumeAll': '重新允许执行',
      'action.saveCap': '保存限额',
      'action.copyDiagnostics': '复制诊断',
      'action.openDashboard': '打开独立控制台',
      'action.openStatus': '打开 IMe 状态',
      'action.reload': '刷新页面',
      'updated': '更新于 {time}',
      'loading': '加载中…',
      'error.auth': '登录状态已失效，请刷新页面后重试。',
      'error.bridge': '界面桥接不可用。请确认 IMe 插件已启用，然后刷新页面。',
      'error.network': '无法连接 Harness。请检查页面连接后重试。',
      'error.generic': '操作失败：{message}',
      'error.invalid_cap': '限额必须是非负整数。',
      'error.cap_below_commitments': '限额不能低于已计入与预留金额。',
      'error.invalid_scope': '范围无效。',
      'error.invalid_currency': '币种必须是三位大写字母。',
      'error.invalid_key': '请填写标识。',
      'error.invalid_task_limit': '任务预算必须是非负整数。',
      'error.invalid_timezone': '时区无效，请填写 IANA 时区，例如 Asia/Shanghai。',
      'error.invalid_settings': '设置内容无效。',
      'error.invalid_allow_apps': '应用名单无效。',
      'error.invalid_model_budget': '模型报价配置无效。',
      'error.invalid_model_route': '模型路由无效，请检查 provider、model、价格与上界。',
      'error.duplicate_model_route': '同一 provider 与 model 只能有一条路由。',
      'error.mixed_budget_currencies': '所有路由必须使用同一币种。',
      'error.invalid_price_expiry': '价格有效期格式无效。',
      'error.invalid_money': '金额必须是非负整数字符串。',
      'error.invalid_turn': '轮次信息无效。',
      'error.unknown_command': '不支持的操作。',
      'turnCost.label': '本次回复',
      'turnCost.actual': '{amount}',
      'turnCost.unknown': '≤ {amount}（待确认）',
      'turnCost.pending': '计费中…',
      'turnCost.unpriced': '未配置报价 · {tokens} tokens',
      'turnCost.detail': '本次回复 {amount}；输入 {input} · 缓存 {cached} · 输出 {output} tokens。',
      'status.cards.running': '执行中任务',
      'status.cards.memories': '生效记忆',
      'status.cards.skills': '技能版本',
      'status.cards.approvals': '待审批',
      'status.summary.title': '运行概况',
      'status.gateway': '模型预算',
      'status.gateway.observe': '仅记录用量',
      'status.gateway.guarded': '预算检查已启用',
      'status.gateway.unavailable': '未连接模型入口',
      'status.hardLimit': '硬预算保证',
      'status.hardLimit.verified': '已验证',
      'status.hardLimit.unverified': '尚未验证',
      'status.desktop': '桌面控制',
      'status.desktop.available': '可用',
      'status.desktop.unavailable': '不可用',
      'status.dashboard': '独立控制台',
      'status.dashboard.available': '运行中',
      'status.dashboard.unavailable': '未运行',
      'status.actions.title': '人工操作',
      'status.actions.hint': '这些操作只由你在这里执行，模型没有对应工具。',
      'status.actionDone': '操作已完成。',
      'status.budget.title': '预算限额',
      'status.budget.empty': '尚未设置预算限额。',
      'status.tasks.title': '最近任务',
      'status.tasks.empty': '暂无任务。',
      'status.approvals.title': '待处理审批',
      'status.approvals.empty': '没有待处理审批。',
      'status.trace.title': '最近审计事件',
      'status.trace.empty': '暂无审计事件。',
      'status.requests.title': '最近模型请求',
      'status.requests.empty': '暂无模型请求。',
      'status.capabilities.title': '宿主能力',
      'status.settingsHint': '界面偏好与宿主配置在「设置 → IMe 设置」中。',
      'settings.interface.title': '界面',
      'settings.intro': '界面偏好、预算限额与宿主配置。修改会立即生效，并写入数据目录下的本地设置文件。',
      'settings.autoRefresh': '自动刷新',
      'settings.autoRefresh.hint': '每隔 {seconds} 秒刷新状态。',
      'settings.autoRefresh.offHint': '不会自动刷新。',
      'settings.autoRefresh.off': '关闭',
      'settings.seconds': '{seconds} 秒',
      'settings.advanced': '显示高级诊断',
      'settings.advanced.hint': '在状态页显示审计事件、模型请求和宿主能力。',
      'settings.budget.title': '预算限额',
      'settings.budget.hint': '限额按会话、当日或账户设置，保存后立即生效；已计入与预留金额不能被调低。',
      'settings.budget.disabled': '尚未设置限额。',
      'settings.budget.readonly': '限额不能低于已计入与预留金额；模型没有修改限额的工具。',
      'settings.cap.form': '新增或更新限额',
      'settings.cap.add': '新增限额',
      'settings.cap.edit': '编辑',
      'settings.scope': '范围',
      'settings.scope.session': '会话',
      'settings.scope.day': '当日',
      'settings.scope.account': '账户',
      'settings.key': '标识',
      'settings.key.hint': '* 表示默认；会话范围填写会话标识。',
      'settings.currency': '币种',
      'settings.limit': '限额（百万分之一）',
      'settings.saved': '限额已保存。',
      'settings.key.invalid': '请填写标识，* 表示默认。',
      'settings.host.title': '宿主配置',
      'settings.host.hint': '应用白名单、默认任务预算与预算时区可在此修改；保存后写入本地设置文件并立即生效。模型价格由宿主配置文件控制。',
      'settings.host.apps': '授权应用（逗号分隔）',
      'settings.host.appsHint': '留空表示不允许桌面应用。',
      'settings.host.save': '保存配置',
      'settings.host.saved': '宿主配置已保存。',
      'settings.host.override': '界面修改会覆盖插件配置中的同名项，重启后仍然有效。',
      'settings.allowApps': '授权应用',
      'settings.allowApps.empty': '未配置（不允许桌面应用）',
      'settings.taskLimit': '默认任务预算',
      'settings.timezone': '预算时区',
      'settings.modelBudget': '模型预算',
      'settings.modelBudget.none': '未配置报价，仅记录用量',
      'settings.modelBudget.title': '模型报价',
      'settings.modelBudget.editHint': '按你自己核定的价格填写 JSON 后保存即可按真实用量计价；占位示例不是真实报价。留空表示恢复宿主配置。保存后新的请求立即按新报价预留与结算，已发生的费用不变。',
      'settings.modelBudget.json': '报价 JSON',
      'settings.modelBudget.placeholder': '{"sessionLimit":"2000000","routes":[{"provider":"deepseek-official","model":"deepseek-flash","inputUpperBound":100000,"maxOutput":8192,"price":{"version":"2026-01","currency":"CNY","inputPerMillion":"2000000","cachedPerMillion":"500000","outputPerMillion":"8000000"}}]}',
      'settings.modelBudget.save': '保存报价',
      'settings.modelBudget.saved': '模型报价已保存。',
      'settings.modelBudget.invalid': 'JSON 无法解析。',
      'settings.modelBudget.gateway': '模型入口不可用，报价会保存到本地并在下次启动时生效。',
      'settings.modelBudget.routes': '{routes} 条路由 · 会话限额 {limit}',
      'settings.dataDir': '数据目录',
      'settings.dashboard.title': '独立控制台',
      'settings.dashboard.hint': '独立控制台提供完整的记忆、技能、审批与诊断页面。',
      'settings.dashboard.unavailable': '独立控制台未运行。',
      'settings.about.title': '关于',
      'settings.bridge': '界面桥接',
      'settings.bridge.ready': '已连接',
      'settings.bridge.missing': '未连接',
      'settings.security': '敏感动作审批、权限和预算上限只由宿主配置或你的人工操作改变；模型没有修改这些值的工具。',
      'settings.copy.copied': '诊断信息已复制。',
      'settings.copy.failed': '复制失败，请检查浏览器权限。',
      'unit.micro': '百万分之一币种单位',
      'label.app': '应用',
      'label.status': '状态',
      'label.updated': '更新时间',
      'label.scope': '范围',
      'label.key': '标识',
      'label.currency': '币种',
      'label.limit': '限额',
      'label.spent': '已计入',
      'label.reserved': '预留',
      'label.event': '事件',
      'label.type': '类型',
      'label.provider': '提供方',
      'label.model': '模型',
      'label.expires': '过期时间',
      'label.risk': '风险',
      'state.running': '执行中',
      'state.paused': '已暂停',
      'state.succeeded': '已完成',
      'state.failed': '失败',
      'state.cancelled': '已取消',
      'state.created': '待准备',
      'state.ready': '待运行',
      'state.waiting_approval': '待审批',
      'state.recovering': '恢复中',
      'state.pending': '待处理',
      'state.approved': '已批准',
      'state.denied': '已拒绝',
      'state.active': '生效',
      'state.candidate': '候选',
      'state.archived': '已归档',
      'state.verified': '已验证',
      'state.published': '已发布',
      'state.deprecated': '已弃用',
      'state.rolled_back': '已回滚',
      'state.actual': '按已知用量计费',
      'state.unpriced': '价格未知',
      'state.unknown': '待确认',
      'state.streaming': '调用中',
      'state.finished': '已结束',
      'state.interrupted': '已中断',
    };
    const en = {
      'panel.label': 'IMe',
      'panel.title': 'IMe',
      'panel.subtitle': 'Local-first memory and execution',
      'panel.status': 'IMe status',
      'panel.settings': 'IMe settings',
      'tab.status': 'Status',
      'tab.settings': 'Settings',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.pauseAll': 'Pause all',
      'action.resumeAll': 'Allow execution',
      'action.saveCap': 'Save limit',
      'action.copyDiagnostics': 'Copy diagnostics',
      'action.openDashboard': 'Open dashboard',
      'action.openStatus': 'Open IMe status',
      'action.reload': 'Reload page',
      'updated': 'Updated {time}',
      'loading': 'Loading…',
      'error.auth': 'Your session expired. Reload the page and try again.',
      'error.bridge': 'The UI bridge is unavailable. Confirm the IMe plugin is enabled, then reload the page.',
      'error.network': 'Cannot reach Harness. Check the page connection and try again.',
      'error.generic': 'Operation failed: {message}',
      'error.invalid_cap': 'The limit must be a non-negative integer.',
      'error.cap_below_commitments': 'The limit cannot be below spent and reserved amounts.',
      'error.invalid_scope': 'Invalid scope.',
      'error.invalid_currency': 'The currency must be three uppercase letters.',
      'error.invalid_key': 'Provide a key.',
      'error.invalid_task_limit': 'The task budget must be a non-negative integer.',
      'error.invalid_timezone': 'Invalid timezone; use an IANA zone such as Asia/Shanghai.',
      'error.invalid_settings': 'Invalid settings.',
      'error.invalid_allow_apps': 'Invalid app list.',
      'error.invalid_model_budget': 'Invalid model price configuration.',
      'error.invalid_model_route': 'Invalid route; check provider, model, prices, and bounds.',
      'error.duplicate_model_route': 'Each provider/model pair may appear once.',
      'error.mixed_budget_currencies': 'All routes must share one currency.',
      'error.invalid_price_expiry': 'Invalid price expiry.',
      'error.invalid_money': 'Amounts must be non-negative integer strings.',
      'error.invalid_turn': 'Invalid turn.',
      'error.unknown_command': 'Unsupported operation.',
      'turnCost.label': 'This reply',
      'turnCost.actual': '{amount}',
      'turnCost.unknown': '≤ {amount} (unconfirmed)',
      'turnCost.pending': 'Billing…',
      'turnCost.unpriced': 'No price configured · {tokens} tokens',
      'turnCost.detail': 'This reply {amount}; {input} input · {cached} cached · {output} output tokens.',
      'status.cards.running': 'Running tasks',
      'status.cards.memories': 'Active memories',
      'status.cards.skills': 'Skill versions',
      'status.cards.approvals': 'Pending approvals',
      'status.summary.title': 'Runtime summary',
      'status.gateway': 'Model budget',
      'status.gateway.observe': 'Observing usage only',
      'status.gateway.guarded': 'Budget checks enabled',
      'status.gateway.unavailable': 'Model entry unavailable',
      'status.hardLimit': 'Hard budget guarantee',
      'status.hardLimit.verified': 'Verified',
      'status.hardLimit.unverified': 'Not verified',
      'status.desktop': 'Desktop control',
      'status.desktop.available': 'Available',
      'status.desktop.unavailable': 'Unavailable',
      'status.dashboard': 'Standalone dashboard',
      'status.dashboard.available': 'Running',
      'status.dashboard.unavailable': 'Not running',
      'status.actions.title': 'User actions',
      'status.actions.hint': 'Only you can run these here; the model has no matching tools.',
      'status.actionDone': 'Operation completed.',
      'status.budget.title': 'Budget limits',
      'status.budget.empty': 'No budget limits yet.',
      'status.tasks.title': 'Recent tasks',
      'status.tasks.empty': 'No tasks yet.',
      'status.approvals.title': 'Pending approvals',
      'status.approvals.empty': 'No pending approvals.',
      'status.trace.title': 'Recent audit events',
      'status.trace.empty': 'No audit events yet.',
      'status.requests.title': 'Recent model requests',
      'status.requests.empty': 'No model requests yet.',
      'status.capabilities.title': 'Host capabilities',
      'status.settingsHint': 'Interface preferences and host configuration live in Settings → IMe settings.',
      'settings.interface.title': 'Interface',
      'settings.intro': 'Interface preferences, budget limits, and host configuration. Changes apply immediately and are written locally.',
      'settings.autoRefresh': 'Auto-refresh',
      'settings.autoRefresh.hint': 'Refresh status every {seconds} seconds.',
      'settings.autoRefresh.offHint': 'No automatic refresh.',
      'settings.autoRefresh.off': 'Off',
      'settings.seconds': '{seconds}s',
      'settings.advanced': 'Show advanced diagnostics',
      'settings.advanced.hint': 'Show audit events, model requests, and host capabilities on the Status tab.',
      'settings.budget.title': 'Budget limits',
      'settings.budget.hint': 'Set limits per session, day, or account. Saving applies immediately; limits cannot drop below spent and reserved amounts.',
      'settings.budget.disabled': 'No limits yet.',
      'settings.budget.readonly': 'A limit cannot be lower than spent and reserved amounts; the model has no tool for changing limits.',
      'settings.cap.form': 'Create or update a limit',
      'settings.cap.add': 'New limit',
      'settings.cap.edit': 'Edit',
      'settings.scope': 'Scope',
      'settings.scope.session': 'Session',
      'settings.scope.day': 'Day',
      'settings.scope.account': 'Account',
      'settings.key': 'Key',
      'settings.key.hint': '* means default; use a session id for the session scope.',
      'settings.currency': 'Currency',
      'settings.limit': 'Limit (millionths)',
      'settings.saved': 'Limit saved.',
      'settings.key.invalid': 'Provide a key; * means the default.',
      'settings.host.title': 'Host configuration',
      'settings.host.hint': 'App allowlist, default task budget, and budget timezone can be changed here; saving writes a local settings file and applies immediately. Model prices stay host-owned.',
      'settings.host.apps': 'Allowed apps (comma separated)',
      'settings.host.appsHint': 'Leave empty to forbid desktop apps.',
      'settings.host.save': 'Save configuration',
      'settings.host.saved': 'Host configuration saved.',
      'settings.host.override': 'A change here overrides the same field in the plugin configuration and survives a restart.',
      'settings.allowApps': 'Allowed apps',
      'settings.allowApps.empty': 'Not configured (no desktop app allowed)',
      'settings.taskLimit': 'Default task budget',
      'settings.timezone': 'Budget timezone',
      'settings.modelBudget': 'Model budget',
      'settings.modelBudget.none': 'No price configuration; usage is observed only',
      'settings.modelBudget.title': 'Model prices',
      'settings.modelBudget.editHint': 'Save JSON with prices you verified yourself; the placeholder is not real pricing. Empty restores the host configuration. New requests reserve and settle under the new prices immediately; historical costs are unchanged.',
      'settings.modelBudget.json': 'Price JSON',
      'settings.modelBudget.placeholder': '{"sessionLimit":"2000000","routes":[{"provider":"deepseek-official","model":"deepseek-flash","inputUpperBound":100000,"maxOutput":8192,"price":{"version":"2026-01","currency":"CNY","inputPerMillion":"2000000","cachedPerMillion":"500000","outputPerMillion":"8000000"}}]}',
      'settings.modelBudget.save': 'Save prices',
      'settings.modelBudget.saved': 'Model prices saved.',
      'settings.modelBudget.invalid': 'The JSON cannot be parsed.',
      'settings.modelBudget.gateway': 'The model entry is unavailable; prices are stored and take effect on next start.',
      'settings.modelBudget.routes': '{routes} routes · session limit {limit}',
      'settings.dataDir': 'Data directory',
      'settings.dashboard.title': 'Standalone dashboard',
      'settings.dashboard.hint': 'The standalone dashboard provides full memory, skill, approval, and diagnostics pages.',
      'settings.dashboard.unavailable': 'The standalone dashboard is not running.',
      'settings.about.title': 'About',
      'settings.bridge': 'UI bridge',
      'settings.bridge.ready': 'Connected',
      'settings.bridge.missing': 'Not connected',
      'settings.security': 'Sensitive approvals, permissions, and budget limits change only through host configuration or your actions; the model has no tools for them.',
      'settings.copy.copied': 'Diagnostics copied.',
      'settings.copy.failed': 'Copy failed; check browser permissions.',
      'unit.micro': 'millionths of a currency unit',
      'label.app': 'App',
      'label.status': 'Status',
      'label.updated': 'Updated',
      'label.scope': 'Scope',
      'label.key': 'Key',
      'label.currency': 'Currency',
      'label.limit': 'Limit',
      'label.spent': 'Spent',
      'label.reserved': 'Reserved',
      'label.event': 'Event',
      'label.type': 'Type',
      'label.provider': 'Provider',
      'label.model': 'Model',
      'label.expires': 'Expires',
      'label.risk': 'Risk',
      'state.running': 'Running',
      'state.paused': 'Paused',
      'state.succeeded': 'Succeeded',
      'state.failed': 'Failed',
      'state.cancelled': 'Cancelled',
      'state.created': 'Created',
      'state.ready': 'Ready',
      'state.waiting_approval': 'Waiting approval',
      'state.recovering': 'Recovering',
      'state.pending': 'Pending',
      'state.approved': 'Approved',
      'state.denied': 'Denied',
      'state.active': 'Active',
      'state.candidate': 'Candidate',
      'state.archived': 'Archived',
      'state.verified': 'Verified',
      'state.published': 'Published',
      'state.deprecated': 'Deprecated',
      'state.rolled_back': 'Rolled back',
      'state.actual': 'Known usage',
      'state.unpriced': 'Unpriced',
      'state.unknown': 'Unconfirmed',
      'state.streaming': 'Streaming',
      'state.finished': 'Finished',
      'state.interrupted': 'Interrupted',
    };

    const PREF_KEY = 'ime.ui.v1';

    function readPrefs() {
      try {
        const value = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
        const refreshMs = [0, 5000, 15000, 60000].includes(value && value.refreshMs) ? value.refreshMs : 15000;
        return { refreshMs, advanced: Boolean(value && value.advanced) };
      } catch {
        return { refreshMs: 15000, advanced: false };
      }
    }

    function savePrefs(prefs) {
      try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* storage may be disabled */ }
    }

    async function call(path, init) {
      let response;
      try {
        response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
      } catch (cause) {
        const error = new Error('NETWORK');
        error.cause = cause;
        throw error;
      }
      const raw = await response.text();
      let body = null;
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = null; }
      }
      if (!response.ok) {
        const code = body && typeof body.error === 'string' ? body.error : 'HTTP_' + response.status;
        const error = new Error(code);
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function errorText(t, error) {
      if (error && error.status === 401) return t('error.auth');
      if (error && (error.status === 404 || error.message === 'NETWORK')) return t('error.bridge');
      const message = error instanceof Error ? error.message : String(error);
      const key = 'error.' + message.toLowerCase();
      const translated = t(key);
      if (translated !== key) return translated;
      return t('error.generic', { message });
    }

    function formatTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      try {
        return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(date);
      } catch {
        return date.toISOString();
      }
    }

    function formatMoney(value, currency) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return '—';
      const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
      if (code) {
        try {
          return new Intl.NumberFormat(undefined, {
            style: 'currency', currency: code, maximumFractionDigits: 6,
          }).format(amount / 1e6);
        } catch { /* fall through */ }
      }
      return (amount / 1e6).toFixed(2) + (code ? ' ' + code : '');
    }

    function stateLabel(t, value) {
      const key = 'state.' + String(value);
      const text = t(key);
      return text === key ? String(value || '—') : text;
    }

    function statusTone(value) {
      if (['succeeded', 'active', 'published', 'verified', 'finished', 'actual', 'approved'].includes(value)) return 'ok';
      if (['failed', 'denied', 'cancelled', 'error', 'interrupted'].includes(value)) return 'error';
      if (['paused', 'waiting_approval', 'candidate', 'unknown', 'unpriced', 'pending', 'recovering'].includes(value)) return 'warn';
      return 'idle';
    }

    function formatCount(value) {
      const amount = Number(value);
      return Number.isFinite(amount) ? new Intl.NumberFormat().format(amount) : '—';
    }

    /**
     * Per-reply cost line rendered at the end of an assistant turn.
     *
     * The amount comes from the IMe ledger (usage entries joined to the request
     * trace), never from an estimate: an unpriced or open request is labelled
     * instead of being folded into a precise-looking number.
     */
    function TurnCostBadge(props) {
      const t = props.t || ((key) => key);
      const turn = props.turn;
      const turnNumber = turn && typeof turn.turn === 'number' ? turn.turn : Number(turn);
      const loader = React.useRef(props.loadTurnCost);
      loader.current = props.loadTurnCost;
      const [cost, setCost] = React.useState(null);
      React.useEffect(() => {
        if (!Number.isSafeInteger(turnNumber) || typeof props.sessionId !== 'string' || !props.sessionId) return undefined;
        let active = true;
        let polls = 0;
        let timer;
        const load = async () => {
          try {
            const next = await loader.current(turnNumber);
            if (!active) return;
            setCost(next && typeof next === 'object' ? next : null);
            if (next && next.certainty === 'pending' && polls < 20) {
              polls += 1;
              timer = setTimeout(load, 2000);
            }
          } catch {
            if (active) setCost(null);
          }
        };
        void load();
        return () => { active = false; if (timer) clearTimeout(timer); };
      }, [turnNumber, props.sessionId]);

      if (!cost || !cost.available || !cost.requests) return null;
      const tokens = cost.tokens || {};
      const amount = cost.currency ? formatMoney(cost.total, cost.currency) : null;
      let text;
      if (cost.certainty === 'pending') text = t('turnCost.pending');
      else if (!amount || cost.certainty === 'unpriced') text = t('turnCost.unpriced', { tokens: formatCount(tokens.input) });
      else if (cost.certainty === 'unknown') text = t('turnCost.unknown', { amount });
      else text = t('turnCost.actual', { amount });
      const detail = t('turnCost.detail', {
        amount: amount || '—',
        input: formatCount(tokens.input),
        cached: formatCount(tokens.cached),
        output: formatCount(tokens.output),
      });
      return h('div', {
        className: 'ime-turn-cost',
        'data-certainty': cost.certainty,
        title: detail,
      },
      h('span', { className: 'ime-turn-cost-dot', 'aria-hidden': true }),
      h('span', null, t('turnCost.label') + ' ' + text));
    }

    function useImeState(prefs) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(true);
      const [updatedAt, setUpdatedAt] = React.useState(null);
      const sequence = React.useRef(0);
      const refresh = React.useCallback(async (quiet) => {
        const id = ++sequence.current;
        if (!quiet) setBusy(true);
        try {
          const next = await call('/api/ime/state');
          if (id !== sequence.current) return;
          setState(next);
          setError(null);
          setUpdatedAt(new Date());
        } catch (cause) {
          if (id !== sequence.current) return;
          setError(cause);
        } finally {
          if (id === sequence.current) setBusy(false);
        }
      }, []);
      React.useEffect(() => { void refresh(); }, [refresh]);
      React.useEffect(() => {
        if (!prefs.refreshMs) return undefined;
        const timer = setInterval(() => { void refresh(true); }, prefs.refreshMs);
        return () => clearInterval(timer);
      }, [prefs.refreshMs, refresh]);
      return { state, error, busy, updatedAt, refresh };
    }

    function useCommand(t, refresh) {
      const [busy, setBusy] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      const run = async (command, successText) => {
        setBusy(command.command);
        setMessage(null);
        try {
          await call('/api/ime/command', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(command),
          });
          setMessage({ tone: 'ok', text: successText });
          await refresh(true);
          return true;
        } catch (cause) {
          setMessage({ tone: 'error', text: errorText(t, cause) });
          return false;
        } finally {
          setBusy(null);
        }
      };
      return { busy, message, run, setMessage };
    }

    function ImeIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 16;
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, focusable: 'false',
      },
      h('rect', { x: 3.25, y: 4.25, width: 17.5, height: 15.5, rx: 4, stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.9 }),
      h('path', { d: 'M7.5 9h6.5M7.5 12h4.5M7.5 15h5.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: 0.8 }),
      h('circle', { cx: 17, cy: 15, r: 2, fill: 'currentColor' }),
      h('path', { d: 'M17 7v3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: 0.55 }));
    }

    function Button({ children, onClick, variant, disabled, type }) {
      return h('button', {
        type: type || 'button',
        className: 'ime-button',
        'data-variant': variant,
        disabled: Boolean(disabled),
        onClick,
      }, children);
    }

    function Badge({ tone, children }) {
      return h('span', { className: 'ime-badge', 'data-tone': tone }, children);
    }

    function Stat({ label, value }) {
      return h('div', { className: 'ime-card' },
        h('div', { className: 'ime-card-label' }, label),
        h('div', { className: 'ime-card-value' }, String(value)));
    }

    function Section({ title, hint, children }) {
      return h('section', { className: 'ime-section' },
        h('div', { className: 'ime-section-head' },
          h('h2', { className: 'ime-section-title' }, title),
          hint ? h('p', { className: 'ime-section-hint' }, hint) : null),
        children);
    }

    function Kv({ items }) {
      return h('div', { className: 'ime-panel ime-kv' }, items.map(([key, value], index) =>
        h(React.Fragment, { key: index },
          h('div', { className: 'ime-kv-key' }, key),
          h('div', { className: 'ime-kv-value' }, value))));
    }

    function Notice({ tone, children }) {
      return h('div', { className: 'ime-notice', 'data-tone': tone, role: tone === 'error' ? 'alert' : 'status' }, children);
    }

    function Field({ label, children }) {
      return h('label', { className: 'ime-field' },
        h('span', null, label),
        children);
    }

    function StatusView({ t, state, advanced, command }) {
      const counts = state.counts || {};
      const taskCounts = counts.tasks || {};
      const memoryCounts = counts.memories || {};
      const skillCounts = counts.skills || {};
      const approvalCounts = counts.approvals || {};
      const gateway = state.gateway;
      const dashboard = state.dashboard || {};
      const capabilities = state.capabilities || {};
      const caps = state.caps || [];
      const tasks = state.tasks || [];
      const approvals = state.approvals || [];
      const trace = state.trace || [];
      const requests = gateway && Array.isArray(gateway.requests) ? gateway.requests : [];

      const gatewayBadge = !gateway
        ? h(Badge, { tone: 'idle' }, t('status.gateway.unavailable'))
        : h(Badge, { tone: gateway.mode === 'guarded' ? 'ok' : 'warn' },
          t(gateway.mode === 'guarded' ? 'status.gateway.guarded' : 'status.gateway.observe'));
      const hardLimitBadge = h(Badge, { tone: gateway && gateway.hardLimit ? 'ok' : 'warn' },
        t(gateway && gateway.hardLimit ? 'status.hardLimit.verified' : 'status.hardLimit.unverified'));
      const desktopBadge = h(Badge, { tone: capabilities.desktop ? 'ok' : 'idle' },
        t(capabilities.desktop ? 'status.desktop.available' : 'status.desktop.unavailable'));
      const dashboardValue = dashboard.available && dashboard.url
        ? h('a', { className: 'ime-link', href: dashboard.url, target: '_blank', rel: 'noreferrer' }, t('status.dashboard.available'))
        : h(Badge, { tone: dashboard.available ? 'ok' : 'idle' },
          t(dashboard.available ? 'status.dashboard.available' : 'status.dashboard.unavailable'));

      return h('div', null,
        h('div', { className: 'ime-grid' },
          h(Stat, { label: t('status.cards.running'), value: taskCounts.running || 0 }),
          h(Stat, { label: t('status.cards.memories'), value: memoryCounts.active || 0 }),
          h(Stat, { label: t('status.cards.skills'), value: skillCounts.total || 0 }),
          h(Stat, { label: t('status.cards.approvals'), value: approvalCounts.pending || 0 })),
        h(Section, { title: t('status.summary.title') },
          h(Kv, {
            items: [
              [t('status.gateway'), gatewayBadge],
              [t('status.hardLimit'), hardLimitBadge],
              [t('status.desktop'), desktopBadge],
              [t('status.dashboard'), dashboardValue],
            ],
          })),
        approvals.length > 0
          ? h(Section, { title: t('status.approvals.title') },
            h('div', { className: 'ime-panel' }, approvals.map((item, index) =>
              h('div', { className: 'ime-row', key: item.id || index },
                h('div', { className: 'ime-row-main' },
                  h('div', { className: 'ime-row-title' }, t('label.risk') + ': ' + (item.risk || '—')),
                  h('div', { className: 'ime-row-sub' }, item.taskId || '—')),
                h('div', { className: 'ime-row-side' },
                  h(Badge, { tone: statusTone(item.status) }, stateLabel(t, item.status)),
                  h('span', null, t('label.expires') + ' ' + formatTime(item.expiresAt)))))))
          : null,
        h(Section, { title: t('status.actions.title'), hint: t('status.actions.hint') },
          h('div', { className: 'ime-actions' },
            h(Button, {
              onClick: () => command.run({ command: 'pause_all' }, t('status.actionDone')),
              disabled: Boolean(command.busy),
              variant: 'danger',
            }, t('action.pauseAll')),
            h(Button, {
              onClick: () => command.run({ command: 'resume_all' }, t('status.actionDone')),
              disabled: Boolean(command.busy),
            }, t('action.resumeAll')))),
        h(Section, { title: t('status.budget.title') },
          caps.length
            ? h('div', { className: 'ime-panel' }, caps.map((cap, index) =>
              h('div', { className: 'ime-row', key: cap.scope + '|' + cap.key + '|' + cap.currency },
                h('div', { className: 'ime-row-main' },
                  h('div', { className: 'ime-row-title' }, t('settings.scope.' + cap.scope) + ' · ' + cap.key),
                  h('div', { className: 'ime-row-sub' },
                    cap.currency + ' · ' + t('label.limit') + ' ' + formatMoney(cap.limit, cap.currency))),
                h('div', { className: 'ime-row-side' },
                  t('label.spent') + ' ' + formatMoney(cap.spent, cap.currency) + ' · ' +
                  t('label.reserved') + ' ' + formatMoney(cap.reserved, cap.currency)))))
            : h('div', { className: 'ime-panel' }, h('div', { className: 'ime-empty' }, t('status.budget.empty')))),
        h(Section, { title: t('status.tasks.title') },
          tasks.length
            ? h('div', { className: 'ime-panel' }, tasks.map(task =>
              h('div', { className: 'ime-row', key: task.id },
                h('div', { className: 'ime-row-main' },
                  h('div', { className: 'ime-row-title' }, task.goal || task.id),
                  h('div', { className: 'ime-row-sub' }, (task.app || '—') + ' · ' + formatTime(task.updatedAt))),
                h('div', { className: 'ime-row-side' },
                  h(Badge, { tone: statusTone(task.status) }, stateLabel(t, task.status))))))
            : h('div', { className: 'ime-panel' }, h('div', { className: 'ime-empty' }, t('status.tasks.empty')))),
        advanced
          ? h(React.Fragment, null,
            h(Section, { title: t('status.trace.title') },
              trace.length
                ? h('div', { className: 'ime-panel' }, trace.map((item, index) =>
                  h('div', { className: 'ime-row', key: index },
                    h('div', { className: 'ime-row-main' },
                      h('div', { className: 'ime-row-title' }, item.type || '—')),
                    h('div', { className: 'ime-row-side ime-time' }, formatTime(item.createdAt)))))
                : h('div', { className: 'ime-panel' }, h('div', { className: 'ime-empty' }, t('status.trace.empty')))),
            h(Section, { title: t('status.requests.title') },
              requests.length
                ? h('div', { className: 'ime-panel' }, requests.map((item, index) =>
                  h('div', { className: 'ime-row', key: item.id || index },
                    h('div', { className: 'ime-row-main' },
                      h('div', { className: 'ime-row-title' }, (item.provider || '—') + ' / ' + (item.model || '—')),
                      h('div', { className: 'ime-row-sub' }, formatTime(item.createdAt))),
                    h('div', { className: 'ime-row-side' },
                      h(Badge, { tone: statusTone(item.state) }, stateLabel(t, item.state)),
                      h(Badge, { tone: statusTone(item.certainty) }, stateLabel(t, item.certainty))))))
                : h('div', { className: 'ime-panel' }, h('div', { className: 'ime-empty' }, t('status.requests.empty')))),
            h(Section, { title: t('status.capabilities.title') },
              h('div', { className: 'ime-chips' },
                Object.entries(capabilities).map(([key, value]) =>
                  h('span', { className: 'ime-chip', key }, key + '=' + (value ? 'on' : 'off'))))))
          : null);
    }

    function SettingsView({ t, state, prefs, updatePrefs, command }) {
      const [copy, setCopy] = React.useState(null);
      const settings = state.settings || {};
      const caps = state.caps || [];
      const allowApps = Array.isArray(settings.allowApps) ? settings.allowApps : [];
      const modelBudget = settings.modelBudget;
      const dashboard = state.dashboard || {};
      const [draft, setDraft] = React.useState(() => ({
        scope: 'day', key: '*', currency: (caps[0] && caps[0].currency) || 'CNY', limit: '',
      }));
      const [formError, setFormError] = React.useState(null);
      const [host, setHost] = React.useState(() => ({
        allowApps: allowApps.join(', '),
        taskDefaultLimit: settings.taskDefaultLimit == null ? '' : String(settings.taskDefaultLimit),
        budgetTimezone: settings.budgetTimezone || '',
      }));
      const [hostDirty, setHostDirty] = React.useState(false);
      const modelConfig = modelBudget && modelBudget.config ? modelBudget.config : null;
      const modelKey = modelConfig ? JSON.stringify(modelConfig) : '';
      const [modelText, setModelText] = React.useState(() => (modelConfig ? JSON.stringify(modelConfig, null, 2) : ''));
      const [modelDirty, setModelDirty] = React.useState(false);
      const appKey = allowApps.join('|');

      React.useEffect(() => {
        if (hostDirty) return;
        setHost({
          allowApps: allowApps.join(', '),
          taskDefaultLimit: settings.taskDefaultLimit == null ? '' : String(settings.taskDefaultLimit),
          budgetTimezone: settings.budgetTimezone || '',
        });
      }, [appKey, settings.taskDefaultLimit, settings.budgetTimezone, hostDirty]);

      React.useEffect(() => {
        if (modelDirty) return;
        setModelText(modelKey ? JSON.stringify(JSON.parse(modelKey), null, 2) : '');
      }, [modelKey, modelDirty]);

      const copyDiagnostics = async () => {
        const payload = { updatedAt: state.updatedAt, counts: state.counts, settings: state.settings };
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          setCopy('ok');
        } catch {
          setCopy('error');
        }
      };

      const editCap = (cap) => {
        setDraft({ scope: cap.scope, key: cap.key, currency: cap.currency, limit: String(cap.limit) });
        setFormError(null);
      };

      const saveCap = async () => {
        const key = String(draft.key || '').trim() || '*';
        const currency = String(draft.currency || '').trim().toUpperCase();
        const limit = String(draft.limit || '').trim();
        if (!key) { setFormError(t('error.invalid_key')); return; }
        if (!/^[A-Z]{3}$/.test(currency)) { setFormError(t('error.invalid_currency')); return; }
        if (!/^\d+$/.test(limit)) { setFormError(t('error.invalid_cap')); return; }
        setFormError(null);
        const ok = await command.run({ command: 'set_cap', scope: draft.scope, key, currency, limit }, t('settings.saved'));
        if (ok) setDraft({ scope: draft.scope, key: '*', currency, limit: '' });
      };

      const saveHost = async () => {
        const apps = String(host.allowApps || '').split(/[,，\n]/).map((value) => value.trim()).filter(Boolean);
        const taskLimit = String(host.taskDefaultLimit || '').trim();
        const zone = String(host.budgetTimezone || '').trim();
        if (apps.length > 50) { setFormError(t('error.invalid_allow_apps')); return; }
        if (taskLimit && !/^\d+$/.test(taskLimit)) { setFormError(t('error.invalid_task_limit')); return; }
        const payload = { command: 'update_settings', allowApps: apps };
        if (taskLimit) payload.taskDefaultLimit = taskLimit;
        if (zone) payload.budgetTimezone = zone;
        setFormError(null);
        const ok = await command.run(payload, t('settings.host.saved'));
        if (ok) setHostDirty(false);
      };

      const saveModel = async () => {
        const raw = String(modelText || '').trim();
        let parsed = null;
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch { setFormError(t('settings.modelBudget.invalid')); return; }
        }
        setFormError(null);
        const ok = await command.run({ command: 'update_settings', modelBudget: parsed }, t('settings.modelBudget.saved'));
        if (ok) setModelDirty(false);
      };

      const refreshHint = prefs.refreshMs
        ? t('settings.autoRefresh.hint', { seconds: prefs.refreshMs / 1000 })
        : t('settings.autoRefresh.offHint');

      return h('div', null,
        command.message ? h(Notice, { tone: command.message.tone }, command.message.text) : null,
        formError ? h(Notice, { tone: 'error' }, formError) : null,
        h(Section, { title: t('settings.interface.title') },
          h('div', { className: 'ime-panel' },
            h('div', { className: 'ime-row' },
              h('div', { className: 'ime-row-main' },
                h('div', { className: 'ime-row-title' }, t('settings.autoRefresh')),
                h('div', { className: 'ime-row-sub' }, refreshHint)),
              h('div', { className: 'ime-row-side' },
                h('select', {
                  className: 'ime-select', value: String(prefs.refreshMs),
                  onChange: (event) => updatePrefs({ refreshMs: Number(event.target.value) }),
                },
                h('option', { value: '0' }, t('settings.autoRefresh.off')),
                h('option', { value: '5000' }, t('settings.seconds', { seconds: 5 })),
                h('option', { value: '15000' }, t('settings.seconds', { seconds: 15 })),
                h('option', { value: '60000' }, t('settings.seconds', { seconds: 60 }))))),
            h('div', { className: 'ime-row' },
              h('div', { className: 'ime-row-main' },
                h('div', { className: 'ime-row-title' }, t('settings.advanced')),
                h('div', { className: 'ime-row-sub' }, t('settings.advanced.hint'))),
              h('div', { className: 'ime-row-side' },
                h('button', {
                  type: 'button', className: 'ime-switch', role: 'switch',
                  'aria-checked': prefs.advanced ? 'true' : 'false',
                  'aria-label': t('settings.advanced'),
                  onClick: () => updatePrefs({ advanced: !prefs.advanced }),
                }))))),
        h(Section, { title: t('settings.budget.title'), hint: t('settings.budget.hint') },
          h('div', { className: 'ime-panel' },
            caps.length
              ? caps.map((cap) => h('div', { className: 'ime-row', key: cap.scope + '|' + cap.key + '|' + cap.currency },
                h('div', { className: 'ime-row-main' },
                  h('div', { className: 'ime-row-title' }, t('settings.scope.' + cap.scope) + ' · ' + cap.key),
                  h('div', { className: 'ime-row-sub' },
                    cap.currency + ' · ' + t('label.limit') + ' ' + formatMoney(cap.limit, cap.currency))),
                h('div', { className: 'ime-row-side' },
                  h('span', null, t('label.spent') + ' ' + formatMoney(cap.spent, cap.currency) + ' · ' +
                    t('label.reserved') + ' ' + formatMoney(cap.reserved, cap.currency)),
                  h(Button, { onClick: () => editCap(cap) }, t('settings.cap.edit')))))
              : h('div', { className: 'ime-empty' }, t('settings.budget.disabled')),
            h('div', { className: 'ime-form' },
              h(Field, { label: t('settings.scope') },
                h('select', {
                  className: 'ime-select', value: draft.scope,
                  onChange: (event) => setDraft({ ...draft, scope: event.target.value }),
                },
                h('option', { value: 'session' }, t('settings.scope.session')),
                h('option', { value: 'day' }, t('settings.scope.day')),
                h('option', { value: 'account' }, t('settings.scope.account')))),
              h(Field, { label: t('settings.key') },
                h('input', {
                  className: 'ime-input', value: draft.key, placeholder: '*', maxLength: 200,
                  onChange: (event) => setDraft({ ...draft, key: event.target.value }),
                })),
              h(Field, { label: t('settings.currency') },
                h('input', {
                  className: 'ime-input', value: draft.currency, maxLength: 3, placeholder: 'CNY',
                  onChange: (event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() }),
                })),
              h(Field, { label: t('settings.limit') },
                h('input', {
                  className: 'ime-input', inputMode: 'numeric', value: draft.limit, placeholder: '1000000',
                  onChange: (event) => setDraft({ ...draft, limit: event.target.value.replace(/[^\d]/g, '') }),
                })),
              h('div', { className: 'ime-form-actions' },
                h('span', { className: 'ime-form-note' }, t('settings.key.hint')),
                h(Button, { onClick: saveCap, disabled: Boolean(command.busy), variant: 'primary' }, t('action.saveCap'))))),
          h('p', { className: 'ime-section-hint', style: { marginTop: '8px' } }, t('settings.budget.readonly'))),
        h(Section, { title: t('settings.host.title'), hint: t('settings.host.hint') },
          h('div', { className: 'ime-panel' },
            h('div', { className: 'ime-form' },
              h(Field, { label: t('settings.host.apps') },
                h('input', {
                  className: 'ime-input', value: host.allowApps, placeholder: '微信, 浏览器',
                  onChange: (event) => { setHostDirty(true); setHost({ ...host, allowApps: event.target.value }); },
                })),
              h(Field, { label: t('settings.taskLimit') },
                h('input', {
                  className: 'ime-input', inputMode: 'numeric', value: host.taskDefaultLimit, placeholder: '1000000',
                  onChange: (event) => { setHostDirty(true); setHost({ ...host, taskDefaultLimit: event.target.value.replace(/[^\d]/g, '') }); },
                })),
              h(Field, { label: t('settings.timezone') },
                h('input', {
                  className: 'ime-input', value: host.budgetTimezone, placeholder: 'Asia/Shanghai',
                  onChange: (event) => { setHostDirty(true); setHost({ ...host, budgetTimezone: event.target.value }); },
                })),
              h('div', { className: 'ime-form-actions' },
                h('span', { className: 'ime-form-note' }, t('settings.host.override')),
                h(Button, { onClick: saveHost, disabled: Boolean(command.busy), variant: 'primary' }, t('settings.host.save')))),
            h(Kv, {
              items: [
                [t('settings.dataDir'), h('code', { className: 'ime-code' }, settings.dataDir || '—')],
                [t('settings.allowApps'), allowApps.length
                  ? h('div', { className: 'ime-chips' }, allowApps.map((app) => h('span', { className: 'ime-chip', key: app }, app)))
                  : t('settings.allowApps.empty')],
              ],
            })),
          null),
        h(Section, { title: t('settings.modelBudget.title'), hint: t('settings.modelBudget.editHint') },
          h('div', { className: 'ime-panel' },
            h('div', { className: 'ime-form' },
              h('label', { className: 'ime-field', style: { gridColumn: '1/-1' } },
                h('span', null, t('settings.modelBudget.json')),
                h('textarea', {
                  className: 'ime-textarea', value: modelText, spellCheck: false,
                  placeholder: t('settings.modelBudget.placeholder'),
                  onChange: (event) => { setModelDirty(true); setModelText(event.target.value); },
                })),
              h('div', { className: 'ime-form-actions' },
                h('span', { className: 'ime-form-note' },
                  state.gateway
                    ? t(state.gateway.mode === 'guarded' ? 'status.gateway.guarded' : 'status.gateway.observe')
                    : t('settings.modelBudget.gateway')),
                h(Button, { onClick: saveModel, disabled: Boolean(command.busy), variant: 'primary' }, t('settings.modelBudget.save')))),
            modelBudget
              ? h('p', { className: 'ime-section-hint', style: { padding: '0 16px 14px' } },
                t('settings.modelBudget.routes', {
                  routes: modelBudget.routes,
                  limit: modelBudget.currencies && modelBudget.currencies.length === 1
                    ? formatMoney(modelBudget.sessionLimit, modelBudget.currencies[0])
                    : modelBudget.sessionLimit + ' (' + t('unit.micro') + ')',
                }))
              : null)),
        h(Section, { title: t('settings.dashboard.title'), hint: t('settings.dashboard.hint') },
          dashboard.available && dashboard.url
            ? h('div', null, h('a', { className: 'ime-button', href: dashboard.url, target: '_blank', rel: 'noreferrer' }, t('action.openDashboard')))
            : h('div', { className: 'ime-panel' }, h('div', { className: 'ime-empty' }, t('settings.dashboard.unavailable')))),
        h(Section, { title: t('settings.about.title') },
          h(Kv, {
            items: [
              [t('settings.bridge'), h(Badge, { tone: state ? 'ok' : 'error' },
                t(state ? 'settings.bridge.ready' : 'settings.bridge.missing'))],
            ],
          }),
          h('div', { className: 'ime-actions' },
            h(Button, { onClick: copyDiagnostics }, t('action.copyDiagnostics')),
            copy ? h('span', { className: 'ime-section-hint' },
              t(copy === 'ok' ? 'settings.copy.copied' : 'settings.copy.failed')) : null),
          h('p', { className: 'ime-section-hint', style: { marginTop: '16px' } }, t('settings.security'))));
    }

    function StatusPanel(props) {
      const t = props.t || ((key) => key);
      const [prefs] = React.useState(readPrefs);
      const { state, error, busy, updatedAt, refresh } = useImeState(prefs);
      const command = useCommand(t, refresh);

      return h('section', { className: 'ime-page', 'aria-label': t('panel.status') },
        h('div', { className: 'ime-header' },
          h('div', { className: 'ime-header-inner' },
            h('div', { className: 'ime-title-row' },
              h('div', null,
                h('h1', { className: 'ime-title' }, t('panel.title')),
                h('p', { className: 'ime-subtitle' }, t('panel.subtitle'))),
              h('div', { className: 'ime-head-actions' },
                updatedAt ? h('span', { className: 'ime-updated' },
                  t('updated', { time: formatTime(updatedAt.toISOString()) })) : null,
                h(Button, { onClick: () => refresh(false), disabled: busy }, t('action.refresh')))))),
        h('div', { className: 'ime-scroll' },
          h('div', { className: 'ime-body' },
            h('p', { className: 'ime-section-hint', style: { marginBottom: '20px' } }, t('status.settingsHint')),
            error
              ? h(Notice, { tone: 'error' },
                h('span', null, errorText(t, error)),
                h(Button, { onClick: () => refresh(false) }, t('action.retry')))
              : null,
            command.message
              ? h(Notice, { tone: command.message.tone }, command.message.text)
              : null,
            !state && busy
              ? h('div', { className: 'ime-empty' }, t('loading'))
              : null,
            state
              ? h(StatusView, { t, state, advanced: prefs.advanced, command })
              : null)));
    }

    function SettingsPanel(props) {
      const t = props.t || ((key) => key);
      const [prefs, setPrefs] = React.useState(readPrefs);
      const updatePrefs = React.useCallback((patch) => {
        setPrefs((current) => {
          const next = { ...current, ...patch };
          savePrefs(next);
          return next;
        });
      }, []);
      const { state, error, busy, refresh } = useImeState(prefs);
      const command = useCommand(t, refresh);

      return h('div', { className: 'ime-settings' },
        h('p', { className: 'ime-settings-intro' }, t('settings.intro')),
        error
          ? h(Notice, { tone: 'error' },
            h('span', null, errorText(t, error)),
            h(Button, { onClick: () => refresh(false) }, t('action.retry')))
          : null,
        !state && busy
          ? h('div', { className: 'ime-empty' }, t('loading'))
          : null,
        state
          ? h(SettingsView, { t, state, prefs, updatePrefs, command })
          : null);
    }

    function OpenImeStatus({ subject, onOpen, t }) {
      if (!subject || (subject.kind !== 'bundle' && subject.kind !== 'row')) return null;
      if (!subject.pkg || subject.pkg.name !== 'dsh-ime') return null;
      if (subject.kind === 'row' && (!subject.row || subject.row.moduleName !== 'dsh-ime')) return null;
      return h('button', { type: 'button', className: 'ime-button', onClick: onOpen }, t('action.openStatus'));
    }

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.dshIme = '';
        tag.textContent = CSS;
        document.head.append(tag);
        return () => tag.remove();
      });
      ctx.effect(() => {
        try { return ctx.locale.register(NS, { zh, en }); }
        catch { return () => {}; }
      });
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'ime',
        order: 20,
        locale: NS,
        label: () => t('panel.status'),
      }, ImeIcon));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'ime',
        locale: NS,
        inject: () => ({ t }),
      }, StatusPanel));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'ime-settings',
        order: 30,
        locale: NS,
        label: () => t('panel.settings'),
        inject: () => ({ t }),
      }, SettingsPanel));
      ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
        name: 'plugins.detail.actions',
        id: 'ime-open-status',
        order: 30,
        locale: NS,
        inject: () => ({ t, onOpen: () => ctx.layout.selectPanel('ime') }),
      }, OpenImeStatus));
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'ime-turn-cost',
        order: 40,
        locale: NS,
        inject: (sessionId) => ({
          sessionId,
          loadTurnCost: (turn) => call('/api/ime/turn-cost', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, turn }),
          }),
        }),
      }, TurnCostBadge));
    }

    return { inject: ['slots', 'locale', 'layout'], apply };
  },
});
