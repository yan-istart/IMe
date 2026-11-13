import { randomUUID } from 'node:crypto';
import { Store } from './store.js';

// All amounts are integer micro-units of the stated currency, serialized as strings.
export interface Price {
  version: string; currency: string;
  inputPerMillion: string; cachedPerMillion: string; outputPerMillion: string;
}
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface ModelRequest { inputUpperBound: number; maxOutput: number; toolAllowance: string }
export interface Quote { amount: string; price: Price; request: ModelRequest }
function integer(n: number): void { if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_TOKEN_COUNT'); }
export function money(n: string): number {
  if (typeof n !== 'string' || !/^\d+$/.test(n) || BigInt(n) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_MONEY');
  return Number(n);
}
export function cost(price: Price, usage: Usage): number {
  Object.values(usage).forEach(integer);
  if (usage.cachedInputTokens > usage.inputTokens) throw new Error('INVALID_CACHED_TOKENS');
  const total = BigInt(usage.inputTokens - usage.cachedInputTokens) * BigInt(money(price.inputPerMillion))
    + BigInt(usage.cachedInputTokens) * BigInt(money(price.cachedPerMillion))
    + BigInt(usage.outputTokens) * BigInt(money(price.outputPerMillion));
  return money(((total + 999_999n) / 1_000_000n).toString());
}
export class CostGateway {
  private stopped = false;
  private active = new Set<Promise<unknown>>();
  private readonly zone: () => string;
  private checkedZone: string | undefined;
  constructor(private readonly store: Store,timezone: string | (() => string)=Intl.DateTimeFormat().resolvedOptions().timeZone) {
    const base = typeof timezone === 'function' ? timezone : () => timezone;
    this.zone = () => {
      const value = base();
      if (this.checkedZone !== value) {
        new Intl.DateTimeFormat('en-CA',{timeZone:value}).format();
        this.checkedZone = value;
      }
      return value;
    };
    this.zone();
  }
  setLimit(scope:'session'|'day'|'account',key:string,currency:string,limit:string):void {
    if(!['session','day','account'].includes(scope)||!key||!/^[A-Z]{3}$/.test(currency))throw new Error('INVALID_CAP');
    const amount=money(limit);
    this.store.transaction(()=>{
      const keys=scope==='day'&&key==='*'?['*',new Intl.DateTimeFormat('en-CA',{timeZone:this.zone(),year:'numeric',month:'2-digit',day:'2-digit'}).format()]:[key];
      for(const current of keys){
        const row=this.store.db.prepare('SELECT * FROM budget_caps WHERE scope=? AND key=? AND currency=?').get(scope,current,currency);
        if(row&&amount<Number(row.spent)+Number(row.reserved))throw new Error('CAP_BELOW_COMMITMENTS');
        this.store.db.prepare('INSERT INTO budget_caps(scope,key,currency,limit_amount) VALUES(?,?,?,?) ON CONFLICT(scope,key,currency) DO UPDATE SET limit_amount=excluded.limit_amount').run(scope,current,currency,amount);
      }
      this.store.event('ime.budget.cap_changed',{scope,key,currency,limit});
    });
  }
  reconcile(id:string,usage:Usage):void {this.settle(id,usage,true);}
  private capKeys(taskId:string,currency:string) {
    const session=this.store.db.prepare('SELECT session_id FROM tasks WHERE id=?').get(taskId)!;
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:this.zone(),year:'numeric',month:'2-digit',day:'2-digit'}).format();
    const keys=[['session',String(session.session_id)],['day',day],['account','*']];
    for(const [scope,key] of keys) {
      const template=this.store.db.prepare("SELECT limit_amount FROM budget_caps WHERE scope=? AND key='*' AND currency=?").get(scope!,currency);
      if(template&&key!=='*')this.store.db.prepare('INSERT OR IGNORE INTO budget_caps(scope,key,currency,limit_amount) VALUES(?,?,?,?)').run(scope!,key!,currency,Number(template.limit_amount));
    }
    return keys.filter(([scope,key])=>Boolean(this.store.db.prepare('SELECT 1 FROM budget_caps WHERE scope=? AND key=? AND currency=?').get(scope!,key!,currency)));
  }
  quote(price: Price, request: ModelRequest): Quote {
    integer(request.inputUpperBound); integer(request.maxOutput);
    if (request.maxOutput === 0 || !price.version || !/^[A-Z]{3}$/.test(price.currency)) throw new Error('INVALID_QUOTE');
    // Reserve with the more expensive input rate, even for unusual cache pricing.
    const conservative = { ...price, inputPerMillion: String(Math.max(money(price.inputPerMillion), money(price.cachedPerMillion))) };
    const amount = money(String(cost(conservative, { inputTokens: request.inputUpperBound, cachedInputTokens: 0, outputTokens: request.maxOutput }) + money(request.toolAllowance)));
    return { amount: String(amount), price: { ...price }, request: { ...request } };
  }
  reserve(taskId: string, requestId: string, quote: Quote): string {
    if (this.stopped) throw new Error('GATEWAY_STOPPED');
    if (quote.amount !== this.quote(quote.price, quote.request).amount) throw new Error('INVALID_QUOTE');
    const amount = money(quote.amount);
    return this.store.transaction(() => {
      const state = this.store.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
      if (state?.status !== 'running') throw new Error('TASK_NOT_RUNNING');
      const changed = this.store.db.prepare(`UPDATE budgets SET reserved=reserved+? WHERE task_id=? AND currency=?
        AND ?<=limit_amount-spent-reserved`).run(amount, taskId, quote.price.currency, amount);
      if (!changed.changes) throw new Error('BUDGET_DENIED');
      const id = randomUUID();
      for(const [scope,key] of this.capKeys(taskId,quote.price.currency)) {
        const changed=this.store.db.prepare('UPDATE budget_caps SET reserved=reserved+? WHERE scope=? AND key=? AND currency=? AND ?<=limit_amount-spent-reserved').run(amount,scope!,key!,quote.price.currency,amount);
        if(!changed.changes)throw new Error('BUDGET_DENIED');
        this.store.db.prepare('INSERT INTO reservation_caps VALUES(?,?,?,?)').run(id,scope!,key!,quote.price.currency);
      }
      this.store.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?)').run(id, taskId, requestId, amount, 'reserved', JSON.stringify(quote));
      this.store.event('ime.budget.reserved', { taskId, requestId, reservationId: id, amount: quote.amount });
      return id;
    });
  }
  settle(id: string, usage?: Usage,reconcile=false): void {
    this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
      if (!row) throw new Error('RESERVATION_NOT_FOUND');
      const wasReserved=row.state==='reserved';
      if(!wasReserved&&!(reconcile&&row.state==='unknown'&&usage))return;
      const quote = JSON.parse(String(row.quote)) as Quote;
      const amount = usage ? money(String(cost(quote.price, usage) + money(quote.request.toolAllowance))) : Number(row.amount);
      const old=this.store.db.prepare('SELECT amount FROM usage_entries WHERE reservation_id=?').get(id);
      const delta=wasReserved?amount:amount-Number(old?.amount ?? 0);
      this.store.db.prepare('UPDATE budgets SET reserved=reserved-?,spent=spent+? WHERE task_id=?').run(wasReserved?Number(row.amount):0,delta,String(row.task_id));
      for(const cap of this.store.db.prepare('SELECT * FROM reservation_caps WHERE reservation_id=?').all(id)) {
        this.store.db.prepare('UPDATE budget_caps SET reserved=reserved-?,spent=spent+? WHERE scope=? AND key=? AND currency=?')
          .run(wasReserved?Number(row.amount):0,delta,String(cap.scope),String(cap.key),String(cap.currency));
      }
      this.store.db.prepare('UPDATE reservations SET state=? WHERE id=?').run(usage ? 'settled' : 'unknown', id);
      this.store.db.prepare('INSERT INTO usage_entries VALUES(?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET amount=excluded.amount,certainty=excluded.certainty,usage=excluded.usage').run(String(row.request_id), id, amount, usage ? 'actual' : 'unknown', usage ? JSON.stringify(usage) : null, JSON.stringify(quote.price));
      this.store.event('ime.model.usage', { taskId: row.task_id, requestId: row.request_id, amount: String(amount), certainty: usage ? 'actual' : 'unknown', pricingVersion: quote.price.version });
      if (amount > Number(row.amount)) {
        this.store.db.prepare("UPDATE tasks SET status='paused' WHERE id=? AND status='running'").run(String(row.task_id));
        this.store.event('ime.budget.bound_exceeded', { taskId: row.task_id });
      }
    });
  }
  call<T>(taskId: string, price: Price, request: ModelRequest,
    provider: (request: ModelRequest) => Promise<{ value: T; usage?: Usage }>): Promise<T> {
    const work = this.perform(taskId, price, request, provider);
    this.active.add(work);
    void work.then(() => this.active.delete(work), () => this.active.delete(work));
    return work;
  }
  async stopAndDrain(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active]);
  }
  private async perform<T>(taskId: string, price: Price, request: ModelRequest,
    provider: (request: ModelRequest) => Promise<{ value: T; usage?: Usage }>): Promise<T> {
    // Each attempt must enter this method separately. Failures retain worst-case cost.
    const reservation = this.reserve(taskId, randomUUID(), this.quote(price, request));
    try {
      const response = await provider({ ...request });
      this.settle(reservation, response.usage);
      return response.value;
    } catch (error) { this.settle(reservation); throw error; }
  }
}
