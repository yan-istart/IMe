import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/core/runtime.js';
import { HostModelGateway } from '../src/adapters/model-gateway.js';
import { ImeWebBridge, type HostConnectionFetch } from '../src/web/bridge.js';

interface Route {
  path: string;
  methods: readonly string[];
  fetch(request: Request): Promise<Response>;
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ime-bridge-'));
  const runtime = new Runtime({ dataDir: dir });
  const gateway = new HostModelGateway(runtime);
  const routes: Route[] = [];
  const connection: HostConnectionFetch = {
    register(route) { routes.push(route as Route); return async () => {}; },
  };
  const bridge = new ImeWebBridge(runtime, { dataDir: dir }, gateway, undefined, { desktop: false });
  bridge.register(connection);
  t.after(async () => { await bridge.close(); await gateway.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (path: string, body: unknown) => {
    const route = routes.find((item) => item.path === path);
    assert.ok(route, `route ${path} registered`);
    return route.fetch(new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  };
  const get = (path: string) => {
    const route = routes.find((item) => item.path === path);
    assert.ok(route, `route ${path} registered`);
    return route.fetch(new Request(`http://127.0.0.1${path}`));
  };
  return { runtime, gateway, bridge, routes, post, get };
}

test('bridge exposes the authenticated turn-cost route and rejects malformed bodies', async t => {
  const { runtime, gateway, post, routes } = setup(t);
  assert.ok(routes.some((route) => route.path === '/api/ime/turn-cost' && route.methods.includes('POST')));

  gateway.setContext('session-a', { turn: 1, step: 1 });
  const stream = gateway.intercept({ provider: 'p', model: 'm', sessionId: 'session-a', maxTokens: 10 }, () => (async function* () {
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  for await (const _ of stream) { /* drain */ }

  const ok = await post('/api/ime/turn-cost', { sessionId: 'session-a', turn: 1 });
  assert.equal(ok.status, 200);
  const payload = await ok.json() as Record<string, unknown>;
  assert.equal(payload.available, true);
  assert.deepEqual(payload.tokens, { input: 4, cached: 0, output: 2 });
  assert.equal(payload.certainty, 'unpriced');

  const missing = await post('/api/ime/turn-cost', { turn: 1 });
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as Record<string, unknown>).error, 'INVALID_TURN');

  const invalid = await post('/api/ime/turn-cost', { sessionId: 'session-a', turn: 1.5 });
  assert.equal(invalid.status, 400);
  assert.equal(runtime.turnCost('session-a', 1).requests, 1);
});

test('settings commands change caps, configuration, and the live gateway', async t => {
  const { runtime, gateway, post, get } = setup(t);

  const cap = await post('/api/ime/command', { command: 'set_cap', scope: 'day', key: '*', currency: 'CNY', limit: '500' });
  assert.equal(cap.status, 200);
  const caps = ((await cap.json()) as Record<string, unknown>).caps as { limit: string }[];
  assert.ok(caps.some((item) => item.limit === '500'));

  const normalized = await post('/api/ime/command', { command: 'set_cap', scope: 'day', key: '*', currency: 'cny', limit: '600' });
  assert.equal(normalized.status, 200);
  assert.ok((((await normalized.json()) as Record<string, unknown>).caps as { currency: string }[]).some((item) => item.currency === 'CNY'));

  const badCurrency = await post('/api/ime/command', { command: 'set_cap', scope: 'day', key: '*', currency: 'CN', limit: '500' });
  assert.equal(badCurrency.status, 400);
  assert.equal(((await badCurrency.json()) as Record<string, unknown>).error, 'INVALID_CURRENCY');

  const budget = {
    sessionLimit: '1000',
    routes: [{
      provider: 'p', model: 'm', inputUpperBound: 10, maxOutput: 10,
      price: { version: 'v1', currency: 'CNY', inputPerMillion: '1000000', cachedPerMillion: '0', outputPerMillion: '1000000' },
    }],
  };
  const update = await post('/api/ime/command', {
    command: 'update_settings', allowApps: ['微信'], taskDefaultLimit: '2000', budgetTimezone: 'Asia/Shanghai', modelBudget: budget,
  });
  assert.equal(update.status, 200);
  assert.deepEqual(runtime.allowApps, ['微信']);
  assert.equal(runtime.settings.taskDefaultLimit, '2000');
  assert.equal(runtime.settings.budgetTimezone, 'Asia/Shanghai');
  assert.equal(gateway.status().mode, 'guarded');

  const invalidSettings = await post('/api/ime/command', { command: 'update_settings', budgetTimezone: 'Mars/Base' });
  assert.equal(invalidSettings.status, 400);

  const state = await (await get('/api/ime/state')).json() as Record<string, any>;
  assert.deepEqual(state.settings.allowApps, ['微信']);
  assert.equal(state.settings.editable.modelBudget, true);
  assert.equal(state.settings.modelBudget.routes, 1);
});
