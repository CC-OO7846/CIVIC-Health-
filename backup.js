'use strict';

const BACKUP_FORMAT='clean-garage-backup';
const RECORD_FILE_NAME='CleanGarage_Record.json';
const RECORD_FILE_STATE_KEY='clean-garage-record-file-state-v1';
const SHARED_RECORD_URL='./CleanGarage_Record.json';
const BACKUP_FORMAT_VERSION=2;
const BACKUP_BYTE_LIMIT=typeof MAX_BACKUP_BYTES==='number'?MAX_BACKUP_BYTES:100*1024*1024;
const GITHUB_UPLOAD_WARNING_BYTES=20*1024*1024;
const GITHUB_BROWSER_UPLOAD_LIMIT_BYTES=25*1024*1024;
const BACKUP_METRICS_CACHE_MS=10000;
const RECORD_FILE_STATE_VERSION=2;
const MAX_TIMESTAMP_FUTURE_SKEW_MS=5*60*1000;
let pendingRestore=null;
let sharedRecordCheckInFlight=false;
let sharedRecordUiExportedAt='';
let backupMetricsCache={database:null,measuredAt:0,metrics:null};
let recordFileStateMemory=null;

function isBackupObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function parseBackupText(text){
  try{return JSON.parse(text)}
  catch(error){throw new Error('Backup file is not valid JSON')}
}

function createBackupPayload(database,exportedAt){
  const stamp=String(exportedAt||database?.settings?.lastBackupAt||'');
  const appVersion=typeof APP_VERSION==='string'?APP_VERSION:'10.19.5';
  return {
    format:BACKUP_FORMAT,
    version:BACKUP_FORMAT_VERSION,
    exportedAt:stamp,
    app:'Clean Garage',
    appVersion,
    schemaVersion:SCHEMA_VERSION,
    summary:backupSummary(database),
    db:cloneValue(database)
  };
}

function safeBackupName(){return RECORD_FILE_NAME;}

function backupSummary(database){
  const history=Array.isArray(database?.history)?database.history:[];
  return {
    vehicle:String(database?.car?.name||'Unknown vehicle'),
    mileage:Number(database?.car?.km||0),
    repairRecordCount:history.length,
    pmCount:history.filter(record=>record?.pmTracked).length,
    healthHistoryCount:Array.isArray(database?.healthHistory)?database.healthHistory.length:0,
    customImageCount:history.filter(record=>record?.customImage&&typeof record.image==='string'&&record.image.startsWith('data:image/')).length,
    receiptImageCount:history.filter(record=>typeof record?.receiptImage==='string'&&record.receiptImage.startsWith('data:image/')).length
  };
}

function backupByteLength(value){
  const text=String(value||'');
  if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(text).byteLength;
  if(typeof Buffer!=='undefined')return Buffer.byteLength(text,'utf8');
  return text.length;
}

function isSafeStoredImageDataUrl(value){
  if(value==='')return true;
  if(typeof value!=='string')return false;
  const match=/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  return !!match&&match[1].length%4===0;
}

function serializeBackup(database,exportedAt){
  const payload=createBackupPayload(database,exportedAt);
  const json=JSON.stringify(payload,null,2);
  return {payload,json,bytes:backupByteLength(json)};
}

function assertBackupSize(bytes,operation='export'){
  const size=Number(bytes||0);
  if(size<=BACKUP_BYTE_LIMIT)return size;
  if(operation==='restore')throw new Error('Backup file exceeds the supported 100 MB restore limit.');
  throw new Error('Backup is too large to export and restore safely. Image data is likely responsible. Remove or replace oversized images, then try again.');
}

function backupStorageMetrics(database){
  const history=Array.isArray(database?.history)?database.history:[];
  let imageBytes=0;
  for(const record of history){
    if(record?.customImage&&typeof record.image==='string'&&record.image.startsWith('data:image/'))imageBytes+=backupByteLength(record.image);
    if(typeof record?.receiptImage==='string'&&record.receiptImage.startsWith('data:image/'))imageBytes+=backupByteLength(record.receiptImage);
  }
  let backupBytes=0;
  try{backupBytes=serializeBackup(database,database?.settings?.lastBackupAt||'').bytes;}catch(error){console.warn('Backup size estimate failed',error);}
  return {backupBytes,imageBytes};
}

function cachedBackupStorageMetrics(database,nowMs=Date.now()){
  const measuredAt=Number(nowMs)||0;
  if(backupMetricsCache.metrics&&backupMetricsCache.database===database&&measuredAt-backupMetricsCache.measuredAt<BACKUP_METRICS_CACHE_MS)return backupMetricsCache.metrics;
  const metrics=backupStorageMetrics(database);
  backupMetricsCache={database,measuredAt,metrics};
  return metrics;
}

function githubUploadAwareness(bytes){
  const size=Math.max(0,Number(bytes)||0);
  return {
    warning:size>GITHUB_UPLOAD_WARNING_BYTES,
    size,
    warningBytes:GITHUB_UPLOAD_WARNING_BYTES,
    browserLimitBytes:GITHUB_BROWSER_UPLOAD_LIMIT_BYTES,
    message:'Record file is over 20 MiB. GitHub browser upload has a 25 MiB per-file limit; keep the local backup and use Git or reduce image size before publishing.'
  };
}

function updateGithubUploadWarning(bytes){
  if(typeof document==='undefined')return githubUploadAwareness(bytes);
  const awareness=githubUploadAwareness(bytes);
  const warning=document.getElementById('githubUploadWarning');
  if(warning){warning.hidden=!awareness.warning;warning.textContent=awareness.warning?awareness.message:'';}
  return awareness;
}

function formatStorageBytes(bytes){
  const value=Math.max(0,Number(bytes)||0);
  if(value<1024)return value+' B';
  if(value<1024*1024)return (value/1024).toFixed(value>=100*1024?0:1)+' KB';
  return (value/1024/1024).toFixed(value>=100*1024*1024?0:1)+' MB';
}

function validateBackup(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Backup root must be an object');
  let database=raw;
  let metadata={format:'legacy-raw',version:0,exportedAt:'',schemaVersion:Number(raw.schemaVersion||0)};
  if(Object.prototype.hasOwnProperty.call(raw,'format')){
    if(raw.format!==BACKUP_FORMAT)throw new Error('Unsupported backup format');
    if(!Number.isInteger(raw.version)||raw.version<1||raw.version>BACKUP_FORMAT_VERSION)throw new Error('Unsupported backup version');
    database=raw.db;
    metadata={format:raw.format,version:raw.version,exportedAt:String(raw.exportedAt||''),schemaVersion:Number(raw.schemaVersion||database?.schemaVersion||0)};
  }
  if(!database||typeof database!=='object'||Array.isArray(database))throw new Error('Backup database is missing');
  if(!database.car||typeof database.car!=='object'||Array.isArray(database.car))throw new Error('Vehicle data is missing');
  if(!Number.isFinite(Number(database.car.km))||Number(database.car.km)<0)throw new Error('Vehicle mileage is invalid');
  if(!Array.isArray(database.history))throw new Error('Repair history is missing');
  for(const key of ['symptoms','inspections','alerts','tasks','serviceEvents','healthHistory']){
    if(Object.prototype.hasOwnProperty.call(database,key)&&!Array.isArray(database[key]))throw new Error(key+' must be an array');
  }
  if(database.settings!==undefined&&!isBackupObject(database.settings))throw new Error('settings must be an object');
  if(database.fluidState!==undefined&&!isBackupObject(database.fluidState))throw new Error('fluidState must be an object');
  for(const record of database.history){
    if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('Repair history contains an invalid record');
    if(record.image!==undefined&&typeof record.image!=='string')throw new Error('Part image payload is invalid');
    if(record.receiptImage!==undefined&&typeof record.receiptImage!=='string')throw new Error('Receipt image payload is invalid');
    if(record.image&&!isSafeStoredImageDataUrl(record.image))throw new Error('Part image payload is not a safe JPEG, PNG, or WebP data URL');
    if(record.receiptImage&&!isSafeStoredImageDataUrl(record.receiptImage))throw new Error('Receipt image payload is not a safe JPEG, PNG, or WebP data URL');
    for(const key of ['actualCost','customReferencePrice','referencePrice']){
      if(record[key]!==undefined&&(!Number.isFinite(Number(record[key]))||Number(record[key])<0))throw new Error(key+' is invalid');
    }
  }
  const schemaVersion=Number(database.schemaVersion||metadata.schemaVersion||0);
  if(!Number.isFinite(schemaVersion)||schemaVersion<0)throw new Error('Schema version is invalid');
  if(schemaVersion>SCHEMA_VERSION)throw new Error(`Backup schema ${schemaVersion} is newer than this app supports`);
  const migrated=migrateSource(database);
  return {metadata,database:cloneValue(database),migrated,summary:backupSummary(migrated)};
}


function defaultRecordFileState(){
  return {stateVersion:RECORD_FILE_STATE_VERSION,dirty:false,fresh:false,firstSyncRequired:false,lastSavedAt:'',lastLoadedAt:'',fileName:RECORD_FILE_NAME};
}

function loadRecordFileState(){
  const fallback=defaultRecordFileState();
  if(recordFileStateMemory)return {...recordFileStateMemory};
  try{
    if(typeof localStorage==='undefined')return fallback;
    const raw=localStorage.getItem(RECORD_FILE_STATE_KEY);
    if(!raw)return fallback;
    const parsed=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return fallback;
    const lastSavedAt=String(parsed.lastSavedAt||'');
    const lastLoadedAt=String(parsed.lastLoadedAt||'');
    const legacyState=Number(parsed.stateVersion||0)<RECORD_FILE_STATE_VERSION;
    const state={
      stateVersion:RECORD_FILE_STATE_VERSION,
      dirty:parsed.dirty!==false,
      fresh:parsed.fresh===true,
      firstSyncRequired:typeof parsed.firstSyncRequired==='boolean'
        ?parsed.firstSyncRequired
        :legacyState&&parsed.fresh!==true&&!lastSavedAt&&!lastLoadedAt,
      lastSavedAt,
      lastLoadedAt,
      fileName:String(parsed.fileName||RECORD_FILE_NAME)
    };
    recordFileStateMemory=state;
    return {...state};
  }catch(error){
    return fallback;
  }
}

function saveRecordFileState(patch){
  const current=loadRecordFileState();
  const next={...current,...patch,stateVersion:RECORD_FILE_STATE_VERSION,fileName:RECORD_FILE_NAME};
  recordFileStateMemory=next;
  try{
    if(typeof localStorage!=='undefined')localStorage.setItem(RECORD_FILE_STATE_KEY,JSON.stringify(next));
  }catch(error){
    console.warn('Could not persist Record file status',error);
  }
  updateRecordFileStatus();
  return next;
}

function initializeRecordFileState({freshDevice=false}={}){
  if(freshDevice){
    recordFileStateMemory=null;
    return saveRecordFileState({dirty:false,fresh:true,firstSyncRequired:false,lastSavedAt:'',lastLoadedAt:''});
  }
  try{
    if(typeof localStorage==='undefined')return saveRecordFileState({dirty:false,fresh:false,firstSyncRequired:true});
    const raw=localStorage.getItem(RECORD_FILE_STATE_KEY);
    if(raw){
      let parsed=null;
      try{parsed=JSON.parse(raw);}catch(error){parsed=null;}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){
        recordFileStateMemory=null;
        return saveRecordFileState({dirty:true,fresh:false,firstSyncRequired:true,lastSavedAt:'',lastLoadedAt:''});
      }
      recordFileStateMemory=null;
      const state=loadRecordFileState();
      const hasKnownReference=localRecordReference().ms>0;
      const firstSyncRequired=!state.fresh&&!hasKnownReference;
      return saveRecordFileState({firstSyncRequired});
    }
  }catch(error){return saveRecordFileState({dirty:false,fresh:false,firstSyncRequired:true});}
  return saveRecordFileState({dirty:false,fresh:!!freshDevice,firstSyncRequired:!freshDevice});
}

function markRecordFileDirty(){
  return saveRecordFileState({dirty:true,fresh:false});
}

function markRecordFileClean({savedAt='',loadedAt=''}={}){
  const patch={dirty:false,fresh:false,firstSyncRequired:false};
  if(savedAt)patch.lastSavedAt=String(savedAt);
  if(loadedAt)patch.lastLoadedAt=String(loadedAt);
  return saveRecordFileState(patch);
}

function recordFileStatusLabel(state=loadRecordFileState()){
  if(state.firstSyncRequired)return 'First sync required';
  if(state.dirty)return (state.lastSavedAt||state.lastLoadedAt)?'Unsaved changes':'Local changes';
  if(!state.lastSavedAt&&!state.lastLoadedAt)return 'Waiting for shared record';
  return 'Up to date';
}

function hasLocalRecordChanges(state=loadRecordFileState()){
  return !!state.dirty||(typeof hasPendingDatabaseChanges==='function'&&hasPendingDatabaseChanges());
}

function updateRecordFileStatus(){
  if(typeof document==='undefined')return;
  const state=loadRecordFileState();
  const displayState={...state,dirty:hasLocalRecordChanges(state)};
  const badge=document.getElementById('recordFileBadge');
  const dirty=document.getElementById('backupAgeStatus');
  const file=document.getElementById('recordFileName');
  const currentKm=document.getElementById('recordCurrentKm');
  const last=document.getElementById('lastBackupStatus');
  if(badge){
    badge.textContent=recordFileStatusLabel(displayState);
    badge.classList.toggle('record-dirty',displayState.dirty);
    badge.classList.toggle('record-clean',!displayState.dirty);
  }
  if(dirty){
    dirty.textContent=recordFileStatusLabel(displayState);
    dirty.classList.toggle('storage-warning',displayState.dirty);
  }
  if(file)file.textContent=RECORD_FILE_NAME;
  if(currentKm&&typeof db!=='undefined')currentKm.textContent=fmt(Number(db?.car?.km||0))+' km';
  const database=typeof db!=='undefined'?db:null;
  const savedAt=state.lastSavedAt||database?.settings?.lastRecordSavedAt||database?.settings?.lastBackupAt||'';
  if(last)last.textContent=savedAt?dateFmt(savedAt):'Never';
  updateSharedRecordDebug();
}

async function deliverRecordFile(blob,fileName){
  const isMobile=(typeof matchMedia==='function'&&matchMedia('(max-width:760px)').matches)
    ||(typeof navigator!=='undefined'&&/Android|iPhone|iPad|iPod/i.test(String(navigator.userAgent||'')));
  if(isMobile&&typeof navigator!=='undefined'&&typeof navigator.share==='function'&&typeof File!=='undefined'){
    try{
      const file=new File([blob],fileName,{type:'application/json'});
      if(typeof navigator.canShare!=='function'||navigator.canShare({files:[file]})){
        await navigator.share({
          title:'Clean Garage Record',
          text:'Save this file to Files, iCloud Drive, Google Drive, or another location you can access from your other device.',
          files:[file]
        });
        return 'shared';
      }
    }catch(error){
      if(error?.name==='AbortError')return 'cancelled';
      console.warn('Record share failed; falling back to download',error);
    }
  }
  if(typeof document==='undefined'||typeof URL==='undefined')return 'unavailable';
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download=fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  return 'downloaded';
}


const ISO_TIMESTAMP_PATTERN=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
function parseIsoMs(value){
  const text=String(value||'').trim();
  const parts=ISO_TIMESTAMP_PATTERN.exec(text);
  if(!parts)return 0;
  const ms=Date.parse(text);
  if(!Number.isFinite(ms))return 0;
  const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]),hour=Number(parts[4]),minute=Number(parts[5]),second=Number(parts[6]),millisecond=Number(String(parts[7]||'0').padEnd(3,'0'));
  const offsetHour=Number(parts[10]||0),offsetMinute=Number(parts[11]||0);
  if(offsetHour>14||offsetMinute>59||(offsetHour===14&&offsetMinute!==0))return 0;
  const offsetSign=parts[9]==='-'?-1:1;
  const localView=new Date(ms+(parts[8]==='Z'?0:offsetSign*(offsetHour*60+offsetMinute)*60000));
  if(localView.getUTCFullYear()!==year||localView.getUTCMonth()+1!==month||localView.getUTCDate()!==day||localView.getUTCHours()!==hour||localView.getUTCMinutes()!==minute||localView.getUTCSeconds()!==second||localView.getUTCMilliseconds()!==millisecond)return 0;
  return ms;
}
function recordTimestampState(value,nowMs=Date.now()){
  const ms=parseIsoMs(value);
  if(!ms)return {valid:false,reason:'invalid',ms:0};
  const current=Number(nowMs);
  if(Number.isFinite(current)&&ms>current+MAX_TIMESTAMP_FUTURE_SKEW_MS)return {valid:false,reason:'future',ms};
  return {valid:true,reason:'',ms};
}
function localRecordReference(nowMs=Date.now()){
  const state=loadRecordFileState();
  const database=typeof db!=='undefined'?db:null;
  const candidates=[
    state.lastSavedAt,
    database?.settings?.lastRecordSavedAt,
    database?.settings?.lastBackupAt
  ].map(value=>{const timestamp=recordTimestampState(value,nowMs);return {iso:String(value||''),ms:timestamp.ms,valid:timestamp.valid};}).filter(item=>item.valid).map(({iso,ms})=>({iso,ms}));
  return candidates.reduce((best,item)=>item.ms>best.ms?item:best,{iso:'',ms:0});
}
function decideSharedRecord({remoteExportedAt='',localReferenceAt='',dirty=false,freshDevice=false,firstSyncRequired=false,nowMs=Date.now()}={}){
  const remote=recordTimestampState(remoteExportedAt,nowMs);
  const local=recordTimestampState(localReferenceAt,nowMs);
  const remoteTime=remote.ms;
  const localTime=local.valid?local.ms:0;
  if(!remote.valid)return {status:remote.reason==='future'?'future-timestamp':'invalid-timestamp',remoteTime,localTime};
  if(firstSyncRequired)return {status:'first-sync-required',remoteTime,localTime};
  if(dirty&&localTime&&remoteTime<=localTime)return {status:'local-unpublished',remoteTime,localTime};
  if(localTime&&remoteTime<=localTime)return {status:'current',remoteTime,localTime};
  if(dirty)return {status:'conflict',remoteTime,localTime};
  if(freshDevice)return {status:'newer',remoteTime,localTime};
  if(!localTime)return {status:'unknown-local-time',remoteTime,localTime};
  return {status:'newer',remoteTime,localTime};
}
function debugIso(value){
  const ms=parseIsoMs(value);
  return ms?new Date(ms).toISOString():'—';
}
function updateSharedRecordDebug(remoteExportedAt=sharedRecordUiExportedAt){
  if(typeof document==='undefined')return;
  const state=loadRecordFileState();
  const local=localRecordReference();
  const values={
    sharedRecordExportedAt:debugIso(remoteExportedAt),
    sharedRecordLocalTime:debugIso(local.iso),
    sharedRecordDirty:hasLocalRecordChanges(state)?'Yes':'No',
    sharedRecordLastLoaded:debugIso(state.lastLoadedAt)
  };
  for(const [id,value] of Object.entries(values)){
    const element=document.getElementById(id);
    if(element)element.textContent=value;
  }
}
function setSharedRecordUi(status,message='',showLoad=false,{remoteExportedAt=sharedRecordUiExportedAt}={}){
  sharedRecordUiExportedAt=String(remoteExportedAt||'');
  if(typeof document==='undefined')return;
  const statusEl=document.getElementById('sharedRecordStatus');
  const noteEl=document.getElementById('sharedRecordNote');
  const button=document.getElementById('loadSharedRecordBtn');
  if(statusEl)statusEl.textContent=status;
  if(noteEl)noteEl.textContent=message;
  if(button)button.hidden=!showLoad;
  updateSharedRecordDebug();
}
function setSharedRecordCheckBusy(busy){
  if(typeof document==='undefined')return;
  const button=document.getElementById('checkSharedRecordBtn');
  if(button){button.disabled=!!busy;button.textContent=busy?'CHECKING…':'CHECK FOR LATEST RECORD';}
}
function resolveSharedRecordUrl(baseHref){
  const base=baseHref||(typeof document!=='undefined'?document.baseURI:'http://localhost/');
  return new URL(SHARED_RECORD_URL,base).href;
}
function sharedRecordError(code,message){
  const error=new Error(message);
  error.code=code;
  return error;
}
function isJsonContentType(value){
  const type=String(value||'').split(';',1)[0].trim().toLowerCase();
  return type==='application/json'||type==='text/json'||type.endsWith('+json');
}
async function parseSharedRecordResponse(response,{nowMs=Date.now()}={}){
  if(response.status===404)return null;
  if(!response.ok)throw sharedRecordError('http',`Shared Record HTTP ${response.status}`);
  const contentType=response.headers?.get?.('content-type')||'';
  if(!isJsonContentType(contentType))throw sharedRecordError('content-type','Shared Record response is not JSON. GitHub Pages may still be deploying or returned an HTML fallback.');
  const declared=Number(response.headers?.get?.('content-length')||0);
  if(declared)assertBackupSize(declared,'restore');
  const text=await response.text();
  assertBackupSize(backupByteLength(text),'restore');
  if(/^\s*(?:<!doctype\s+html|<html|<)/i.test(text))throw sharedRecordError('html','Shared Record returned HTML instead of JSON. Local data was not changed.');
  let raw;
  try{raw=parseBackupText(text);}
  catch(error){throw sharedRecordError('malformed',error.message);}
  const result=validateBackup(raw);
  const timestamp=recordTimestampState(result.metadata.exportedAt,nowMs);
  if(!timestamp.valid)throw sharedRecordError(timestamp.reason==='future'?'future-timestamp':'timestamp',timestamp.reason==='future'?'Shared Record exportedAt is too far in the future.':'Shared Record exportedAt must be a valid ISO timestamp.');
  return result;
}
async function fetchSharedRecord({fetchImpl,baseHref,now,validationNow}={}){
  const requestUrl=new URL(resolveSharedRecordUrl(baseHref));
  requestUrl.searchParams.set('record-check',String(now||Date.now()));
  const requestFetch=fetchImpl||(typeof fetch==='function'?fetch:null);
  if(!requestFetch)throw sharedRecordError('network','Shared Record fetch is unavailable in this browser.');
  let response;
  try{
    response=await requestFetch(requestUrl.href,{cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json'}});
  }catch(error){throw sharedRecordError('network','Could not reach the Shared Record. Local data was not changed.');}
  return parseSharedRecordResponse(response,{nowMs:validationNow===undefined?Date.now():validationNow});
}
async function applySharedRecord(result){
  if(!result)return false;
  const loadedAt=nowIso();
  const candidate=cloneValue(result.migrated);
  candidate.settings={...(candidate.settings||{}),lastRecordLoadedAt:loadedAt};
  db=await commitRestoredDatabase(db,candidate,{
    writeRecovery:idbWriteRecovery,
    writeState:snapshot=>commitDatabaseCandidate(snapshot,{markRecordDirty:false})
  });
  markRecordFileClean({savedAt:result.metadata.exportedAt||db.settings?.lastRecordSavedAt||'',loadedAt});
  renderAll();
  await updateStorageStatus();
  return true;
}
function sharedFetchFailureUi(error,{online=typeof navigator==='undefined'||navigator.onLine!==false}={}){
  if(['content-type','html','malformed','timestamp','future-timestamp'].includes(error?.code))return {status:'Invalid shared file',message:(error.message||'Shared Record is invalid')+' Local database preserved.'};
  if(error?.code==='network'&&!online)return {status:'Offline',message:'The Shared Record could not be checked while offline. Local database preserved; retry when connected.'};
  return {status:'Unavailable',message:(error?.message||'Could not read the Shared Record file.')+' Retry when GitHub Pages is ready.'};
}
async function checkSharedRecordFile({autoApply=false}={}){
  setSharedRecordUi('Checking…','Looking for CleanGarage_Record.json in this GitHub Pages folder.',false,{remoteExportedAt:''});
  let result;
  try{result=await fetchSharedRecord();}
  catch(error){
    console.warn('Shared Record fetch failed',error);
    const ui=sharedFetchFailureUi(error);
    setSharedRecordUi(ui.status,ui.message,false,{remoteExportedAt:''});
    return {status:'error',error};
  }
  if(!result){
    setSharedRecordUi('Not found','Shared file is not available yet. Local data is unchanged; retry after GitHub Pages finishes deploying.',false,{remoteExportedAt:''});
    return {status:'missing'};
  }
  const state=loadRecordFileState();
  const local=localRecordReference();
  const decision=decideSharedRecord({
    remoteExportedAt:result.metadata.exportedAt,
    localReferenceAt:local.iso,
    dirty:hasLocalRecordChanges(state),
    freshDevice:state.fresh,
    firstSyncRequired:state.firstSyncRequired
  });
  const uiOptions={remoteExportedAt:result.metadata.exportedAt};
  if(decision.status==='first-sync-required'){
    setSharedRecordUi('First sync required','Existing local data has no Record-file baseline. Automatic replacement was skipped; review and load the validated Shared Record manually.',true,uiOptions);
    return {status:'first-sync-required',result,decision};
  }
  if(decision.status==='local-unpublished'){
    setSharedRecordUi('Local changes not published','This device has unsaved changes and the Shared Record is equal or older. Local data was preserved; save and publish a new Record file.',false,uiOptions);
    return {status:'local-unpublished',result,decision};
  }
  if(decision.status==='current'){
    setSharedRecordUi('Up to date','Shared Record is not newer than this device.',false,uiOptions);
    return {status:'current',result,decision};
  }
  if(decision.status==='conflict'){
    setSharedRecordUi('Newer shared record available','This device has unsaved local changes. It will not be overwritten automatically.',true,uiOptions);
    return {status:'conflict',result,decision};
  }
  if(decision.status==='unknown-local-time'){
    setSharedRecordUi('Review shared record','Local data has no comparable ISO reference time. Automatic replacement was skipped.',true,uiOptions);
    return {status:'unknown-local-time',result,decision};
  }
  if(decision.status==='invalid-timestamp'){
    const error=sharedRecordError('timestamp','Shared Record exportedAt must be a valid ISO timestamp.');
    setSharedRecordUi('Invalid shared file',error.message+' Local database preserved.',false,uiOptions);
    return {status:'error',error,result,decision};
  }
  if(decision.status==='future-timestamp'){
    const error=sharedRecordError('future-timestamp','Shared Record exportedAt is too far in the future.');
    setSharedRecordUi('Invalid shared file',error.message+' Local database preserved.',false,uiOptions);
    return {status:'error',error,result,decision};
  }
  if(autoApply){
    try{
      await applySharedRecord(result);
      setSharedRecordUi('Updated','Loaded the newer Shared Record and saved it to this device.',false,uiOptions);
      showDbToast('Shared Record updated from GitHub Pages');
      return {status:'updated',result,decision};
    }catch(error){
      console.error('Shared Record apply failed',error);
      setSharedRecordUi('Load failed','Validation passed, but the recovery snapshot or final IndexedDB write failed. Local database was preserved.',true,uiOptions);
      return {status:'apply-error',error,result,decision};
    }
  }
  setSharedRecordUi('Newer shared record available','A newer validated Shared Record is ready to load.',true,uiOptions);
  return {status:'available',result,decision};
}
async function checkForLatestRecord(){
  if(sharedRecordCheckInFlight)return false;
  sharedRecordCheckInFlight=true;
  setSharedRecordCheckBusy(true);
  try{return await checkSharedRecordFile({autoApply:true});}
  finally{sharedRecordCheckInFlight=false;setSharedRecordCheckBusy(false);}
}
async function loadSharedRecordFile(){
  const checked=await checkSharedRecordFile({autoApply:false});
  const loadable=['conflict','first-sync-required','unknown-local-time','available'].includes(checked.status);
  if(!loadable)return checked.status==='updated'||checked.status==='current';
  if(['conflict','first-sync-required','unknown-local-time'].includes(checked.status)){
    const message=checked.status==='conflict'
      ?'This device has unsaved local changes. Loading the Shared Record will replace them. Continue?'
      :checked.status==='first-sync-required'
        ?'This is the first Shared Record sync for existing local data. Loading will replace the current database after validation and a recovery snapshot. Continue?'
      :'This device has no comparable local reference time. Loading the Shared Record will replace its current database. Continue?';
    if(!confirm(message))return false;
  }
  try{
    await applySharedRecord(checked.result);
    setSharedRecordUi('Updated','Shared Record loaded after validation and safe IndexedDB commit.',false,{remoteExportedAt:checked.result.metadata.exportedAt});
    showDbToast('Shared Record loaded');
    return true;
  }catch(error){
    console.error('Shared Record load failed',error);
    setSharedRecordUi('Load failed','Current local database was preserved.',true,{remoteExportedAt:checked.result.metadata.exportedAt});
    alert('Shared Record could not be loaded. The current local database was preserved.');
    return false;
  }
}

function backupAge(lastBackupAt,now=new Date()){
  if(!lastBackupAt)return {days:null,label:'Never',stale:true};
  const date=new Date(lastBackupAt);
  if(!Number.isFinite(date.getTime()))return {days:null,label:'Unknown',stale:true};
  const days=Math.max(0,Math.floor((now-date)/86400000));
  return {days,label:days===0?'Today':days===1?'1 day':`${days} days`,stale:days>30};
}

function updateBackupStatus(){
  const state=loadRecordFileState();
  const stamp=state.lastSavedAt||db?.settings?.lastRecordSavedAt||db?.settings?.lastBackupAt||'';
  const age=backupAge(stamp);
  const warning=document.getElementById('backupWarning');
  updateRecordFileStatus();
  if(warning){
    const dirty=!!state.dirty;
    const firstSyncRequired=!!state.firstSyncRequired;
    warning.hidden=!firstSyncRequired&&!dirty&&!age.stale;
    if(firstSyncRequired)warning.textContent='First sync required. Existing local data will not be replaced automatically; save it or review a validated Shared Record.';
    else if(dirty)warning.textContent='This device has newer changes than your Record file. Tap SAVE RECORD FILE before switching devices.';
    else if(age.stale)warning.textContent='Your last Record file is more than 30 days old. Save a fresh copy when convenient.';
    else warning.textContent='';
  }
  const metrics=cachedBackupStorageMetrics(db);
  const backupEstimate=document.getElementById('backupSizeEstimate');
  const imageEstimate=document.getElementById('imageStorageEstimate');
  if(backupEstimate)backupEstimate.textContent=formatStorageBytes(metrics.backupBytes)+' / 100 MB';
  if(imageEstimate)imageEstimate.textContent=formatStorageBytes(metrics.imageBytes);
  updateGithubUploadWarning(metrics.backupBytes);
}

async function exportDatabaseBackup(){
  const exportedAt=nowIso();
  const candidate=cloneValue(db);
  candidate.settings={
    ...(candidate.settings||{}),
    lastBackupAt:exportedAt,
    lastRecordSavedAt:exportedAt
  };
  const serialized=serializeBackup(candidate,exportedAt);
  const blob=new Blob([serialized.json],{type:'application/json'});
  const githubAwareness=updateGithubUploadWarning(blob.size);
  try{assertBackupSize(blob.size,'export');}
  catch(error){
    console.error('Record file export refused',error);
    alert(error.message);
    showDbToast('Record file not created');
    return false;
  }

  let delivered='unavailable';
  try{
    delivered=await deliverRecordFile(blob,RECORD_FILE_NAME);
  }catch(error){
    console.error('Record file delivery failed',error);
    alert('Could not save the Record file. Your local database was not changed.');
    return false;
  }
  if(delivered==='cancelled')return false;
  if(delivered==='unavailable'){
    alert('This browser could not save the Record file.');
    return false;
  }

  db.settings={
    ...(db.settings||{}),
    lastBackupAt:exportedAt,
    lastRecordSavedAt:exportedAt
  };
  let timestampSaved=true;
  try{await persistNow({markRecordDirty:false});}
  catch(error){timestampSaved=false;console.warn('Record saved timestamp was not persisted',error);}
  markRecordFileClean({savedAt:exportedAt});
  updateBackupStatus();
  updateGithubUploadWarning(blob.size);
  if(timestampSaved)showDbToast(githubAwareness.warning?'Record saved locally · over 20 MiB for GitHub browser upload':delivered==='shared'?'Record ready to save/share':'Record file saved');
  return true;
}

async function saveRecordFile(){
  return exportDatabaseBackup();
}

function setRestorePreview(result,fileName){
  pendingRestore={...result,fileName};
  const summary=result.summary;
  document.getElementById('restoreFileName').textContent=fileName;
  document.getElementById('restoreExportedAt').textContent=result.metadata.exportedAt?dateFmt(result.metadata.exportedAt):'Legacy backup (no export timestamp)';
  document.getElementById('restoreVehicle').textContent=summary.vehicle;
  document.getElementById('restoreMileage').textContent=fmt(summary.mileage)+' km';
  document.getElementById('restoreRepairs').textContent=String(summary.repairRecordCount);
  document.getElementById('restorePm').textContent=String(summary.pmCount);
  document.getElementById('restoreHealth').textContent=String(summary.healthHistoryCount);
  document.getElementById('restoreImages').textContent=String(summary.customImageCount);
  document.getElementById('restoreReceipts').textContent=String(summary.receiptImageCount||0);
  showModal(document.getElementById('restorePreviewModal'));
}

function closeRestorePreview(){
  pendingRestore=null;
  document.getElementById('restorePreviewModal').classList.remove('show');
}

async function restoreDatabaseBackup(event){
  const file=event.target.files?.[0];
  event.target.value='';
  if(!file)return;
  try{
    assertBackupSize(file.size,'restore');
    const parsed=parseBackupText(await file.text());
    const result=validateBackup(parsed);
    setRestorePreview(result,file.name);
  }catch(error){
    console.error('Restore validation failed',error);
    alert(`Restore failed: ${error.message}`);
  }
}


async function loadRecordFile(event){
  return restoreDatabaseBackup(event);
}

async function commitRestoredDatabase(current,candidate,writers={}){
  const writeRecovery=writers.writeRecovery||idbWriteRecovery;
  const writeState=writers.writeState||idbWriteState;
  await writeRecovery(current,'pre-restore');
  await writeState(candidate);
  return candidate;
}

async function confirmRestoreDatabase(){
  if(!pendingRestore)return;
  const candidate=cloneValue(pendingRestore.migrated);
  const modal=document.getElementById('restorePreviewModal');
  const button=document.getElementById('confirmRestoreBtn');
  button.disabled=true;
  button.textContent='Restoring…';
  try{
    const loadedMeta={...pendingRestore.metadata};
    const loadedFileName=pendingRestore.fileName||RECORD_FILE_NAME;
    const loadedAt=nowIso();
    candidate.settings={...(candidate.settings||{}),lastRecordLoadedAt:loadedAt};
    db=await commitRestoredDatabase(db,candidate,{
      writeRecovery:idbWriteRecovery,
      writeState:snapshot=>commitDatabaseCandidate(snapshot,{markRecordDirty:false})
    });
    pendingRestore=null;
    modal.classList.remove('show');
    markRecordFileClean({savedAt:loadedMeta.exportedAt||db.settings?.lastRecordSavedAt||'',loadedAt});
    renderAll();
    await updateStorageStatus();
    showDbToast(`Loaded ${loadedFileName}`);
  }catch(error){
    console.error('Restore failed',error);
    alert('Load failed. The current database was not replaced.');
  }finally{
    button.disabled=false;
    button.textContent='Restore and replace';
  }
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={BACKUP_FORMAT,BACKUP_FORMAT_VERSION,BACKUP_BYTE_LIMIT,GITHUB_UPLOAD_WARNING_BYTES,GITHUB_BROWSER_UPLOAD_LIMIT_BYTES,BACKUP_METRICS_CACHE_MS,RECORD_FILE_STATE_VERSION,MAX_TIMESTAMP_FUTURE_SKEW_MS,RECORD_FILE_NAME,RECORD_FILE_STATE_KEY,SHARED_RECORD_URL,isBackupObject,parseBackupText,createBackupPayload,backupSummary,backupByteLength,isSafeStoredImageDataUrl,serializeBackup,assertBackupSize,backupStorageMetrics,cachedBackupStorageMetrics,githubUploadAwareness,formatStorageBytes,validateBackup,backupAge,defaultRecordFileState,loadRecordFileState,saveRecordFileState,initializeRecordFileState,markRecordFileClean,recordFileStatusLabel,hasLocalRecordChanges,parseIsoMs,recordTimestampState,localRecordReference,decideSharedRecord,resolveSharedRecordUrl,isJsonContentType,parseSharedRecordResponse,fetchSharedRecord,sharedFetchFailureUi,commitRestoredDatabase};
}
