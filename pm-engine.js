'use strict';

function engineNorm(value){return String(value||'').toLowerCase().replace(/\([^)]*\)/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function engineClamp(value,min,max){return Math.max(min,Math.min(max,value));}

function aliasKey(name){
  const n=engineNorm(name);
  if(n.includes('spark'))return 'spark plugs';
  if(n==='atf'||n.startsWith('atf '))return 'atf';
  if(n.includes('engine oil'))return 'engine oil';
  if(n.includes('engine air filter'))return 'engine air filter';
  if(n.includes('cabin air filter'))return 'cabin air filter';
  if(n.includes('brake fluid'))return 'brake fluid';
  if(n.includes('coolant'))return 'coolant';
  if(n.includes('wheel')&&n.includes('bearing'))return 'wheel bearing';
  if(n.includes('fan motor'))return 'fan motor';
  if(n.includes('battery'))return 'battery';
  if(n.includes('tension'))return 'tensioner';
  if(n.includes('engine mount'))return 'engine mount';
  if(n.includes('drive belt'))return 'drive belt';
  if(n.includes('brake pad'))return 'brake pad';
  if(n.includes('fuel pump'))return 'fuel pump';
  if(n.includes('brake disc')||n.includes('rotor'))return 'brake disc';
  if(n.includes('shock')||n.includes('strut'))return 'shock absorber';
  if(n.includes('thermostat'))return 'thermostat';
  if(n.includes('radiator'))return 'radiator';
  if(n.includes('water pump'))return 'water pump';
  if(n.includes('tire')||n.includes('tyre'))return 'tire';
  if(n.includes('starter'))return 'starter motor';
  if(n.includes('alternator'))return 'alternator';
  if(n.includes('throttle body')||n.includes('butterfly valve'))return 'throttle body';
  if(n.includes('injector'))return 'fuel injector';
  if(n.includes('timing chain'))return 'timing chain';
  if(n.includes('valve adjustment')||n.includes('valve train')||n.includes('camshaft'))return 'valve train';
  if(n.includes('idler pulley')||n.includes('belt pulley bearing')||n.includes('pulley bearing'))return 'belt pulley bearing';
  return n;
}

function imageKeyForPartName(name){
  const key=aliasKey(name);
  const map={
    'spark plugs':'spark_plug',
    'atf':'atf',
    'engine oil':'engine_oil',
    'engine air filter':'engine_air_filter',
    'cabin air filter':'cabin_air_filter',
    'brake fluid':'brake_fluid',
    'coolant':'coolant',
    'wheel bearing':'wheel_bearing',
    'fan motor':'fan_motor',
    'battery':'battery',
    'tensioner':'drive_belt_tensioner',
    'fuel pump':'fuel_pump',
    'engine mount':'engine_mount',
    'drive belt':'drive_belt',
    'brake pad':'brake_pad',
    'brake disc':'brake_disc',
    'shock absorber':'shock_absorber',
    'thermostat':'thermostat',
    'radiator':'radiator',
    'water pump':'water_pump',
    'tire':'tire',
    'starter motor':'starter_motor',
    'alternator':'alternator',
    'throttle body':'throttle_body',
    'fuel injector':'fuel_injector',
    'timing chain':'timing_chain',
    'valve train':'valve_train',
    'belt pulley bearing':'belt_pulley_bearing'
  };
  return map[key]||null;
}

function addMonthsIso(dateStr,months){if(!dateStr||!months)return '';const d=new Date(dateStr+'T00:00:00');d.setMonth(d.getMonth()+Number(months));return d.toISOString().slice(0,10)}

function isFluidRecord(r){const n=engineNorm(r.part);return ['engine oil','atf','coolant','brake fluid','power steering fluid','differential oil','washer fluid'].some(x=>n.includes(x))}

function calculateLife(record,car,now=new Date()){
  const currentKm=Number(car?.km||0),installedKm=Number(record?.km||0),kmLife=Number(record?.intervalKm||0),monthLife=Number(record?.intervalMonths||0),planKm=Number(record?.pmPlanKm||0);
  let kmPct=null,timePct=null,remainingKm=null,dueDate=null;
  const errors=[];
  if(planKm>installedKm&&installedKm>0){
    if(currentKm<installedKm)errors.push('Current mileage < installed mileage');
    else{const span=planKm-installedKm;remainingKm=planKm-currentKm;kmPct=(remainingKm/span)*100;}
  }else if(kmLife>0&&installedKm>0){
    if(currentKm<installedKm)errors.push('Current mileage < installed mileage');
    else{remainingKm=kmLife-(currentKm-installedKm);kmPct=(remainingKm/kmLife)*100;}
  }
  const explicitDue=record?.pmPlanDate||record?.pmDerivedPlanDate||'';
  if(explicitDue&&record?.date){
    const startDate=new Date(record.date+'T00:00:00'),endDate=new Date(explicitDue+'T00:00:00');
    const total=(endDate-startDate)/86400000,remain=(endDate-now)/86400000;
    if(Number.isFinite(total)&&total>0){timePct=(remain/total)*100;dueDate=endDate;}
    else errors.push('Invalid service or due date');
  }else if(monthLife>0&&record?.date){
    const startDate=new Date(record.date+'T00:00:00');
    if(Number.isFinite(startDate.getTime())){
      dueDate=new Date(startDate);dueDate.setMonth(dueDate.getMonth()+monthLife);
      const total=(dueDate-startDate)/86400000,remain=(dueDate-now)/86400000;
      if(total>0)timePct=(remain/total)*100;
    }else errors.push('Invalid service date');
  }
  const values=[kmPct,timePct].filter(value=>value!==null&&Number.isFinite(value));
  const raw=values.length?Math.min(...values):null;
  return {kmPct:kmPct===null?null:engineClamp(kmPct,0,100),timePct:timePct===null?null:engineClamp(timePct,0,100),remaining:raw===null?null:engineClamp(raw,0,100),raw,remainingKm,dueDate,errors};
}
function lifeMetrics(record){return calculateLife(record,db.car,new Date());}
function lifeOf(r){return lifeMetrics(r).remaining}
function lifeColor(l){if(l===null)return '#626770';if(l<=20)return 'var(--danger)';if(l<=40)return 'var(--amber)';return 'var(--green)'}
function statusText(l){if(l===null)return 'INSUFFICIENT DATA';if(l<=0)return 'OVERDUE';if(l<20)return 'REPLACE SOON';if(l<=40)return 'PLAN REPLACEMENT';if(l<=70)return 'MONITOR';return 'HEALTHY'}
function resolvePartImage(r){
  if(!r)return '';
  if(r.customImage&&r.image)return r.image;
  if(r.imageKey&&IMAGE_MAP[r.imageKey])return IMAGE_MAP[r.imageKey];
  const inferred=imageKeyForPartName(r.part||'');
  if(inferred&&IMAGE_MAP[inferred])return IMAGE_MAP[inferred];
  if(r.needsVerify)return FALLBACK_PART_IMAGE;
  return r.image||'';
}
function hasDisplayImage(r){return !!resolvePartImage(r)}
function visibleHistory(){return db.history.filter(r=>r.pmTracked&&hasDisplayImage(r))}


function resolveImageSource(record,imageMap){
  if(!record)return '';
  if(record.customImage&&record.image)return record.image;
  if(record.imageKey&&imageMap[record.imageKey])return imageMap[record.imageKey];
  const inferred=imageKeyForPartName(record.part||'');
  return (inferred&&imageMap[inferred])||(record.needsVerify&&typeof FALLBACK_PART_IMAGE!=='undefined'?FALLBACK_PART_IMAGE:'')||record.image||'';
}

if(typeof module!=='undefined'&&module.exports){module.exports={aliasKey,imageKeyForPartName,calculateLife,statusText,resolveImageSource,isFluidRecord,addMonthsIso};}
