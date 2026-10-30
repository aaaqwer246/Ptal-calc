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
