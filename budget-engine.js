'use strict';

let budgetWindow=5000;
const BUDGET_SERVICE_KEYS=new Set(['throttle_body_clean','tire_rotation','fuel_injector_clean','valve_adjustment']);

function budgetDueDate(pm){
  const value=pm.planDate||pm.derivedPlanDate||'';
  if(!value)return null;
  const date=new Date(value+'T00:00:00');
  return Number.isFinite(date.getTime())?date:null;
}
function budgetMonthsTo(date,now=new Date()){
  if(!date)return null;
  return (date-now)/86400000/30.4375;
}
function budgetKind(pm){return BUDGET_SERVICE_KEYS.has(pm.pmKey)?'Service / Labor':'Parts / Materials';}
function buildBudgetMeta(pm,context,now=new Date()){
  const currentKm=Number(context?.currentKm||0),monthlyKm=Math.max(1,Number(context?.monthlyKm||1200));
  const planKm=Number(pm.planKm||0),kmTo=planKm>0?planKm-currentKm:null;
  const dueDate=budgetDueDate(pm),monthsTo=budgetMonthsTo(dueDate,now);
  const estimatedKmByTime=monthsTo===null?null:monthsTo*monthlyKm;
  const candidates=[];
  if(kmTo!==null&&Number.isFinite(kmTo))candidates.push({kind:'km',distance:kmTo});
  if(estimatedKmByTime!==null&&Number.isFinite(estimatedKmByTime))candidates.push({kind:'date',distance:estimatedKmByTime});
  const effective=candidates.length?candidates.reduce((a,b)=>a.distance<=b.distance?a:b):null;
  const trigger=effective?.kind==='km'?`${fmt(planKm)} km`:effective?.kind==='date'&&dueDate?dateFmt(dueDate.toISOString().slice(0,10)):'No plan';
  const overdue=(kmTo!==null&&kmTo<=0)||(monthsTo!==null&&monthsTo<=0);
  const included=Number(pm.referencePrice||0)===0&&/included/i.test(String(pm.priceScope||''));
  return {pm,kmTo,monthsTo,dueDate,effectiveKm:effective?.distance??null,trigger,overdue,price:included?0:Number(pm.referencePrice||0),kind:budgetKind(pm),included};
}
function budgetMeta(pm){return buildBudgetMeta(pm,{currentKm:db.car.km,monthlyKm:db.car.monthlyKm},new Date());}
function budgetAll(){
  const seen=new Set();
  return PM_SCHEDULE.filter(pm=>!seen.has(pm.pmKey)&&seen.add(pm.pmKey)).map(budgetMeta).filter(row=>row.effectiveKm!==null||row.dueDate).sort((a,b)=>{
    if(a.overdue!==b.overdue)return a.overdue?-1:1;
    return (a.effectiveKm??1e15)-(b.effectiveKm??1e15);
  });
}
function rowsForBudgetWindow(rows,win){
  if(win==='all')return rows.slice();
  if(win==='12m')return rows.filter(row=>row.overdue||(row.monthsTo!==null&&row.monthsTo<=12));
  const distance=Number(win);
  return rows.filter(row=>row.overdue||(row.effectiveKm!==null&&row.effectiveKm<=distance));
}
function budgetRowsForWindow(win){return rowsForBudgetWindow(budgetAll(),win);}
function budgetSum(rows){return rows.reduce((sum,row)=>sum+(Number(row.price)||0),0);}
function budgetRemainText(x){
  if(x.overdue){
    const parts=[];
    if(x.kmTo!==null&&x.kmTo<=0)parts.push(`${fmt(Math.abs(Math.round(x.kmTo)))} km overdue`);
    if(x.monthsTo!==null&&x.monthsTo<=0)parts.push(`${Math.abs(x.monthsTo).toFixed(1)} mo overdue`);
    return parts.join(' · ')||'Due now';
  }
  const parts=[];
  if(x.kmTo!==null)parts.push(`${fmt(Math.max(0,Math.round(x.kmTo)))} km`);
  if(x.monthsTo!==null)parts.push(`${Math.max(0,x.monthsTo).toFixed(1)} mo`);
  return parts.join(' · ')||'—';
}
function budgetStatusClass(x){
  if(x.overdue)return 'due';
  if(x.effectiveKm!==null&&x.effectiveKm<=5000)return 'soon';
  return 'plan';
}
function setBudgetWindow(win,btn){
  budgetWindow=win;
  document.querySelectorAll('.budget-filter').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  renderNextBudget();
}
function renderNextBudget(){
  const body=document.getElementById('nextBudgetBody');
  if(!body)return;
  const all=budgetAll();
  const due=all.filter(x=>x.overdue);
  const w5=all.filter(x=>x.overdue||(x.effectiveKm!==null&&x.effectiveKm<=5000));
  const w10=all.filter(x=>x.overdue||(x.effectiveKm!==null&&x.effectiveKm<=10000));
  const w20=all.filter(x=>x.overdue||(x.effectiveKm!==null&&x.effectiveKm<=20000));

  const setText=(id,val)=>{const el=document.getElementById(id);if(el)el.textContent=val};
  setText('budgetDueNow','฿'+fmt(budgetSum(due)));
  setText('budgetDueNowCount',`${due.length} items`);
  setText('budget5k','฿'+fmt(budgetSum(w5)));
  setText('budget5kCount',`${w5.length} items`);
  setText('budget10k','฿'+fmt(budgetSum(w10)));
  setText('budget10kCount',`${w10.length} items`);
  setText('budget20k','฿'+fmt(budgetSum(w20)));
  setText('budget20kCount',`${w20.length} items`);
  setText('budgetContext',`${fmt(db.car.km)} km · ${fmt(db.car.monthlyKm)} km/month`);

  const rows=budgetRowsForWindow(budgetWindow);
  const parts=rows.filter(x=>x.kind==='Parts / Materials');
  const service=rows.filter(x=>x.kind==='Service / Labor');
  setText('budgetParts','฿'+fmt(budgetSum(parts)));
  setText('budgetService','฿'+fmt(budgetSum(service)));
  setText('budgetTotal','฿'+fmt(budgetSum(rows)));
  setText('budgetItemCount',String(rows.length));

  body.innerHTML=rows.length?rows.map(x=>{
    const pm=x.pm;
    const price=x.price>0?'฿'+fmt(x.price):(pm.pmKey==='fuel_filter'?'Included':'—');
    const trigger=x.overdue?'Due now':x.trigger;
    return `<tr>
      <td><div class="budget-part">${esc(pm.part)}</div><div class="budget-sub">${esc(pm.priceScope||pm.group||'')}</div></td>
      <td><span class="budget-pill ${budgetStatusClass(x)}">${esc(trigger)}</span></td>
      <td><div class="budget-part">${esc(budgetRemainText(x))}</div><div class="budget-sub">${x.dueDate?'Date '+esc(dateFmt(x.dueDate.toISOString().slice(0,10))):''}${x.kmTo!==null?' · Plan '+fmt(pm.planKm)+' km':''}</div></td>
      <td><span class="budget-pill">${esc(x.kind)}</span></td>
      <td><div class="budget-price">${esc(price)}</div><div class="budget-sub">Reference</div></td>
    </tr>`;
  }).join(''):'<tr><td colspan="5"><div class="empty">No planned maintenance found in this window.</div></td></tr>';
}

if(typeof module!=='undefined'&&module.exports){module.exports={BUDGET_SERVICE_KEYS,budgetDueDate,budgetMonthsTo,budgetKind,buildBudgetMeta,rowsForBudgetWindow,budgetSum};}
