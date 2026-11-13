export interface Balance {state:'actual'|'unavailable';fetchedAt:string;balances?:{currency:string;total:string;available:boolean}[]}
export class DeepSeekBalance {
  private cache:Balance|undefined;
  constructor(private credential:()=>string|undefined,private fetcher:typeof fetch=fetch){}
  async get(force=false):Promise<Balance> {
    if(!force&&this.cache&&Date.now()-Date.parse(this.cache.fetchedAt)<60000)return this.cache;
    const key=this.credential();
    if(!key)return {state:'unavailable',fetchedAt:new Date().toISOString()};
    try{
      const response=await this.fetcher('https://api.deepseek.com/user/balance',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000),redirect:'error'});
      if(!response.ok)throw Error('BALANCE_UNAVAILABLE');
      const raw=await response.json() as {is_available:boolean;balance_infos:{currency:string;total_balance:string}[]};
      if(typeof raw.is_available!=='boolean'||!Array.isArray(raw.balance_infos))throw Error('INVALID_BALANCE');
      const balances=raw.balance_infos.map(b=>{if(!/^[A-Z]{3}$/.test(b.currency)||typeof b.total_balance!=='string'||!/^\d+(\.\d+)?$/.test(b.total_balance))throw Error('INVALID_BALANCE');return {currency:b.currency,total:b.total_balance,available:raw.is_available};});
      return this.cache={state:'actual',fetchedAt:new Date().toISOString(),balances};
    }catch{return {state:'unavailable',fetchedAt:new Date().toISOString()};}
  }
}
