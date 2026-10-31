import {isMapPath,mapParams,forwardMap} from './map.mjs';
const routes={tips:'/v3/assistant/inputtips',search:'/v3/place/text',detail:'/v3/place/detail',nearby:'/v3/place/around',walking:'/v3/direction/walking'};
const fields={tips:['keywords'],search:['keywords','city'],detail:['id'],nearby:['location','radius','types','page'],walking:['origin','destination']};
const fail=(status,code,message,providerCode)=>Response.json({error:{code,message,...(/^\d{5}$/.test(providerCode||'')?{providerCode}:{})}},{status,headers:{'Cache-Control':'no-store'}});
const authorizationErrors=new Map([
  ...['10001','10013'].map(code=>[code,['AMAP_KEY_INVALID','默认服务的授权已失效，请使用个人配置或联系管理员']]),
  ['10009',['AMAP_KEY_PLATFORM','默认服务的授权类型不匹配，请使用个人配置或联系管理员']],
  ...['10002','10012','10041'].map(code=>[code,['AMAP_PERMISSION','默认服务尚未开通这项查询，请使用个人配置或联系管理员']]),
  ...['10005','10006'].map(code=>[code,['AMAP_ACCESS_DENIED','默认服务的访问授权受限，请使用个人配置或联系管理员']]),
  ...['10007','10008'].map(code=>[code,['AMAP_SIGNATURE','默认服务的授权校验失败，请使用个人配置或联系管理员']]),
  ...['10010','10026'].map(code=>[code,['AMAP_ACCOUNT_BLOCKED','默认服务已被高德限制访问，请使用个人配置或联系管理员']]),
  ['40000',['AMAP_BALANCE','默认服务的高德服务余额已耗尽，请使用个人配置或联系管理员']],
  ['40002',['AMAP_EXPIRED','默认服务的高德服务已到期，请使用个人配置或联系管理员']]
]);
export function validate(action,params){
  if(!Object.hasOwn(routes,action))throw Error('不支持的接口');
  const allowed=fields[action];
  if([...params.keys()].some(k=>!allowed.includes(k)||params.getAll(k).length!==1)||allowed.some(k=>!params.has(k)))throw Error('参数缺失、重复或包含不允许的字段');
  for(const [key,value] of params){
    if(!value.trim()||value.length>200||/[\x00-\x1f]/.test(value))throw Error('参数为空或长度非法');
    if(['origin','destination','location'].includes(key)){
      if(!/^-?\d+(?:\.\d+)?,[-]?\d+(?:\.\d+)?$/.test(value))throw Error('坐标格式错误');
      const [lng,lat]=value.split(',').map(Number);if(lng< -180||lng>180||lat< -90||lat>90)throw Error('坐标超出范围');
    }
    if(key==='radius'&&(!/^\d+$/.test(value)||Number(value)<1||Number(value)>5000))throw Error('半径应为1至5000米');
    if(key==='page'&&(!/^\d+$/.test(value)||Number(value)<1||Number(value)>100))throw Error('页码应为1至100');
    if(key==='types'&&!['150700','150500'].includes(value))throw Error('仅允许公交或地铁站点');
    if(key==='id'&&!/^[a-zA-Z0-9]{1,80}$/.test(value))throw Error('POI ID 格式错误');
  }
  return new URLSearchParams(params);
}
function cors(response,origin){
  const headers=new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');headers.set('Cache-Control','no-store');
  headers.set('Access-Control-Expose-Headers','Retry-After');
  headers.set('X-Content-Type-Options','nosniff');headers.set('X-PTAL-Version','edge-query-20261101');
  return new Response(response.body,{status:response.status,headers});
}
export default {async fetch(request,env){
  const url=new URL(request.url),map=isMapPath(url.pathname),config=url.pathname==='/api/map-config';
  let origin=request.headers.get('Origin');
  // SDK 的 JSONP 不带 Origin，用完整 Referer 的来源核对白名单；仍非身份认证。
  if(!origin&&map){try{origin=new URL(request.headers.get('Referer')).origin;}catch{}}
  const allowed=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!origin||!allowed.includes(origin))return fail(403,'ORIGIN_DENIED','此网站未获允许访问查询服务');
  const respond=r=>cors(r,origin),action=url.pathname.match(/^\/api\/([a-z]+)$/)?.[1];
  if(!map&&!config&&!Object.hasOwn(routes,action||''))return respond(fail(404,'NOT_FOUND','接口不存在'));
  if(request.method==='OPTIONS'){
    if(request.headers.get('Access-Control-Request-Method')!=='GET'||request.headers.get('Access-Control-Request-Headers'))return respond(fail(403,'PREFLIGHT_DENIED','不允许的跨域请求'));
    return respond(new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET','Access-Control-Max-Age':'600'}}));
  }
  if(request.method!=='GET')return respond(fail(405,'METHOD_NOT_ALLOWED','仅允许 GET 请求'));
  if((map||config)&&(!env.AMAP_JS_KEY||!env.AMAP_JS_SECRET))return respond(fail(503,'MAP_NOT_CONFIGURED','默认地图暂不可用，可稍后重试或填写个人配置'));
  if((map||config)&&env.AMAP_JS_KEY===env.AMAP_KEY)return respond(fail(503,'MAP_KEY_PLATFORM','默认地图暂不可用，请联系管理员'));
  let params;try{
    if(map)params=mapParams(url,env.AMAP_JS_KEY);
    else if(config){if(url.search)throw Error('地图配置接口不接受参数');}
    else params=validate(action,url.searchParams);
  }catch(error){return respond(fail(400,'INVALID_PARAMS',error.message));}
  if((!map&&!config&&!env.AMAP_KEY)||!env.IP_LIMITER||!env.BUDGET)return respond(fail(503,'NOT_CONFIGURED','默认查询服务暂不可用，请稍后重试'));
  try{
    const ip=request.headers.get('CF-Connecting-IP');
    if(!ip)return respond(fail(403,'CLIENT_UNKNOWN','无法识别请求来源'));
    if(!(await env.IP_LIMITER.limit({key:ip})).success){const r=fail(429,'RATE_LIMITED','请求过于频繁，请等待60秒后重试');r.headers.set('Retry-After','60');return respond(r);}
    if(config)return respond(Response.json({key:env.AMAP_JS_KEY,serviceHost:`${url.origin}/_AMapService`}));
    const stub=env.BUDGET.get(env.BUDGET.idFromName('amap-global'));
    const permit=await stub.fetch(new Request(`https://internal/reserve/${map?'map':'query'}`,{method:'POST'}));
    if(!permit.ok)return respond(permit);
    if(map)return respond(await forwardMap(url,params,env));
    return respond(await fetchQuery(action,params,env,()=>stub.fetch(new Request('https://internal/block/query',{method:'POST'}))));
  }catch{return respond(fail(503,'SERVICE_UNAVAILABLE','查询服务暂时不可用，请稍后重试'));}
}};

// 只持久化计数和熔断状态，不保存高德数据。所有区域共享一个配额闸门。
export class QuotaGate{
  constructor(state,env){this.state=state;this.env=env;}
  async fetch(request){
    const url=new URL(request.url),match=url.pathname.match(/^\/(reserve|block)\/(query|map)$/);
    if(request.method!=='POST'||url.hostname!=='internal'||url.search||!match)return fail(400,'INVALID_PARAMS','内部请求无效');
    const [,operation,kind]=match,map=kind==='map',budgetKey=map?'map-quota':'quota';
    const now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10);
    if(operation==='block'){
      await this.state.storage.transaction(async txn=>{
        const q=await txn.get(budgetKey)||{};q.blockedUntil=Date.parse(day+'T00:00:00+08:00')+86400000;await txn.put(budgetKey,q);
      });
      return Response.json({ok:true});
    }
    const daily=Number(map?this.env.MAP_DAILY_LIMIT||this.env.DAILY_LIMIT:this.env.DAILY_LIMIT),perMinute=Number(this.env.MINUTE_LIMIT);
    if(!Number.isSafeInteger(daily)||daily<1||!Number.isSafeInteger(perMinute)||perMinute<1)return fail(503,'NOT_CONFIGURED','查询服务暂不可用，请稍后重试');
    const decision=await this.state.storage.transaction(async txn=>{
      const old=await txn.get(budgetKey)||{},minute=Math.floor(now/60000);
      const q={day,daily:old.day===day?old.daily:0,minute,count:old.minute===minute?old.count:0,blockedUntil:old.blockedUntil||0};
      if(q.blockedUntil>now)return 'blocked';if(q.daily>=daily)return 'daily';if(q.count>=perMinute)return 'minute';
      q.daily++;q.count++;await txn.put(budgetKey,q);return null;
    });
    if(decision){const r=fail(429,'BUDGET_LIMIT',decision==='minute'?'全站请求繁忙，请等待60秒后重试':'服务当日预算已用完或高德配额已耗尽，请联系管理员');r.headers.set('Retry-After',decision==='minute'?'60':String(Math.ceil((Date.parse(day+'T00:00:00+08:00')+86400000-now)/1000)));return r;}
    return Response.json({ok:true});
  }
}

async function fetchQuery(action,params,env,block){
  const upstream=new URL(routes[action],'https://restapi.amap.com');
  params.set('key',env.AMAP_KEY);params.set('output','JSON');
  if(action==='tips'){params.set('city','上海');params.set('citylimit','false');}
  if(action==='search'){params.set('offset','8');params.set('page','1');params.set('extensions','base');}
  if(action==='detail')params.set('extensions','base');
  if(action==='nearby'){params.set('offset','25');params.set('extensions','all');params.set('sortrule','distance');}
  upstream.search=params.toString();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(upstream,{signal:controller.signal,redirect:'manual',cache:'no-store'});
    if(!response.ok)return fail(502,'UPSTREAM_HTTP','高德服务异常，请稍后重试');
    const data=await response.json();
    if(String(data.status)!=='1'){
      const code=String(data.infocode||'');
      if(['10003','10044'].includes(code)){
        await block();
        return fail(429,'AMAP_QUOTA','高德调用配额已耗尽，服务已暂停当日请求，请检查高德控制台',code);
      }
      if(authorizationErrors.has(code)){const [name,message]=authorizationErrors.get(code);return fail(503,name,message,code);}
      if(['10004','10014','10015','10019','10020','10021','10029'].includes(code))return fail(429,'AMAP_RATE_LIMIT','高德请求过于频繁，请稍后重试',code);
      if(['10000','10016','10017'].includes(code))return fail(502,'AMAP_UNAVAILABLE','高德服务繁忙，请稍后重试',code);
      return fail(502,'AMAP_ERROR','高德暂未完成查询，请稍后重试或使用个人配置',code);
    }
    // 不回传 Key、请求 URL 或不需要的上游字段。
    const result=action==='walking'?{route:data.route}:action==='tips'?{tips:data.tips}:{count:data.count,pois:data.pois};
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return fail(error.name==='AbortError'?504:502,error.name==='AbortError'?'UPSTREAM_TIMEOUT':'UPSTREAM_ERROR',error.name==='AbortError'?'高德请求超时，请稍后重试':'高德接口响应异常，请稍后重试');}
  finally{clearTimeout(timer);}
}
