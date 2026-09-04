'use strict';

const KEY='clean-garage-v10-vehicle-health';
const LEGACY_KEYS=['clean-garage-v8-parts-with-images','clean-garage-v7-single-hero-history','car-maintenance-life-v4-simple'];
const SCHEMA_VERSION=13;
const SYSTEMS=['Engine','Transmission','Cooling','Electrical','Brake','Suspension','Steering','Tires','Fluids','Battery','Air Conditioning'];
const SYSTEM_WEIGHTS={Engine:0.16,Transmission:0.14,Cooling:0.10,Electrical:0.08,Brake:0.12,Suspension:0.10,Steering:0.07,Tires:0.08,Fluids:0.07,Battery:0.04,'Air Conditioning':0.04};
const MILEAGE_STRESS_SYSTEMS=new Set(['Engine','Transmission','Cooling','Suspension','Steering']);
const FLUID_CATALOG=[
  {name:'Engine Oil',system:'Engine'}, {name:'ATF',system:'Transmission'}, {name:'Coolant',system:'Cooling'},
  {name:'Brake Fluid',system:'Brake'}, {name:'Power Steering Fluid',system:'Steering'},
  {name:'Differential Oil',system:'Transmission'}, {name:'Washer Fluid',system:'Air Conditioning'}
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
function dateFmt(s){if(!s)return '—';return new Intl.DateTimeFormat('th-TH',{year:'numeric',month:'short',day:'numeric'}).format(new Date(s))}


function renderFluids(){fluidGrid.innerHTML=fluidRows().map(({catalog,record})=>{if(!record)return `<div class="fluid-card"><div class="fluid-top"><div><div class="fluid-name">${catalog.name}</div><div class="fluid-system">${catalog.system}</div></div></div><div class="life-big">—<small> Insufficient Data</small></div><button class="btn" style="margin-top:12px" onclick="prefillFluid('${catalog.name}','${catalog.system}')">Add service data</button></div>`;const m=lifeMetrics(record),st=db.fluidState[record.id]||{condition:'Normal',leak:false};return `<div class="fluid-card"><div class="fluid-top"><div><div class="fluid-name">${esc(record.part)}</div><div class="fluid-system">${esc(catalog.system)}</div></div><span class="verify">${statusText(m.remaining)}</span></div><div class="life-big" style="color:${lifeColor(m.remaining)}">${m.remaining===null?'—':m.remaining.toFixed(0)+'%'}<small> remaining</small></div><div class="dual-life"><div><small>Mileage life</small><b>${m.kmPct===null?'—':m.kmPct.toFixed(0)+'%'}</b></div><div><small>Time life</small><b>${m.timePct===null?'—':m.timePct.toFixed(0)+'%'}</b></div></div><div class="fluid-controls"><select onchange="setFluidCondition(${record.id},this.value)"><option ${st.condition==='Normal'?'selected':''}>Normal</option><option ${st.condition==='Monitor'?'selected':''}>Monitor</option><option ${st.condition==='Abnormal'?'selected':''}>Abnormal</option></select><label class="leak-toggle"><input type="checkbox" ${st.leak?'checked':''} onchange="setFluidLeak(${record.id},this.checked)"> Leak</label></div></div>`}).join('')}
function setFluidCondition(id,val){db.fluidState[id]={...(db.fluidState[id]||{}),condition:val};persist();renderAll()}
function setFluidLeak(id,val){db.fluidState[id]={...(db.fluidState[id]||{}),leak:val};persist();renderAll()}
function prefillFluid(name,system){openHistoryModal();fPart.value=name;fSystem.value=system;fEventType.value='fluid_change'}
function renderPartsLife(){const arr=partRows().filter(r=>lifeOf(r)!==null).sort((a,b)=>lifeOf(a)-lifeOf(b));partsLifeCount.textContent=`${arr.length} monitored`;partsLifeGrid.innerHTML=arr.length?arr.map(r=>{const m=lifeMetrics(r);return `<div class="life-card"><div class="life-card-top"><div><div class="life-card-name">${esc(r.part)}</div><div class="life-card-system">${esc(r.system||'')}</div></div><span class="verify">${statusText(m.remaining)}</span></div><div class="life-big" style="color:${lifeColor(m.remaining)}">${m.remaining.toFixed(0)}<small>%</small></div><div class="bar"><div class="fill" style="width:${m.remaining}%;background:${lifeColor(m.remaining)}"></div></div><div class="row-sub" style="margin-top:9px">${m.remainingKm===null?'No mileage forecast':m.remainingKm<=0?'Overdue by mileage':fmt(Math.max(0,m.remainingKm))+' km remaining'}</div></div>`}).join(''):'<div class="empty">No part with complete lifecycle data.</div>'}

function renderSymptoms(){
  const active=db.symptoms.filter(symptom=>symptom.status!=='Resolved').sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  symptomList.innerHTML=active.length?active.map(symptom=>{
    const recurrence=symptomRecurrence(symptom);
    return `<div class="symptom-row"><div class="symptom-top"><div><div class="row-title">${esc(symptom.name)}</div><div class="row-sub">${esc(symptom.system)} · Severity ${symptom.severity}/5 · ${esc(symptom.status)}</div></div><span class="symptom-count">${recurrence}×</span></div><div class="symptom-meta"><span>${dateFmt(symptom.date)}</span><span>${fmt(symptom.km)} km</span><span>${recurrence} occurrence(s)</span></div><div class="row-actions"><button onclick="editSymptom('${symptom.id}')">Edit</button><button onclick="resolveSymptom('${symptom.id}')">Resolve</button></div></div>`;
  }).join(''):'<div class="empty">No active symptom recorded.</div>';
  const findings=diagnostics();
  diagnosticList.innerHTML=findings.length?findings.map(item=>`<div class="symptom-row"><div class="row-title">${esc(item.title)}</div><div class="symptom-diagnostic">${esc(item.message)}</div></div>`).join(''):'<div class="empty">Need repeated symptom data to identify a pattern.</div>';
}
function populateSystemSelect(){sSystem.innerHTML=SYSTEMS.filter(x=>x!=='Fluids').map(x=>`<option>${x}</option>`).join('')}
function openSymptomModal(prefill={}){editingSymptomId=null;populateSystemSelect();symptomModalTitle.textContent='Add Symptom';sDate.value=prefill.date||todayIso();sKm.value=prefill.km??db.car.km;sSystem.value=prefill.system||'Engine';sName.value=prefill.name||'';sSeverity.value=prefill.severity||3;sStatus.value=prefill.status||'Active';sEngineState.value='';sRpm.value='';sCoolantTemp.value='';sAtfTemp.value='';sAc.value='';sGear.value='';sSpeed.value='';sAmbient.value='';sNote.value=prefill.note||'';symptomModal.classList.add('show')}
function closeSymptomModal(){symptomModal.classList.remove('show')}
function symptomFromForm(id){return {id:id||uid('sym'),vehicleId:db.car.id,date:sDate.value,km:Number(sKm.value||db.car.km),system:sSystem.value,name:sName.value.trim(),severity:Number(sSeverity.value),status:sStatus.value,conditions:{engineState:sEngineState.value,rpm:numOrNull(sRpm.value),coolantTemp:numOrNull(sCoolantTemp.value),atfTemp:numOrNull(sAtfTemp.value),ac:sAc.value,gear:sGear.value,speed:numOrNull(sSpeed.value),ambient:numOrNull(sAmbient.value)},note:sNote.value.trim(),updatedAt:nowIso()}}
function numOrNull(v){return v===''?null:Number(v)}
function saveSymptom(){if(!sName.value.trim()){alert('กรุณาใส่อาการ');return}const obj=symptomFromForm(editingSymptomId);if(editingSymptomId)db.symptoms=db.symptoms.map(x=>x.id===editingSymptomId?{...x,...obj}:x);else{obj.createdAt=nowIso();db.symptoms.unshift(obj)}persist();closeSymptomModal();renderAll()}
function editSymptom(id){const s=db.symptoms.find(x=>x.id===id);if(!s)return;openSymptomModal(s);editingSymptomId=id;sDate.value=s.date;sKm.value=s.km;sSystem.value=s.system;sName.value=s.name;sSeverity.value=s.severity;sStatus.value=s.status;sEngineState.value=s.conditions?.engineState||'';sRpm.value=s.conditions?.rpm??'';sCoolantTemp.value=s.conditions?.coolantTemp??'';sAtfTemp.value=s.conditions?.atfTemp??'';sAc.value=s.conditions?.ac||'';sGear.value=s.conditions?.gear||'';sSpeed.value=s.conditions?.speed??'';sAmbient.value=s.conditions?.ambient??'';sNote.value=s.note||'';symptomModalTitle.textContent='Edit Symptom'}
function resolveSymptom(id){const s=db.symptoms.find(x=>x.id===id);if(s){s.status='Resolved';s.updatedAt=nowIso();persist();renderAll()}}

function pmRecord(pm){return db.history.find(r=>r.pmKey===pm.pmKey)||null}
function pmLastText(pm){const a=[];if(pm.historyKm)a.push(fmt(pm.historyKm)+' km');if(pm.historyDate)a.push(dateFmt(pm.historyDate));if(pm.historyDateRaw)a.push(pm.historyDateRaw);return a.length?a.join(' · '):'—'}
function pmPlanText(pm){const a=[];if(pm.planKm)a.push(fmt(pm.planKm)+' km');const d=pm.planDate||pm.derivedPlanDate;if(d)a.push(dateFmt(d)+(pm.derivedPlanDate&&!pm.planDate?' (derived)':''));if(pm.planDateRaw)a.push('raw '+pm.planDateRaw);return a.length?a.join(' · '):'—'}
function renderPmSchedule(){
  if(typeof pmScheduleBody==='undefined'||!pmScheduleBody)return;
  const rows=PM_SCHEDULE.map(pm=>{const r=pmRecord(pm),m=r?lifeMetrics(r):{remaining:null},img=r&&hasDisplayImage(r),rep=pm.needsSpecificImage&&!r?.customImage;const st=img?statusText(m.remaining):'NO IMAGE';const imgLabel=pm.needsVerify?'VERIFY NAME':img?(rep?'REPRESENTATIVE':'READY'):'IMAGE NEEDED';const imgClass=pm.needsVerify?'pm-verify':img?(rep?'pm-warn':'pm-ok'):'pm-missing';const priceText=Number(pm.referencePrice||0)>0?'฿'+fmt(pm.referencePrice):pm.pmKey==='fuel_filter'?'Included':pm.pmKey==='prostate'?'—':'฿0';return `<tr><td><div class="pm-main">${esc(pm.part)}</div><div class="pm-sub">Excel: ${esc(pm.sourceLabel)}</div></td><td>${esc(pm.group)}</td><td>${esc(pmLastText(pm))}</td><td>${esc(pmPlanText(pm))}</td><td><div class="pm-price">${esc(priceText)}</div><div class="pm-sub">${esc(pm.priceScope||'')}</div></td><td><span class="pm-pill ${img?'pm-ok':'pm-missing'}">${esc(st)}</span></td><td><span class="pm-pill ${imgClass}">${imgLabel}</span></td></tr>`}).join('');
  pmScheduleBody.innerHTML=rows;
  const ready=PM_SCHEDULE.filter(p=>{const r=pmRecord(p);return r&&hasDisplayImage(r)}).length,missing=PM_SCHEDULE.length-ready,specific=PM_SCHEDULE.filter(p=>p.needsSpecificImage).length;
  pmSourceSummary.textContent=`${PM_SCHEDULE.length} PM rows · ${ready} image-backed`;
  const priced=PM_SCHEDULE.filter(p=>Number(p.referencePrice||0)>0).length,catalogSum=PM_SCHEDULE.reduce((s,p)=>s+Number(p.referencePrice||0),0);pmSummaryChips.innerHTML=`<span class="pm-chip">Excel rows ${PM_SCHEDULE.length}</span><span class="pm-chip">Status rows ${ready}</span><span class="pm-chip">Priced ${priced}/${PM_SCHEDULE.length}</span><span class="pm-chip">Reference catalog ฿${fmt(catalogSum)}</span><span class="pm-chip">Missing image ${missing}</span>`;
  const needs=PM_SCHEDULE.filter(pm=>{const r=pmRecord(pm);return !r||!hasDisplayImage(r)||pm.needsSpecificImage||pm.needsVerify});
  pmImageNeeds.innerHTML=needs.map(pm=>{const r=pmRecord(pm),custom=!!r?.customImage,label=pm.needsVerify?'VERIFY SOURCE NAME':custom?'CUSTOM IMAGE ADDED':pm.needsSpecificImage?'REPLACE REPRESENTATIVE':'ADD IMAGE';return `<div class="pm-need"><b>${esc(pm.imageRequest||pm.part)}</b><small>${esc(pm.sourceLabel)} · ${label}${pm.needsSpecificImage?' · current generated image is only representative':''}</small></div>`}).join('')||'<div class="empty">All PM items have dedicated images.</div>';
  const issues=PM_SCHEDULE.filter(p=>p.sourceIssue);pmSourceIssues.innerHTML=issues.map(p=>`<div class="symptom-row"><div class="row-title">${esc(p.sourceLabel)}</div><div class="symptom-diagnostic">${esc(p.sourceIssue)}</div></div>`).join('')||'<div class="empty">No source issue flagged.</div>';
}

function renderHistory(){
  const query=search.value.trim().toLowerCase(),system=systemFilter.value;
  const records=visibleHistory().filter(record=>(!query||(record.part+' '+record.system+' '+(record.note||'')).toLowerCase().includes(query))&&(!system||record.system===system));
  if(!records.length){historyGrid.innerHTML='<div class="empty">No repaired part found.</div>';return;}
  historyGrid.innerHTML=records.map(record=>{
    const metrics=lifeMetrics(record),life=metrics.remaining,status=statusText(life),id=JSON.stringify(record.id);
    const source=resolvePartImage(record);
    const image=source?`<img src="${source}" alt="${esc(record.part)}" loading="lazy" decoding="async">`:'<div class="photo-placeholder"><strong>+</strong><small>Add photo</small></div>';
    const reference=record.pmTracked?Number(record.referencePrice??record.price??0):0;
    const actual=recordActualCost(record);
    const displayCost=actual>0?actual:reference;
    const costLabel=actual>0?'Paid':record.pmTracked?'Ref. price':'Cost';
    const price=displayCost>0?'฿'+fmt(displayCost):record.pmKey==='fuel_filter'?'Included':'—';
    const warranty=warrantyInfo(record);
    const secondary=actual>0&&reference>0?`<span class="price-scope">Ref ฿${fmt(reference)}</span>`:warranty.active?`<span class="price-scope warranty-active">${esc(warranty.label)}</span>`:record.priceScope?`<span class="price-scope">${esc(record.priceScope)}</span>`:'';
    const note=metrics.errors.length?`<div class="note note-error">${esc(metrics.errors.join('; '))}</div>`:(record.note?`<div class="note">${esc(record.note)}</div>`:'');
    return `<article class="history-card">
      <div class="part-photo">${image}<label class="upload-overlay" aria-label="Change ${esc(record.part)} photo">Photo<input type="file" accept="image/*" hidden onchange="quickPhoto(${id},event)"></label></div>
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

function renderAll(){refreshAlerts();const o=renderHealth();renderLegacyKpi(o);renderAlerts();renderForecast();renderFluids();renderPartsLife();renderSymptoms();renderNextBudget();renderPmSchedule();renderHistory();renderMobileDashboard();heroKm.textContent=fmt(db.car.km);persist()}
function render(){renderAll()}

function resetHistoryExtraFields(){
  for(const id of ['fWorkshop','fPartBrand','fPartNumber','fWarrantyMonths']){const el=document.getElementById(id);if(el)el.value='';}
  if(fReceipt)fReceipt.value='';
}
function openHistoryModal(){
  editingId=null;replacementMode=false;historyModalTitle.textContent='Add service record';
  ['fPart','fSystem','fDate','fKm','fPrice','fIntervalKm','fIntervalMonths','fNote'].forEach(id=>document.getElementById(id).value='');
  resetHistoryExtraFields();fDate.value=todayIso();fKm.value=db.car.km;fImage.value='';fEventType.value='part_replacement';historyModal.classList.add('show');
}
function closeHistoryModal(){replacementMode=false;historyModal.classList.remove('show')}
function fillHistoryForm(r,{replacement=false}={}){
  fPart.value=r.part||'';fSystem.value=r.system||'';fDate.value=replacement?todayIso():(r.date||'');fKm.value=replacement?db.car.km:(r.km||'');
  fPrice.value=replacement?'':(recordActualCost(r)||'');fIntervalKm.value=r.intervalKm||'';fIntervalMonths.value=r.intervalMonths||'';fNote.value=r.note||'';
  fEventType.value=r.eventType||'part_replacement';fImage.value='';fWorkshop.value=r.workshop||'';fPartBrand.value=r.partBrand||'';fPartNumber.value=r.partNumber||'';fWarrantyMonths.value=r.warrantyMonths||'';fReceipt.value='';
}
function editHistory(id){const r=db.history.find(x=>x.id===id);if(!r)return;editingId=id;replacementMode=false;historyModalTitle.textContent='Edit service record';fillHistoryForm(r);historyModal.classList.add('show')}
async function fileData(file){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(file)})}
async function saveHistory(){
  const part=fPart.value.trim();if(!part){alert('กรุณาใส่ชื่ออะไหล่');return}
  const old=editingId?db.history.find(x=>x.id===editingId):null;
  let image=old?.image||'',customImage=!!old?.customImage;if(fImage.files[0]){image=await fileData(fImage.files[0]);customImage=true}
  let receiptImage=old?.receiptImage||'';if(fReceipt.files[0])receiptImage=await fileData(fReceipt.files[0]);
  const actualCost=Number(fPrice.value||0);
  const rec={...(old||{}),id:editingId||Date.now(),part,system:fSystem.value.trim(),date:fDate.value,km:Number(fKm.value||0),actualCost,intervalKm:Number(fIntervalKm.value||0),intervalMonths:Number(fIntervalMonths.value||0),note:fNote.value.trim(),image,customImage,imageKey:old?.imageKey||imageKeyForPartName(part)||'',needsVerify:false,eventType:fEventType.value,workshop:fWorkshop.value.trim(),partBrand:fPartBrand.value.trim(),partNumber:fPartNumber.value.trim(),warrantyMonths:Number(fWarrantyMonths.value||0),receiptImage};
  rec.price=rec.pmTracked?(actualCost>0?actualCost:Number(old?.price??rec.referencePrice??0)):actualCost;
  if(rec.pmTracked&&old){if(rec.intervalKm>0&&rec.km>0)rec.pmPlanKm=rec.km+rec.intervalKm;if(rec.intervalMonths>0&&rec.date)rec.pmPlanDate=addMonthsIso(rec.date,rec.intervalMonths);rec.pmDerivedPlanDate='';rec.pmPlanDateRaw=null}
  const createEvent=!editingId||replacementMode;
  if(editingId)db.history=db.history.map(x=>x.id===editingId?rec:x);else db.history.unshift(rec);
  if(createEvent)db.serviceEvents.unshift({id:uid('evt'),vehicleId:db.car.id,type:rec.eventType,date:rec.date,km:rec.km,system:rec.system,title:rec.part,cost:serviceEventCost(rec),actualCost:serviceEventCost(rec),sourceId:rec.id,userEntered:true,workshop:rec.workshop||'',partBrand:rec.partBrand||'',partNumber:rec.partNumber||'',createdAt:nowIso()});
  replacementMode=false;persist();closeHistoryModal();renderAll();
}
async function quickPhoto(id,e){const file=e.target.files?.[0];if(!file)return;const r=db.history.find(x=>x.id===id);if(!r)return;r.image=await fileData(file);r.customImage=true;persist();renderAll()}
function markReplaced(id){const r=db.history.find(x=>x.id===id);if(!r)return;editingId=id;replacementMode=true;historyModalTitle.textContent=`Record ${r.part} replacement`;fillHistoryForm(r,{replacement:true});historyModal.classList.add('show')}
function removeHistory(id){if(!confirm('ลบประวัติรายการนี้?'))return;db.history=db.history.filter(x=>x.id!==id);if(detailRecordId===id)closePartDetails();persist();renderAll()}
function openPartDetails(id){
  const r=db.history.find(x=>x.id===id);if(!r)return;detailRecordId=id;
  partDetailTitle.textContent=r.part||'Part Detail';partDetailSystem.textContent=r.system||'Service record';
  const src=resolvePartImage(r);partDetailImage.innerHTML=src?`<img src="${src}" alt="${esc(r.part)}">`:'<div class="photo-placeholder"><strong>+</strong><small>No image</small></div>';
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
function saveCar(){const km=Number(carKm.value||0),v=validateVehicleMileage(km);if(!v.ok){alert(v.message);return}db.car.km=km;db.car.monthlyKm=Number(monthlyKm.value||1200);persist();carModal.classList.remove('show');renderAll()}

document.addEventListener('DOMContentLoaded',()=>{
  window.addEventListener('scroll',()=>topbar.classList.toggle('scrolled',scrollY>20));
  registerOfflineApp();
  bootDatabase();
  window.addEventListener('online',updateStorageStatus);
  window.addEventListener('offline',updateStorageStatus);
});
