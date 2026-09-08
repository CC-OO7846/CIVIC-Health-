'use strict';

const BACKUP_FORMAT='clean-garage-backup';
const RECORD_FILE_NAME='CleanGarage_Record.json';
const RECORD_FILE_STATE_KEY='clean-garage-record-file-state-v1';
const BACKUP_FORMAT_VERSION=2;
const BACKUP_BYTE_LIMIT=typeof MAX_BACKUP_BYTES==='number'?MAX_BACKUP_BYTES:100*1024*1024;
let pendingRestore=null;

function isBackupObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function parseBackupText(text){
  try{return JSON.parse(text)}
  catch(error){throw new Error('Backup file is not valid JSON')}
}

function createBackupPayload(database,exportedAt){
  const stamp=String(exportedAt||database?.settings?.lastBackupAt||'');
  const appVersion=typeof APP_VERSION==='string'?APP_VERSION:'10.19.1';
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
  return {dirty:true,lastSavedAt:'',lastLoadedAt:'',fileName:RECORD_FILE_NAME};
}

function loadRecordFileState(){
  const fallback=defaultRecordFileState();
  try{
    if(typeof localStorage==='undefined')return fallback;
    const raw=localStorage.getItem(RECORD_FILE_STATE_KEY);
    if(!raw)return fallback;
    const parsed=JSON.parse(raw);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return fallback;
    return {
      dirty:parsed.dirty!==false,
      lastSavedAt:String(parsed.lastSavedAt||''),
      lastLoadedAt:String(parsed.lastLoadedAt||''),
      fileName:String(parsed.fileName||RECORD_FILE_NAME)
    };
  }catch(error){
    return fallback;
  }
}

function saveRecordFileState(patch){
  const current=loadRecordFileState();
  const next={...current,...patch,fileName:RECORD_FILE_NAME};
  try{
    if(typeof localStorage!=='undefined')localStorage.setItem(RECORD_FILE_STATE_KEY,JSON.stringify(next));
  }catch(error){
    console.warn('Could not persist Record file status',error);
  }
  updateRecordFileStatus();
  return next;
}

function markRecordFileDirty(){
  return saveRecordFileState({dirty:true});
}

function markRecordFileClean({savedAt='',loadedAt=''}={}){
  const patch={dirty:false};
  if(savedAt)patch.lastSavedAt=String(savedAt);
  if(loadedAt)patch.lastLoadedAt=String(loadedAt);
  return saveRecordFileState(patch);
}

function recordFileStatusLabel(state=loadRecordFileState()){
  if(state.dirty)return state.lastSavedAt?'Unsaved changes':'Not saved yet';
  return 'Up to date';
}

function updateRecordFileStatus(){
  if(typeof document==='undefined')return;
  const state=loadRecordFileState();
  const badge=document.getElementById('recordFileBadge');
  const dirty=document.getElementById('backupAgeStatus');
  const file=document.getElementById('recordFileName');
  const currentKm=document.getElementById('recordCurrentKm');
  const last=document.getElementById('lastBackupStatus');
  if(badge){
    badge.textContent=recordFileStatusLabel(state);
    badge.classList.toggle('record-dirty',state.dirty);
    badge.classList.toggle('record-clean',!state.dirty);
  }
  if(dirty){
    dirty.textContent=recordFileStatusLabel(state);
    dirty.classList.toggle('storage-warning',state.dirty);
  }
  if(file)file.textContent=RECORD_FILE_NAME;
  if(currentKm&&typeof db!=='undefined')currentKm.textContent=fmt(Number(db?.car?.km||0))+' km';
  const savedAt=state.lastSavedAt||db?.settings?.lastRecordSavedAt||db?.settings?.lastBackupAt||'';
  if(last)last.textContent=savedAt?dateFmt(savedAt):'Never';
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
    warning.hidden=!dirty&&!age.stale;
    if(dirty)warning.textContent='This device has newer changes than your Record file. Tap SAVE RECORD FILE before switching devices.';
    else if(age.stale)warning.textContent='Your last Record file is more than 30 days old. Save a fresh copy when convenient.';
    else warning.textContent='';
  }
  const metrics=backupStorageMetrics(db);
  const backupEstimate=document.getElementById('backupSizeEstimate');
  const imageEstimate=document.getElementById('imageStorageEstimate');
  if(backupEstimate)backupEstimate.textContent=formatStorageBytes(metrics.backupBytes)+' / 100 MB';
  if(imageEstimate)imageEstimate.textContent=formatStorageBytes(metrics.imageBytes);
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
  if(timestampSaved)showDbToast(delivered==='shared'?'Record ready to save/share':'Record file saved');
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
    db=await commitRestoredDatabase(db,candidate,{
      writeRecovery:idbWriteRecovery,
      writeState:snapshot=>commitDatabaseCandidate(snapshot,{markRecordDirty:false})
    });
    pendingRestore=null;
    modal.classList.remove('show');
    const loadedAt=nowIso();
    db.settings={...(db.settings||{}),lastRecordLoadedAt:loadedAt};
    try{await persistNow({markRecordDirty:false});}catch(error){console.warn('Record load timestamp was not persisted',error);}
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
  module.exports={BACKUP_FORMAT,BACKUP_FORMAT_VERSION,BACKUP_BYTE_LIMIT,RECORD_FILE_NAME,RECORD_FILE_STATE_KEY,isBackupObject,parseBackupText,createBackupPayload,backupSummary,backupByteLength,serializeBackup,assertBackupSize,backupStorageMetrics,formatStorageBytes,validateBackup,backupAge,defaultRecordFileState,recordFileStatusLabel,commitRestoredDatabase};
}
