'use strict';

const BACKUP_FORMAT='clean-garage-backup';
const BACKUP_FORMAT_VERSION=2;
let pendingRestore=null;

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

function validateBackup(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Backup root must be an object');
  let database=raw;
  let metadata={format:'legacy-raw',version:0,exportedAt:'',schemaVersion:Number(raw.schemaVersion||0)};
  if(Object.hasOwn(raw,'format')){
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
    if(Object.hasOwn(database,key)&&!Array.isArray(database[key]))throw new Error(`${key} must be an array`);
  }
  for(const record of database.history){
    if(!record||typeof record!=='object'||Array.isArray(record))throw new Error('Repair history contains an invalid record');
    if(record.customImage&&record.image!==undefined&&typeof record.image!=='string')throw new Error('Custom image payload is invalid');
    if(record.receiptImage!==undefined&&typeof record.receiptImage!=='string')throw new Error('Receipt image payload is invalid');
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
}

async function exportDatabaseBackup(){
  db.settings={...(db.settings||{}),lastBackupAt:nowIso()};
  try{await persistNow();}catch(error){console.warn('Backup timestamp was not persisted',error);}
  const payload={
    format:BACKUP_FORMAT,version:BACKUP_FORMAT_VERSION,exportedAt:db.settings.lastBackupAt,
    app:'Clean Garage',appVersion:'10.17.0',schemaVersion:SCHEMA_VERSION,summary:backupSummary(db),db:cloneValue(db)
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;anchor.download=safeBackupName();
  document.body.appendChild(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  updateBackupStatus();
  showDbToast('Backup snapshot created');
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
    if(file.size>100*1024*1024)throw new Error('Backup file is too large');
    const parsed=JSON.parse(await file.text());
    const result=validateBackup(parsed);
    setRestorePreview(result,file.name);
  }catch(error){
    console.error('Restore validation failed',error);
    alert(`Restore failed: ${error.message}`);
  }
}

async function confirmRestoreDatabase(){
  if(!pendingRestore)return;
  const candidate=cloneValue(pendingRestore.migrated);
  const modal=document.getElementById('restorePreviewModal');
  const button=document.getElementById('confirmRestoreBtn');
  button.disabled=true;
  button.textContent='Restoring…';
  try{
    await idbWriteRecovery(db,'pre-restore');
    await idbWriteState(candidate);
    db=candidate;
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
  module.exports={BACKUP_FORMAT,BACKUP_FORMAT_VERSION,backupSummary,validateBackup,backupAge};
}
