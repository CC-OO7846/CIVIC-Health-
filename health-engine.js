'use strict';

function recordSystems(r){
  const n=norm(r.part), s=String(r.system||'').toLowerCase(), out=new Set();
  if(s.includes('engine'))out.add('Engine'); if(s.includes('transmission'))out.add('Transmission'); if(s.includes('cooling'))out.add('Cooling');
  if(s.includes('electrical'))out.add('Electrical'); if(s.includes('brake'))out.add('Brake'); if(s.includes('suspension')||s.includes('wheel'))out.add('Suspension');
  if(s.includes('steering'))out.add('Steering'); if(s.includes('tire'))out.add('Tires'); if(s.includes('a/c')||s.includes('air conditioning'))out.add('Air Conditioning');
  if(n.includes('engine oil')||n.includes('spark')||n.includes('engine air')||n.includes('drive belt')||n.includes('tension')||n.includes('engine mount')||n.includes('fuel pump'))out.add('Engine');
  if(n.includes('atf')||n.includes('valve body')||n.includes('torque converter')||n.includes('transmission'))out.add('Transmission');
  if(n.includes('coolant')||n.includes('radiator')||n.includes('thermostat')||n.includes('water pump')||n.includes('fan motor'))out.add('Cooling');
  if(n.includes('battery')){out.add('Battery');out.add('Electrical')}
  if(n.includes('alternator')||n.includes('starter'))out.add('Electrical');
  if(n.includes('brake'))out.add('Brake'); if(n.includes('bearing')||n.includes('lower arm')||n.includes('ball joint')||n.includes('shock')||n.includes('bushing'))out.add('Suspension');
  if(n.includes('tie rod')||n.includes('steering'))out.add('Steering'); if(n.includes('tire'))out.add('Tires'); if(n.includes('cabin air')||n.includes('a/c'))out.add('Air Conditioning');
  if(isFluidRecord(r))out.add('Fluids'); return [...out];
}

function symptomRecurrence(sym){return db.symptoms.filter(x=>norm(x.name)===norm(sym.name)&&x.system===sym.system).length}
function symptomPriority(sym){
  const recurrence=symptomRecurrence(sym),severity=clamp(Number(sym.severity||1),1,5);
  const attention=severity>=5||recurrence>=5?'CRITICAL':severity>=4||recurrence>=3?'WARNING':'MONITOR';
  return {recurrence,severity,attention};
}
function latestInspectionStatus(system){
  const relevant=db.inspections.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  for(const ins of relevant){const items=(ins.items||[]).filter(x=>x.system===system&&x.status&&x.status!=='N/A');if(items.length)return items}return [];
}
function repeatFailureCount(system){
  const events=db.serviceEvents.filter(e=>recordSystems({part:e.title,system:e.system}).includes(system)&&(e.type==='corrective'||e.type==='breakdown'||e.type==='part_replacement'));
  const g={};events.forEach(e=>g[aliasKey(e.title)]=(g[aliasKey(e.title)]||0)+1);return Object.values(g).reduce((s,n)=>s+Math.max(0,n-1),0)
}
function systemHealth(system){
  const reasons=[], records=visibleHistory().filter(r=>recordSystems(r).includes(system)), lifeRows=records.map(r=>({r,m:lifeMetrics(r)})).filter(x=>x.m.remaining!==null);
  let deduction=0, evidence=0;
  if(lifeRows.length){
    const avg=lifeRows.reduce((s,x)=>s+x.m.remaining,0)/lifeRows.length;const d=clamp((100-avg)*0.32,0,32);deduction+=d;evidence+=Math.min(40,15+lifeRows.length*6);
    reasons.push({text:`Lifecycle average ${avg.toFixed(0)}% from ${lifeRows.length} monitored item(s)`,delta:-Math.round(d),negative:d>0});
    lifeRows.filter(x=>x.m.raw!==null&&x.m.raw<=0).forEach(x=>reasons.push({text:`${x.r.part} overdue`,delta:-5,negative:true}));
  }
  const syms=db.symptoms.filter(s=>s.system===system&&s.status!=='Resolved');
  if(syms.length){let d=0;syms.forEach(s=>{const rec=symptomRecurrence(s);d+=Number(s.severity||1)*2+Math.max(0,rec-1)*1.2});d=clamp(d,0,32);deduction+=d;evidence+=Math.min(30,12+syms.length*6);reasons.push({text:`${syms.length} active/monitoring symptom(s)`,delta:-Math.round(d),negative:true})}else if(lifeRows.length){reasons.push({text:'No active symptom recorded',delta:0,negative:false})}
  const inspect=latestInspectionStatus(system);if(inspect.length){const ab=inspect.filter(i=>i.status==='Abnormal').length,mo=inspect.filter(i=>i.status==='Monitor').length,d=ab*10+mo*4;deduction+=clamp(d,0,20);evidence+=15;reasons.push({text:`Latest inspection: ${ab} abnormal, ${mo} monitor`,delta:-clamp(d,0,20),negative:d>0})}
  const fluidLeaks=records.filter(r=>isFluidRecord(r)&&db.fluidState[r.id]?.leak);if(fluidLeaks.length){deduction+=12;reasons.push({text:`Fluid leak flagged: ${fluidLeaks.map(x=>x.part).join(', ')}`,delta:-12,negative:true});evidence+=10}
  const fluidConditionRows=records.filter(r=>isFluidRecord(r)&&db.fluidState[r.id]?.condition&&db.fluidState[r.id]?.condition!=='Normal');
  if(fluidConditionRows.length){const d=clamp(fluidConditionRows.reduce((s,r)=>s+(db.fluidState[r.id].condition==='Abnormal'?8:4),0),0,16);deduction+=d;reasons.push({text:`Fluid condition flagged: ${fluidConditionRows.map(x=>x.part+' '+db.fluidState[x.id].condition).join(', ')}`,delta:-d,negative:true});evidence+=8}
  const repeats=repeatFailureCount(system);if(repeats){const d=clamp(repeats*2,0,10);deduction+=d;reasons.push({text:`${repeats} repeat repair/failure occurrence(s)`,delta:-d,negative:true});evidence+=10}
  if(MILEAGE_STRESS_SYSTEMS.has(system)&&Number(db.car.km)>Number(db.settings.mileageStressStartKm)){
    const span=Math.max(1,Number(db.settings.mileageStressMaxKm)-Number(db.settings.mileageStressStartKm)),ratio=clamp((Number(db.car.km)-Number(db.settings.mileageStressStartKm))/span,0,1),d=ratio*Number(db.settings.maxMileageDeduction||5);deduction+=d;reasons.push({text:`Mileage exposure ${fmt(db.car.km)} km`,delta:-Math.round(d),negative:d>0});evidence+=5
  }
  evidence=clamp(evidence,0,100);if(evidence<15)return {system,score:null,confidence:evidence,reasons:[{text:'Insufficient supporting data',delta:0,negative:false}],records};
  return {system,score:Math.round(clamp(100-deduction,0,100)),confidence:evidence,reasons,records};
}
function grade(score){if(score===null)return {label:'INSUFFICIENT DATA',color:'#737780'};if(score>=90)return {label:'EXCELLENT',color:'var(--green)'};if(score>=80)return {label:'GOOD',color:'var(--green)'};if(score>=70)return {label:'MONITOR',color:'var(--amber)'};if(score>=50)return {label:'SERVICE SOON',color:'#ff983e'};return {label:'CRITICAL',color:'var(--danger)'}}
function overallHealth(){
  const systems=SYSTEMS.map(systemHealth), valid=systems.filter(s=>s.score!==null);let w=0,sum=0,confidenceWeighted=0;
  valid.forEach(s=>{const sw=(db.settings.systemWeights||SYSTEM_WEIGHTS)[s.system]||0;w+=sw;sum+=s.score*sw;confidenceWeighted+=s.confidence*sw});
  if(w<0.25)return {score:null,confidence:Math.round(w*100),systems,reasons:[]};
  const score=Math.round(sum/w),confidence=Math.round(confidenceWeighted/w*w);const reasons=systems.flatMap(s=>s.reasons.filter(r=>r.negative).map(r=>({...r,system:s.system}))).sort((a,b)=>a.delta-b.delta).slice(0,4);return {score,confidence,systems,reasons}
}

function fluidRecordFor(name){const key=norm(name);return visibleHistory().find(r=>norm(r.part).includes(key==='engine oil'?'engine oil':key==='brake fluid'?'brake fluid':key==='coolant'?'coolant':key))||null}
function fluidRows(){return FLUID_CATALOG.map(f=>({catalog:f,record:fluidRecordFor(f.name)}))}
function partRows(){return visibleHistory().filter(r=>!isFluidRecord(r))}

function forecast(){
  const items=[];visibleHistory().forEach(r=>{const m=lifeMetrics(r);if(m.remaining===null)return;let urgency=999999,label='';if(m.remainingKm!==null){urgency=m.remainingKm;label=m.remainingKm<=0?'Due now':`${fmt(Math.max(0,m.remainingKm))} km`}
    if(m.dueDate){const days=Math.ceil((m.dueDate-new Date())/(86400000));const kmEquiv=days*(Number(db.car.monthlyKm||1000)/30.4375);if(kmEquiv<urgency){urgency=kmEquiv;label=days<=0?'Due by time':`${Math.max(0,days)} days`}}
    if(urgency<=20000||m.remaining<=40){const bucket=urgency<=1000?'Next 1,000 km':urgency<=5000?'Next 5,000 km':urgency<=10000?'Next 10,000 km':urgency<=20000?'Next 20,000 km':'Time / condition based';items.push({type:'maintenance',title:r.part,system:r.system||'',urgency,label,bucket,life:m.remaining,record:r})}});
  db.symptoms.filter(s=>s.status!=='Resolved').forEach(s=>{const priority=symptomPriority(s);if(priority.severity>=4||priority.recurrence>=3)items.push({type:'symptom',title:`Inspect: ${s.name}`,system:s.system,urgency:-(priority.severity*10+priority.recurrence),label:'Review symptom',life:null,symptom:s})});
  return items.sort((a,b)=>a.urgency-b.urgency).slice(0,10)
}

function alertSignature(type,key){return `${type}:${key}`}
function canCreateAlert(sig){const a=db.alerts.filter(x=>x.signature===sig).sort((x,y)=>String(y.createdAt).localeCompare(String(x.createdAt)))[0];if(!a)return true;if(['active','acknowledged'].includes(a.status))return false;return Date.now()-new Date(a.createdAt).getTime()>ALERT_COOLDOWN_MS}
function addAlert(obj){if(!canCreateAlert(obj.signature))return;db.alerts.unshift({id:uid('alert'),vehicleId:db.car.id,status:'active',createdAt:nowIso(),...obj})}
function refreshAlerts(){
  visibleHistory().forEach(r=>{const m=lifeMetrics(r);if(m.remaining===null)return;if(m.remaining<=0)addAlert({signature:alertSignature('life',r.id),severity:'CRITICAL',title:`${r.part} overdue`,message:'Recorded lifecycle has reached or passed its service limit.',sourceType:'history',sourceId:r.id});else if(m.remaining<=20)addAlert({signature:alertSignature('life',r.id),severity:'WARNING',title:`${r.part} replacement planning`,message:`Remaining life ${m.remaining.toFixed(0)}%.`,sourceType:'history',sourceId:r.id});if(isFluidRecord(r)&&db.fluidState[r.id]?.leak)addAlert({signature:alertSignature('leak',r.id),severity:'CRITICAL',title:`${r.part} leak flagged`,message:'Leak was marked in Fluid Health. Inspect source and level before continued use.',sourceType:'history',sourceId:r.id})});
  db.symptoms.filter(s=>s.status!=='Resolved').forEach(s=>{const priority=symptomPriority(s);if(priority.recurrence>=3||priority.severity>=4)addAlert({signature:alertSignature('symptom',norm(s.name)),severity:priority.attention,title:`${s.system}: ${s.name}`,message:`Recorded ${priority.recurrence} time(s) at severity ${priority.severity}/5.`,sourceType:'symptom',sourceId:s.id})});
}
function activeAlerts(){return db.alerts.filter(a=>['active','acknowledged'].includes(a.status)).slice(0,10)}
function alertClass(sev){return sev==='CRITICAL'?'alert-critical':sev==='WARNING'?'alert-warning':sev==='MONITOR'?'alert-monitor':'alert-info'}
function updateAlert(id,status){const a=db.alerts.find(x=>x.id===id);if(a){a.status=status;a.updatedAt=nowIso();persist();renderAll()}}
function createTaskFromAlert(id){const a=db.alerts.find(x=>x.id===id);if(!a)return;db.tasks.push({id:uid('task'),title:a.title,status:'open',sourceAlertId:id,createdAt:nowIso()});a.status='acknowledged';persist();renderAll()}
function createSymptomFromAlert(id){const a=db.alerts.find(x=>x.id===id);if(!a)return;let system='Engine',name=a.title;if(a.sourceType==='history'){const r=db.history.find(x=>x.id===a.sourceId);if(r){system=recordSystems(r).find(x=>x!=='Fluids')||r.system||'Engine';name='Inspect '+r.part}}else if(a.sourceType==='symptom'){const s=db.symptoms.find(x=>x.id===a.sourceId);if(s){system=s.system;name=s.name}}openSymptomModal({system,name,note:'Created from alert: '+a.message})}
function openAlertSource(id){const a=db.alerts.find(x=>x.id===id);if(!a)return;if(a.sourceType==='history'){const r=db.history.find(x=>x.id===a.sourceId);if(r){search.value=r.part;systemFilter.value='';renderHistory();document.getElementById('history').scrollIntoView({behavior:'smooth'})}}else{document.getElementById('symptoms').scrollIntoView({behavior:'smooth'})}}

function diagnostics(){
  const groups={};db.symptoms.forEach(s=>{const k=`${s.system}|${norm(s.name)}`;(groups[k]||(groups[k]=[])).push(s)});const out=[];
  Object.values(groups).forEach(g=>{if(g.length<2)return;const sample=g[0],atfs=g.map(x=>Number(x.conditions?.atfTemp)).filter(Number.isFinite),cold=g.filter(x=>x.conditions?.engineState==='Cold').length;let msg=`${sample.name} recorded ${g.length} times.`;if(atfs.length>=2&&atfs.filter(v=>v<60).length/atfs.length>=0.75)msg+=` Pattern is primarily when ATF temperature < 60°C (${atfs.filter(v=>v<60).length}/${atfs.length} records).`;else if(cold/g.length>=0.75)msg+=` Pattern is primarily during cold condition (${cold}/${g.length} records).`;out.push({title:sample.system,message:msg})});return out
}

function appendHealthSnapshot(overall){if(overall.score===null)return;const today=todayIso(),last=db.healthHistory[db.healthHistory.length-1];if(!last||last.date!==today){db.healthHistory.push({id:uid('health'),vehicleId:db.car.id,date:today,km:db.car.km,score:overall.score,createdAt:nowIso()})}else if(last.score!==overall.score){last.score=overall.score;last.km=db.car.km;last.updatedAt=nowIso()}}

function renderHealth(){
  const o=overallHealth(),g=grade(o.score);vhOverallScore.textContent=o.score===null?'—':o.score;vhOverallGrade.textContent=g.label;vhOverallGrade.style.color=g.color;vhConfidence.innerHTML=`Confidence: <b>${o.confidence}%</b> · ${o.systems.filter(x=>x.score!==null).length}/${SYSTEMS.length} systems have usable evidence`;
  vhTopReasons.innerHTML=o.reasons.length?o.reasons.map(r=>`<div class="reason-mini"><span>${esc(r.system)} · ${esc(r.text)}</span><b>${r.delta}</b></div>`).join(''):'<div class="reason-mini"><span>No scored deduction available yet.</span><b>—</b></div>';
  systemHealthGrid.innerHTML=o.systems.map(s=>{const gr=grade(s.score);return `<button class="system-card" onclick="openHealthDetail('${esc(s.system)}')"><div class="system-name">${esc(s.system)}</div><div class="system-score ${s.score===null?'insufficient':''}">${s.score===null?'—':s.score+'%'}</div><div class="system-status" style="color:${gr.color}">${gr.label}</div><div class="system-data">Confidence ${s.confidence}% · ${s.records.length} related record(s)</div></button>`}).join('');
  appendHealthSnapshot(o);return o
}
function openHealthDetail(system){const h=systemHealth(system),g=grade(h.score);healthDetailTitle.textContent=`${system} Health`;healthDetailSummary.innerHTML=`Score: <b style="color:${g.color}">${h.score===null?'Insufficient Data':h.score+'% '+g.label}</b><br>Evidence confidence: <b>${h.confidence}%</b>`;healthDetailReasons.innerHTML=h.reasons.map(r=>`<div class="detail-reason ${r.negative?'detail-negative':'detail-positive'}"><span>${esc(r.text)}</span><b>${r.delta<0?r.delta:r.delta===0?'NORMAL':'+'+r.delta}</b></div>`).join('');healthDetailModal.classList.add('show')}

function renderAlerts(){const arr=activeAlerts();alertCount.textContent=`${arr.length} active`;alertList.innerHTML=arr.length?arr.map(a=>`<div class="alert-row"><div class="alert-top"><div><div class="row-title">${esc(a.title)}</div><div class="row-sub">${esc(a.message)}</div></div><span class="alert-sev ${alertClass(a.severity)}">${a.severity}</span></div><div class="row-actions">${a.status==='active'?`<button onclick="updateAlert('${a.id}','acknowledged')">Acknowledge</button>`:''}<button onclick="updateAlert('${a.id}','dismissed')">Dismiss</button><button onclick="createTaskFromAlert('${a.id}')">Create Task</button><button onclick="createSymptomFromAlert('${a.id}')">Create Symptom</button><button onclick="openAlertSource('${a.id}')">Open Related</button></div></div>`).join(''):'<div class="empty">No active alert.</div>'}
function renderForecast(){const arr=forecast();forecastList.innerHTML=arr.length?arr.map(x=>`<div class="forecast-row"><div class="forecast-top"><div><div class="row-title">${esc(x.title)}</div><div class="row-sub">${esc(x.system)}</div></div><div style="text-align:right"><div class="forecast-km">${esc(x.label)}</div><div class="forecast-bucket">${x.type==='symptom'?'Symptom review':'Upcoming'}</div></div></div></div>`).join(''):'<div class="empty">No maintenance forecast with current data.</div>'}

if(typeof module!=='undefined'&&module.exports){module.exports={grade};}
