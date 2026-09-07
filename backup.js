'use strict';

const BACKUP_FORMAT='clean-garage-backup';
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
  const appVersion=typeof APP_VERSION==='string'?APP_VERSION:'10.18.6';
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

function safeBackupName(){return `clean-garage-backup-${todayIso()}.json`;}

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

function backupAge(lastBackupAt,now=new Date()){
  if(!lastBackupAt)return {days:null,label:'Never',stale:true};
  const date=new Date(lastBackupAt);
  if(!Number.isFinite(date.getTime()))return {days:null,label:'Unknown',stale:true};
  const days=Math.max(0,Math.floor((now-date)/86400000));
  return {days,label:days===0?'Today':days===1?'1 day':`${days} days`,stale:days>30};
}

function updateBackupStatus(){
  const stamp=db?.settings?.lastBackupAt||'';
  const age=backupAge(stamp);
  const last=document.getElementById('lastBackupStatus');
  const ageElement=document.getElementById('backupAgeStatus');
  const warning=document.getElementById('backupWarning');
  if(last)last.textContent=stamp?dateFmt(stamp):'Never';
  if(ageElement){ageElement.textContent=age.label;ageElement.classList.toggle('storage-warning',age.stale);}
  if(warning){
    warning.hidden=!age.stale;
    warning.textContent=stamp?'Backup is more than 30 days old. Create a fresh JSON snapshot.':'No JSON backup has been created on this device yet.';
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
  candidate.settings={...(candidate.settings||{}),lastBackupAt:exportedAt};
  const serialized=serializeBackup(candidate,exportedAt);
  const blob=new Blob([serialized.json],{type:'application/json'});
  try{assertBackupSize(blob.size,'export');}
  catch(error){
    console.error('Backup export refused',error);
    alert(error.message);
    showDbToast('Backup not created');
    return false;
  }
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=safeBackupName();
  document.body.appendChild(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  db.settings={...(db.settings||{}),lastBackupAt:exportedAt};
  let timestampSaved=true;
  try{await persistNow();}catch(error){timestampSaved=false;console.warn('Backup timestamp was not persisted',error);}
  updateBackupStatus();
  if(timestampSaved)showDbToast('Backup snapshot created');
  return true;
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
  document.getElementById('restorePreviewModal').classList.add('show');
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
    db=await commitRestoredDatabase(db,candidate,{
      writeRecovery:idbWriteRecovery,
      writeState:snapshot=>commitDatabaseCandidate(snapshot)
    });
    pendingRestore=null;
    modal.classList.remove('show');
    renderAll();
    await updateStorageStatus();
    showDbToast('Database restored');
  }catch(error){
    console.error('Restore failed',error);
    alert('Restore failed. The current database was not replaced.');
  }finally{
    button.disabled=false;
    button.textContent='Restore and replace';
  }
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={BACKUP_FORMAT,BACKUP_FORMAT_VERSION,BACKUP_BYTE_LIMIT,isBackupObject,parseBackupText,createBackupPayload,backupSummary,backupByteLength,serializeBackup,assertBackupSize,backupStorageMetrics,formatStorageBytes,validateBackup,backupAge,commitRestoredDatabase};
}
