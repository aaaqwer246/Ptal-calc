(function (root) {
  'use strict';
  const cancelled = () => new DOMException('查询已取消', 'AbortError');
  function check(signal) { if (signal?.aborted) throw cancelled(); }
  function delay(ms, signal) {
    return new Promise((resolve,reject)=>{
      check(signal);
      const end=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      const abort=()=>{end();reject(cancelled());};
      const timer=setTimeout(()=>{end();resolve();},ms);
      signal?.addEventListener('abort',abort,{once:true});
    });
  }
  // SDK 没有通用取消方法：终止等待并丢弃迟到回调，不再启动后续请求。
  function request(invoke,signal,timeout=15000) {
    return new Promise((resolve,reject)=>{
      check(signal); let done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>finish(cancelled());
      const timer=setTimeout(()=>finish(new Error('高德接口超时，请重试')),timeout);
      signal?.addEventListener('abort',abort,{once:true});
      try { const pending=invoke((status,result)=>{
        if (status==='complete') finish(null,result);
        else if (status==='no_data') finish(null,null);
        else {
          const info=typeof result==='string'?result:result?.info;
          const code=/^[A-Z0-9_]{2,80}$/.test(info||'')?`（${info}）`:'';
          const detail={INVALID_USER_DOMAIN:'当前页面域名不在高德 Web端 Key 白名单中，请在高德控制台调整域名配置后重试',INVALID_USER_KEY:'高德 Key 无效，请在「个人设置」中核对',USERKEY_PLAT_NOMATCH:'Key 平台类型不匹配，请使用 Web端 Key',INVALID_USER_SCODE:'高德安全密钥校验失败，请在「个人设置」中核对配套安全密钥'}[info];
          finish(new Error(detail?`${detail}${code}`:`高德接口请求失败${code}`));
        }
      }); pending?.catch(error=>finish(error)); } catch { finish(new Error('高德插件调用失败，请检查网络或 Key 权限')); }
    });
  }
  function personal(config){
    const key=typeof config?.key==='string'?config.key.trim():'',securityJsCode=typeof config?.securityJsCode==='string'?config.securityJsCode.trim():'';
    if(Boolean(key)!==Boolean(securityJsCode))throw new Error('个人 Key 和安全密钥需同时填写，或同时清空后使用默认服务');
    return key?{key,securityJsCode}:null;
  }
  async function load(config,business=false) {
    if (root.AMap?.Map&&(!business||(root.AMap.AutoComplete&&root.AMap.PlaceSearch&&root.AMap.Walking))) return root.AMap;
    let selected=personal(config);
    const base=root.PTAL_DEPLOYMENT?.workerUrl;
    if(!selected&&base)selected=await root.PTALWorker.services(base).mapConfig();
    if(!selected?.key)throw new Error('默认地图暂不可用，可稍后重试或填写个人配置');
    if(selected.serviceHost){
      const host=new URL(selected.serviceHost);
      if(host.origin!==new URL(base).origin||host.pathname!=='/_AMapService'||host.search||host.hash||host.username||host.password)throw new Error('地图服务暂不可用，请稍后重试');
      root._AMapSecurityConfig={serviceHost:host.href};
    }else{
      if(!selected.securityJsCode)throw new Error('地图安全配置不完整');
      root._AMapSecurityConfig={securityJsCode:selected.securityJsCode};
    }
    await new Promise((resolve,reject)=>{
      const script=document.createElement('script'); let finished=false;
      const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);root.__ptalMapReady=()=>{};error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(new Error('地图加载超时，请检查网络后刷新；手动计算仍可使用')),15000);
      root.__ptalMapReady=()=>finish();
      const url=new URL('https://webapi.amap.com/maps');
      url.search=new URLSearchParams({v:'2.0',key:selected.key,callback:'__ptalMapReady'}).toString();
      if(business)url.searchParams.set('plugin','AMap.AutoComplete,AMap.PlaceSearch,AMap.Walking');
      script.dataset.ptalSdk='';script.src=url.toString();script.onerror=()=>finish(new Error('地图脚本加载失败，请检查网络后刷新'));document.head.append(script);
    });
    if (!root.AMap?.Map) throw new Error('地图搜索插件未就绪，请刷新后重试');
    if(business&&(!root.AMap.AutoComplete||!root.AMap.PlaceSearch||!root.AMap.Walking))throw new Error('个人 Key 的搜索与步行插件未就绪，请核对配置后重试');
    return root.AMap;
  }
  class Adapter {
    constructor(A,map,store) { this.A=A;this.map=map;this.store=store;this.overlays=[];this.routeLine=null;this.nextWalkingAt=0;this.callsIssued=0;this.refresh=false; }
    static async create(config,onSelect,store) {
      const adapter=await Adapter.connect(config,store);
      await adapter.attachMap(onSelect);return adapter;
    }
    static async connect(config,store){
      const own=personal(config);
      if(own){
        const adapter=new Adapter(await load(own,true),null,store);
        adapter.config=own;adapter.pageSize=50;adapter.source='personal';return adapter;
      }
      const base=root.PTAL_DEPLOYMENT?.workerUrl;
      if(!base)throw new Error('默认查询服务暂不可用，可稍后重试或填写个人配置');
      const adapter=new Adapter(root.PTALWorker.services(base,store),null,store);
      adapter.config={};adapter.pageSize=25;adapter.source='cloudflare';return adapter;
    }
    async attachMap(onSelect){
      if(this.map)return;
      if(this.config){const A=await load(this.config);this.A={...this.A,Map:A.Map,Marker:A.Marker,Circle:A.Circle,Polyline:A.Polyline};}
      document.getElementById('map-container').replaceChildren();
      const map=new this.A.Map('map-container',{zoom:15,center:[121.4737,31.2304],resizeEnable:true});
      this.map=map;
      map.on('click',e=>onSelect([e.lnglat.getLng(),e.lnglat.getLat()],'地图选点'));
    }
    call(invoke,signal) {check(signal);this.store.reserve();this.callsIssued++;return request(invoke,signal);}
    walkKey(origin,destination) {return `walk:${origin.join(',')}>${destination.join(',')}`;}
    cached(key,days){return this.refresh?null:this.store.get(key,days);}
    clear() { if(this.overlays.length)this.map?.remove(this.overlays);this.overlays=[];this.clearPath(); }
    clearPath() { if(this.routeLine)this.map?.remove(this.routeLine);this.routeLine=null; }
    locate(coords,name,params) {
      if(!this.map)return;
      this.clear();
      this.overlays.push(new this.A.Marker({position:coords,title:name}));
      for(const [mode,color] of [['lu','#17468c'],['bus','#c84139']]) this.overlays.push(new this.A.Circle({center:coords,radius:params[`${mode}Max`],strokeColor:color,strokeOpacity:0.6,strokeWeight:1,fillColor:color,fillOpacity:0.045}));
      this.map.add(this.overlays);this.map.setCenter(coords);
    }
    updateBounds(params){this.overlays[1]?.setRadius?.(params.luMax);this.overlays[2]?.setRadius?.(params.busMax);}
    async suggest(text,signal){
      const key=`tips:${text.trim()}`,cached=this.store.get(key,1);if(cached)return cached;
      const autocomplete=new this.A.AutoComplete({city:'上海',citylimit:false});
      const result=await this.call(cb=>autocomplete.search(text,cb,signal),signal);
      const tips=(result?.tips||[]).filter(t=>typeof t.name==='string'&&t.name.trim()).map(t=>({id:typeof t.id==='string'?t.id:'',name:t.name,district:typeof t.district==='string'?t.district:'',address:typeof t.address==='string'?t.address:'',adcode:typeof t.adcode==='string'?t.adcode:'',location:PTAL.coordinates(t.location)}));
      if(tips.length)this.store.put(key,tips);return tips;
    }
    async resolveTip(tip,signal){
      if(PTAL.coordinates(tip.location))return [tip];
      if(tip.id){
        const key=`detail:${tip.id}`,cached=this.store.get(key,30);if(cached)return cached;
        const searcher=new this.A.PlaceSearch({extensions:'base'});
        const result=await this.call(cb=>searcher.getDetails(tip.id,cb,signal),signal);
        const pois=(result?.poiList?.pois||[]).filter(p=>PTAL.coordinates(p.location)).map(p=>({...p,location:PTAL.coordinates(p.location)}));
        if(pois.length){this.store.put(key,pois);return pois;}
      }
      return this.search(tip.name,signal,tip.adcode||'上海');
    }
    async search(text,signal,city='上海') {
      const key=`place-v2:${city}:${text.trim()}`,cached=this.cached(key,30);if(cached)return cached;
      const searcher=new this.A.PlaceSearch({pageSize:8,city,citylimit:false,extensions:'base'});
      const result=await this.call(cb=>searcher.search(text,cb,signal),signal);
      const pois=(result?.poiList?.pois||[]).filter(p=>PTAL.coordinates(p.location)).map(p=>({...p,location:PTAL.coordinates(p.location)}));
      this.store.put(key,pois);return pois;
    }
    async nearby(coords,params,signal,progress) {
      const key=`nearby-full:${coords.join(',')}:${params.busMax}:${params.luMax}`,cached=this.cached(key,1);
      if(cached?.pois?.length)return {...cached,cached:true};
      const pois=[],warnings=[],pageSize=this.pageSize||50;
      // 公交和地铁分别完整分页，缓存减少重复查询，不截断结果来节省调用。
      for(const [mode,type] of [['bus','150700'],['lu','150500']]) {
        const radius=params[`${mode}Max`], seen=new Set();
        const searcher=new this.A.PlaceSearch({type,radius,pageSize,extensions:'all'});
        try {
          for(let page=1;page<=100;page++) {
            check(signal); progress(`正在检索${PTAL.MODES[mode]}候选站点 · 第 ${page} 页`);
            searcher.setPageIndex(page);
            const result=await this.call(cb=>searcher.searchNearBy('',coords,radius,cb,signal),signal);
            const list=result?.poiList?.pois||[];
            if(!list.length)break;
            let added=0;
            for(const p of list) { const key=p.id||`${p.name}:${PTAL.coordinates(p.location)}`;if(!seen.has(key)){seen.add(key);pois.push({...p,location:PTAL.coordinates(p.location)});added++;} }
            const count=Number(result?.poiList?.count);
            if(!added) {warnings.push(`${PTAL.MODES[mode]}分页返回重复数据，检索可能不完整`);break;}
            if(list.length<pageSize||(Number.isFinite(count)&&count>0&&count<=page*pageSize))break;
            if(page===100)warnings.push(`${PTAL.MODES[mode]}达到高德分页接口上限，结果可能不完整`);
          }
        } catch(error) { if(error.name==='AbortError')throw error;warnings.push(`${PTAL.MODES[mode]}检索失败：${error.message}`); }
      }
      const value={pois,warnings};
      if(!warnings.length&&pois.length)this.store.put(key,value);
      return value;
    }
    async walking(origin,destination,signal) {
      check(signal);
      const key=this.walkKey(origin,destination),cached=this.cached(key,7);
      if(cached)return cached;
      // 全局启动间隔600ms；失败不自动重试，避免重复扣额。
      const start=Math.max(Date.now(),this.nextWalkingAt);this.nextWalkingAt=start+600;
      await delay(Math.max(0,start-Date.now()),signal);
      const walker=new this.A.Walking({hideMarkers:true});
      // JS 插件的第4参是内部地点结果；仅默认服务接收取消信号。
      const result=await this.call(cb=>this.source==='cloudflare'?walker.search(origin,destination,cb,signal):walker.search(origin,destination,cb),signal);
      const routes=(result?.routes||[]).filter(r=>r.distance!==null&&r.distance!==''&&Number.isFinite(Number(r.distance))&&Number(r.distance)>=0);
      if(!routes.length)throw new Error('未取得可用步行路线');
      const route=routes.reduce((a,b)=>Number(a.distance)<=Number(b.distance)?a:b);
      const value={distance:Number(route.distance),path:(route.steps||[]).flatMap(step=>step.path||[]).map(p=>PTAL.coordinates(p)).filter(Boolean)};
      this.store.put(key,value);
      return value;
    }

    async measure(candidates,origin,signal,progress,existing=new Map()) {
      const startIssued=this.callsIssued;
      const groups=new Map();
      for(const c of candidates){const key=c.location.join(',');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}
      // 优先处理线路较多的接入点，全部接入点都会规划，不以直线距离代替路线长度。
      const jobs=Array.from(groups.values()).sort((a,b)=>new Set(b.flatMap(c=>c.routes)).size-new Set(a.flatMap(c=>c.routes)).size), measured=new Map(existing);
      let cursor=0,complete=0;
      const worker=async()=>{
        while(cursor<jobs.length) {
          check(signal);const group=jobs[cursor++];let value;
          if(group.every(c=>measured.has(c.key)))continue;
          const cached=this.cached(this.walkKey(origin,group[0].location),7);
          if(cached){for(const c of group)measured.set(c.key,cached);continue;}
          try { value=await this.walking(origin,group[0].location,signal); }
          catch(error){if(error.name==='AbortError')throw error;value={distance:null,path:[],distanceError:error.message};}
          check(signal);for(const c of group)measured.set(c.key,value);
          progress(`正在规划实际步行路线 · ${++complete} / ${jobs.length} 个接入点`);
        }
      };
      await Promise.all([worker(),worker()]);return {measured,attempts:this.callsIssued-startIssued};
    }
    showPath(service) {
      this.clearPath();
      if(!this.map||!service.path?.length)return false;
      this.routeLine=new this.A.Polyline({path:service.path,strokeColor:'#1767bb',strokeWeight:5,strokeOpacity:0.9,isOutline:true,outlineColor:'#fff'});
      this.map.add(this.routeLine);this.map.setFitView([this.routeLine]);return true;
    }
  }
  root.PTALMap={Adapter,request};
})(globalThis);
