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
let lastPersistedSnapshot=null;
let localMutationRevision=0;
let settledMutationRevision=0;

function cloneValue(value){
  if(typeof structuredClone==='function')return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isPlainDataObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}

function validateMigrationSource(source){
  if(!isPlainDataObject(source))throw new Error('Database root must be an object');
  const schemaVersion=Number(source.schemaVersion||0);
  if(!Number.isFinite(schemaVersion)||schemaVersion<0)throw new Error('Database schema version is invalid');
  if(schemaVersion>SCHEMA_VERSION)throw new Error('Database schema '+schemaVersion+' is newer than this app supports');
  if(source.car!==undefined&&!isPlainDataObject(source.car))throw new Error('Vehicle data is invalid');
  for(const key of ['history','symptoms','inspections','alerts','tasks','serviceEvents','healthHistory']){
    if(source[key]!==undefined&&!Array.isArray(source[key]))throw new Error(key+' must be an array');
    if(Array.isArray(source[key])&&source[key].some(item=>!isPlainDataObject(item)))throw new Error(key+' contains an invalid record');
  }
  if(source.fluidState!==undefined&&!isPlainDataObject(source.fluidState))throw new Error('fluidState must be an object');
  if(source.settings!==undefined&&!isPlainDataObject(source.settings))throw new Error('settings must be an object');
  if(source.settings?.systemWeights!==undefined&&!isPlainDataObject(source.settings.systemWeights))throw new Error('systemWeights must be an object');
  return source;
}

function normalizeSystemWeights(source){
  const input=isPlainDataObject(source)?source:{};
  const values={};
  for(const system of SYSTEMS){
    const hasCustom=Object.prototype.hasOwnProperty.call(input,system);
    const candidate=hasCustom?Number(input[system]):Number(SYSTEM_WEIGHTS[system]);
    values[system]=Number.isFinite(candidate)&&candidate>=0?candidate:Number(SYSTEM_WEIGHTS[system]||0);
  }
  const total=Object.values(values).reduce((sum,value)=>sum+value,0);
  if(!(total>0))return {...SYSTEM_WEIGHTS};
  const normalized={};
  let assigned=0;
  SYSTEMS.forEach((system,index)=>{
    const value=index===SYSTEMS.length-1?Math.max(0,1-assigned):values[system]/total;
    normalized[system]=value;
    assigned+=value;
  });
  return normalized;
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

function legacySeedServiceSignature(record,seed){
  if(!record||!seed)return false;
  return aliasKey(record.part)===aliasKey(seed.part)
    && Number(record.km||0)===Number(seed.km||0)
    && String(record.date||'')===String(seed.date||'')
    && Number(record.intervalKm||0)===Number(seed.intervalKm||0)
    && Number(record.intervalMonths||0)===Number(seed.intervalMonths||0);
}

function isUntouchedLegacySeedRecord(record){
  return [...INITIAL_HISTORY,...REQUIRED_RECORDS].some(seed=>legacySeedServiceSignature(record,seed));
}

function syncLegacySeedFromExcel(record,pm){
  if(!record||!pm||!isUntouchedLegacySeedRecord(record))return false;
  record.part=pm.part;
  record.system=pm.system;
  record.date=pm.historyDate||'';
  record.km=Number(pm.historyKm||0);
  record.intervalKm=Number(pm.intervalKm||0);
  record.intervalMonths=Number(pm.intervalMonths||0);
  record.pmPlanKm=Number(pm.planKm||0);
  record.pmPlanDate=pm.planDate||'';
  record.pmDerivedPlanDate=pm.derivedPlanDate||'';
  record.pmPlanDateRaw=pm.planDateRaw??null;
  record.pmHistoryDateRaw=pm.historyDateRaw||'';
  record.pmExcelSourceSynced=true;
  return true;
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
    syncLegacySeedFromExcel(record,pm);
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
  const isNew=source==null;
  if(!isNew)validateMigrationSource(source);
  const defaults=baseDb();
  const target=isNew?defaults:cloneValue(source);
  target.car={...defaults.car,...(isPlainDataObject(target.car)?target.car:{})};
  for(const key of ['history','symptoms','inspections','alerts','tasks','serviceEvents','healthHistory']){
    if(!Array.isArray(target[key]))target[key]=[];
  }
  if(!isPlainDataObject(target.fluidState))target.fluidState={};
  const storedSettings=isPlainDataObject(target.settings)?target.settings:{};
  target.settings={...defaults.settings,...storedSettings,systemWeights:normalizeSystemWeights(storedSettings.systemWeights)};
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
  // PM catalog seeding happens after legacy aliases are normalized. Complete
  // service-field migration for any records introduced by that catalog pass so
  // reopening the same database is deterministic and makes no second-pass edits.
  target.history=target.history.map(record=>migrateServiceFields(record));
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
  const raw=isPlainDataObject(source)?cloneValue(source):{};
  const target={...defaults,...raw};
  target.car={...defaults.car,...(isPlainDataObject(raw.car)?raw.car:{})};
  for(const key of ['history','symptoms','inspections','alerts','tasks','serviceEvents','healthHistory']){
    target[key]=Array.isArray(raw[key])?raw[key].filter(isPlainDataObject):[];
  }
  target.fluidState=isPlainDataObject(raw.fluidState)?raw.fluidState:{};
  const storedSettings=isPlainDataObject(raw.settings)?raw.settings:{};
  target.settings={...defaults.settings,...storedSettings,systemWeights:normalizeSystemWeights(storedSettings.systemWeights)};
  target.schemaVersion=SCHEMA_VERSION;
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
  validateMigrationSource(snapshot);
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

function isQuotaError(error){
  const name=String(error?.name||'').toLowerCase();
  const message=String(error?.message||error||'').toLowerCase();
  return name==='quotaexceedederror'||/quota|storage.+full|disk.+full|space.+left/.test(message)||(error?.cause&&error.cause!==error?isQuotaError(error.cause):false);
}

function isDatabaseWriteError(error){return !!error?.storageFailure||isQuotaError(error);}

function databaseWriteMessage(error){
  return isQuotaError(error)
    ?'Device storage is full. Your latest change could not be saved. Create a backup and remove large images.'
    :'Database save failed. Your latest change could not be saved.';
}

function markStorageFailure(error){
  const failure=new Error(String(error?.message||error||'IndexedDB write failed'));
  failure.name=String(error?.name||'DatabaseWriteError');
  failure.cause=error;
  failure.storageFailure=true;
  return failure;
}

async function writeDatabaseCandidate(current,candidate,writeState=idbWriteState){
  const snapshot=cloneValue(candidate);
  await writeState(snapshot);
  return snapshot;
}

function reportPersistFailure(error){
  const failure=markStorageFailure(error);
  lastPersistError=failure;
  if(lastPersistedSnapshot)db=cloneValue(lastPersistedSnapshot);
  console.error('IndexedDB persist failed',failure);
  if(booted&&typeof renderAll==='function'){
    try{renderAll();}catch(renderError){console.error('Rollback render failed',renderError);}
  }
  const status=document.getElementById('dbStatus');
  if(status)status.textContent='Save error';
  showDbToast(databaseWriteMessage(failure));
  return failure;
}

function hasPendingDatabaseChanges(){return localMutationRevision>settledMutationRevision;}
function databaseMutationRevision(){return localMutationRevision;}

function enqueueStateWrite(snapshot,{applyToMemory=false,markRecordDirty=false,mutationRevision=0}={}){
  const candidate=cloneValue(snapshot);
  const write=persistChain.catch(()=>{}).then(()=>writeDatabaseCandidate(db,candidate,idbWriteState));
  persistChain=write.then(async saved=>{
    lastPersistError=null;
    lastPersistedSnapshot=cloneValue(saved);
    if(applyToMemory)db=cloneValue(saved);
    if(markRecordDirty&&typeof markRecordFileDirty==='function'){
      try{markRecordFileDirty();}catch(error){console.warn('Record file state update failed',error);}
    }
    // This snapshot either includes or explicitly replaces revisions captured
    // when it was queued. Later mutations must remain pending.
    settledMutationRevision=Math.max(settledMutationRevision,mutationRevision);
    try{await updateStorageStatus();}catch(error){console.warn('Storage status update failed',error);}
    return cloneValue(saved);
  },error=>{
    if(markRecordDirty)settledMutationRevision=Math.max(settledMutationRevision,mutationRevision);
    throw reportPersistFailure(error);
  });
  return persistChain;
}

async function persistNow({markRecordDirty=false,prepareDerived=true}={}){
  clearTimeout(persistTimer);persistTimer=null;
  if(markRecordDirty&&!hasPendingDatabaseChanges())localMutationRevision++;
  if(markRecordDirty&&prepareDerived&&typeof prepareDatabaseForPersistence==='function')prepareDatabaseForPersistence(db);
  return enqueueStateWrite(db,{markRecordDirty,mutationRevision:localMutationRevision});
}

async function commitDatabaseCandidate(candidate,{markRecordDirty=true}={}){
  clearTimeout(persistTimer);persistTimer=null;
  if(markRecordDirty)localMutationRevision++;
  if(markRecordDirty&&typeof prepareDatabaseForPersistence==='function')prepareDatabaseForPersistence(candidate);
  if(markRecordDirty&&typeof updateRecordFileStatus==='function')updateRecordFileStatus();
  return enqueueStateWrite(candidate,{applyToMemory:true,markRecordDirty,mutationRevision:localMutationRevision});
}

function persist(){
  clearTimeout(persistTimer);
  localMutationRevision++;
  if(typeof prepareDatabaseForPersistence==='function')prepareDatabaseForPersistence(db);
  if(typeof updateRecordFileStatus==='function')updateRecordFileStatus();
  persistTimer=setTimeout(()=>{persistTimer=null;persistNow({markRecordDirty:true,prepareDerived:false}).catch(()=>{});},120);
}

async function bootDatabase(){
  let stored=null;
  let freshDevice=false;
  try{
    stored=await idbReadState();
    if(!stored){
      const legacy=readLegacyLocalStorage();
      freshDevice=!legacy;
      db=migrateSource(legacy);
      if(legacy)await idbWriteRecovery(legacy,'legacy-localstorage-import');
      if(typeof prepareDatabaseForPersistence==='function')prepareDatabaseForPersistence(db);
      await idbWriteState(db);
      lastPersistedSnapshot=cloneValue(db);
      if(legacy)showDbToast('Moved existing data to IndexedDB');
    }else{
      lastPersistedSnapshot=cloneValue(stored);
      const fromVersion=Number(stored.schemaVersion||0);
      const migrated=migrateSource(stored);
      if(fromVersion<SCHEMA_VERSION){
        await idbWriteRecovery(stored,`schema-${fromVersion}-to-${SCHEMA_VERSION}`);
        if(typeof prepareDatabaseForPersistence==='function')prepareDatabaseForPersistence(migrated);
        await idbWriteState(migrated);
        lastPersistedSnapshot=cloneValue(migrated);
      }
      db=migrated;
    }
    booted=true;
    if(typeof initializeRecordFileState==='function')initializeRecordFileState({freshDevice});
    renderAll();
    await updateStorageStatus();
    if(typeof checkSharedRecordFile==='function'){
      try{await checkSharedRecordFile({autoApply:true});}
      catch(error){console.warn('Shared Record check failed',error);}
    }
  }catch(error){
    console.error('Database boot failed',error);
    lastPersistedSnapshot=stored?cloneValue(stored):null;
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
  showDbToast._timer=setTimeout(()=>element.classList.remove('show'),String(message||'').length>60?5200:2600);
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
  module.exports={baseDb,migrateSource,applyPmCatalog,runtimeFallback,cloneValue,isPlainDataObject,validateMigrationSource,normalizeSystemWeights,legacySeedServiceSignature,isUntouchedLegacySeedRecord,syncLegacySeedFromExcel,recoveryIdsToDelete,isQuotaError,isDatabaseWriteError,databaseWriteMessage,writeDatabaseCandidate,hasPendingDatabaseChanges,IDB_NAME,IDB_VERSION,IDB_STORE,IDB_PRIMARY_KEY,IDB_RECOVERY_STORE,RECOVERY_MAX_COUNT,RECOVERY_MAX_AGE_DAYS};
}
