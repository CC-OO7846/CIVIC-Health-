'use strict';

const KEY='clean-garage-v10-vehicle-health';
const LEGACY_KEYS=['clean-garage-v8-parts-with-images','clean-garage-v7-single-hero-history','car-maintenance-life-v4-simple'];
const APP_VERSION='10.18.6';
const SCHEMA_VERSION=17;
const STORAGE_LIMITS=Object.freeze({
  uploadInputBytes:12*1024*1024,
  storedImageBytes:2*1024*1024,
  backupBytes:100*1024*1024,
  imageLongEdge:1600,
  imageMinLongEdge:480,
  imageMinQuality:0.50
});
const MAX_IMAGE_UPLOAD_BYTES=STORAGE_LIMITS.uploadInputBytes;
const MAX_STORED_IMAGE_BYTES=STORAGE_LIMITS.storedImageBytes;
const MAX_BACKUP_BYTES=STORAGE_LIMITS.backupBytes;
const SYSTEMS=['Engine','Transmission','Cooling','Electrical','Brake','Suspension','Tires','Fluids','Battery','Air Conditioning'];
const SYSTEM_WEIGHTS={Engine:0.16,Transmission:0.14,Cooling:0.10,Electrical:0.09,Brake:0.13,Suspension:0.13,Tires:0.09,Fluids:0.07,Battery:0.04,'Air Conditioning':0.05};
const MILEAGE_STRESS_SYSTEMS=new Set(['Engine','Transmission','Cooling','Suspension']);
const FLUID_CATALOG=[
  {name:'Engine Oil',system:'Engine'},
  {name:'ATF',system:'Transmission'},
  {name:'Coolant',system:'Cooling'},
  {name:'Brake Fluid',system:'Brake'}
];

const ALERT_COOLDOWN_MS=7*24*60*60*1000;
let editingId=null, editingSymptomId=null, replacementMode=false, detailRecordId=null;

function nowIso(){return new Date().toISOString()}
function todayIso(){return new Date().toISOString().slice(0,10)}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function fmt(n){return Number(n||0).toLocaleString('th-TH')}
function norm(s){return String(s||'').toLowerCase().replace(/\([^)]*\)/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
function clamp(n,a,b){return Math.max(a,Math.min(b,n))}
function uid(prefix='id'){return prefix+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,8)}
function daysBetween(a,b=new Date()){if(!a)return null;return (new Date(b)-new Date(a))/(1000*60*60*24)}
function monthsBetweenDate(a,b=new Date()){const d=daysBetween(a,b);return d===null?null:d/30.4375}
function dateFmt(s){if(!s)return '—';const date=new Date(s);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('th-TH',{year:'numeric',month:'short',day:'numeric'}).format(date):'—'}
function nonNegativeNumber(value,fallback=0){const number=Number(value);return Number.isFinite(number)&&number>=0?number:fallback}
function positiveNumber(value,fallback=0){const number=Number(value);return Number.isFinite(number)&&number>0?number:fallback}
function hideBrokenReceipt(image){if(!image)return;image.onerror=null;image.removeAttribute('src');const wrap=image.closest?.('.receipt-preview');if(wrap)wrap.hidden=true;if(typeof showDbToast==='function')showDbToast('Receipt image could not be displayed')}


function renderFluids(){fluidGrid.innerHTML=fluidRows().map(({catalog,record})=>{if(!record)return `<div class="fluid-card"><div class="fluid-top"><div><div class="fluid-name">${catalog.name}</div><div class="fluid-system">${catalog.system}</div></div></div><div class="life-big">—<small> Insufficient Data</small></div><button class="btn" style="margin-top:12px" onclick="prefillFluid('${catalog.name}','${catalog.system}')">Add service data</button></div>`;const m=lifeMetrics(record),st=db.fluidState[record.id]||{condition:'Normal',leak:false};return `<div class="fluid-card"><div class="fluid-top"><div><div class="fluid-name">${esc(record.part)}</div><div class="fluid-system">${esc(catalog.system)}</div></div><span class="verify">${statusText(m.remaining)}</span></div><div class="life-big" style="color:${lifeColor(m.remaining)}">${m.remaining===null?'—':m.remaining.toFixed(0)+'%'}<small> remaining</small></div><div class="dual-life"><div><small>Mileage life</small><b>${m.kmPct===null?'—':m.kmPct.toFixed(0)+'%'}</b></div><div><small>Time life</small><b>${m.timePct===null?'—':m.timePct.toFixed(0)+'%'}</b></div></div><div class="fluid-controls"><select onchange="setFluidCondition(${record.id},this.value)"><option ${st.condition==='Normal'?'selected':''}>Normal</option><option ${st.condition==='Monitor'?'selected':''}>Monitor</option><option ${st.condition==='Abnormal'?'selected':''}>Abnormal</option></select><label class="leak-toggle"><input type="checkbox" ${st.leak?'checked':''} onchange="setFluidLeak(${record.id},this.checked)"> Leak</label></div></div>`}).join('')}
function setFluidCondition(id,val){db.fluidState[id]={...(db.fluidState[id]||{}),condition:val};persist();renderAll()}
function setFluidLeak(id,val){db.fluidState[id]={...(db.fluidState[id]||{}),leak:val};persist();renderAll()}
function prefillFluid(name,system){openHistoryModal();fPart.value=name;fSystem.value=system;fEventType.value='fluid_change'}
function renderPartsLife(){
  const arr=partRows().filter(r=>lifeOf(r)!==null).sort((a,b)=>lifeOf(a)-lifeOf(b));
  partsLifeCount.textContent=`${arr.length} monitored`;
  partsLifeGrid.innerHTML=arr.length?arr.map(r=>{
    const m=lifeMetrics(r);
    const source=resolvePartImage(r)||FALLBACK_PART_IMAGE;
    return `<div class="life-card">
      <div class="life-card-top">
        <div class="life-card-identity">
          <div class="life-card-image"><img src="${source}" alt="${esc(r.part)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=FALLBACK_PART_IMAGE"></div>
          <div>
            <div class="life-card-name">${esc(r.part)}</div>
            <div class="life-card-system">${esc(r.system||'')}</div>
          </div>
        </div>
        <span class="verify">${statusText(m.remaining)}</span>
      </div>
      <div class="life-big" style="color:${lifeColor(m.remaining)}">${m.remaining.toFixed(0)}<small>%</small></div>
      <div class="bar"><div class="fill" style="width:${m.remaining}%;background:${lifeColor(m.remaining)}"></div></div>
      <div class="row-sub" style="margin-top:9px">${m.remainingKm===null?'No mileage forecast':m.remainingKm<=0?'Overdue by mileage':fmt(Math.max(0,m.remainingKm))+' km remaining'}</div>
    </div>`;
  }).join(''):'<div class="empty">No part with complete lifecycle data.</div>';
}
function populateSystemSelect(){sSystem.innerHTML=SYSTEMS.filter(x=>x!=='Fluids').map(x=>`<option>${x}</option>`).join('')}
function openSymptomModal(prefill={}){editingSymptomId=null;populateSystemSelect();symptomModalTitle.textContent='Add Symptom';sDate.value=prefill.date||todayIso();sKm.value=prefill.km??db.car.km;sSystem.value=prefill.system||'Engine';sName.value=prefill.name||'';sSeverity.value=prefill.severity||3;sStatus.value=prefill.status||'Active';sEngineState.value='';sRpm.value='';sCoolantTemp.value='';sAtfTemp.value='';sAc.value='';sGear.value='';sSpeed.value='';sAmbient.value='';sNote.value=prefill.note||'';symptomModal.classList.add('show')}
function closeSymptomModal(){symptomModal.classList.remove('show')}
function symptomFromForm(id){return {id:id||uid('sym'),vehicleId:db.car.id,date:sDate.value,km:Number(sKm.value||db.car.km),system:sSystem.value,name:sName.value.trim(),severity:Number(sSeverity.value),status:sStatus.value,conditions:{engineState:sEngineState.value,rpm:numOrNull(sRpm.value),coolantTemp:numOrNull(sCoolantTemp.value),atfTemp:numOrNull(sAtfTemp.value),ac:sAc.value,gear:sGear.value,speed:numOrNull(sSpeed.value),ambient:numOrNull(sAmbient.value)},note:sNote.value.trim(),updatedAt:nowIso()}}
function numOrNull(v){return v===''?null:Number(v)}
function saveSymptom(){if(!sName.value.trim()){alert('กรุณาใส่อาการ');return}const obj=symptomFromForm(editingSymptomId);if(editingSymptomId)db.symptoms=db.symptoms.map(x=>x.id===editingSymptomId?{...x,...obj}:x);else{obj.createdAt=nowIso();db.symptoms.unshift(obj)}persist();closeSymptomModal();renderAll()}
function editSymptom(id){const s=db.symptoms.find(x=>x.id===id);if(!s)return;openSymptomModal(s);editingSymptomId=id;sDate.value=s.date;sKm.value=s.km;sSystem.value=s.system;sName.value=s.name;sSeverity.value=s.severity;sStatus.value=s.status;sEngineState.value=s.conditions?.engineState||'';sRpm.value=s.conditions?.rpm??'';sCoolantTemp.value=s.conditions?.coolantTemp??'';sAtfTemp.value=s.conditions?.atfTemp??'';sAc.value=s.conditions?.ac||'';sGear.value=s.conditions?.gear||'';sSpeed.value=s.conditions?.speed??'';sAmbient.value=s.conditions?.ambient??'';sNote.value=s.note||'';symptomModalTitle.textContent='Edit Symptom'}
function resolveSymptom(id){const s=db.symptoms.find(x=>x.id===id);if(s){s.status='Resolved';s.updatedAt=nowIso();persist();renderAll()}}

function renderHistory(){
  const query=search.value.trim().toLowerCase(),system=systemFilter.value;
  const records=allSavedHistory().filter(record=>(!query||(record.part+' '+record.system+' '+(record.note||'')).toLowerCase().includes(query))&&(!system||record.system===system));
  if(!records.length){historyGrid.innerHTML='<div class="empty">No repaired part found.</div>';return;}
  historyGrid.innerHTML=records.map(record=>{
    const metrics=lifeMetrics(record),life=metrics.remaining,status=statusText(life),id=JSON.stringify(record.id);
    const source=resolvePartImage(record);
    const image=source?`<img src="${source}" alt="${esc(record.part)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=FALLBACK_PART_IMAGE">`:'<div class="photo-placeholder"><strong>+</strong><small>Add photo</small></div>';
    const reference=record.pmTracked?Number(record.referencePrice??record.price??0):0;
    const actual=recordActualCost(record);
    const displayCost=actual>0?actual:reference;
    const costLabel=actual>0?'Paid':record.pmTracked?'Ref. price':'Cost';
    const price=displayCost>0?'฿'+fmt(displayCost):record.pmKey==='fuel_filter'?'Included':'—';
    const warranty=warrantyInfo(record);
    const secondary=actual>0&&reference>0?`<span class="price-scope">Ref ฿${fmt(reference)}</span>`:warranty.active?`<span class="price-scope warranty-active">${esc(warranty.label)}</span>`:record.priceScope?`<span class="price-scope">${esc(record.priceScope)}</span>`:'';
    const note=metrics.errors.length?`<div class="note note-error">${esc(metrics.errors.join('; '))}</div>`:(record.note?`<div class="note">${esc(record.note)}</div>`:'');
    return `<article class="history-card">
      <div class="part-photo">${image}<label class="upload-overlay" aria-label="Change ${esc(record.part)} photo">Photo<input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden onchange="quickPhoto(${id},event)"></label></div>
      <div class="card-body">
        <div class="card-top"><div><div class="part-name">${esc(record.part)}</div><div class="system">${esc(record.system||'Uncategorized')}</div></div><span class="part-status" style="color:${lifeColor(life)}">${esc(status)}</span></div>
        <div class="life compact-life"><div class="life-row"><small>Remaining life</small><strong style="color:${lifeColor(life)}">${life===null?'—':life.toFixed(0)+'%'}</strong></div><div class="bar"><div class="fill" style="width:${life===null?0:life}%;background:${lifeColor(life)}"></div></div></div>
        <div class="record-data compact-record-data"><div><small>Last date</small><strong>${dateFmt(record.date)}</strong></div><div><small>Last km</small><strong>${record.km?fmt(record.km)+' km':'—'}</strong></div><div><small>${costLabel}</small><strong>${price}</strong>${secondary}</div></div>
        ${note}
        <div class="card-actions"><button class="done" onclick="markReplaced(${id})">Replace</button><button onclick="openPartDetails(${id})">Details</button><button onclick="editHistory(${id})">Edit</button></div>
      </div>
    </article>`;
  }).join('');
}

function renderLegacyKpi(o){const engine=o.systems.find(x=>x.system==='Engine'),trans=o.systems.find(x=>x.system==='Transmission'),next=forecast()[0];const set=(id,gid,obj)=>{const el=document.getElementById(id),ge=document.getElementById(gid);if(!el||!ge)return;el.textContent=obj?.score??'—';const gr=grade(obj?.score??null);ge.textContent=gr.label;ge.style.color=gr.color};set('engineHealthStat','engineHealthGrade',engine);set('transHealthStat','transHealthGrade',trans);const veh={score:o.score};set('vehicleHealthStat','vehicleHealthGrade',veh);nextServiceStat.textContent=next?.title||'—';nextServiceDetail.textContent=next?.label||'No due record'}

// === V10.15.1 Mobile UX ===
function mobileSystemView(overall,name,scoreId,gradeId){
  const s=overall.systems.find(x=>x.system===name);
  const score=document.getElementById(scoreId);
  const gr=document.getElementById(gradeId);
  if(!score||!gr)return;
  const g=grade(s?.score??null);
  score.textContent=s?.score==null?'—':s.score+'%';
  gr.textContent=g.label;
  gr.style.color=g.color;
}
function renderMobileDashboard(){
  const scoreElement=document.getElementById('mobileHealthScore');
  if(!scoreElement)return;
  const overall=overallHealth(),healthGrade=grade(overall.score);
  scoreElement.textContent=overall.score==null?'—':overall.score;
  const gradeElement=document.getElementById('mobileHealthGrade');
  gradeElement.textContent=healthGrade.label;gradeElement.style.color=healthGrade.color;
  document.getElementById('mobileHealthRing')?.style.setProperty('--score',String(overall.score==null?0:overall.score));
  const message=document.getElementById('mobileHealthMessage');
  if(overall.score==null)message.textContent='ยังมีข้อมูลไม่พอสำหรับประเมินภาพรวม เพิ่มประวัติ PM เพื่อให้คะแนนแม่นขึ้น';
  else if(overall.score>=90)message.textContent='สภาพรวมดีมาก รักษารอบ PM และติดตามรายการที่ใกล้ครบอายุ';
  else if(overall.score>=80)message.textContent='สภาพรวมดี มีบางรายการที่ควรวางแผนตาม Remaining Life';
  else if(overall.score>=70)message.textContent='มีรายการที่ควรติดตาม วางแผนตรวจและเตรียมงบล่วงหน้า';
  else message.textContent='มีรายการที่ควรให้ความสำคัญ เปิด Vehicle Health เพื่อดูสาเหตุหลัก';
  mobileSystemView(overall,'Engine','mobileEngineScore','mobileEngineGrade');
  mobileSystemView(overall,'Transmission','mobileTransScore','mobileTransGrade');
  mobileSystemView(overall,'Brake','mobileBrakeScore','mobileBrakeGrade');
  const mileage=document.getElementById('mobileKm');if(mileage)mileage.textContent=fmt(db.car.km);
  const vehicle=document.getElementById('mobileVehicleName');if(vehicle)vehicle.textContent=`${db.car.name||'Vehicle'} · ${db.car.engine||''}`.replace(/ · $/,'');
  const next=forecast()[0];
  const nextTitle=document.getElementById('mobileNextService'),nextDetail=document.getElementById('mobileNextServiceDetail');
  if(nextTitle)nextTitle.textContent=next?.title||'No due item';if(nextDetail)nextDetail.textContent=next?.label||'No scheduled item';
  const all=budgetAll(),within5k=all.filter(item=>item.overdue||(item.effectiveKm!==null&&item.effectiveKm<=5000));
  const budget=document.getElementById('mobileBudget5k'),count=document.getElementById('mobileBudgetCount');
  if(budget)budget.textContent='฿'+fmt(budgetSum(within5k));if(count)count.textContent=`${within5k.length} item${within5k.length===1?'':'s'}`;
  const alert=activeAlerts().find(item=>item.severity==='CRITICAL')||activeAlerts().find(item=>item.severity==='WARNING');
  const attentionTitle=document.getElementById('mobileAttentionTitle'),attentionDetail=document.getElementById('mobileAttentionDetail'),attention=document.getElementById('mobileAttention');
  if(alert){attentionTitle.textContent=alert.title;attentionDetail.textContent=alert.message;attention?.classList.add('has-alert');}
  else if(next){attentionTitle.textContent=next.title;attentionDetail.textContent=next.label||'Upcoming maintenance';attention?.classList.remove('has-alert');}
  else{attentionTitle.textContent='No critical item';attentionDetail.textContent='Maintenance status is up to date';attention?.classList.remove('has-alert');}
}
function mobileNavigate(tab,button){
  const target={
    home:'mobileHome',
    health:'vehicleHealth',
    budget:'nextBudget',
    more:'localDatabase'
  }[tab];
  if(target)document.getElementById(target)?.scrollIntoView({behavior:'smooth',block:'start'});
  document.querySelectorAll('.mobile-tabbar button[data-mobile-nav]').forEach(b=>b.classList.remove('active'));
  if(button?.dataset?.mobileNav)button.classList.add('active');
}

function renderAll(){refreshAlerts();const o=renderHealth();renderLegacyKpi(o);renderAlerts();renderForecast();renderFluids();renderPartsLife();renderNextBudget();renderHistory();renderMobileDashboard();heroKm.textContent=fmt(db.car.km)}
function render(){renderAll()}

function resetHistoryExtraFields(){
  for(const id of ['fWorkshop','fPartBrand','fPartNumber','fWarrantyMonths']){const el=document.getElementById(id);if(el)el.value='';}
  if(fReceipt)fReceipt.value='';
}
function openHistoryModal(){
  editingId=null;replacementMode=false;historyModalTitle.textContent='Add service record';
  ['fPart','fSystem','fDate','fKm','fPrice','fReferencePrice','fIntervalKm','fIntervalMonths','fNote'].forEach(id=>document.getElementById(id).value='');
  resetHistoryExtraFields();fDate.value=todayIso();fKm.value=db.car.km;fImage.value='';fEventType.value='part_replacement';historyModal.classList.add('show');
}
function closeHistoryModal(){replacementMode=false;historyModal.classList.remove('show')}
function fillHistoryForm(r,{replacement=false}={}){
  const refInput=document.getElementById('fReferencePrice');
  fPart.value=r.part||'';fSystem.value=r.system||'';fDate.value=replacement?todayIso():(r.date||'');fKm.value=replacement?db.car.km:(r.km||'');
  fPrice.value=replacement?'':(recordActualCost(r)||'');
  if(refInput)refInput.value=(Object.prototype.hasOwnProperty.call(r,'customReferencePrice')?Number(r.customReferencePrice||0):Number(r.referencePrice||0))||'';
  fIntervalKm.value=r.intervalKm||'';fIntervalMonths.value=r.intervalMonths||'';fNote.value=r.note||'';
  fEventType.value=r.eventType||'part_replacement';fImage.value='';fWorkshop.value=r.workshop||'';fPartBrand.value=r.partBrand||'';fPartNumber.value=r.partNumber||'';fWarrantyMonths.value=r.warrantyMonths||'';fReceipt.value='';
}
function editHistory(id){const r=db.history.find(x=>x.id===id);if(!r)return;editingId=id;replacementMode=false;historyModalTitle.textContent='Edit service record';fillHistoryForm(r);historyModal.classList.add('show')}
const SUPPORTED_IMAGE_TYPES=new Set(['image/jpeg','image/jpg','image/png','image/webp']);
function validateImageFile(file,label='Image'){
  if(!file)throw new Error(label+' is missing');
  const type=String(file.type||'').toLowerCase();
  const name=String(file.name||'');
  if(/^image\/hei[cf](?:-sequence)?$/.test(type)||/\.(?:heic|heif)$/i.test(name))throw new Error('HEIC/HEIF is not supported. Please use JPEG, PNG, or WebP.');
  const supportedName=/\.(?:jpe?g|png|webp)$/i.test(name);
  if((type&&!SUPPORTED_IMAGE_TYPES.has(type))||(!type&&!supportedName))throw new Error(label+' must be JPEG, PNG, or WebP');
  if(Number(file.size||0)>MAX_IMAGE_UPLOAD_BYTES)throw new Error(label+' must be 12 MB or smaller');
}

function storedDataUrlBytes(dataUrl){
  const value=String(dataUrl||'');
  if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(value).byteLength;
  if(typeof Buffer!=='undefined')return Buffer.byteLength(value,'utf8');
  return value.length;
}

function fitImageDimensions(width,height,maxLongEdge=STORAGE_LIMITS.imageLongEdge){
  const sourceWidth=Math.max(1,Math.round(Number(width)||0));
  const sourceHeight=Math.max(1,Math.round(Number(height)||0));
  const longEdge=Math.max(sourceWidth,sourceHeight);
  const scale=Math.min(1,Math.max(1,Number(maxLongEdge)||STORAGE_LIMITS.imageLongEdge)/longEdge);
  return {width:Math.max(1,Math.round(sourceWidth*scale)),height:Math.max(1,Math.round(sourceHeight*scale))};
}

function buildImageOptimizationPlan(width,height,quality=0.82){
  const fitted=fitImageDimensions(width,height);
  const startQuality=clamp(Number(quality)||0.82,STORAGE_LIMITS.imageMinQuality,0.92);
  const qualities=[];
  for(let value=startQuality;value>=STORAGE_LIMITS.imageMinQuality;value-=0.08)qualities.push(Number(value.toFixed(2)));
  if(qualities[qualities.length-1]!==STORAGE_LIMITS.imageMinQuality)qualities.push(STORAGE_LIMITS.imageMinQuality);
  const plan=[],seen=new Set();
  for(const scale of [1,0.82,0.67,0.55,0.44,0.30]){
    let candidateWidth=Math.max(1,Math.round(fitted.width*scale));
    let candidateHeight=Math.max(1,Math.round(fitted.height*scale));
    const fittedLong=Math.max(fitted.width,fitted.height);
    const candidateLong=Math.max(candidateWidth,candidateHeight);
    if(fittedLong>=STORAGE_LIMITS.imageMinLongEdge&&candidateLong<STORAGE_LIMITS.imageMinLongEdge){
      const minimum=fitImageDimensions(fitted.width,fitted.height,STORAGE_LIMITS.imageMinLongEdge);
      candidateWidth=minimum.width;candidateHeight=minimum.height;
    }
    const dimensionKey=candidateWidth+'x'+candidateHeight;
    if(seen.has(dimensionKey))continue;
    seen.add(dimensionKey);
    for(const candidateQuality of qualities)plan.push({width:candidateWidth,height:candidateHeight,quality:candidateQuality});
  }
  return plan;
}

async function readBlobAsDataUrl(blob,label='Image'){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result||''));
    reader.onerror=()=>reject(reader.error||new Error(label+' could not be read'));
    reader.readAsDataURL(blob);
  });
}

async function decodeUploadedImage(file){
  if(typeof createImageBitmap==='function'){
    try{
      const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
      return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close?.()};
    }catch(error){
      try{
        const bitmap=await createImageBitmap(file);
        return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close?.()};
      }catch(fallbackError){console.warn('ImageBitmap decode fallback failed',fallbackError);}
    }
  }
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const image=new Image();
    image.onload=()=>resolve({source:image,width:image.naturalWidth,height:image.naturalHeight,close:()=>URL.revokeObjectURL(url)});
    image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Image could not be decoded'));};
    image.src=url;
  });
}

function canvasBlob(canvas,mimeType,quality){
  return new Promise((resolve,reject)=>canvas.toBlob(
    blob=>blob?resolve(blob):reject(new Error('Image could not be encoded')),
    mimeType,
    quality
  ));
}

let webpSupportPromise=null;
function canvasSupportsWebp(){
  if(webpSupportPromise)return webpSupportPromise;
  webpSupportPromise=new Promise(resolve=>{
    try{
      const canvas=document.createElement('canvas');
      canvas.width=1;canvas.height=1;
      canvas.toBlob(blob=>resolve(blob?.type==='image/webp'),'image/webp',0.8);
    }catch(error){resolve(false);}
  });
  return webpSupportPromise;
}

async function decodedImageHasTransparency(decoded){
  const dimensions=fitImageDimensions(decoded.width,decoded.height,512);
  const canvas=document.createElement('canvas');
  canvas.width=dimensions.width;canvas.height=dimensions.height;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return false;
  context.drawImage(decoded.source,0,0,canvas.width,canvas.height);
  const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
  for(let index=3;index<pixels.length;index+=4)if(pixels[index]<255)return true;
  return false;
}

async function encodeImageCandidate(decoded,candidate,mimeType){
  const canvas=document.createElement('canvas');
  canvas.width=candidate.width;canvas.height=candidate.height;
  const context=canvas.getContext('2d');
  if(!context)throw new Error('Image processing is unavailable');
  if(mimeType==='image/jpeg'){context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);}
  context.drawImage(decoded.source,0,0,canvas.width,canvas.height);
  const blob=await canvasBlob(canvas,mimeType,candidate.quality);
  return {dataUrl:await readBlobAsDataUrl(blob),mimeType:blob.type||mimeType};
}

async function optimizeUploadedImage(file,options={}){
  const label=options.label||'Image';
  const hooks=options.testingHooks||{};
  try{validateImageFile(file,label);}
  catch(error){return {ok:false,reason:'validation',message:error.message};}
  let decoded=null;
  try{
    decoded=await (hooks.decode?hooks.decode(file):decodeUploadedImage(file));
    if(!decoded||!Number(decoded.width)||!Number(decoded.height))throw new Error('Image dimensions are invalid');
    const webpSupported=Object.prototype.hasOwnProperty.call(hooks,'webpSupported')?!!hooks.webpSupported:await canvasSupportsWebp();
    const sourceCouldHaveAlpha=/^image\/(?:png|webp)$/i.test(String(file.type||''))||/\.(?:png|webp)$/i.test(String(file.name||''));
    const transparent=Object.prototype.hasOwnProperty.call(hooks,'transparent')?!!hooks.transparent:(!webpSupported&&sourceCouldHaveAlpha?await decodedImageHasTransparency(decoded):false);
    const mimeType=webpSupported?'image/webp':transparent?'image/png':'image/jpeg';
    const encode=hooks.encode||encodeImageCandidate;
    const plan=buildImageOptimizationPlan(decoded.width,decoded.height,options.quality);
    const attemptedDimensions=new Set();
    for(const candidate of plan){
      if(mimeType==='image/png'){
        const key=candidate.width+'x'+candidate.height;
        if(attemptedDimensions.has(key))continue;
        attemptedDimensions.add(key);
      }
      const encoded=await encode(decoded,candidate,mimeType);
      if(typeof encoded?.dataUrl!=='string'||!encoded.dataUrl.startsWith('data:image/'))throw new Error('Image encoder returned invalid data');
      const bytes=Number(encoded.storedBytes??storedDataUrlBytes(encoded.dataUrl));
      if(bytes<=MAX_STORED_IMAGE_BYTES){
        return {
          ok:true,
          dataUrl:encoded.dataUrl,
          mimeType:encoded.mimeType||mimeType,
          width:candidate.width,
          height:candidate.height,
          originalBytes:Number(file.size||0),
          storedBytes:bytes
        };
      }
    }
    return {ok:false,reason:'too_large',message:'Optimized image is still larger than 2 MB. Choose a smaller or simpler image.'};
  }catch(error){
    console.error('Image optimization failed',error);
    return {ok:false,reason:'processing',message:label+' could not be processed. Please choose another JPEG, PNG, or WebP image.'};
  }finally{
    try{decoded?.close?.();}catch(error){console.warn('Image cleanup failed',error);}
  }
}

async function saveHistory(){
  const part=fPart.value.trim();if(!part){alert('กรุณาใส่ชื่ออะไหล่');return}
  const old=editingId?db.history.find(x=>x.id===editingId):null;
  let image=old?.image||'',customImage=!!old?.customImage,receiptImage=old?.receiptImage||'';
  const saveButton=historyModal.querySelector('.modal-actions .primary');
  if(saveButton){saveButton.disabled=true;saveButton.textContent='Saving…';}
  try{
    if(fImage.files[0]){
      const result=await optimizeUploadedImage(fImage.files[0],{label:'Part image',quality:0.82});
      if(!result.ok)throw new Error(result.message);
      image=result.dataUrl;customImage=true;
    }
    if(fReceipt.files[0]){
      const result=await optimizeUploadedImage(fReceipt.files[0],{label:'Receipt image',quality:0.78});
      if(!result.ok)throw new Error(result.message);
      receiptImage=result.dataUrl;
    }
    const actualCost=nonNegativeNumber(fPrice.value,0);
    const customReferencePrice=nonNegativeNumber(document.getElementById('fReferencePrice')?.value,0);
    const rec={...(old||{}),id:editingId||Date.now(),part,system:fSystem.value.trim(),date:fDate.value,km:nonNegativeNumber(fKm.value,0),actualCost,intervalKm:nonNegativeNumber(fIntervalKm.value,0),intervalMonths:nonNegativeNumber(fIntervalMonths.value,0),note:fNote.value.trim(),image,customImage,imageKey:old?.imageKey||imageKeyForPartName(part)||'',needsVerify:false,eventType:fEventType.value,workshop:fWorkshop.value.trim(),partBrand:fPartBrand.value.trim(),partNumber:fPartNumber.value.trim(),warrantyMonths:nonNegativeNumber(fWarrantyMonths.value,0),receiptImage};
    rec.customReferencePrice=Number.isFinite(customReferencePrice)&&customReferencePrice>=0?customReferencePrice:0;
    rec.referencePrice=rec.customReferencePrice;
    rec.price=rec.pmTracked?(actualCost>0?actualCost:rec.referencePrice):actualCost;
    if(rec.pmTracked&&old){if(rec.intervalKm>0&&rec.km>0)rec.pmPlanKm=rec.km+rec.intervalKm;if(rec.intervalMonths>0&&rec.date)rec.pmPlanDate=addMonthsIso(rec.date,rec.intervalMonths);rec.pmDerivedPlanDate='';rec.pmPlanDateRaw=null}
    const createEvent=!editingId||replacementMode;
    const candidate=cloneValue(db);
    if(editingId)candidate.history=candidate.history.map(x=>x.id===editingId?rec:x);else candidate.history.unshift(rec);
    if(createEvent)candidate.serviceEvents.unshift({id:uid('evt'),vehicleId:candidate.car.id,type:rec.eventType,date:rec.date,km:rec.km,system:rec.system,title:rec.part,cost:serviceEventCost(rec),actualCost:serviceEventCost(rec),sourceId:rec.id,userEntered:true,workshop:rec.workshop||'',partBrand:rec.partBrand||'',partNumber:rec.partNumber||'',createdAt:nowIso()});
    await commitDatabaseCandidate(candidate);
    replacementMode=false;closeHistoryModal();renderAll();
    showDbToast('Service record saved');
  }catch(error){
    const message=typeof isDatabaseWriteError==='function'&&isDatabaseWriteError(error)?databaseWriteMessage(error):error.message;
    alert(message||'Service record could not be saved');
  }finally{
    if(saveButton){saveButton.disabled=false;saveButton.textContent='Save Record';}
  }
}
async function quickPhoto(id,e){
  const file=e.target.files?.[0];if(!file)return;
  const current=db.history.find(x=>x.id===id);if(!current)return;
  try{
    const result=await optimizeUploadedImage(file,{label:'Part image',quality:0.82});
    if(!result.ok)throw new Error(result.message);
    const candidate=cloneValue(db);
    candidate.history=candidate.history.map(record=>record.id===id?{...record,image:result.dataUrl,customImage:true}:record);
    await commitDatabaseCandidate(candidate);
    renderAll();
    showDbToast('Part image saved');
  }catch(error){
    const message=typeof isDatabaseWriteError==='function'&&isDatabaseWriteError(error)?databaseWriteMessage(error):error.message;
    alert(message||'Part image could not be saved');
  }finally{e.target.value='';}
}
function markReplaced(id){const r=db.history.find(x=>x.id===id);if(!r)return;editingId=id;replacementMode=true;historyModalTitle.textContent=`Record ${r.part} replacement`;fillHistoryForm(r,{replacement:true});historyModal.classList.add('show')}
function removeHistory(id){if(!confirm('ลบประวัติรายการนี้?'))return;db.history=db.history.filter(x=>x.id!==id);if(detailRecordId===id)closePartDetails();persist();renderAll()}
function openPartDetails(id){
  const r=db.history.find(x=>x.id===id);if(!r)return;detailRecordId=id;
  partDetailTitle.textContent=r.part||'Part Detail';partDetailSystem.textContent=r.system||'Service record';
  const src=resolvePartImage(r);partDetailImage.innerHTML=src?`<img src="${src}" alt="${esc(r.part)}" onerror="this.onerror=null;this.src=FALLBACK_PART_IMAGE">`:'<div class="photo-placeholder"><strong>+</strong><small>No image</small></div>';
  partDetailDate.textContent=dateFmt(r.date);partDetailKm.textContent=r.km?fmt(r.km)+' km':'—';
  const actual=recordActualCost(r),reference=Number(r.referencePrice||0);partDetailActual.textContent=actual>0?'฿'+fmt(actual):'—';partDetailReference.textContent=reference>0?'฿'+fmt(reference):'—';
  partDetailWorkshop.textContent=r.workshop||'—';partDetailBrand.textContent=r.partBrand||'—';partDetailNumber.textContent=r.partNumber||'—';
  const warranty=warrantyInfo(r);partDetailWarranty.textContent=warranty.expiry?`${warranty.label} · ${dateFmt(warranty.expiry)}`:'—';
  partDetailNote.textContent=r.note||'No note';
  partDetailReceiptWrap.hidden=!r.receiptImage;if(r.receiptImage)partDetailReceipt.src=r.receiptImage;else partDetailReceipt.removeAttribute('src');
  partDetailDelete.onclick=()=>removeHistory(id);partDetailEdit.onclick=()=>{closePartDetails();editHistory(id)};partDetailReplace.onclick=()=>{closePartDetails();markReplaced(id)};
  partDetailModal.classList.add('show');
}
function closePartDetails(){detailRecordId=null;partDetailModal.classList.remove('show')}

function openCarModal(){carKm.value=db.car.km;monthlyKm.value=db.car.monthlyKm||1200;carModal.classList.add('show')}
function validateVehicleMileage(km){if(!Number.isFinite(km)||km<0)return {ok:false,message:'Mileage ไม่ถูกต้อง'};const maxKnown=Math.max(0,...db.history.map(r=>Number(r.km||0)),...db.symptoms.map(s=>Number(s.km||0)),...db.inspections.map(i=>Number(i.km||0)));if(km<maxKnown)return {ok:false,message:`Current mileage (${fmt(km)}) cannot be lower than recorded mileage (${fmt(maxKnown)}).`};return {ok:true}}
function saveCar(){const km=Number(carKm.value||0),monthly=positiveNumber(monthlyKm.value,0),v=validateVehicleMileage(km);if(!v.ok){alert(v.message);return}if(!monthly){alert('Average km / month must be greater than 0.');return}db.car.km=km;db.car.monthlyKm=monthly;persist();carModal.classList.remove('show');renderAll()}

document.addEventListener('DOMContentLoaded',()=>{
  window.addEventListener('scroll',()=>topbar.classList.toggle('scrolled',scrollY>20));
  registerOfflineApp();
  bootDatabase();
  window.addEventListener('online',updateStorageStatus);
  window.addEventListener('offline',updateStorageStatus);
});
