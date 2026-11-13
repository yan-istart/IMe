import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Runtime } from '../src/core/runtime.js';
import { MockDesktop } from '../src/adapters/mock.js';
import { mount, type HostContext, type ToolDefinition } from '../src/adapters/dsh.js';
import { Dashboard } from '../src/web/dashboard.js';

const fingerprint = 'mock-app:v1:zh:1280x720';
function setup(t: TestContext, learning?: { minSuccesses?: number; autoPublish?: boolean; captureHostExperience?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'ime-learning-'));
  const provider = new MockDesktop();
  const r = new Runtime({ dataDir: dir, allowApps: ['mock-app'], desktopLeasePath: join(dir, 'desktop.lock'),
    ...learning ? { learning } : {} }, provider);
  t.after(async () => { await r.close(); rmSync(dir, { recursive: true, force: true }); });
  return { r, provider, dir };
}
function action() {
  return { id: randomUUID(), app: 'mock-app', kind: 'click' as const, target: 'task-panel',
    risk: 'reversible_write' as const, expectedFingerprint: fingerprint, timeoutMs: 1000 };
}
async function completeTask(r: Runtime, provider: MockDesktop, sessionId: string, goal = '打开任务面板') {
  provider.state = 'home';
  const task = r.tasks.create(sessionId, goal, 'mock-app', '1000');
  r.tasks.transition(task.id, 'ready'); r.tasks.transition(task.id, 'running');
  await r.desktop!.run(task.id, action(), observation => observation.state === 'task-panel');
  r.tasks.transition(task.id, 'succeeded');
  return { taskId: task.id, skillId: r.candidate(task.id) };
}
test('repeated successful tasks accumulate on one deterministic skill and need review evidence', async t => {
  const { r, provider } = setup(t);
  const first = await completeTask(r, provider, 'session-a');
  assert.match(first.skillId, /^sk-/);
  assert.equal(r.knowledge.skill(first.skillId, 1).status, 'candidate');
  assert.equal(r.knowledge.skillStats(first.skillId, 1).successes, 1);

  const second = await completeTask(r, provider, 'session-b');
  assert.equal(second.skillId, first.skillId);
  assert.equal(r.knowledge.skill(first.skillId).version, 1, 'same step graph must not create a new version');
  assert.equal(r.knowledge.skillStats(first.skillId, 1).successes, 2);
  assert.equal(r.knowledge.reviewEligibility(first.skillId, 1, 3).eligible, false);

  const third = await completeTask(r, provider, 'session-c');
  assert.equal(third.skillId, first.skillId);
  const eligibility = r.knowledge.reviewEligibility(first.skillId, 1, 3);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.stats.sessions, 3);
  assert.throws(() => r.knowledge.publish(first.skillId, 1), /SKILL_NOT_VERIFIED/);

  const published = r.knowledge.publishReviewed(first.skillId, 1, '人工复核三次真实成功轨迹', 3);
  assert.equal(published.status, 'published');
  assert.equal(r.knowledge.match('mock-app', fingerprint).length, 1);
  const state = r.context.build({ goal: '打开任务面板', constraints: [], permissions: [], checkpointId: 'c1', fingerprint, app: 'mock-app' });
  assert.match(state, new RegExp(first.skillId));
});
test('the same successful task run is counted once, never inflating promotion evidence', async t => {
  const { r, provider } = setup(t);
  const { taskId, skillId } = await completeTask(r, provider, 'session-a');
  r.candidate(taskId);
  r.candidate(taskId);
  assert.equal(r.knowledge.skillStats(skillId, 1).successes, 1);
});
test('configured auto-publish waits for the accumulated minimum and two independent sessions', async t => {
  const { r, provider } = setup(t, { minSuccesses: 2, autoPublish: true });
  const first = await completeTask(r, provider, 'session-a');
  assert.equal(r.knowledge.skill(first.skillId, 1).status, 'candidate');
  await completeTask(r, provider, 'session-b');
  assert.equal(r.knowledge.skill(first.skillId, 1).status, 'published');
});
test('a high failure rate blocks review publication even after enough successes', async t => {
  const { r, provider } = setup(t);
  const { skillId } = await completeTask(r, provider, 'session-a');
  await completeTask(r, provider, 'session-b');
  await completeTask(r, provider, 'session-c');
  r.knowledge.recordObservation({ skillId, version: 1, taskId: 'failed-task', sessionId: 'session-d', outcome: 'failure', evidenceRefs: [] });
  const eligibility = r.knowledge.reviewEligibility(skillId, 1, 3);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'FAILURE_RATE_TOO_HIGH');
  assert.throws(() => r.knowledge.publishReviewed(skillId, 1, 'should fail', 3), /FAILURE_RATE_TOO_HIGH/);
});
test('a failed independent evaluation blocks review publication', async t => {
  const { r, provider } = setup(t);
  const { skillId } = await completeTask(r, provider, 'session-a');
  await completeTask(r, provider, 'session-b');
  await completeTask(r, provider, 'session-c');
  await r.knowledge.evaluate(skillId, 1, ['a', 'b', 'c'], async () => false);
  const eligibility = r.knowledge.reviewEligibility(skillId, 1, 3);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'EVALUATION_FAILED');
  assert.throws(() => r.knowledge.publishReviewed(skillId, 1, 'bypass', 3), /EVALUATION_FAILED/);
});
test('observe records a checkpoint so L4 can match a published skill before the first action', async t => {
  const { r, provider } = setup(t);
  const { skillId } = await completeTask(r, provider, 'session-a');
  await completeTask(r, provider, 'session-b');
  await completeTask(r, provider, 'session-c');
  r.knowledge.publishReviewed(skillId, 1, 'reviewed', 3);
  provider.state = 'home';
  const task = r.tasks.create('session-new', '打开任务面板', 'mock-app', '1000');
  r.tasks.transition(task.id, 'ready'); r.tasks.transition(task.id, 'running');
  const { observation, checkpointId } = await r.observe(task.id);
  assert.equal(observation.fingerprint, fingerprint);
  assert.ok(checkpointId);
  const latest = r.tasks.latest(task.id);
  const context = r.context.build({ goal: task.goal, constraints: [], permissions: [],
    checkpointId: String(latest?.id), fingerprint: String(latest?.fingerprint), app: task.app }, task.id);
  assert.match(context, new RegExp(skillId));
});
test('review publication cannot race an in-flight independent evaluation', async t => {
  const { r, provider } = setup(t);
  const { skillId } = await completeTask(r, provider, 'session-a');
  await completeTask(r, provider, 'session-b');
  await completeTask(r, provider, 'session-c');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = r.knowledge.evaluate(skillId, 1, ['a', 'b', 'c'], async () => { await gate; return true; });
  const eligibility = r.knowledge.reviewEligibility(skillId, 1, 3);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'EVALUATION_IN_PROGRESS');
  assert.throws(() => r.knowledge.publishReviewed(skillId, 1, 'racing', 3), /EVALUATION_IN_PROGRESS/);
  release();
  await pending;
  assert.equal(r.knowledge.skill(skillId, 1).status, 'verified');
});
test('a rolled-back version is not silently reused by a later successful run', async t => {
  const { r, provider } = setup(t);
  const { skillId } = await completeTask(r, provider, 'session-a');
  await completeTask(r, provider, 'session-b');
  await completeTask(r, provider, 'session-c');
  r.knowledge.publishReviewed(skillId, 1, 'reviewed', 3);
  r.knowledge.rollback(skillId, 1);
  assert.equal(r.knowledge.skill(skillId, 1).status, 'rolled_back');
  await completeTask(r, provider, 'session-d');
  assert.equal(r.knowledge.skill(skillId).version, 2);
  assert.equal(r.knowledge.skill(skillId, 2).status, 'candidate');
  assert.equal(r.knowledge.skillStats(skillId, 2).successes, 1);
});
test('host experience capture can be disabled without affecting task learning', async t => {
  const { r, provider } = setup(t, { captureHostExperience: false });
  r.experience.capture('session-a', { name: 'cua_driver_native__click', arguments: { bundleId: 'com.demo.app' }, result: { isError: false } });
  r.experience.finalize('session-a', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(r.experience.recent().length, 0);
  const { skillId } = await completeTask(r, provider, 'session-a');
  assert.match(skillId, /^sk-/);
});
test('dashboard shows accumulated evidence and the authenticated review-publish path', async t => {
  const { r, provider } = setup(t);
  const { skillId } = await completeTask(r, provider, 'session-a');
  await completeTask(r, provider, 'session-b');
  await completeTask(r, provider, 'session-c');
  const dashboard = new Dashboard(r, undefined, {});
  await dashboard.ready;
  const headers = { Authorization: 'Bearer ' + dashboard.token, 'Content-Type': 'application/json' };
  const state = await (await fetch(dashboard.url + 'api/state', { headers })).json() as { learning: { minSuccesses: number }; skillVersions: { observation_success_count: number }[] };
  assert.equal(state.learning.minSuccesses, 3);
  assert.equal(state.skillVersions[0]?.observation_success_count, 3);
  const response = await fetch(dashboard.url + 'api/command', { method: 'POST', headers,
    body: JSON.stringify({ operation: 'skill_review_publish', id: skillId, version: 1, note: '复核通过' }) });
  assert.equal(response.status, 200);
  assert.equal(r.knowledge.skill(skillId, 1).status, 'published');
  const html = await (await fetch(dashboard.url)).text();
  assert.ok(html.includes('经验轨迹'));
  assert.ok(html.includes('复核发布'));
  await dashboard.close();
});
test('host computer-use tool results become procedure/failure memories without prompts or input text', async t => {
  const { r } = setup(t);
  r.experience.noteTurn('session-1', 3);
  r.experience.capture('session-1', { name: 'cua_driver_native__get_window_snapshot', arguments: { bundleId: 'com.demo.app' }, result: { isError: false } });
  r.experience.capture('session-1', { name: 'cua_driver_native__click', arguments: { app: 'com.demo.app' }, result: { isError: false } });
  r.experience.capture('session-1', { name: 'bash', arguments: { command: 'echo secret' }, result: { isError: false } });
  const completed = r.experience.finalize('session-1', { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
  assert.ok(completed?.traceId);
  const traces = r.experience.recent();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.app, 'com.demo.app');
  assert.equal(traces[0]?.tool_count, 2, 'non-computer-use tools are not learned');
  const memory = r.store.db.prepare("SELECT * FROM memories WHERE app='com.demo.app' AND kind='procedure'").get();
  assert.ok(memory);
  assert.equal(memory?.trust, 'tool_verified');
  assert.ok(String(memory?.content).includes('cua_driver_native__get_window_snapshot'));
  assert.ok(!String(memory?.content).includes('echo secret'));

  r.experience.capture('session-2', { name: 'cua_driver_native__click', arguments: { bundleId: 'com.demo.app' }, result: { isError: true, error: 'denied' } });
  r.experience.finalize('session-2', { type: 'turn/end', data: { turn: 1, reason: { kind: 'failed' } } });
  assert.ok(r.store.db.prepare("SELECT 1 FROM memories WHERE app='com.demo.app' AND kind='failure' AND trust='tool_verified'").get());

  r.experience.capture('session-3', { name: 'cua_driver_native__get_window_snapshot', arguments: { bundleId: 'com.demo.app' }, result: { isError: false } });
  r.experience.capture('session-3', { name: 'cua_driver_native__click', arguments: { app: 'com.demo.app' }, result: { isError: false } });
  r.experience.finalize('session-3', { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  assert.equal(r.store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE app='com.demo.app' AND kind='procedure'").get()?.n, 1);
  assert.equal(r.experience.recent().length, 3);
});
test('an app hint is still found inside projected window discovery results', async t => {
  const { r } = setup(t);
  r.experience.capture('session-nested', { name: 'cua_driver_native__list_windows', arguments: { pid: 123 },
    result: { isError: false, structuredContent: { windows: [{ pid: 123, window_id: '456', app: 'com.nested.app' }] } } });
  r.experience.finalize('session-nested', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(r.experience.recent()[0]?.app, 'com.nested.app');
});
test('host tools/result and session/event hooks feed the same experience store', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ime-learning-host-'));
  const tools = new Map<string, ToolDefinition>(); const events = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: HostContext = { get: () => undefined, effect: () => undefined,
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    on(event, fn) { events.set(event, fn); return () => events.delete(event); } };
  const mounted = mount(ctx, { dataDir: dir, dashboard: { enabled: false } });
  t.after(async () => { await mounted.dispose(); rmSync(dir, { recursive: true, force: true }); });
  events.get('agent/pre-step')!({ agent: { session: { id: 'host-session' } }, turn: 7, step: 1 }, () => ({ kind: 'skip' }));
  events.get('tools/result')!({ name: 'cua_driver_native__type_text', callId: 'call-1', arguments: { bundleId: 'com.host.app' },
    agent: { session: { id: 'host-session' } } }, { isError: false });
  events.get('session/event')!({ id: 'host-session' }, { type: 'turn/end', data: { turn: 7, reason: 'completed' } });
  const traces = mounted.runtime.experience.recent();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.app, 'com.host.app');
  assert.ok(mounted.runtime.store.db.prepare("SELECT 1 FROM memories WHERE kind='procedure' AND app='com.host.app'").get());
});
