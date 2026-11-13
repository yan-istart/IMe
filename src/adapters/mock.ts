import type { Action, DesktopPort, Observation } from '../core/desktop.js';
export class MockDesktop implements DesktopPort {
  state = 'home';
  calls: string[] = [];
  async reset(_app:string,_caseId:string,signal:AbortSignal) {signal.throwIfAborted();this.state='home';}
  async observe(app: string, signal: AbortSignal): Promise<Observation> {
    signal.throwIfAborted();
    return { fingerprint:`${app}:v1:zh:1280x720`,state:this.state,evidenceRef:`mock://${app}/${this.state}` };
  }
  async execute(action: Action, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.calls.push(action.id);
    if (action.target === 'task-panel') this.state='task-panel';
  }
}
