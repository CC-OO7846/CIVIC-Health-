'use strict';

const IDB_NAME='clean-garage-db';
const IDB_VERSION=2;
const IDB_STORE='app_state';
const IDB_PRIMARY_KEY='primary';
const IDB_RECOVERY_STORE='recovery_snapshots';
const RECOVERY_MAX_COUNT=12;
const RECOVERY_MAX_AGE_DAYS=180;
let idbHandle=null;
let db=baseDb();
let persistTimer=null;
let persistChain=Promise.resolve();
let booted=false;
let lastPersistError=null;

function cloneValue(value){
  if(typeof structuredClone==='function')return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function baseDb(){
  return {
    schemaVersion:SCHEMA_VERSION,
    car:{id:'vehicle-1',name:'Honda Civic ES 2.0',year:2001,engine:'K20A',transmission:'AT',km:333500,monthlyKm:1200},
    history:[],symptoms:[],inspections:[],alerts:[],tasks:[],serviceEvents:[],fluidState:{},healthHistory:[],
    settings:{mileageStressStartKm:200000,mileageStressMaxKm:400000,maxMileageDeduction:5,systemWeights:{...SYSTEM_WEIGHTS},lastBackupAt:''}
  };
}

function mergeRequiredForNew(history){
  const arr=history;
  REQUIRED_RECORDS.forEach((req,i)=>{
    const key=aliasKey(req.part);
    if(!arr.some(item=>aliasKey(item.part)===key))arr.push({id:Date.now()+i+1000,image:'',customImage:false,needsVerify:!!req.needsVerify,eventType:'part_replacement',...cloneValue(req)});
  });
  return arr;
}

function applyPmCatalog(target,{seedMissing=true}={}){
  const history=target.history;
  PM_SCHEDULE.forEach((pm,i)=>{
    let record=history.find(item=>item.pmKey===pm.pmKey);
    if(!record&&pm.adoptAlias)record=history.find(item=>!item.pmKey&&aliasKey(item.part)===pm.adoptAlias);
    if(!record&&seedMissing){
      record={
        id:Date.now()+5000+i,part:pm.part,system:pm.system,date:pm.historyDate||'',km:Number(pm.historyKm||0),
        price:Number(pm.referencePrice||0),intervalKm:Number(pm.intervalKm||0),intervalMonths:Number(pm.intervalMonths||0),
        image:'',customImage:false,imageKey:pm.imageKey||'',note:`PM source: ${pm.sourceLabel}`,needsVerify:!!pm.needsVerify,
        eventType:pm.eventType||'preventive',pmPlanKm:Number(pm.planKm||0),pmPlanDate:pm.planDate||'',
        pmDerivedPlanDate:pm.derivedPlanDate||'',pmPlanDateRaw:pm.planDateRaw??null,pmHistoryDateRaw:pm.historyDateRaw||''
      };
      history.push(record);
    }
    if(!record)return;
    const customReference=Object.prototype.hasOwnProperty.call(record,'customReferencePrice')?Number(record.customReferencePrice||0):null;
    const metadata={
      pmKey:pm.pmKey,pmTracked:true,pmSource:'Civic es(3).xlsx',pmGroup:pm.group,pmSourceLabel:pm.sourceLabel,
      pmSourceIssue:pm.sourceIssue||'',pmImageRequest:pm.imageRequest||'',pmNeedsSpecificImage:!!pm.needsSpecificImage,
      referencePrice:customReference!==null&&Number.isFinite(customReference)?customReference:Number(pm.referencePrice||0),priceScope:pm.priceScope||'',priceSource:pm.priceSource||''
    };
    Object.assign(record,metadata);
    if(record.pmPlanDateRaw===undefined)record.pmPlanDateRaw=pm.planDateRaw??null;
    if(record.pmHistoryDateRaw===undefined)record.pmHistoryDateRaw=pm.historyDateRaw||'';
    if(!record.part)record.part=pm.part;
    if(!record.system)record.system=pm.system;
    if(!record.eventType)record.eventType=pm.eventType||'preventive';
    if(!record.imageKey&&!record.customImage&&pm.imageKey)record.imageKey=pm.imageKey;
  });
  target.pmSourceVersion=PM_SOURCE_VERSION;
  return target;
}

function migrateSource(source){
  const isNew=!source;
  const defaults=baseDb();
  const target=isNew?defaults:cloneValue(source);
  target.car={...defaults.car,...(target.car&&typeof target.car==='object'?target.car:{})};
  for(const key of ['history','symptoms','inspections','alerts','tasks','serviceEvents','healthHistory']){
    if(!Array.isArray(target[key]))target[key]=[];
  }
  if(!target.fluidState||typeof target.fluidState!=='object'||Array.isArray(target.fluidState))target.fluidState={};
  target.settings={...defaults.settings,...(target.settings&&typeof target.settings==='object'?target.settings:{})};
  target.settings.systemWeights={...SYSTEM_WEIGHTS,...(target.settings.systemWeights||{})};
  if(isNew){
    target.history=mergeRequiredForNew(INITIAL_HISTORY.map(item=>({...cloneValue(item)})));
  }
  target.history=target.history.map(record=>{
    const migrated=migrateServiceFields(record);
    if(migrated.image&&!migrated.imageKey&&migrated.customImage!==false)migrated.customImage=true;
    if(!migrated.eventType)migrated.eventType=isFluidRecord(migrated)?'fluid_change':'part_replacement';
    if(!migrated.imageKey){const inferred=imageKeyForPartName(migrated.part);if(inferred)migrated.imageKey=inferred;}
    return migrated;
  });
  applyPmCatalog(target,{seedMissing:true});
  if(isNew&&!target.serviceEvents.length){
    target.history.filter(record=>record.date||record.km).forEach(record=>target.serviceEvents.push({
      id:uid('evt'),vehicleId:target.car.id,type:record.eventType||'part_replacement',date:record.date||'',
      km:Number(record.km||0),system:record.system||'',title:record.part,cost:Number(record.price||0),sourceId:record.id,createdAt:nowIso()
    }));
  }
  target.schemaVersion=SCHEMA_VERSION;
  return target;
}

function runtimeFallback(source){
  const defaults=baseDb();
  const target={...defaults,...cloneValue(source||{})};
  target.car={...defaults.car,...(target.car||{})};
  for(const key of ['history','symptoms','inspections','alerts','tasks','serviceEvents','healthHistory'])if(!Array.isArray(target[key]))target[key]=[];
  target.fluidState=target.fluidState&&typeof target.fluidState==='object'?target.fluidState:{};
  target.settings={...defaults.settings,...(target.settings||{})};
  return target;
}

function readLegacyLocalStorage(){
  let source=null;
  try{const raw=localStorage.getItem(KEY);if(raw)source=JSON.parse(raw);}catch(error){console.warn('Legacy state read failed',error);}
  if(!source){
    for(const key of LEGACY_KEYS){
      try{const raw=localStorage.getItem(key);if(raw){source=JSON.parse(raw);break;}}catch(error){console.warn('Legacy key read failed',key,error);}
    }
  }
  return source;
}

function openLocalDatabase(){
  if(idbHandle)return Promise.resolve(idbHandle);
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(IDB_NAME,IDB_VERSION);
    request.onupgradeneeded=()=>{
      const database=request.result;
      if(!database.objectStoreNames.contains(IDB_STORE))database.createObjectStore(IDB_STORE);
      if(!database.objectStoreNames.contains(IDB_RECOVERY_STORE))database.createObjectStore(IDB_RECOVERY_STORE,{keyPath:'id'});
    };
    request.onsuccess=()=>{
      idbHandle=request.result;
      idbHandle.onversionchange=()=>{idbHandle.close();idbHandle=null;};
      resolve(idbHandle);
    };
    request.onerror=()=>reject(request.error||new Error('IndexedDB open failed'));
    request.onblocked=()=>reject(new Error('IndexedDB upgrade blocked by another open Clean Garage tab'));
  });
}

async function idbReadState(){
  const database=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(IDB_STORE,'readonly');
    const request=tx.objectStore(IDB_STORE).get(IDB_PRIMARY_KEY);
    request.onsuccess=()=>resolve(request.result||null);
    request.onerror=()=>reject(request.error||new Error('IndexedDB read failed'));
  });
}

async function idbWriteState(snapshot){
  const database=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).put(cloneValue(snapshot),IDB_PRIMARY_KEY);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('IndexedDB write failed'));
    tx.onabort=()=>reject(tx.error||new Error('IndexedDB write aborted'));
  });
}

function recoveryIdsToDelete(records,nowMs=Date.now()){
  const cutoff=nowMs-(RECOVERY_MAX_AGE_DAYS*24*60*60*1000);
  return [...(records||[])]
    .sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0))
    .filter((record,index)=>{
      const createdAt=Date.parse(record.createdAt||0);
      return index>=RECOVERY_MAX_COUNT||(Number.isFinite(createdAt)&&createdAt<cutoff);
    })
    .map(record=>record.id)
    .filter(Boolean);
}

async function idbCleanupRecoveries(){
  const database=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction(IDB_RECOVERY_STORE,'readwrite');
    const store=tx.objectStore(IDB_RECOVERY_STORE);
    const request=store.getAll();
    request.onsuccess=()=>recoveryIdsToDelete(request.result).forEach(id=>store.delete(id));
    request.onerror=()=>tx.abort();
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Recovery cleanup failed'));
    tx.onabort=()=>reject(tx.error||new Error('Recovery cleanup aborted'));
  });
}

async function idbWriteRecovery(snapshot,reason='migration'){
  const database=await openLocalDatabase();
  const record={id:`${Date.now()}-${Math.random().toString(36).slice(2,8)}`,createdAt:nowIso(),reason,db:cloneValue(snapshot)};
  await new Promise((resolve,reject)=>{
    const tx=database.transaction(IDB_RECOVERY_STORE,'readwrite');
    tx.objectStore(IDB_RECOVERY_STORE).put(record);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('Recovery snapshot failed'));
    tx.onabort=()=>reject(tx.error||new Error('Recovery snapshot aborted'));
  });
  try{await idbCleanupRecoveries();}catch(error){console.warn('Recovery cleanup failed',error);}
  return record.id;
}

async function persistNow(){
  const snapshot=cloneValue(db);
  persistChain=persistChain.catch(()=>{}).then(()=>idbWriteState(snapshot)).then(()=>{
    lastPersistError=null;
    return updateStorageStatus();
  }).catch(error=>{
    lastPersistError=error;
    console.error('IndexedDB persist failed',error);
    showDbToast('Database save failed');
    throw error;
  });
  return persistChain;
}

function persist(){
  clearTimeout(persistTimer);
  persistTimer=setTimeout(()=>persistNow().catch(()=>{}),120);
}

async function bootDatabase(){
  let stored=null;
  try{
    stored=await idbReadState();
    if(!stored){
      const legacy=readLegacyLocalStorage();
      db=migrateSource(legacy);
      if(legacy)await idbWriteRecovery(legacy,'legacy-localstorage-import');
      await idbWriteState(db);
      if(legacy)showDbToast('Moved existing data to IndexedDB');
    }else{
      const fromVersion=Number(stored.schemaVersion||0);
      const migrated=migrateSource(stored);
      if(fromVersion<SCHEMA_VERSION){
        await idbWriteRecovery(stored,`schema-${fromVersion}-to-${SCHEMA_VERSION}`);
        await idbWriteState(migrated);
      }
      db=migrated;
    }
    booted=true;
    renderAll();
    await updateStorageStatus();
  }catch(error){
    console.error('Database boot failed',error);
    db=stored?runtimeFallback(stored):migrateSource(readLegacyLocalStorage());
    booted=true;
    renderAll();
    const status=document.getElementById('dbStatus');
    if(status)status.textContent=stored?'Migration not saved · original retained':'IndexedDB unavailable · memory fallback';
    showDbToast(stored?'Migration failed; original database retained':'IndexedDB unavailable');
  }
}

function showDbToast(message){
  const element=document.getElementById('dbToast');
  if(!element)return;
  element.textContent=message;
  element.classList.add('show');
  clearTimeout(showDbToast._timer);
  showDbToast._timer=setTimeout(()=>element.classList.remove('show'),2600);
}

async function updateStorageStatus(){
  const status=document.getElementById('dbStatus');
  if(status)status.textContent=lastPersistError?'Save error':booted?'Saved on this device':'Starting…';
  const offline=document.getElementById('offlineStatus');
  if(offline)offline.textContent=('serviceWorker' in navigator)?(navigator.serviceWorker.controller?'Ready':'Installing…'):'Unsupported';
  const persistence=document.getElementById('persistenceStatus');
  if(persistence&&navigator.storage?.persisted){
    try{persistence.textContent=(await navigator.storage.persisted())?'Persistent':'Best effort';}catch(error){persistence.textContent='Unknown';}
  }
  const usage=document.getElementById('dbUsage');
  if(usage&&navigator.storage?.estimate){
    try{
      const estimate=await navigator.storage.estimate();
      const formatMb=value=>(value/1024/1024).toFixed(value>100*1024*1024?0:1)+' MB';
      usage.textContent=estimate.quota?`${formatMb(Number(estimate.usage||0))} / ${formatMb(Number(estimate.quota||0))}`:formatMb(Number(estimate.usage||0));
    }catch(error){usage.textContent='Available';}
  }
  if(typeof updateBackupStatus==='function')updateBackupStatus();
}

async function requestPersistentStorage(){
  if(!navigator.storage?.persist){showDbToast('Browser does not expose persistent storage');return;}
  try{
    const granted=await navigator.storage.persist();
    showDbToast(granted?'Storage protected':'Browser kept best-effort storage');
    updateStorageStatus();
  }catch(error){showDbToast('Could not request storage protection');}
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={baseDb,migrateSource,applyPmCatalog,runtimeFallback,cloneValue,recoveryIdsToDelete,IDB_NAME,IDB_VERSION,IDB_STORE,IDB_PRIMARY_KEY,IDB_RECOVERY_STORE,RECOVERY_MAX_COUNT,RECOVERY_MAX_AGE_DAYS};
}
