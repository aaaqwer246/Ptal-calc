(function(root){
  'use strict';
  const CACHE_KEY='ptal-cache-v1',BUDGET_KEY='ptal-budget-v1';
  function dateKey(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
  class LocalStore{
    constructor(storage){this.storage=storage;this.available=true;this.data={};this.memoryCounts={};try{storage.setItem('ptal-probe','1');storage.removeItem('ptal-probe');storage.removeItem(CACHE_KEY);} catch{this.available=false;}}
    get(key,days){const entry=this.data[key],age=Date.now()-entry?.at;return entry&&age>=0&&age<days*86400000?entry.value:null;}
    put(key,value){
      this.data[key]={at:Date.now(),value};
      const entries=Object.entries(this.data).sort((a,b)=>b[1].at-a[1].at).slice(0,300);
      this.data=Object.fromEntries(entries);
    }

    counts(){
      let data=this.memoryCounts;if(this.available)try{const parsed=JSON.parse(this.storage.getItem(BUDGET_KEY)||'{}');if(parsed&&typeof parsed==='object')data=parsed;}catch{}
      const day=dateKey(),month=day.slice(0,7);
      return {day,month,daily:data.day===day?Number(data.daily)||0:0,monthly:data.month===month?Number(data.monthly)||0:0};
    }
    reserve(){
      const counts=this.counts();
      counts.daily++;counts.monthly++;
      this.memoryCounts=counts;
      try{this.storage.setItem(BUDGET_KEY,JSON.stringify(counts));}catch{this.available=false;}
    }
    clearCache(){this.data={};try{this.storage.removeItem(CACHE_KEY);}catch{}}
  }
  root.PTALStore={LocalStore};
  if(typeof module!=='undefined'&&module.exports)module.exports={LocalStore};
})(globalThis);
