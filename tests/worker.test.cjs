const test=require('node:test'),assert=require('node:assert/strict');
const origin='https://aaaqwer246.github.io';
const request=(path='/api/walking?origin=121,31&destination=121.1,31.1',options={})=>new Request('https://worker.test'+path,{headers:{Origin:origin,'CF-Connecting-IP':'127.0.0.1'},...options});
async function fixture(){
  const {default:worker,QuotaGate}=await import('../worker/index.mjs');
  const records=new Map(),storage={get:async k=>structuredClone(records.get(k)),put:async(k,v)=>records.set(k,structuredClone(v))};storage.transaction=fn=>fn(storage);
  const env={AMAP_KEY:'test-secret-not-real',ALLOWED_ORIGINS:origin,DAILY_LIMIT:'100',MINUTE_LIMIT:'100',IP_LIMITER:{limit:async()=>({success:true})}};
  const gate=new QuotaGate({storage},env);env.BUDGET={idFromName:x=>x,get:()=>({fetch:r=>gate.fetch(r)})};
  return {worker,env,records};
}
test('Worker 白名单、预检、方法、任意URL及非法参数均在上游调用前拒绝',async()=>{
  const {worker,env}=await fixture();let calls=0;const old=global.fetch;global.fetch=async()=>{calls++;throw Error('unexpected');};
  try{
    assert.equal((await worker.fetch(request(undefined,{headers:{Origin:'https://evil.test'}}),env)).status,403);
    assert.equal((await worker.fetch(request(undefined,{headers:{}}),env)).status,403);
    assert.equal((await worker.fetch(request('/api/walking?origin=181,31&destination=121,31'),env)).status,400);
    assert.equal((await worker.fetch(request('/api/walking?origin=121,31&destination=121,31&key=x'),env)).status,400);
    assert.equal((await worker.fetch(request('/api/search?keywords=a&keywords=b&city=上海'),env)).status,400);
    assert.equal((await worker.fetch(request('/api/proxy?url=https://evil.test'),env)).status,404);
    assert.equal((await worker.fetch(request(undefined,{method:'POST'}),env)).status,405);
    const pre=await worker.fetch(request(undefined,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET'}}),env);
    assert.equal(pre.status,204);assert.equal(pre.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(calls,0);
  }finally{global.fetch=old;}
});
test('部署白名单允许固定本地端口，拒绝文件来源、其他端口和外部网站',async()=>{
  const {worker,env}=await fixture();
  const config=require('node:fs').readFileSync(require('node:path').join(__dirname,'../worker/wrangler.toml'),'utf8');
  env.ALLOWED_ORIGINS=config.match(/^ALLOWED_ORIGINS = "([^"]+)"/m)[1];
  for(const source of ['http://127.0.0.1:8765','http://localhost:8765','https://ptal-calc.zhouguillaume111750.workers.dev',origin]){
    const response=await worker.fetch(request('/api/walking?origin=999,31&destination=121,31',{headers:{Origin:source}}),env);
    assert.equal(response.status,400);assert.equal(response.headers.get('Access-Control-Allow-Origin'),source);
  }
  for(const source of ['null','http://127.0.0.1:9999','https://evil.test'])assert.equal((await worker.fetch(request(undefined,{headers:{Origin:source}}),env)).status,403);
});
test('直接打开本地HTML时提示使用本地启动入口',()=>{
  require('../src/worker-client.js');const saved=global.location;
  try{global.location={protocol:'file:'};assert.throws(()=>PTALWorker.services('https://worker.test'),/启动本地计算器.cmd/);}
  finally{if(saved===undefined)delete global.location;else global.location=saved;}
});
test('前端通过 Worker 完成地点、站点分页与步行数据转换；Key 仅出现在上游',async()=>{
  const {worker,env}=await fixture();const old=global.fetch;let upstream=[];
  global.PTAL=require('../src/model.js');require('../src/worker-client.js');require('../src/amap.js');const {LocalStore}=require('../src/cache.js');
  const store=new LocalStore(),signal=new AbortController().signal;
  global.fetch=async(input,options)=>{
    const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(u.hostname==='worker.test'){
      assert.equal(u.searchParams.has('key'),false);
      return worker.fetch(request(u.pathname+u.search,{signal:options.signal}),env);
    }
    upstream.push(u);assert.equal(u.hostname,'restapi.amap.com');assert.equal(u.searchParams.get('key'),env.AMAP_KEY);
    if(u.pathname.endsWith('walking'))return Response.json({status:'1',route:{paths:[{distance:'321.5',steps:[{polyline:'121,31;121.1,31.1'}]}]}});
    if(u.pathname.endsWith('inputtips'))return Response.json({status:'1',tips:[{id:'B1',name:'东门',location:'121,31'}]});
    const page=Number(u.searchParams.get('page')||1),count=u.searchParams.get('types')==='150500'?0:26;
    return Response.json({status:'1',count:String(count),pois:Array.from({length:count?Math.min(25,count-(page-1)*25):0},(_,i)=>({id:`B${page}${i}`,name:'站(公交站)',type:'公交车站',address:'1路',location:'121,31'}))});
  };
  try{
    const adapter=new PTALMap.Adapter(PTALWorker.services('https://worker.test',store),null,store);adapter.pageSize=25;
    assert.deepEqual((await adapter.suggest('公园',signal))[0].location,[121,31]);
    const nearby=await adapter.nearby([121,31],PTAL.DEFAULTS,signal,()=>{});assert.equal(nearby.pois.length,26);assert.deepEqual(nearby.warnings,[]);
    const walk=await adapter.walking([121,31],[121.1,31.1],signal);assert.equal(walk.distance,321.5);assert.deepEqual(walk.path,[[121,31],[121.1,31.1]]);
    const count=upstream.length;await adapter.walking([121,31],[121.1,31.1],signal);assert.equal(upstream.length,count);
  }finally{global.fetch=old;}
});
test('单IP限流、全站预算、配额熔断、错误响应与网络超时不泄露密钥',async()=>{
  const {worker,env}=await fixture();const old=global.fetch;let calls=0;
  global.fetch=async()=>{calls++;return Response.json({status:'0',infocode:'10003',info:env.AMAP_KEY});};
  try{
    env.IP_LIMITER.limit=async()=>({success:false});assert.equal((await worker.fetch(request(),env)).status,429);assert.equal(calls,0);
    env.IP_LIMITER.limit=async()=>({success:true});const exhausted=await worker.fetch(request(),env);assert.equal(exhausted.status,429);assert.match(await exhausted.text(),/AMAP_QUOTA/);
    const next=await worker.fetch(request(),env);assert.equal(next.status,429);assert.equal(calls,1);assert.doesNotMatch(await next.text(),new RegExp(env.AMAP_KEY));
    for(const scenario of ['budget','minute','http','redirect','json','timeout','rate','missing']){
      const f=await fixture();
      if(scenario==='budget')f.env.DAILY_LIMIT='1';if(scenario==='minute')f.env.MINUTE_LIMIT='1';if(scenario==='missing')delete f.env.AMAP_KEY;
      global.fetch=async(_,options)=>{assert.equal(options.redirect,'manual');if(scenario==='http')return new Response('',{status:503});if(scenario==='redirect')return new Response('',{status:302,headers:{Location:'https://untrusted.test'}});if(scenario==='json')return new Response('oops');if(scenario==='timeout')throw new DOMException('timeout','AbortError');if(scenario==='rate')return Response.json({status:'0',infocode:'10004'});return Response.json({status:'1',route:{paths:[]}});};
      const first=await f.worker.fetch(request(),f.env);
      if(['budget','minute'].includes(scenario)){assert.equal(first.status,200);assert.equal((await f.worker.fetch(request(),f.env)).status,429);}
      else assert.equal(first.status,{http:502,redirect:502,json:502,timeout:504,rate:429,missing:503}[scenario]);
    }
  }finally{global.fetch=old;}
});
test('启用底图后业务服务仍使用 Worker；429阻止同操作后续请求，取消能中断网络',async()=>{
  require('../src/worker-client.js');require('../src/amap.js');
  const saved={fetch:global.fetch,AMap:global.AMap,document:global.document,config:global.PTAL_DEPLOYMENT};
  try{
    global.PTAL_DEPLOYMENT={workerUrl:'https://worker.test'};
    global.AMap={Map:class{on(){}},Walking:class{},PlaceSearch:class{}};
    global.document={getElementById:()=>({replaceChildren(){}})};
    const adapter=await PTALMap.Adapter.connect({},{}),walking=adapter.A.Walking;
    await adapter.attachMap(()=>{});assert.equal(adapter.A.Walking,walking);assert.notEqual(walking,global.AMap.Walking);
    let calls=0;global.fetch=async()=>{calls++;return Response.json({error:{message:'配额耗尽'}},{status:429});};
    const signal=new AbortController().signal,service=PTALWorker.services('https://worker.test');
    await assert.rejects(service.AutoComplete.prototype.search('公园',()=>{},signal),/配额耗尽/);
    await assert.rejects(service.AutoComplete.prototype.search('广场',()=>{},signal),/配额耗尽/);assert.equal(calls,1);
    global.fetch=async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('取消','AbortError')),{once:true}));
    const controller=new AbortController(),pending=service.AutoComplete.prototype.search('公园',()=>{},controller.signal);controller.abort();
    await assert.rejects(pending,error=>error.name==='AbortError');
  }finally{global.fetch=saved.fetch;global.AMap=saved.AMap;global.document=saved.document;global.PTAL_DEPLOYMENT=saved.config;}
});
test('站点地图配置只公开JS Key；代理固定目标、隐藏jscode、预算与查询独立',async()=>{
  const {worker,env,records}=await fixture(),old=global.fetch;
  env.AMAP_JS_KEY='test-public-js-key';env.AMAP_JS_SECRET='test-private-js-secret';env.MAP_DAILY_LIMIT='2';
  try{
    let upstream=0;
    global.fetch=async(input,options)=>{
      upstream++;const url=new URL(input);assert.equal(url.hostname,'webapi.amap.com');assert.equal(url.pathname,'/v4/map/styles');
      assert.equal(url.searchParams.get('key'),env.AMAP_JS_KEY);assert.equal(url.searchParams.get('jscode'),env.AMAP_JS_SECRET);assert.equal(options.redirect,'manual');
      return new Response('AMap.cb({});',{headers:{'Content-Type':'application/javascript'}});
    };
    const config=await worker.fetch(request('/api/map-config'),env),data=await config.json();
    assert.deepEqual(data,{key:env.AMAP_JS_KEY,serviceHost:'https://worker.test/_AMapService'});assert.equal(upstream,0);
    assert.equal(JSON.stringify(data).includes(env.AMAP_KEY),false);assert.equal(JSON.stringify(data).includes(env.AMAP_JS_SECRET),false);
    records.set('quota',{day:'2000-01-01',daily:1000,blockedUntil:Date.now()+60000});
    const path='/_AMapService/v4/map/styles?key=test-public-js-key&callback=AMap.cb&styleid=normal';
    const proxy=await worker.fetch(request(path,{headers:{Referer:origin+'/Ptal-calc/','CF-Connecting-IP':'127.0.0.1'}}),env);
    assert.equal(proxy.status,200);assert.equal(await proxy.text(),'AMap.cb({});');assert.equal(proxy.headers.get('Cache-Control'),'no-store');
    assert.equal((await worker.fetch(request(path),env)).status,200);assert.equal((await worker.fetch(request(path),env)).status,429);assert.equal(upstream,2);
    for(const extra of ['&url=https://evil.test','&jscode=evil','&callback=evil()','&key=second'])assert.equal((await worker.fetch(request(path+extra),env)).status,400);
    assert.equal((await worker.fetch(request('/_AMapService/v3/place/text'),env)).status,404);
    assert.equal((await worker.fetch(request(path,{headers:{Referer:'https://evil.test'}}),env)).status,403);
    const missing=await fixture();assert.equal((await missing.worker.fetch(request('/api/map-config'),missing.env)).status,503);
  }finally{global.fetch=old;}
});
test('无个人Key也能加载站点地图，jscode和Web服务Key不进入浏览器配置',async()=>{
  require('../src/worker-client.js');require('../src/amap.js');
  const saved={fetch:global.fetch,AMap:global.AMap,document:global.document,config:global.PTAL_DEPLOYMENT,security:global._AMapSecurityConfig};let scriptUrl;
  try{
    global.AMap=undefined;global.PTAL_DEPLOYMENT={workerUrl:'https://worker.test'};
    global.fetch=async(input)=>{assert.match(String(input),/\/api\/map-config$/);return Response.json({key:'test-shared-js-key',serviceHost:'https://worker.test/_AMapService'});};
    global.document={getElementById:()=>({replaceChildren(){}}),createElement:()=>({dataset:{}}),head:{append(script){scriptUrl=script.src;global.AMap={Map:class{on(){}}};global.__ptalMapReady();}}};
    const adapter=await PTALMap.Adapter.connect({},{});await adapter.attachMap(()=>{});
    assert.equal(new URL(scriptUrl).searchParams.get('key'),'test-shared-js-key');
    assert.deepEqual(global._AMapSecurityConfig,{serviceHost:'https://worker.test/_AMapService'});
  }finally{global.fetch=saved.fetch;global.AMap=saved.AMap;global.document=saved.document;global.PTAL_DEPLOYMENT=saved.config;global._AMapSecurityConfig=saved.security;}
});
test('地图配置拒绝误用Web服务Key，上游意外回显的密钥不会发给浏览器',async()=>{
  const {worker,env}=await fixture(),old=global.fetch;
  env.AMAP_JS_KEY=env.AMAP_KEY;env.AMAP_JS_SECRET='test-private-js-secret';
  try{
    const wrong=await worker.fetch(request('/api/map-config'),env);assert.equal(wrong.status,503);assert.doesNotMatch(await wrong.text(),new RegExp(env.AMAP_KEY));
    env.AMAP_JS_KEY='test-shared-js-key';global.fetch=async()=>new Response(env.AMAP_JS_SECRET,{headers:{'Content-Type':'application/javascript'}});
    const response=await worker.fetch(request('/_AMapService/v4/map/styles?callback=AMap.cb'),env);
    assert.equal(response.status,502);assert.doesNotMatch(await response.text(),new RegExp(env.AMAP_JS_SECRET));
  }finally{global.fetch=old;}
});
test('个人配置优先用于地图和全部业务，Key失败或填写不完整均不转用公共额度',async()=>{
  global.PTAL=require('../src/model.js');require('../src/worker-client.js');require('../src/amap.js');
  const {LocalStore}=require('../src/cache.js'),saved={fetch:global.fetch,AMap:global.AMap,document:global.document,config:global.PTAL_DEPLOYMENT,security:global._AMapSecurityConfig};
  const calls={worker:0,tips:0,detail:0,search:0,nearby:0,walk:0};let sdk;
  const poi={id:'B1',name:'测试站(公交站)',address:'1路',type:'公交车站',location:[121,31]};
  class PlaceSearch{setPageIndex(){}search(text,cb){calls.search++;cb('complete',{poiList:{pois:[poi]}});}getDetails(id,cb){calls.detail++;cb('complete',{poiList:{pois:[poi]}});}searchNearBy(text,coords,radius,cb){calls.nearby++;cb('complete',{poiList:{count:1,pois:[poi]}});}}
  class Walking{search(o,d,cb){calls.walk++;cb('complete',{routes:[{distance:300,steps:[{path:[o,d]}]}]});}}
  class AutoComplete{search(text,cb){calls.tips++;cb('complete',{tips:[{...poi,name:text}]});}}
  try{
    global.AMap=undefined;global.PTAL_DEPLOYMENT={workerUrl:'https://worker.test'};global.fetch=async()=>{calls.worker++;throw Error('不应调用公共Worker');};
    global.document={getElementById:()=>({replaceChildren(){}}),createElement:()=>({dataset:{}}),head:{append(script){sdk=new URL(script.src);global.AMap={Map:class{on(){}},PlaceSearch,Walking,AutoComplete};global.__ptalMapReady();}}};
    const adapter=await PTALMap.Adapter.connect({key:'own-key',securityJsCode:'own-code'},new LocalStore()),signal=new AbortController().signal;
    assert.equal(adapter.source,'personal');assert.equal(adapter.pageSize,50);assert.equal(sdk.searchParams.get('key'),'own-key');assert.match(sdk.searchParams.get('plugin'),/AMap.Walking/);assert.deepEqual(global._AMapSecurityConfig,{securityJsCode:'own-code'});
    await adapter.suggest('公园',signal);await adapter.resolveTip({id:'B1',name:'站'},signal);await adapter.search('广场',signal);await adapter.nearby([121,31],PTAL.DEFAULTS,signal,()=>{});await adapter.walking([121,31],[121.1,31.1],signal);await adapter.attachMap(()=>{});
    assert.deepEqual(calls,{worker:0,tips:1,detail:1,search:1,nearby:2,walk:1});
    adapter.A.AutoComplete=class{search(text,cb){cb('error','INVALID_USER_KEY');}};
    await assert.rejects(adapter.suggest('错误配置',signal),/Key 无效/);assert.equal(calls.worker,0);
    await assert.rejects(PTALMap.Adapter.connect({key:'only-key'},new LocalStore()),/同时填写/);assert.equal(calls.worker,0);
  }finally{global.fetch=saved.fetch;global.AMap=saved.AMap;global.document=saved.document;global.PTAL_DEPLOYMENT=saved.config;global._AMapSecurityConfig=saved.security;}
});
test('默认服务区分授权、权限、余额与到期，不泄露上游info或误提示个人配置有错',async()=>{
  const old=global.fetch;
  try{
    for(const [providerCode,code,detail] of [['10001','AMAP_KEY_INVALID','授权已失效'],['10009','AMAP_KEY_PLATFORM','授权类型不匹配'],['10041','AMAP_PERMISSION','尚未开通'],['40000','AMAP_BALANCE','余额已耗尽'],['40002','AMAP_EXPIRED','服务已到期']]){
      const {worker,env}=await fixture();global.fetch=async()=>Response.json({status:'0',infocode:providerCode,info:env.AMAP_KEY});
      const response=await worker.fetch(request(),env),error=(await response.json()).error;
      assert.equal(response.status,503);assert.equal(error.code,code);assert.equal(error.providerCode,providerCode);assert.match(error.message,new RegExp(detail));assert.doesNotMatch(JSON.stringify(error),new RegExp(env.AMAP_KEY));
    }
    const {worker,env}=await fixture();global.fetch=async()=>Response.json({status:'0',infocode:'bad-'+env.AMAP_KEY,info:env.AMAP_KEY});
    const error=(await (await worker.fetch(request(),env)).json()).error;assert.equal(error.providerCode,undefined);assert.doesNotMatch(error.message,/检查个人设置/);assert.doesNotMatch(JSON.stringify(error),new RegExp(env.AMAP_KEY));
  }finally{global.fetch=old;}
});
