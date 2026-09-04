
'use strict';

function recordActualCost(record){
  if(!record||typeof record!=='object')return 0;
  if(Object.hasOwn(record,'actualCost')){
    const explicit=Number(record.actualCost||0);
    return Number.isFinite(explicit)&&explicit>0?explicit:0;
  }
  const price=Number(record.price||0);
  if(!Number.isFinite(price)||price<=0)return 0;
  if(!record.pmTracked)return price;
  const reference=Number(record.referencePrice||0);
  return price!==reference?price:0;
}

function migrateServiceFields(record){
  const target={...(record||{})};
  if(target.actualCost===undefined){
    const inferred=recordActualCost(target);
    if(inferred>0)target.actualCost=inferred;
  }
  if(target.workshop===undefined)target.workshop='';
  if(target.partBrand===undefined)target.partBrand='';
  if(target.partNumber===undefined)target.partNumber='';
  if(target.warrantyMonths===undefined)target.warrantyMonths=0;
  if(target.receiptImage===undefined)target.receiptImage='';
  return target;
}

function warrantyExpiryIso(serviceDate,warrantyMonths){
  const months=Number(warrantyMonths||0);
  if(!serviceDate||!Number.isFinite(months)||months<=0)return '';
  const d=new Date(serviceDate+'T12:00:00');
  if(!Number.isFinite(d.getTime()))return '';
  const day=d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth()+Math.round(months));
  const endOfMonth=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  d.setDate(Math.min(day,endOfMonth));
  return d.toISOString().slice(0,10);
}

function warrantyInfo(record,now=new Date()){
  const expiry=warrantyExpiryIso(record?.date,record?.warrantyMonths);
  if(!expiry)return {active:false,expiry:'',daysRemaining:null,label:'No warranty recorded'};
  const end=new Date(expiry+'T23:59:59');
  const days=Math.ceil((end-now)/86400000);
  if(days<0)return {active:false,expiry,daysRemaining:days,label:'Warranty expired'};
  return {active:true,expiry,daysRemaining:days,label:days===0?'Warranty expires today':`${days} days warranty left`};
}

function serviceEventCost(record){return recordActualCost(record);}

if(typeof module!=='undefined'&&module.exports){module.exports={recordActualCost,migrateServiceFields,warrantyExpiryIso,warrantyInfo,serviceEventCost};}
