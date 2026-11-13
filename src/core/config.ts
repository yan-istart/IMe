import type { RuntimeConfig } from './runtime.js';
import { validateModelBudget } from '../adapters/model-gateway.js';
import { money } from './cost.js';
import { endpoint } from '../adapters/network.js';
import {validateHttpModels} from '../adapters/http-model.js';
function shape(value:unknown,keys:string[],code:string):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error(code);
}
export function validateConfig(value:unknown):RuntimeConfig {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_CONFIG');
  const config=value as RuntimeConfig;
  const keys=['dataDir','allowApps','modelBudget','desktopAdapter','desktopAdapters','context','routes','budgetCaps','budgetTimezone','desktopLeasePath','vision','dashboard','taskDefaultLimit','evaluation','learning','recovery','models','sync','telemetry','audit','adaptiveTaskBudget'];
  if(config.adaptiveTaskBudget!==undefined&&typeof config.adaptiveTaskBudget!=='boolean')throw Error('INVALID_BUDGET_PREDICTION_CONFIG');
  if(config.models!==undefined) {
    shape(config.models,['enabled','maxAttempts','privacyRegion','review','vision','http'],'INVALID_MODEL_EXECUTION_CONFIG');
    if(config.models.http!==undefined)validateHttpModels(config.models.http);
    if(config.models.vision!==undefined&&typeof config.models.vision!=='boolean')throw Error('INVALID_MODEL_EXECUTION_CONFIG');
    if(config.models.enabled!==undefined&&typeof config.models.enabled!=='boolean'||config.models.maxAttempts!==undefined&&(!Number.isSafeInteger(config.models.maxAttempts)||Number(config.models.maxAttempts)<1||Number(config.models.maxAttempts)>3)
      ||config.models.privacyRegion!==undefined&&(typeof config.models.privacyRegion!=='string'||!config.models.privacyRegion.trim()))throw Error('INVALID_MODEL_EXECUTION_CONFIG');
    if(config.models.review!==undefined) {
      shape(config.models.review,['provider','model','maxOutput'],'INVALID_REVIEW_MODEL');
      if(typeof config.models.review.provider!=='string'||!config.models.review.provider||typeof config.models.review.model!=='string'||!config.models.review.model||!Number.isSafeInteger(config.models.review.maxOutput)||Number(config.models.review.maxOutput)<1)throw Error('INVALID_REVIEW_MODEL');
    }
  }
  if(config.sync!==undefined) {
    shape(config.sync,['namespace','keyEnv','endpoint','authorizationEnv'],'INVALID_SYNC_CONFIG');
    if(typeof config.sync.namespace!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(config.sync.namespace)||typeof config.sync.keyEnv!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(config.sync.keyEnv))throw Error('INVALID_SYNC_CONFIG');
    if(config.sync.endpoint!==undefined)endpoint(config.sync.endpoint as string);
  }
  if(config.telemetry!==undefined) {
    shape(config.telemetry,['endpoint','serviceName','authorizationEnv','autoFlushMs'],'INVALID_TELEMETRY_CONFIG');
    endpoint(config.telemetry.endpoint as string);
    if(config.telemetry.serviceName!==undefined&&(typeof config.telemetry.serviceName!=='string'||!config.telemetry.serviceName.trim()||config.telemetry.serviceName.length>200))throw Error('INVALID_TELEMETRY_CONFIG');
    if(config.telemetry.autoFlushMs!==undefined&&(!Number.isSafeInteger(config.telemetry.autoFlushMs)||Number(config.telemetry.autoFlushMs)<1000))throw Error('INVALID_TELEMETRY_INTERVAL');
  }
  for(const configPart of [config.sync,config.telemetry])if(configPart?.authorizationEnv!==undefined&&(typeof configPart.authorizationEnv!=='string'||!/^[A-Z][A-Z0-9_]{0,127}$/.test(configPart.authorizationEnv)))throw Error('INVALID_CREDENTIAL_REFERENCE');
  if(config.audit!==undefined) {
    shape(config.audit,['maxBytes','retainedFiles'],'INVALID_AUDIT_CONFIG');
    if(config.audit.maxBytes!==undefined&&(!Number.isSafeInteger(config.audit.maxBytes)||Number(config.audit.maxBytes)<256)||config.audit.retainedFiles!==undefined&&(!Number.isSafeInteger(config.audit.retainedFiles)||Number(config.audit.retainedFiles)<0||Number(config.audit.retainedFiles)>20))throw Error('INVALID_AUDIT_CONFIG');
  }
  if(config.desktopAdapters!==undefined&&(!Array.isArray(config.desktopAdapters)||!config.desktopAdapters.length||config.desktopAdapters.length>10))throw Error('INVALID_DESKTOP_ADAPTERS');
  for(const key of Object.keys(config))if(!keys.includes(key))throw Error('UNKNOWN_CONFIG_FIELD:'+key);
  if(config.dataDir!==undefined&&(typeof config.dataDir!=='string'||!config.dataDir.trim()))throw Error('INVALID_DATA_DIR');
  if(config.allowApps!==undefined&&(!Array.isArray(config.allowApps)||!config.allowApps.every(a=>typeof a==='string'&&a.trim())))throw Error('INVALID_ALLOW_APPS');
  if(config.taskDefaultLimit!==undefined)money(config.taskDefaultLimit);
  validateModelBudget(config.modelBudget);
  if(config.budgetTimezone!==undefined)new Intl.DateTimeFormat('en-CA',{timeZone:config.budgetTimezone}).format();
  if(config.dashboard!==undefined) {
    if(!config.dashboard||typeof config.dashboard!=='object')throw Error('INVALID_DASHBOARD_CONFIG');
    if(config.dashboard.enabled!==undefined&&typeof config.dashboard.enabled!=='boolean')throw Error('INVALID_DASHBOARD_CONFIG');
    if(config.dashboard.port!==undefined&&(!Number.isSafeInteger(config.dashboard.port)||config.dashboard.port<0||config.dashboard.port>65535))throw Error('INVALID_DASHBOARD_PORT');
  }
  if(config.evaluation&&(!Array.isArray(config.evaluation.cases)||config.evaluation.cases.length<3||config.evaluation.cases.length>20||new Set(config.evaluation.cases).size!==config.evaluation.cases.length||typeof config.evaluation.app!=='string'||!config.evaluation.cases.every(id=>typeof id==='string'&&id.trim()&&id.length<=200)))throw Error('INVALID_EVALUATION_CONFIG');
  if(config.recovery!==undefined) {
    const r=config.recovery;
    if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['enabled','maxConsecutive','minIntervalMs'].includes(k)))throw Error('INVALID_RECOVERY_CONFIG');
    if(r.enabled!==undefined&&typeof r.enabled!=='boolean')throw Error('INVALID_RECOVERY_CONFIG');
    if(r.maxConsecutive!==undefined&&(!Number.isSafeInteger(r.maxConsecutive)||r.maxConsecutive<1||r.maxConsecutive>16))throw Error('INVALID_RECOVERY_CAP');
    if(r.minIntervalMs!==undefined&&(!Number.isSafeInteger(r.minIntervalMs)||r.minIntervalMs<0||r.minIntervalMs>600000))throw Error('INVALID_RECOVERY_INTERVAL');
  }
  if(config.learning!==undefined) {
    if(!config.learning||typeof config.learning!=='object'||Array.isArray(config.learning))throw Error('INVALID_LEARNING_CONFIG');
    if(config.learning.minSuccesses!==undefined&&(!Number.isSafeInteger(config.learning.minSuccesses)||config.learning.minSuccesses<2||config.learning.minSuccesses>20))throw Error('INVALID_MIN_SUCCESSES');
    if(config.learning.autoPublish!==undefined&&typeof config.learning.autoPublish!=='boolean')throw Error('INVALID_LEARNING_CONFIG');
    if(config.learning.maintenance!==undefined&&typeof config.learning.maintenance!=='boolean')throw Error('INVALID_LEARNING_CONFIG');
    if(config.learning.captureHostExperience!==undefined&&typeof config.learning.captureHostExperience!=='boolean')throw Error('INVALID_LEARNING_CONFIG');
    if(config.learning.captureToolPrefixes!==undefined&&(!Array.isArray(config.learning.captureToolPrefixes)||config.learning.captureToolPrefixes.some(prefix=>typeof prefix!=='string'||!prefix||prefix.length>80)))throw Error('INVALID_LEARNING_CONFIG');
  }
  if(config.budgetCaps!==undefined) {
    if(!Array.isArray(config.budgetCaps))throw Error('INVALID_BUDGET_CAPS');
    for(const cap of config.budgetCaps){if(!cap||!['session','day','account'].includes(cap.scope)||!cap.key||!/^[A-Z]{3}$/.test(cap.currency))throw Error('INVALID_BUDGET_CAPS');money(cap.limit);}
  }
  // Configuration is host-owned serializable data, never executable callbacks.
  return JSON.parse(JSON.stringify(config)) as RuntimeConfig;
}
export const Config={
  '~standard':{version:1 as const,vendor:'ime',validate(value:unknown) {
    try{return {value:validateConfig(value)};}catch(error){return {issues:[{message:error instanceof Error?error.message:'INVALID_CONFIG'}]};}
  }},
};
