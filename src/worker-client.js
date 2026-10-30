(function(root){
  'use strict';
  function displayError(error){
    const messages={MAP_NOT_CONFIGURED:'默认地图暂不可用，可稍后重试或填写个人配置。',MAP_KEY_PLATFORM:'默认地图暂不可用，请联系管理员。',NOT_CONFIGURED:'默认查询服务暂不可用，请稍后重试。',ORIGIN_DENIED:'当前页面无法使用默认服务，请从首页或本地启动入口重新打开。'};
    const message=messages[error?.code]||error?.message||'查询服务暂不可用，请稍后重试';
    return /Cloudflare|Worker|AMAP_[A-Z_]+|wrangler|serviceHost|src\//i.test(message)?'查询服务暂不可用，请稍后重试':message;
  }
  function services(base,store){
    if(root.location?.protocol==='file:')throw new Error('本地联网查询请使用「启动本地计算器.cmd」打开，直接双击网页仅支持手动计算');
    const blocked=new WeakMap();
    const url=new URL(base);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('默认查询服务暂不可用，请稍后重试');
    async function query(action,params,signal){
      if(signal?.aborted)throw new DOMException('查询已取消','AbortError');
      if(signal&&blocked.has(signal))throw blocked.get(signal);
      const controller=new AbortController(),abort=()=>controller.abort();
      signal?.addEventListener('abort',abort,{once:true});
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},15000);
      try{
        const target=new URL(`${url.href.replace(/\/$/,'')}/api/${action}`);
        target.search=new URLSearchParams(params).toString();
        const response=await fetch(target,{signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'});
        const data=await response.json();
        if(!response.ok||data.error){
          const error=new Error(displayError(data.error));
          error.code=data.error?.code;
          if(signal&&[429,503].includes(response.status))blocked.set(signal,error);
          throw error;
        }
        return data;
      }catch(error){if(timedOut)throw new Error('查询超时，请稍后重试');if(error.name==='TypeError')throw new Error('暂时无法连接查询服务，请检查网络或稍后重试');throw error;}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    }
    const point=p=>typeof p.location==='string'?{...p,location:p.location.split(',').map(Number)}:p;
    class PlaceSearch{
      constructor(options){this.options=options;this.page=1;}setPageIndex(page){this.page=page;}
      async run(action,params,cb,signal){const data=await query(action,params,signal);cb('complete',{poiList:{count:Number(data.count),pois:(data.pois||[]).map(point)}});}
      search(text,cb,signal){return this.run('search',{keywords:text,city:this.options.city||'上海'},cb,signal);}
      getDetails(id,cb,signal){return this.run('detail',{id},cb,signal);}
      searchNearBy(_,coords,radius,cb,signal){return this.run('nearby',{location:coords.join(','),radius,types:this.options.type,page:this.page},cb,signal);}
    }
    class AutoComplete{async search(text,cb,signal){const data=await query('tips',{keywords:text},signal);cb('complete',{tips:(data.tips||[]).map(point)});}}
    class Walking{async search(origin,destination,cb,signal){const data=await query('walking',{origin:origin.join(','),destination:destination.join(',')},signal);cb('complete',{routes:(data.route?.paths||[]).map(p=>({...p,steps:(p.steps||[]).map(s=>({path:(s.polyline||'').split(';').filter(Boolean).map(x=>x.split(',').map(Number))}))}))});}}
    return {PlaceSearch,AutoComplete,Walking,mapConfig:()=>query('map-config',{})};
  }
  root.PTALWorker={services};
})(globalThis);
