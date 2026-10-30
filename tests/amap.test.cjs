const test=require('node:test'),assert=require('node:assert/strict');
global.PTAL=require('../src/model.js');
const {LocalStore}=require('../src/cache.js');require('../src/amap.js');
function fixture(){
  const data=new Map(),calls={walk:0,place:0,tips:0,details:0,pages:[],live:0,maxLive:0};
  const store=new LocalStore({getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)});
  class Walking{search(o,d,cb){calls.walk++;calls.live++;calls.maxLive=Math.max(calls.maxLive,calls.live);setTimeout(()=>{calls.live--;if(d[0]===0)cb('no_data',{});else cb('complete',{routes:[{distance:500.25,steps:[{path:[o,d]}]}]});},5);}}
  class PlaceSearch{
    constructor(options){this.options=options;this.page=1;}setPageIndex(n){this.page=n;}
    search(text,cb){calls.place++;cb('complete',{poiList:{pois:[{name:text,location:{lng:121,lat:31}}]}});}
    getDetails(id,cb){calls.details++;cb('complete',{poiList:{pois:[{id,name:'公园东门',location:{lng:121.42,lat:31.22}}]}});}
    searchNearBy(_,o,r,cb){calls.place++;calls.pages.push([this.options.type,this.page]);const count=this.options.type==='150700'?51:0;const size=this.page===1?Math.min(50,count):1;cb(count?'complete':'no_data',{poiList:{count,pois:Array.from({length:size},(_,i)=>({id:`${this.page}-${i}`,name:'站(公交站)',type:'公交车站',address:'1路',location:{lng:121+i/1000,lat:31}}))}});}
  }
  class AutoComplete{search(text,cb){calls.tips++;cb('complete',{tips:[{id:'gate',name:text+'东门',location:{lng:121.4,lat:31.2}},{id:'no-coordinate',name:text+'北门',location:[]}]});}}
  return {calls,store,adapter:new PTALMap.Adapter({Walking,PlaceSearch,AutoComplete},{},store)};
}
test('完整分页，不因省额度丢弃第二页站点；再次查询复用缓存',async()=>{
  const {adapter,calls}=fixture(),signal=new AbortController().signal;
  assert.equal((await adapter.nearby([121,31],PTAL.DEFAULTS,signal,()=>{})).pois.length,51);
  assert.deepEqual(calls.pages,[['150700',1],['150700',2],['150500',1]]);
  const before=calls.place;await adapter.nearby([121,31],PTAL.DEFAULTS,signal,()=>{});assert.equal(calls.place,before);
});
test('全部候选点规划，超过8点也不截断；同坐标跨线路只调用一次',async()=>{
  const {adapter,calls}=fixture(),signal=new AbortController().signal;
  const list=Array.from({length:10},(_,i)=>({key:`s${i}`,routes:[`${i}路`],location:[121+i/1000,31]}));list.push({...list[0],key:'duplicate-coordinate'});
  const result=await adapter.measure(list,[121,30],signal,()=>{});
  assert.equal(result.measured.size,11);assert.equal(calls.walk,10);assert.ok(calls.maxLive<=2);assert.equal(result.measured.get('s0').distance,500.25);
  const second=await adapter.measure(list,[121,30],signal,()=>{});assert.equal(second.attempts,0);assert.equal(calls.walk,10);
});
test('强制刷新越过缓存，规划失败明确返回未知距离',async()=>{
  const {adapter,calls}=fixture(),signal=new AbortController().signal;
  await adapter.walking([121,31],[122,31],signal);await adapter.walking([121,31],[122,31],signal);assert.equal(calls.walk,1);
  adapter.refresh=true;await adapter.walking([121,31],[122,31],signal);assert.equal(calls.walk,2);
  const result=await adapter.measure([{key:'failure',routes:['1路'],location:[0,0]}],[121,31],signal,()=>{});
  assert.equal(result.measured.get('failure').distance,null);assert.match(result.measured.get('failure').distanceError,/未取得/);
});
test('POI搜索重复关键字使用本地缓存',async()=>{
  const {adapter,calls}=fixture(),signal=new AbortController().signal;await adapter.search('人民广场',signal);await adapter.search('人民广场',signal);assert.equal(calls.place,1);
});
test('地点联想保留具体门和无坐标候选，相同关键字复用缓存',async()=>{
  const {adapter,calls}=fixture(),signal=new AbortController().signal;
  const tips=await adapter.suggest('公园',signal);assert.equal(tips.length,2);assert.equal(tips[0].name,'公园东门');assert.equal(tips[1].location,null);
  await adapter.suggest('公园',signal);assert.equal(calls.tips,1);
  const direct=await adapter.resolveTip(tips[0],signal);assert.deepEqual(direct[0].location,[121.4,31.2]);assert.equal(calls.details,0);
  const details=await adapter.resolveTip(tips[1],signal);assert.equal(details[0].name,'公园东门');assert.equal(calls.details,1);
  await adapter.resolveTip(tips[1],signal);assert.equal(calls.details,1);
});
test('取消后忽略迟到结果，并停止继续排队的请求',async()=>{
  const {adapter,calls}=fixture(),controller=new AbortController();
  const promise=adapter.measure([{key:'a',routes:['1路'],location:[121,31]},{key:'b',routes:['2路'],location:[122,31]}],[121,30],controller.signal,()=>{});
  setTimeout(()=>controller.abort(),1);await assert.rejects(promise,error=>error.name==='AbortError');assert.ok(calls.walk<=1);
});
test('真实域名拒绝码必须说明原因，失败和空结果不能缓存为正常候选',async()=>{
  const {adapter,store}=fixture();let calls=0;
  adapter.A.PlaceSearch=class{setPageIndex(){}searchNearBy(_,coords,radius,cb){calls++;cb('error','INVALID_USER_DOMAIN');}};
  const value=await adapter.nearby([121,31],PTAL.DEFAULTS,new AbortController().signal,()=>{});
  assert.equal(value.pois.length,0);assert.equal(value.warnings.length,2);assert.match(value.warnings[0],/白名单.*INVALID_USER_DOMAIN/);
  assert.equal(store.get('nearby-full:121,31:640:960',1),null);
  await adapter.nearby([121,31],PTAL.DEFAULTS,new AbortController().signal,()=>{});assert.equal(calls,4);
  store.put('nearby-full:121,31:640:960',{pois:[],warnings:[]});
  await adapter.nearby([121,31],PTAL.DEFAULTS,new AbortController().signal,()=>{});assert.equal(calls,6);
});
