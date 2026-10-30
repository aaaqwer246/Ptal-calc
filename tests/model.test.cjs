const test=require('node:test');
const assert=require('node:assert/strict');
const M=require('../src/model.js');
const {LocalStore}=require('../src/cache.js');
const svc=(overrides={})=>({mode:'bus',route:'1路',stop:'测试站',distance:400,freq:6,enabled:true,...overrides});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
test('等级阈值连续，旧空档不再落入最高等级',()=>{
  for(const [ai,code]of [[0,'0'],[0.001,'1a'],[2.5,'1a'],[2.505,'1b'],[5,'1b'],[5.005,'2'],[10.005,'3'],[15.005,'4'],[20.005,'5'],[25.005,'6a'],[40,'6a'],[40.005,'6b']])assert.equal(M.band(ai).code,code);
  assert.throws(()=>M.band(NaN));assert.throws(()=>M.band(-1));
});
test('SWT 与可靠性修正后的 AWT 分开计算',()=>{
  const r=M.calculate([svc()]).included[0];near(r.walkTime,5);near(r.swt,5);near(r.awt,7);near(r.tat,12);near(r.edf,2.5);near(r.aiContribution,2.5);
});
test('每种模式分别只给予最高 EDF 一条完整权重',()=>{
  const c=M.calculate([svc(),svc({route:'2路',distance:0}),svc({mode:'lu',route:'1号线',distance:800,freq:12})]);
  near(c.modeAI.bus,30/7+1.25);near(c.modeAI.lu,30/13.25);near(c.totalAI,c.modeAI.bus+c.modeAI.lu);
  assert.equal(c.included.filter(r=>r.weight===1).length,2);
});
test('按实际步行距离去重，不累计同线路多站或出入口',()=>{
  const c=M.calculate([svc({distance:600}),svc({distance:300}),svc({distance:400})]);assert.equal(c.included.length,1);assert.equal(c.included[0].svc.distance,300);assert.equal(c.rows.filter(r=>r.reason).length,2);
});
test('保留支线差别，地铁前缀和明确方向统一',()=>{
  assert.equal(M.canonical('地铁 2号线','lu'),'2号线');assert.equal(M.canonical('71路(甲--乙)','bus'),'71路');assert.notEqual(M.canonical('71路(区间)','bus'),M.canonical('71路','bus'));
});
test('步行阈值使用完整精度，公交640地铁960边界包含',()=>{
  assert.equal(M.calculate([svc({distance:640})]).included.length,1);assert.equal(M.calculate([svc({distance:640.01})]).included.length,0);
  assert.equal(M.calculate([svc({mode:'lu',distance:960})]).included.length,1);assert.equal(M.calculate([svc({mode:'lu',distance:960.01})]).included.length,0);
});
test('失败路线不能以零距离或零等级替代，非法数值不污染总分',()=>{
  for(const distance of [null,undefined,'',NaN,Infinity,-1,' '])assert.equal(M.calculate([svc({distance})]).included.length,0);
  for(const freq of [0,-1,NaN,Infinity,301])assert.equal(M.calculate([svc({freq})]).included.length,0);
  assert.equal(M.calculate([svc({mode:'__proto__'})]).totalAI,0);
});
test('停用、停运、在建线路不计入',()=>{
  for(const overrides of [{enabled:false},{route:'2号线(在建)'},{route:'1路(停运)'},{stop:'测试站(未开通)'}])assert.equal(M.calculate([svc(overrides)]).included.length,0);
});
test('无班次最近站不遮蔽较远的有效服务',()=>{assert.equal(M.calculate([svc({distance:0,freq:0}),svc({distance:500})]).included[0].svc.distance,500);});
test('候选解析不会把普通地址或缺失地址当线路',()=>{
  const poi={name:'测试站(公交站)',type:'交通设施服务;公交车站',location:{lng:121.4,lat:31.2}};
  const c=M.candidates([{...poi,id:'1',address:'71路;71路(停运);南京西路123号'},{...poi,id:'2',address:'南京西路'},{...poi,id:'3'},{...poi,id:'4',location:null,address:'2路'}]);
  assert.equal(c.candidates.length,1);assert.deepEqual(c.candidates[0].routes,['71路']);assert.equal(c.stats.unknownRoutes,2);assert.equal(c.stats.invalid,1);
});
test('站名不删除道路末尾方向字或数字',()=>{const c=M.candidates([{name:'上海南(公交站)',type:'公交车站',address:'1路',location:[121,31]}]);assert.equal(c.candidates[0].stop,'上海南');});
test('参数严格校验，不接受零速度或无穷值',()=>{assert.throws(()=>M.settings({speed:0}));assert.throws(()=>M.settings({busMax:Infinity}));assert.throws(()=>M.settings({speed:true}));assert.deepEqual(M.settings(),M.DEFAULTS);});
test('导入白名单与范围校验，保留未知步行距离',()=>{
  const p=M.importPlan({version:1,params:M.DEFAULTS,services:[svc({distance:null,securityJsCode:'do-not-import'})]});assert.equal(p.services[0].distance,null);assert.equal(p.services[0].securityJsCode,undefined);
  for(const bad of [{version:2,services:[]},{version:1,services:[svc({freq:-1})]},{version:1,services:[svc({mode:'__proto__'})]},{version:1,services:[svc({distance:-1})]}])assert.throws(()=>M.importPlan(bad));
});
test('CSV 引号转义及公式注入防护',()=>{assert.equal(M.csvCell('a"b'),'"a""b"');assert.equal(M.csvCell('=1+1'),'"\'=1+1"');assert.equal(M.csvCell(' \t@SUM(A1)'),'"\' \t@SUM(A1)"');});
function memory(){const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
test('缓存只在内存中复用和失效控制',()=>{
  const storage=memory(),a=new LocalStore(storage);a.put('walk:x',{distance:500});const b=new LocalStore(storage);assert.equal(b.get('walk:x',30),null);b.put('walk:x',{distance:500});b.data['walk:x'].at=Date.now()-31*86400000;assert.equal(b.get('walk:x',30),null);
});
test('缓存损坏不影响手工计算',()=>{const storage=memory();storage.setItem('ptal-cache-v1','null');assert.equal(new LocalStore(storage).get('x',30),null);});
test('调用计数没有人为上限；清缓存保留计数',()=>{
  const storage=memory(),s=new LocalStore(storage);for(let i=0;i<1000;i++)s.reserve();s.clearCache();assert.equal(s.counts().daily,1000);assert.equal(s.counts().monthly,1000);s.reserve();assert.equal(s.counts().daily,1001);
});
test('本地存储不可用时仍可用会话缓存，不阻断完整分析',()=>{const s=new LocalStore({setItem(){throw Error('blocked');},getItem(){return null;}});s.reserve();s.reserve();assert.equal(s.counts().daily,2);s.put('walk:x',{distance:100});assert.equal(s.get('walk:x',7).distance,100);});
