import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/core/runtime.js';
import { HostModelGateway, type HostChunk, type ModelBudgetConfig } from '../src/adapters/model-gateway.js';

const policy: ModelBudgetConfig = {
  sessionLimit: '1000',
  routes: [{
    provider: 'mock', model: 'text', inputUpperBound: 100, maxOutput: 50,
    price: { version: 'test-only', currency: 'USD', inputPerMillion: '1000000', cachedPerMillion: '100000', outputPerMillion: '2000000' },
  }],
};
const usage = { inputTokens: 60, cacheReadTokens: 20, outputTokens: 10 };
const request = { provider: 'mock', model: 'text', sessionId: 'session-a', maxTokens: 50 };

async function* success(): AsyncGenerator<HostChunk> {
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
async function consume(stream: AsyncIterable<HostChunk>) {
  const chunks: HostChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
function setup(t: TestContext, config?: ModelBudgetConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'ime-turn-'));
  const runtime = new Runtime({ dataDir: dir });
  const gateway = new HostModelGateway(runtime, config);
  t.after(async () => { await gateway.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, gateway, dir };
}

test('a reply cost is summed from settled ledger entries of exactly that turn', async t => {
  const { runtime, gateway } = setup(t, policy);
  gateway.setContext('session-a', { turn: 3, step: 1 });
  await consume(gateway.intercept(request, () => success()));
  gateway.setContext('session-a', { turn: 4, step: 1 });
  await consume(gateway.intercept(request, () => success()));

  const third = runtime.turnCost('session-a', 3);
  assert.equal(third.available, true);
  assert.equal(third.requests, 1);
  assert.equal(third.certainty, 'actual');
  assert.equal(third.currency, 'USD');
  assert.equal(third.priced, true);
  assert.equal(third.total, '82');
  assert.deepEqual(third.tokens, { input: 80, cached: 20, output: 10 });

  assert.equal(runtime.turnCost('session-a', 4).total, '82');
  assert.equal(runtime.turnCost('session-a', 2).available, false);
  assert.equal(runtime.turnCost('other-session', 3).available, false);
  assert.throws(() => runtime.turnCost('', 3), /INVALID_SESSION/);
  assert.throws(() => runtime.turnCost('session-a', -1), /INVALID_TURN/);
});

test('an unpriced or open request is reported instead of a fabricated amount', async t => {
  const { runtime, gateway } = setup(t);
  gateway.setContext('session-a', { turn: 1, step: 1 });
  await consume(gateway.intercept(request, () => success()));
  const unpriced = runtime.turnCost('session-a', 1);
  assert.equal(unpriced.available, true);
  assert.equal(unpriced.certainty, 'unpriced');
  assert.equal(unpriced.priced, false);
  assert.equal(unpriced.total, '0');
  assert.deepEqual(unpriced.tokens, { input: 80, cached: 20, output: 10 });

  const hanging = setup(t, policy);
  hanging.gateway.setContext('session-a', { turn: 1, step: 1 });
  const stream = hanging.gateway.intercept(request, () => (async function* () {
    yield { type: 'usage', usage };
    await new Promise(() => {});
  })());
  const reading = stream.next();
  await reading;
  const pending = hanging.runtime.turnCost('session-a', 1);
  assert.equal(pending.certainty, 'pending');
  assert.equal(pending.currency, 'USD');
  assert.equal(pending.reserved, '200');
  assert.equal(pending.spent, '0');
  await hanging.gateway.close();
});

test('settings edits apply to the live runtime, persist, and reject invalid input', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ime-settings-'));
  const first = new Runtime({ dataDir: dir, allowApps: ['a'], taskDefaultLimit: '1000', budgetTimezone: 'UTC' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    assert.deepEqual(first.allowApps, ['a']);
    first.settings.update({ allowApps: ['a', 'b'], taskDefaultLimit: '2000', budgetTimezone: 'Asia/Shanghai' });
    assert.deepEqual(first.allowApps, ['a', 'b']);
    assert.equal(first.settings.taskDefaultLimit, '2000');
    assert.equal(first.settings.budgetTimezone, 'Asia/Shanghai');
    assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
    assert.throws(() => first.settings.update({ allowApps: ['x', 1] }), /INVALID_ALLOW_APPS/);
    assert.throws(() => first.settings.update({ taskDefaultLimit: '-1' }), /INVALID_MONEY/);
    assert.throws(() => first.settings.update({ budgetTimezone: 'Mars/Base' }), /RangeError/);
    assert.throws(() => first.settings.update({ modelBudget: { sessionLimit: '1', routes: [] } }), /INVALID_MODEL_BUDGET/);
    first.settings.update({ modelBudget: policy });
    assert.equal(first.settings.modelBudget?.routes[0]?.model, 'text');
    first.settings.update({ modelBudget: structuredClone(policy) });
    assert.equal(first.settings.snapshot().allowApps[1], 'b');
    first.settings.update({ modelBudget: null });
    assert.equal(first.settings.modelBudget, undefined);
    first.settings.update({ modelBudget: structuredClone(policy) });
  } finally {
    await first.close();
  }

  const reopened = new Runtime({ dataDir: dir, allowApps: ['a'], taskDefaultLimit: '1000', budgetTimezone: 'UTC' });
  try {
    assert.deepEqual(reopened.allowApps, ['a', 'b']);
    assert.equal(reopened.settings.taskDefaultLimit, '2000');
    assert.equal(reopened.settings.budgetTimezone, 'Asia/Shanghai');
    assert.equal(reopened.settings.modelBudget?.sessionLimit, '1000');
  } finally {
    await reopened.close();
  }
});
