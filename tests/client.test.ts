import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The browser bundle is shipped as plain JavaScript, so it is not covered by
 * tsc. Load it through the same module-loader contract Harness uses and assert
 * that every surface still registers with the expected identity.
 */
test('client bundle registers its surfaces and the per-reply cost loader', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8');
  const react = {
    createElement: () => null,
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: undefined }),
    useCallback: (fn: unknown) => fn,
    memo: (fn: unknown) => fn,
    Fragment: 'Fragment',
  };
  const slots: { name: string; id?: string | undefined; spec: Record<string, unknown> }[] = [];
  const injected: string[] = [];
  const previousWindow = (globalThis as Record<string, unknown>).window;
  const previousDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    head: { append: () => {} },
    querySelector: () => null,
    documentElement: { lang: 'zh-CN' },
  };
  let loaded: { inject?: string[]; apply?: (ctx: unknown) => void } | undefined;
  (globalThis as Record<string, unknown>).window = {
    __ModuleLoader__: {
      load(spec: { factory: (require: (id: string) => unknown) => unknown }) {
        loaded = spec.factory((id) => {
          if (id === 'react') return react;
          throw new Error('unknown module ' + id);
        }) as typeof loaded;
      },
    },
  };
  try {
    new Function('window', source)((globalThis as Record<string, unknown>).window);
    assert.ok(loaded?.apply, 'bundle exposes apply()');
    assert.deepEqual(loaded?.inject, ['slots', 'locale', 'layout']);
    const ctx = {
      effect: (setup: () => unknown) => { setup(); },
      locale: { register: () => () => {}, bind: () => (key: string) => key },
      slots: {
        inject: (name: string, callback: () => void) => { injected.push(name); callback(); },
        register: (spec: Record<string, unknown>) => {
          slots.push({ name: String(spec.name), id: spec.id as string | undefined, spec });
          return () => {};
        },
      },
      layout: { selectPanel: () => {} },
    };
    loaded.apply(ctx);
  } finally {
    (globalThis as Record<string, unknown>).window = previousWindow;
    (globalThis as Record<string, unknown>).document = previousDocument;
  }

  assert.deepEqual(injected, ['sidebar.panellist', 'main', 'settings.section', 'plugins.detail.actions', 'conversation.chat.turnTail']);
  const ids = Object.fromEntries(slots.map((item) => [item.name, item.id]));
  assert.equal(ids['sidebar.panellist'], 'ime');
  assert.equal(ids['settings.section'], 'ime-settings');
  assert.equal(ids['plugins.detail.actions'], 'ime-open-status');
  assert.equal(ids['conversation.chat.turnTail'], 'ime-turn-cost');
  const tail = slots.find((item) => item.name === 'conversation.chat.turnTail');
  const inject = tail?.spec.inject as (sessionId: string) => Record<string, unknown>;
  const props = inject('session-a');
  assert.equal(props.sessionId, 'session-a');
  assert.equal(typeof props.loadTurnCost, 'function');
});
