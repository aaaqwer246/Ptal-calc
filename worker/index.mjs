import {isMapPath,mapParams,forwardMap} from './map.mjs';
const routes={tips:'/v3/assistant/inputtips',search:'/v3/place/text',detail:'/v3/place/detail',nearby:'/v3/place/around',walking:'/v3/direction/walking'};
const fields={tips:['keywords'],search:['keywords','city'],detail:['id'],nearby:['location','radius','types','page'],walking:['origin','destination']};
const fail=(status,code,message)=>Response.json({error:{code,message}},{status,headers:{'Cache-Control':'no-store'}});
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
  headers.set('X-Content-Type-Options','nosniff');
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
  if((map||config)&&(!env.AMAP_JS_KEY||!env.AMAP_JS_SECRET))return respond(fail(503,'MAP_NOT_CONFIGURED','站点地图尚未配置，请管理员在 Cloudflare 添加 AMAP_JS_KEY 和 AMAP_JS_SECRET'));
  if((map||config)&&env.AMAP_JS_KEY===env.AMAP_KEY)return respond(fail(503,'MAP_KEY_PLATFORM','地图与查询不能使用同一串 Key，请管理员配置 Web端 JS Key'));
  let params;try{
    if(map)params=mapParams(url,env.AMAP_JS_KEY);
    else if(config){if(url.search)throw Error('地图配置接口不接受参数');}
    else params=validate(action,url.searchParams);
  }catch(error){return respond(fail(400,'INVALID_PARAMS',error.message));}
  if((!map&&!config&&!env.AMAP_KEY)||!env.IP_LIMITER||!env.BUDGET)return respond(fail(503,'NOT_CONFIGURED','查询服务尚未完成配置'));
  try{
    const ip=request.headers.get('CF-Connecting-IP');
    if(!ip)return respond(fail(403,'CLIENT_UNKNOWN','无法识别请求来源'));
    if(!(await env.IP_LIMITER.limit({key:ip})).success){const r=fail(429,'RATE_LIMITED','请求过于频繁，请等待60秒后重试');r.headers.set('Retry-After','60');return respond(r);}
    if(config)return respond(Response.json({key:env.AMAP_JS_KEY,serviceHost:`${url.origin}/_AMapService`}));
    const stub=env.BUDGET.get(env.BUDGET.idFromName('amap-global'));
    return respond(await stub.fetch(new Request(`https://internal${map?url.pathname:`/api/${action}`}?${params}`)));
  }catch{return respond(fail(503,'SERVICE_UNAVAILABLE','查询服务暂时不可用，请稍后重试'));}
}};

// 只持久化计数和熔断状态，不保存高德数据。所有区域共享一个配额闸门。
export class QuotaGate{
  constructor(state,env){this.state=state;this.env=env;}
  async fetch(request){
    const url=new URL(request.url),map=isMapPath(url.pathname),action=url.pathname.split('/').pop();
    let params;try{params=map?mapParams(url,this.env.AMAP_JS_KEY):validate(action,url.searchParams);}catch{return fail(400,'INVALID_PARAMS','内部参数错误');}
    const now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10);
    const daily=Number(map?this.env.MAP_DAILY_LIMIT||this.env.DAILY_LIMIT:this.env.DAILY_LIMIT),perMinute=Number(this.env.MINUTE_LIMIT),budgetKey=map?'map-quota':'quota';
    if(!Number.isSafeInteger(daily)||daily<1||!Number.isSafeInteger(perMinute)||perMinute<1)return fail(503,'NOT_CONFIGURED','服务预算配置无效');
    const decision=await this.state.storage.transaction(async txn=>{
      const old=await txn.get(budgetKey)||{},minute=Math.floor(now/60000);
      const q={day,daily:old.day===day?old.daily:0,minute,count:old.minute===minute?old.count:0,blockedUntil:old.blockedUntil||0};
      if(q.blockedUntil>now)return 'blocked';if(q.daily>=daily)return 'daily';if(q.count>=perMinute)return 'minute';
      q.daily++;q.count++;await txn.put(budgetKey,q);return null;
    });
    if(decision){const r=fail(429,'BUDGET_LIMIT',decision==='minute'?'全站请求繁忙，请等待60秒后重试':'服务当日预算已用完或高德配额已耗尽，请联系管理员');r.headers.set('Retry-After',decision==='minute'?'60':String(Math.ceil((Date.parse(day+'T00:00:00+08:00')+86400000-now)/1000)));return r;}
    if(map)return forwardMap(url,params,this.env);
    const upstream=new URL(routes[action],'https://restapi.amap.com');
    params.set('key',this.env.AMAP_KEY);params.set('output','JSON');
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
          const until=Date.parse(day+'T00:00:00+08:00')+86400000;
          await this.state.storage.transaction(async txn=>{const q=await txn.get('quota');if(q){q.blockedUntil=until;await txn.put('quota',q);}});
          return fail(429,'AMAP_QUOTA','高德调用配额已耗尽，服务已暂停当日请求，请检查高德控制台');
        }
        if(['10004','10014','10019','10020','10021'].includes(code))return fail(429,'AMAP_RATE_LIMIT','高德请求限流，请稍后重试');
        if(['10000','10016','10017'].includes(code))return fail(502,'AMAP_UNAVAILABLE','高德接口异常，请稍后重试');
        return fail(502,'AMAP_ERROR','高德拒绝查询，请管理员核对 Key 类型、权限及服务配置');
      }
      // 不回传 Key、请求 URL 或不需要的上游字段。
      const result=action==='walking'?{route:data.route}:action==='tips'?{tips:data.tips}:{count:data.count,pois:data.pois};
      return Response.json(result,{headers:{'Cache-Control':'no-store'}});
    }catch(error){return fail(error.name==='AbortError'?504:502,error.name==='AbortError'?'UPSTREAM_TIMEOUT':'UPSTREAM_ERROR',error.name==='AbortError'?'高德请求超时，请稍后重试':'高德接口响应异常，请稍后重试');}
    finally{clearTimeout(timer);}
  }
}
