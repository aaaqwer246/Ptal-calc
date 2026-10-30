(() => {
  'use strict';
  const $=id=>document.getElementById(id), M=PTAL;
  const state={params:{...M.DEFAULTS},services:[],location:null,assessed:false,busy:false,warnings:[],session:null,scope:null};
  let adapter=null,controller=null,generation=0,lastCalc=M.calculate([]),selectedInput='',manualId=0;
  let adapterPending=null,suggestTimer=null,suggestController=null,suggestGeneration=0,composing=false,placeItems=[],activePlace=-1;
  let storage;try{storage=localStorage;}catch{}
  const store=new PTALStore.LocalStore(storage);
  const API_CONFIG_KEY='ptal-map-config-v1',API_RESUME_KEY='ptal-api-resume-v1';
  let mapConfig={};
  try{const saved=JSON.parse(storage.getItem(API_CONFIG_KEY)||'null');if(saved&&typeof saved==='object'){const key=typeof saved.key==='string'?saved.key.trim():'',securityJsCode=typeof saved.securityJsCode==='string'?saved.securityJsCode.trim():'';if(key||securityJsCode)mapConfig={key,securityJsCode};}}catch{}
  globalThis.PTAL_MAP_CONFIG=mapConfig;
  const text=(id,value)=>{$(id).textContent=value;};
  const element=(tag,value,className)=>{const el=document.createElement(tag);if(value!==undefined)el.textContent=value;if(className)el.className=className;return el;};
  function status(message,error=false){text('search-status',message);$('search-status').classList.toggle('error',error);quota();}
  function quota(){const c=(adapter?.store||store).counts();text('quota-status',`本机查询统计：今日 ${c.daily} 次 · 本月 ${c.monthly} 次。${store.available?'':'查询记录仅保留到关闭页面。'}`);}
  function apiStatus(message,error=false){text('api-settings-status',message);$('api-settings-status').classList.toggle('error',error);}
  function writeApiSettings(){
    $('api-key').value=mapConfig.key||'';$('api-security-code').value=mapConfig.securityJsCode||'';
    apiStatus(mapConfig.key&&mapConfig.securityJsCode?'已使用个人配置；留空可恢复默认服务。':mapConfig.key||mapConfig.securityJsCode?'请补齐个人配置，或清空两项使用默认服务。':'当前使用默认服务，也可填写个人配置。');
  }
  function showApiSettings(open){$('api-settings').hidden=!open;$('api-settings-toggle').setAttribute('aria-expanded',String(open));}
  function applyApiSettings(config){
    const reload=Boolean(adapter||adapterPending||globalThis.AMap||document.querySelector('script[data-ptal-sdk]'));
    try{
      // 已加载的高德 SDK 需要整页重载才能可靠切换凭据，先暂存分析。
      if(reload){cancel();hideChoices();sessionStorage.setItem(API_RESUME_KEY,JSON.stringify({version:1,params:state.params,services:state.services,location:state.location,assessed:state.assessed,warnings:state.warnings,scope:state.scope,query:$('map-input').value}));}
      storage.setItem(API_CONFIG_KEY,JSON.stringify(config));
    }catch{
      try{sessionStorage.removeItem(API_RESUME_KEY);}catch{}
      render();apiStatus('保存失败：浏览器存储不可用或空间不足，原 API 配置保留。请允许本地存储后重试。',true);return;
    }
    mapConfig=config;globalThis.PTAL_MAP_CONFIG=config;writeApiSettings();
    if(reload){apiStatus('已保存，正在刷新并恢复当前分析…');location.reload();return;}
    apiStatus(config.key?'个人配置已保存，下次地图和查询优先使用。':'已恢复默认服务。');
  }
  function setBusy(value){
    state.busy=value;$('cancel-btn').hidden=!value;
    $('search-btn').disabled=value;
    $('force-refresh').disabled=value;
    for(const el of $('settings-form').elements)el.disabled=value;
    for(const el of $('add-form').elements)el.disabled=value;
    $('reset-settings').disabled=value;$('import-btn').disabled=value;$('clear-cache').disabled=value;
    $('export-json').disabled=value||!state.assessed;$('export-csv').disabled=value||!state.assessed;
    $('result-state').textContent=value?'正在查询':resultLabel();
  }
  function cancel(){stopSuggestions();generation++;controller?.abort();controller=null;for(const svc of state.services)if(svc.distance===null&&svc.distanceError==='步行规划中')svc.distanceError='步行规划已取消';setBusy(false);}
  function operation(){cancel();controller=new AbortController();setBusy(true);return {id:generation,signal:controller.signal};}
  function current(op){return op.id===generation&&!op.signal.aborted;}
  function scopeStale(){return state.scope&&(state.params.busMax>state.scope.busMax||state.params.luMax>state.scope.luMax);}
  function resultLabel(){return !state.assessed?(state.warnings.length?'查询失败':'待分析'):scopeStale()?'范围待更新':state.warnings.length||state.services.some(s=>s.distance===null)?'数据未补全':state.services.some(s=>s.freqSource==='default')?'默认班次估算':'已计算 · 人工校核数据';}
  function locationLabel(){text('location-label',state.location?`${state.location.name} · ${state.location.coords.map(n=>n.toFixed(6)).join(', ')}`:'手动分析 / 尚未选择位置');}
  function selectLocation(coords,name){
    cancel();state.location={coords:coords.map(n=>Number(n.toFixed(6))),name:String(name).slice(0,200)};
    selectedInput=state.location.name;$('map-input').value=selectedInput;
    state.services=[];state.assessed=false;state.warnings=[];state.session=null;state.scope=null;
    hideChoices();adapter?.locate(state.location.coords,state.location.name,state.params);
    locationLabel();render();status('已选点，点击「搜索分析」后查询；选点本身不请求站点和步行接口。');
    text('candidate-summary','尚未检索候选站点');
  }
  function writeSettings(){for(const [key,value]of Object.entries(state.params))$('settings-form').elements.namedItem(key).value=value;}
  function scopeNote(){
    const stale=scopeStale();
    text('settings-note',stale?'步行范围已扩大，当前候选站点尚未补充，请重新点击「搜索分析」。':'参数修改后立即重算，不重新查询；扩大范围后需重新搜索，以补充范围内站点。');
  }
  function render(){
    lastCalc=M.calculate(state.services,state.params);const calc=lastCalc,b=calc.band;
    const hasScore=state.assessed&&(calc.included.length>0||(!state.warnings.length&&!state.services.some(s=>s.distance===null)));
    text('ai-value',hasScore?calc.totalAI.toFixed(2):'—');text('band-code',hasScore?b.code:'—');text('band-desc',hasScore?b.label:'等待有效数据');
    $('band-disc').style.borderColor=hasScore?b.color:'#bdcbdc';
    text('band-range',hasScore?`${b.range} · 按未舍入指数判定`:'等级按未舍入指数判定，显示值保留两位小数。');
    text('bus-count',calc.byMode.bus.length);text('rail-count',calc.byMode.lu.length);text('excluded-count',calc.rows.length-calc.included.length);
    text('bus-ai',calc.modeAI.bus.toFixed(2));text('rail-ai',calc.modeAI.lu.toFixed(2));
    $('scale-legend').replaceChildren(...M.BANDS.map(item=>{const el=element('div',item.code,'scale-seg'+(hasScore&&item.code===b.code?' active':''));el.style.background=item.color;el.title=`${item.code} · ${item.range}`;return el;}));
    const notes=[];
    if(scopeStale())notes.push('步行范围已扩大，候选站点需重新检索，当前结果可能低估。');
    if(state.services.some(s=>s.freqSource==='default'))notes.push('使用默认班次（公交4 / 地铁12辆每小时），需按统一时段校核。');
    if(state.services.some(s=>s.distanceSource==='amap-walking'))notes.push('距离取自高德步行路线；可重新查询以核实当前路径。');
    if(state.services.some(s=>s.distanceSource==='manual'))notes.push('含手工录入步行距离。');
    notes.push(...state.warnings);
    text('quality-note',notes.join(' ')||'请使用实际步行距离及目标时段单向班次。未分析时不显示零等级。');
    $('result-state').classList.toggle('warning',Boolean(state.warnings.length||scopeStale()));
    scopeNote();renderTable();setBusy(state.busy);quota();
  }
  function renderTable(){
    const fragment=document.createDocumentFragment(),filter=$('service-filter').value.trim().toLowerCase(),showExcluded=$('show-excluded').checked;
    const rows=lastCalc.rows.filter(r=>(showExcluded||!r.reason)&&`${r.svc.route} ${r.svc.stop}`.toLowerCase().includes(filter));
    text('row-count',`${rows.length} / ${lastCalc.rows.length} 项`);
    if(!rows.length){const tr=element('tr'),td=element('td',state.services.length?'没有符合筛选条件的线路。':'搜索地点，或手动添加一条线路开始分析。','empty');td.colSpan=12;tr.append(td);fragment.append(tr);}
    for(const r of rows){
      const s=r.svc,tr=element('tr',undefined,r.reason?'excluded':'');tr.dataset.id=s.id;
      const cell=value=>{const td=element('td',value);tr.append(td);return td;};
      const toggle=element('input');toggle.type='checkbox';toggle.checked=s.enabled!==false;toggle.dataset.field='enabled';toggle.setAttribute('aria-label',`启用 ${s.route}`);cell().append(toggle);
      cell().append(element('span',s.route,'route-name'),element('span',M.MODES[s.mode],`mode-tag ${s.mode}`));cell(s.stop);
      for(const field of ['distance','freq']){
        const input=element('input');input.type='number';input.min='0';input.max=field==='freq'?'300':'100000';input.step='any';input.value=s[field]??'';input.dataset.field=field;input.setAttribute('aria-label',`${s.route} ${field==='freq'?'每小时班次':'实际步行距离'}`);
        const source=field==='freq'?(s.freqSource==='default'?'假设班次':'人工校核'):(s.distance===null?'距离未取得':s.distanceSource==='amap-walking'?'高德步行':'手动步行');
        cell().append(input,element('small',source,'source'));
      }
      const fmt=value=>value===null?'—':value.toFixed(2);
      cell(fmt(r.walkTime));cell(`${fmt(r.swt)} / ${fmt(r.awt)}`);cell(fmt(r.tat));cell(r.reason?'—':fmt(r.edf));cell(r.reason?'—':r.weight.toFixed(1));cell(r.reason?'—':fmt(r.aiContribution)).className='contribution';
      const actions=element('div',undefined,'row-actions');
      if(s.path?.length){const path=element('button','路径','text-btn');path.type='button';path.dataset.action='path';actions.append(path);}
      const remove=element('button','移除','text-btn delete-btn');remove.type='button';remove.dataset.action='remove';remove.setAttribute('aria-label',`移除 ${s.route}`);actions.append(remove);
      const td=cell();td.append(element('div',r.reason||'计入','reason'),actions);
      if(state.busy)for(const el of tr.querySelectorAll('input,button'))el.disabled=true;
      fragment.append(tr);
    }
    $('breakdown-body').replaceChildren(fragment);
  }
  function buildServices(session){
    const previous=new Map(state.services.map(s=>[s.id,s])),all=[];
    for(const c of session.candidates){
      const measurement=session.measured.get(c.key);
      c.routes.forEach((route,i)=>{
        const id=`auto:${c.key}:${i}`,old=previous.get(id);
        if(session.removed?.has(id))return;
        const base={id,automatic:true,mode:c.mode,route,stop:c.stop,location:c.location,enabled:true,distance:measurement?.distance??null,distanceSource:'amap-walking',distanceError:measurement?.distanceError||(!measurement&&state.busy?'步行规划中':'步行距离未取得'),freq:c.mode==='bus'?4:12,freqSource:'default',path:measurement?.path||[]};
        if(old){base.enabled=old.enabled;base.freq=old.freq;base.freqSource=old.freqSource;if(old.distanceSource==='manual'){base.distance=old.distance;base.distanceSource='manual';base.distanceError='';base.path=[];}}
        all.push(base);
      });
    }
    all.push(...state.services.filter(s=>!s.automatic));state.services=all;
  }
  async function measure(session,op){
    const result=await adapter.measure(session.candidates,state.location.coords,op.signal,message=>{if(current(op))status(message);},session.measured);
    if(!current(op))return;
    session.measured=result.measured;
    state.warnings=[...session.warnings];
    const failed=Array.from(result.measured.values()).filter(v=>v.distance===null).length;
    if(failed)state.warnings.push(`${failed} 个接入点步行规划失败；未使用直线距离替代。`);
    buildServices(session);state.assessed=true;
    status(`已计算 ${M.calculate(state.services,state.params).included.length} 条独立线路；全部候选接入点已处理，本次新增 ${result.attempts} 次步行请求。${state.warnings.length?' 有未计入或失败项，请查看数据说明。':''}`,failed>0);
  }
  async function analyze(){
    if(!adapter||!state.location)return;
    const op=operation();state.assessed=false;state.services=[];state.warnings=[];state.session=null;render();
    text('candidate-summary','正在检索候选站点…');
    adapter.refresh=$('force-refresh').checked;
    try{
      adapter.locate(state.location.coords,state.location.name,state.params);
      const response=await adapter.nearby(state.location.coords,state.params,op.signal,message=>{if(current(op))status(message);});
      if(!current(op))return;
      const parsed=M.candidates(response.pois),warnings=[...response.warnings];
      const bus=parsed.candidates.filter(c=>c.mode==='bus').length,rail=parsed.candidates.filter(c=>c.mode==='lu').length;
      text('candidate-summary',`原始站点 ${response.pois.length} 个 → 公交候选 ${bus} 个 · 地铁 / 出入口候选 ${rail} 个${response.cached?'（复用站点缓存）':''}`);
      if(parsed.stats.unknownRoutes)warnings.push(`${parsed.stats.unknownRoutes} 个站点缺少可确认线路，未计入。`);
      if(parsed.stats.inactive)warnings.push(`已排除 ${parsed.stats.inactive} 个停运 / 未开通站点。`);
      if(parsed.stats.invalid)warnings.push(`${parsed.stats.invalid} 个候选点无有效站点类型或坐标。`);
      if(!parsed.candidates.length){
        state.warnings=warnings;
        if(response.warnings.length){text('candidate-summary','未取得候选站点：接口请求失败');status(`候选检索失败：${response.warnings.join('；')}`,true);}
        else if(response.pois.length){status(`返回 ${response.pois.length} 个站点，但未取得有效线路 / 坐标，请查看数据说明。`,true);}
        else{state.assessed=true;status('站点检索成功，但当前范围内没有返回公交或地铁候选站点。');}
        return;
      }
      const session={candidates:parsed.candidates,measured:new Map(),warnings};state.session=session;state.scope={...state.params};
      buildServices(session);render();
      await measure(session,op);
    }catch(error){if(current(op)&&error.name!=='AbortError'){state.warnings=[error.message];status(error.message,true);}}
    finally{if(current(op)){setBusy(false);render();}}
  }
  async function ensureAdapter(){
    if(adapter)return adapter;
    if(!adapterPending)adapterPending=PTALMap.Adapter.connect(mapConfig,store).then(value=>{adapter=value;text('map-state',`${value.source==='personal'?'个人配置':'默认服务'} · 底图按需加载`);return value;}).finally(()=>{adapterPending=null;});
    return adapterPending;
  }
  function stopSuggestions(){clearTimeout(suggestTimer);suggestTimer=null;suggestGeneration++;suggestController?.abort();suggestController=null;}
  function hideChoices(){placeItems=[];activePlace=-1;$('place-choices').hidden=true;$('map-input').setAttribute('aria-expanded','false');$('map-input').removeAttribute('aria-activedescendant');text('place-status','');}
  function showChoices(items){
    placeItems=items;activePlace=-1;
    $('place-choices').replaceChildren(...items.map((p,i)=>{
      const address=typeof p.address==='string'?p.address:'';
      const btn=element('button',`${p.name} · ${p.district||p.cityname||p.adname||''} ${address}`);btn.type='button';btn.id=`place-option-${i}`;btn.setAttribute('role','option');btn.setAttribute('aria-selected','false');btn.addEventListener('click',()=>choosePlace(p));return btn;
    }));
    $('place-choices').hidden=!items.length;$('map-input').setAttribute('aria-expanded',String(Boolean(items.length)));text('place-status',items.length?`${items.length} 个地点候选 · 可输入具体门 / 出入口名称，↑↓选择、Enter确认。`:'未找到地点候选，可补充场所全名、道路或城市。');
  }
  async function choosePlace(poi){
    stopSuggestions();hideChoices();const op=operation();
    try{
      await ensureAdapter();if(!current(op))return;
      const results=await adapter.resolveTip(poi,op.signal);if(!current(op))return;
      if(results.length===1){selectLocation(M.coordinates(results[0].location),results[0].name||poi.name);await analyze();}
      else{showChoices(results);status(results.length?'请选择具体入口或地点。':'该候选没有可用坐标，请补充具体入口名称或地图选点。',!results.length);}
    }catch(error){if(current(op)&&error.name!=='AbortError')status(error.message,true);}
    finally{if(current(op))setBusy(false);}
  }
  function scheduleSuggestions(){
    stopSuggestions();hideChoices();const value=$('map-input').value.trim();
    if(!value||composing||/^[-+\d.]+\s*[,，]\s*[-+\d.]+$/.test(value))return;
    const id=suggestGeneration;text('place-status','输入停顿400毫秒后更新地点候选…');
    suggestTimer=setTimeout(async()=>{
      suggestController=new AbortController();const signal=suggestController.signal;
      try{
        await ensureAdapter();if(id!==suggestGeneration||signal.aborted)return;
        const tips=await adapter.suggest(value,signal);if(id!==suggestGeneration||signal.aborted||$('map-input').value.trim()!==value)return;
        showChoices(tips);quota();
      }catch(error){if(id===suggestGeneration&&error.name!=='AbortError'){text('place-status',`地点联想失败：${error.message}`);quota();}}
    },400);
  }
  $('search-form').addEventListener('submit',async event=>{
    event.preventDefault();if(state.busy||composing)return;
    const value=$('map-input').value.trim();if(!value)return;
    const op=operation();hideChoices();status('正在查找具体地点…');
    try{
      await ensureAdapter();if(!current(op))return;
      adapter.refresh=$('force-refresh').checked;
      if(state.location&&value===selectedInput){await analyze();return;}
      const parts=value.split(/[,，]/);
      if(parts.length===2&&parts.every(p=>p.trim()!==''&&Number.isFinite(Number(p)))){
        const coords=M.coordinates(parts.map(Number));if(!coords){status('经纬度超出有效范围',true);return;}selectLocation(coords,'坐标选点');await analyze();return;
      }
      let pois=await adapter.suggest(value,op.signal);if(!current(op))return;
      if(!pois.length)pois=await adapter.search(value,op.signal);if(!current(op))return;
      showChoices(pois);status(pois.length?'请选择搜索结果中的具体地点或入口，再分析周边交通。':'没有找到有效地点，请补充城市、场所全名或输入高德坐标。',!pois.length);
    }catch(error){if(current(op)&&error.name!=='AbortError')status(error.message,true);}
    finally{if(current(op))setBusy(false);}
  });
  $('cancel-btn').addEventListener('click',()=>{cancel();render();status('已取消；已发出的请求仍可能计费，迟到结果不会覆盖当前分析。');});
  $('map-input').addEventListener('compositionstart',()=>{composing=true;stopSuggestions();hideChoices();});
  $('map-input').addEventListener('compositionend',()=>{composing=false;scheduleSuggestions();});
  $('map-input').addEventListener('input',event=>{if(state.busy){cancel();render();status('输入已改变，旧查询已取消。');}if(!event.isComposing&&!composing)scheduleSuggestions();});
  $('map-input').addEventListener('keydown',event=>{
    if(composing||event.isComposing)return;
    if(event.key==='Escape'){stopSuggestions();hideChoices();event.preventDefault();return;}
    if(!placeItems.length||$('place-choices').hidden)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();activePlace=activePlace<0?(event.key==='ArrowDown'?0:placeItems.length-1):(activePlace+(event.key==='ArrowDown'?1:-1)+placeItems.length)%placeItems.length;
      const buttons=$('place-choices').querySelectorAll('button');buttons.forEach((btn,i)=>{btn.setAttribute('aria-selected',String(i===activePlace));btn.classList.toggle('selected',i===activePlace);});
      $('map-input').setAttribute('aria-activedescendant',buttons[activePlace].id);buttons[activePlace].scrollIntoView({block:'nearest'});
    }else if(event.key==='Enter'&&activePlace>=0){event.preventDefault();choosePlace(placeItems[activePlace]);}
  });
  $('clear-all').addEventListener('click',()=>{cancel();Object.assign(state,{services:[],location:null,assessed:false,warnings:[],session:null,scope:null});selectedInput='';$('map-input').value='';hideChoices();adapter?.clear();locationLabel();render();text('candidate-summary','尚未检索候选站点');status('分析已清空；保留本机缓存和调用计数。');});
  $('settings-form').addEventListener('submit',e=>e.preventDefault());
  $('settings-form').addEventListener('input',()=>{if(!$('settings-form').checkValidity()){status('请输入范围内的计算参数，当前保留上次有效结果。',true);return;}state.params=M.settings(Object.fromEntries(new FormData($('settings-form'))));adapter?.updateBounds(state.params);render();status('参数已更新，已用现有距离重算；没有新增查询。');});
  $('reset-settings').addEventListener('click',()=>{state.params={...M.DEFAULTS};writeSettings();adapter?.updateBounds(state.params);render();status('已恢复 TfL 默认计算参数；没有新增查询。');});
  $('add-form').elements.namedItem('mode').addEventListener('change',()=>{$('add-form').elements.namedItem('freq').value=$('add-form').elements.namedItem('mode').value==='bus'?4:12;});
  $('add-form').addEventListener('submit',event=>{
    event.preventDefault();if(state.busy||!$('add-form').reportValidity())return;
    const data=Object.fromEntries(new FormData($('add-form')));if(!data.route.trim()||!data.stop.trim()){status('线路和站点名称不能为空。',true);return;}
    state.services.push({id:`manual-${++manualId}`,mode:data.mode,route:data.route.trim(),stop:data.stop.trim(),distance:Number(data.distance),freq:Number(data.freq),distanceSource:'manual',freqSource:'manual',enabled:true,path:[]});state.assessed=true;render();status('已添加并重算；没有新增查询。');
  });
  $('service-filter').addEventListener('input',renderTable);$('show-excluded').addEventListener('change',renderTable);
  $('breakdown-body').addEventListener('change',event=>{
    const input=event.target,field=input.dataset.field;if(!field||state.busy)return;
    const svc=state.services.find(s=>s.id===input.closest('tr').dataset.id);if(!svc)return;
    if(field==='enabled')svc.enabled=input.checked;
    else{if(input.value===''||!input.reportValidity()){status('请输入有效的非负数值；当前保留原结果。',true);return;}svc[field]=Number(input.value);if(field==='freq')svc.freqSource='manual';else{svc.distanceSource='manual';svc.distanceError='';svc.path=[];adapter?.clearPath();}}
    render();status('线路数据已更新并重算；没有新增查询。');
  });
  $('breakdown-body').addEventListener('click',async event=>{
    const btn=event.target.closest('button[data-action]');if(!btn||state.busy)return;
    const svc=state.services.find(s=>s.id===btn.closest('tr').dataset.id);if(!svc)return;
    if(btn.dataset.action==='remove'){state.services=state.services.filter(s=>s!==svc);if(svc.automatic&&state.session){state.session.removed??=new Set();state.session.removed.add(svc.id);}render();status('已移除线路并重算；没有新增查询。');}
    else{if(!adapter?.map)await enableMap();if(adapter?.showPath(svc)){$('map-container').scrollIntoView({behavior:'smooth',block:'center'});status(`${svc.route} · ${svc.stop}：高德步行距离 ${svc.distance} 米，显示缓存路径，没有新增查询。`);}}
  });
  function download(content,type,name){const url=URL.createObjectURL(new Blob([content],{type})),a=element('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('export-json').addEventListener('click',()=>{
    const services=state.services.map(({mode,route,stop,distance,freq,enabled,distanceSource,freqSource,location})=>({mode,route,stop,distance,freq,enabled,distanceSource,freqSource,location}));
    download(JSON.stringify({version:1,label:state.location?.name||'手动分析',location:state.location,params:state.params,services,warnings:[...state.warnings,...(scopeStale()?['步行范围已扩大，候选站点未重新检索，可能低估。']:[])],exportedAt:new Date().toISOString()},null,2),'application/json','PTAL方案.json');
  });
  $('export-csv').addEventListener('click',()=>{
    const matrix=[['模式','线路','站点','步行距离(m)','距离来源','单向班次(vph)','班次来源','步行(min)','SWT(min)','AWT(min)','TAT(min)','EDF','权重','AI贡献','状态'],...lastCalc.rows.map(r=>[M.MODES[r.svc.mode],r.svc.route,r.svc.stop,r.svc.distance,r.svc.distanceSource,r.svc.freq,r.svc.freqSource,r.walkTime,r.swt,r.awt,r.tat,r.reason?'':r.edf,r.weight,r.aiContribution,r.reason||'计入'])];
    matrix.push([],['分析位置',state.location?.name||'手动分析'],['总AI',$('ai-value').textContent==='—'?'':lastCalc.totalAI],['PTAL',$('band-code').textContent==='—'?'':lastCalc.band.code],['完整性',[...state.warnings,...(scopeStale()?['步行范围已扩大，候选站点未重新检索，可能低估。']:[])].join('；')||'当前录入数据已处理'],...Object.entries(state.params));
    download('\ufeff'+matrix.map(row=>row.map(M.csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8','PTAL计算明细.csv');
  });
  $('import-btn').addEventListener('click',()=>$('import-file').click());
  $('import-file').addEventListener('change',async()=>{
    const file=$('import-file').files[0];if(!file)return;
    try{if(file.size>2*1024*1024)throw new Error('方案文件不能超过 2 MiB');const raw=JSON.parse(await file.text()),plan=M.importPlan(raw);cancel();Object.assign(state,plan,{assessed:true,session:null,scope:null,warnings:['导入方案：仅校核已录入数据，未重新查询地图或验证来源。',...(Array.isArray(raw.warnings)?raw.warnings.filter(s=>typeof s==='string').slice(0,20).map(s=>s.slice(0,300)):[])]});selectedInput=state.location?.name||'';$('map-input').value=selectedInput;hideChoices();writeSettings();locationLabel();if(state.location)adapter?.locate(state.location.coords,state.location.name,state.params);else adapter?.clear();render();status(`已导入 ${plan.services.length} 项线路；没有新增查询。`);}catch(error){status(`导入失败：${error.message}，原方案保留。`,true);}finally{$('import-file').value='';}
  });
  $('clear-cache').addEventListener('click',()=>{(adapter?.store||store).clearCache();status('路线和站点缓存已清除；调用计数保留，下次查询会消耗额度。');});
  $('api-settings-toggle').addEventListener('click',()=>{const open=$('api-settings').hidden;showApiSettings(open);if(open)$('api-key').focus();});
  $('api-show-secrets').addEventListener('change',()=>{for(const id of ['api-key','api-security-code'])$(id).type=$('api-show-secrets').checked?'text':'password';});
  $('api-settings-form').addEventListener('submit',event=>{
    event.preventDefault();if(!$('api-settings-form').reportValidity())return;
    const config={key:$('api-key').value.trim(),securityJsCode:$('api-security-code').value.trim()};
    if(Boolean(config.key)!==Boolean(config.securityJsCode)||/\s/.test(config.key+config.securityJsCode)){apiStatus('Key 和安全密钥需同时填写，或同时清空使用默认服务；不能包含空白字符。',true);return;}
    applyApiSettings(config.key?config:{});
  });
  async function enableMap(){
    const btn=$('enable-map');btn.disabled=true;text('map-state','正在启用地图');
    try{await ensureAdapter();await adapter.attachMap(selectLocation);text('map-state','高德地图 · 按需查询');if(state.location)adapter.locate(state.location.coords,state.location.name,state.params);render();status('地图已启用；输入可联想具体门和出入口，点击地图只选点。');}
    catch(error){text('map-state','地图不可用');btn.disabled=false;if(!btn.isConnected){const placeholder=element('div',undefined,'map-placeholder');placeholder.append(element('div','地图暂不可用，可重试；手工计算仍可使用。'),btn);$('map-container').replaceChildren(placeholder);}status(error.message,true);}
  }
  $('enable-map').addEventListener('click',enableMap);
  writeApiSettings();
  let resume;try{resume=sessionStorage.getItem(API_RESUME_KEY);if(resume)sessionStorage.removeItem(API_RESUME_KEY);}catch{}
  if(resume)try{
      const saved=JSON.parse(resume),plan=M.importPlan(saved);
      plan.services.forEach((svc,i)=>{const path=saved.services[i].path;if(Array.isArray(path)&&path.length<=100000&&path.every(point=>M.coordinates(point)))svc.path=path.map(point=>M.coordinates(point));});
      Object.assign(state,plan,{assessed:saved.assessed===true,warnings:Array.isArray(saved.warnings)?saved.warnings.filter(item=>typeof item==='string').slice(0,100):[],scope:saved.scope&&Number.isFinite(saved.scope.busMax)&&Number.isFinite(saved.scope.luMax)?saved.scope:null});
      selectedInput=state.location?.name||'';$('map-input').value=typeof saved.query==='string'?saved.query.slice(0,200):selectedInput;writeSettings();
      status('个人设置已更新，当前分析已恢复。');showApiSettings(true);apiStatus('设置已保存，当前分析已恢复。');
  }catch{status('未能恢复上次分析；可在「个人设置」中查看已保存的配置。',true);}
  locationLabel();render();
})();
