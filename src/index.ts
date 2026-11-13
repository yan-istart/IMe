import { mount, type HostContext } from './adapters/dsh.js';
import type { RuntimeConfig } from './core/runtime.js';
export const name = 'ime-core';
export const inject = ['tools', 'llm'];
export async function apply(ctx: HostContext, config: RuntimeConfig = {}): Promise<void> { const mounted=mount(ctx,config);await mounted.ready; }
export { Runtime } from './core/runtime.js';

export { Config } from './core/config.js';
