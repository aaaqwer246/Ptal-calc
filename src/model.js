(function (root) {
  'use strict';
  const DEFAULTS = Object.freeze({ speed: 80, busMax: 640, luMax: 960, busReliability: 2, luReliability: 0.75 });
  const BANDS = [[0,'0','无有效服务','#778397'],[2.5,'1a','很低','#973e42'],[5,'1b','很低','#b45340'],[10,'2','较低','#bf782d'],[15,'3','中等','#ac8a30'],[20,'4','良好','#7b903b'],[25,'5','很好','#44834a'],[40,'6a','优秀','#207e67'],[Infinity,'6b','优秀','#12634e']]
    .map(([hi,code,label,color],i,all) => ({hi,code,label,color,range:i===0?'AI = 0':i===8?'AI > 40':`${all[i-1][0]} < AI ≤ ${hi}`}));
  const MODES = { bus:'公交', lu:'地铁' };
  const INACTIVE = /停运|暂停运营|暂停营运|在建|拟建|规划中|未开通/;
  const LIMITS = { speed:[10,200], busMax:[1,5000], luMax:[1,5000], busReliability:[0,30], luReliability:[0,30] };
  function numeric(value) { return value !== null && value !== undefined && !(typeof value==='string'&&!value.trim()) && typeof value !== 'boolean' && (typeof value==='string'||typeof value==='number') && Number.isFinite(Number(value)); }
  function settings(input = {}) {
    const result = {};
    for (const [key,fallback] of Object.entries(DEFAULTS)) {
      const value = input[key] === undefined ? fallback : input[key];
      if (!numeric(value) || Number(value)<LIMITS[key][0] || Number(value)>LIMITS[key][1]) throw new Error(`计算参数 ${key} 超出允许范围`);
      result[key] = Number(value);
    }
    return result;
  }
  function band(ai) {
    if (!Number.isFinite(ai) || ai<0) throw new Error('AI 必须为非负有限数值');
    return BANDS.find(item => ai<=item.hi);
  }
  function canonical(route, mode) {
    let name = String(route || '').normalize('NFKC').replace(/\s+/g,'');
    // 只移除明确的起终点方向，不合并支线、区间、快车等不同服务。
    name = name.replace(/\([^()]*(?:--|—|→|开往|方向)[^()]*\)/g,'');
    if (mode==='lu') name = name.replace(/^(?:地铁|轨道交通)(?=\d+号线)/,'');
    return name;
  }
  function coordinates(value) {
    const lng=Array.isArray(value)?value[0]:value?.lng, lat=Array.isArray(value)?value[1]:value?.lat;
    return numeric(lng) && numeric(lat) && Math.abs(Number(lng))<=180 && Math.abs(Number(lat))<=90 ? [Number(lng),Number(lat)] : null;
  }
  function routeNames(poi) {
    if (typeof poi.address!=='string') return [];
    return poi.address.split(/[;；]/).map(s=>s.trim()).filter(s=>s && !INACTIVE.test(s) &&
      /\d|[一二三四五六七八九十百]+路|线|BRT|接驳|公交|巴士|隧道|大桥/i.test(s) &&
      !/(?:路|街|大道|公路|弄|巷)\s*\d+号|附近|交叉口|[东西南北]侧/.test(s));
  }
  function candidates(pois) {
    const stats={invalid:0,unknownRoutes:0,inactive:0}, result=[], seen=new Set();
    for (const poi of pois) {
      const name=String(poi.name||''), type=String(poi.type||''), code=String(poi.typecode||'');
      if (INACTIVE.test(name)) { stats.inactive++; continue; }
      const bus=/公交车站|公交站/.test(type+name)||code.startsWith('150700');
      const metro=!bus && (/地铁站|轨道交通/.test(type+name)||code.startsWith('150500'));
      const location=coordinates(poi.location);
      if ((!bus&&!metro)||!location) { stats.invalid++; continue; }
      const routes=routeNames(poi);
      if (!routes.length) { stats.unknownRoutes++; continue; }
      const stop=name.replace(/[（(](?:公交站|地铁站)[）)]/g,'').trim()||name;
      const key=`${poi.id||name}|${location.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key); result.push({key,stop,mode:bus?'bus':'lu',location,routes});
    }
    return {candidates:result,stats};
  }
  function calculate(services,input=DEFAULTS) {
    const params=settings(input), best=new Map();
    const rows=services.map((svc,index)=>{
      let reason='';
      if (!Object.hasOwn(MODES,svc.mode)||!canonical(svc.route,svc.mode)) reason='模式或线路无效';
      else if (INACTIVE.test(String(svc.route))||INACTIVE.test(String(svc.stop))) reason='停运 / 未开通';
      else if (svc.enabled===false) reason='已停用';
      else if (!numeric(svc.distance)||Number(svc.distance)<0||Number(svc.distance)>100000) reason=svc.distanceError||'步行距离未取得';
      else if (!numeric(svc.freq)||Number(svc.freq)<=0||Number(svc.freq)>300) reason=Number(svc.freq)===0?'无班次':'班次无效';
      else if (Number(svc.distance)>params[`${svc.mode}Max`]) reason='超过步行上限';
      return {svc,index,reason,walkTime:null,swt:null,awt:null,tat:null,edf:0,weight:0,aiContribution:0};
    });
    for (const row of rows.filter(r=>!r.reason)) {
      const key=`${row.svc.mode}:${canonical(row.svc.route,row.svc.mode)}`, previous=best.get(key);
      if (!previous||Number(row.svc.distance)<Number(previous.svc.distance)||
        (Number(row.svc.distance)===Number(previous.svc.distance)&&Number(row.svc.freq)>Number(previous.svc.freq))) {
        if (previous) previous.reason='同线较远 / 重复接入';
        best.set(key,row);
      } else row.reason='同线较远 / 重复接入';
    }
    const included=rows.filter(r=>!r.reason), byMode={bus:[],lu:[]}, modeAI={bus:0,lu:0};
    for (const r of included) {
      r.walkTime=Number(r.svc.distance)/params.speed;
      r.swt=30/Number(r.svc.freq); r.awt=r.swt+params[`${r.svc.mode}Reliability`];
      r.tat=r.walkTime+r.awt; r.edf=30/r.tat; byMode[r.svc.mode].push(r);
    }
    for (const [mode,list] of Object.entries(byMode)) {
      list.sort((a,b)=>b.edf-a.edf||a.index-b.index).forEach((r,i)=>{
        r.weight=i===0?1:0.5; r.aiContribution=r.edf*r.weight; modeAI[mode]+=r.aiContribution;
      });
    }
    const totalAI=modeAI.bus+modeAI.lu;
    return {totalAI,band:band(totalAI),rows,included,modeAI,byMode};
  }
  function importPlan(data) {
    if (!data||data.version!==1||!Array.isArray(data.services)||data.services.length>10000) throw new Error('方案格式无效：需要 version=1，且线路不超过 10000 项');
    const params=settings(data.params);
    const services=data.services.map((s,i)=>{
      if (!s||!Object.hasOwn(MODES,s.mode)||typeof s.route!=='string'||!s.route.trim()||s.route.length>200||typeof s.stop!=='string'||s.stop.length>200||
        !(s.distance===null||(numeric(s.distance)&&Number(s.distance)>=0&&Number(s.distance)<=100000))||!numeric(s.freq)||Number(s.freq)<0||Number(s.freq)>300) throw new Error(`第 ${i+1} 项线路数据无效`);
      return {id:`import-${i}`,mode:s.mode,route:s.route.trim(),stop:s.stop.trim(),distance:s.distance===null?null:Number(s.distance),freq:Number(s.freq),enabled:s.enabled!==false,
        distanceSource:s.distanceSource==='amap-walking'?'amap-walking':'manual',freqSource:s.freqSource==='default'?'default':'manual',
        location:coordinates(s.location),distanceError:s.distance===null?'步行距离未取得':'',path:[]};
    });
    let location=null;
    if (data.location) {
      const coords=coordinates(data.location.coords);
      if (!coords||typeof data.location.name!=='string'||data.location.name.length>200) throw new Error('分析位置数据无效');
      location={coords,name:data.location.name};
    }
    return {params,services,location,label:typeof data.label==='string'?data.label.slice(0,200):''};
  }
  function csvCell(value) {
    let str=value==null?'':String(value);
    if (/^[\s]*[=+\-@]/.test(str)) str=`'${str}`;
    return `"${str.replace(/"/g,'""')}"`;
  }
  const api={DEFAULTS,BANDS,MODES,settings,band,canonical,coordinates,candidates,calculate,importPlan,csvCell};
  root.PTAL=api;
  if (typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:window);
