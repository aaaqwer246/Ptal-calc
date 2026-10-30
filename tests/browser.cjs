const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
let playwright;try{playwright=require('playwright');}catch{playwright=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const tempRoot='E:\\Codex临时文件';
if(!fs.existsSync(tempRoot))throw new Error('E:\\Codex临时文件 不可用，无法生成浏览器测试中间文件');
for(const name of ['TEMP','TMP','TMPDIR'])process.env[name]=tempRoot;
const root=path.resolve(__dirname,'..'),artifacts=path.join(tempRoot,'ptal-browser-check');
fs.mkdirSync(artifacts,{recursive:true});
async function mockAMap(){
  window.fake={walk:0,nearby:0,search:0,tips:0,details:0,tipWords:[],slow:false,fail:false,map:null};
  class MapView{
    constructor(id){fake.map=this;this.handlers={};document.getElementById(id).replaceChildren(Object.assign(document.createElement('div'),{className:'map-placeholder',textContent:'自动化测试地图 · 不连接高德'}));}
    on(name,fn){this.handlers[name]=fn;}add(){}remove(){}setCenter(){}setFitView(){}
    click(lng,lat){this.handlers.click({lnglat:{getLng:()=>lng,getLat:()=>lat}});}
  }
  class Overlay{constructor(options){this.options=options;}}
  class PlaceSearch{
    constructor(options){this.options=options;}setPageIndex(page){this.page=page;}
    search(text,cb){fake.search++;setTimeout(()=>cb('complete',{poiList:{pois:[{name:text,location:{lng:121.4737,lat:31.2304},address:'测试地址'}]}}),10);}
    getDetails(id,cb){fake.details++;setTimeout(()=>cb('complete',{poiList:{pois:[{name:'世纪公园北门',location:[121.4737,31.2304]}]}}),5);}
    searchNearBy(_,origin,radius,cb){
      if(fake.domainError){setTimeout(()=>cb('error','INVALID_USER_DOMAIN'),5);return;}
      fake.nearby++;const isBus=this.options.type==='150700';
      const pois=isBus?[
        {id:'b1',name:'测试近站(公交站)',type:'公交车站',address:'71路;72路',location:{lng:121.474,lat:31.231}},
        {id:'b2',name:'测试远站(公交站)',type:'公交车站',address:'71路',location:{lng:121.475,lat:31.231}},
        {id:'b3',name:'无法到达(公交站)',type:'公交车站',address:'99路',location:{lng:121.476,lat:31.231}}
      ]:[{id:'m1',name:'测试地铁站(地铁站)',type:'地铁站',address:'地铁2号线;3号线(在建)',location:{lng:121.477,lat:31.231}}];
      setTimeout(()=>cb('complete',{poiList:{count:pois.length,pois}}),fake.slow?150:5);
    }
  }
  class Walking{
    search(origin,dest,cb){fake.walk++;const bad=dest[0]===121.476||fake.fail,ms=fake.slow?1000:5;
      // 近坐标站路线反而长，以验证实际步行长度而非几何距离决定同线最近站。
      const distance=dest[0]===121.474?600:dest[0]===121.475?200:800;
      setTimeout(()=>bad?cb('no_data',{}):cb('complete',{routes:[{distance,steps:[{path:[origin,dest]}]}]}),ms);
    }
  }
  class AutoComplete{search(word,cb){fake.tips++;fake.tipWords.push(word);const delay=word==='旧地点'?800:5;setTimeout(()=>cb('complete',{tips:[{id:'gate-east',name:word+'东门',district:'上海市浦东新区',address:'测试地址',location:[121.4737,31.2304]},{id:'gate-north',name:word+'北门',location:[]}]}),delay);}}
  window.AMap={Map:MapView,Marker:Overlay,Circle:Overlay,Polyline:Overlay};
  window.PTAL_DEPLOYMENT.workerUrl='https://mock-worker.test';
  window.PTALWorker.services=()=>({PlaceSearch,Walking,AutoComplete});
}
(async()=>{
  let browser;
  try{
    try{browser=await playwright.chromium.launch({headless:true});}catch{browser=await playwright.chromium.launch({channel:'msedge',headless:true});}
    const context=await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true});
    const errors=[],external=[];
    await context.route(/^https?:\/\//,route=>{external.push(route.request().url());return route.abort();});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    const url=pathToFileURL(path.join(root,'index.html')).href;
    await page.goto(url);await page.waitForFunction(()=>document.getElementById('quota-status').textContent.length>0);
    assert.equal(external.length,0,'打开页面不应发起高德请求');assert.equal(await page.locator('#ai-value').innerText(),'—');
    assert.equal(await page.locator('#api-settings').isVisible(),false,'默认使用站点地图，无需填写个人Key');
    await page.locator('#api-settings-toggle').click();
    assert.equal(await page.locator('#api-use-file').count(),0,'统一使用浏览器配置');
    await page.locator('#api-key').fill('test-browser-key');await page.locator('#api-security-code').fill('test-browser-code');await page.getByRole('button',{name:'保存并应用',exact:true}).click();
    await page.reload();assert.equal(await page.evaluate(()=>PTAL_MAP_CONFIG.key),'test-browser-key','刷新后读取浏览器配置');
    const form=page.locator('#add-form');await form.locator('[name=route]').fill('71路');await form.locator('[name=stop]').fill('测试站');await form.locator('[name=distance]').fill('400');await form.locator('[name=freq]').fill('6');await form.locator('button').click();
    assert.equal(await page.locator('#ai-value').innerText(),'2.50');assert.equal(await page.locator('#band-code').innerText(),'1a');
    await page.locator('#breakdown-body [data-field=freq]').fill('12');await page.locator('#breakdown-body [data-field=freq]').press('Tab');
    assert.equal(await page.locator('#ai-value').innerText(),'3.16');
    await page.locator('#settings-form [name=speed]').fill('40');assert.equal(await page.locator('#ai-value').innerText(),'2.07');
    await page.locator('#reset-settings').click();assert.equal(await page.locator('#ai-value').innerText(),'3.16');
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-json').click()]);
    const saved=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(saved.services[0].freq,12);assert.ok(!JSON.stringify(saved).includes('securityJsCode'));assert.ok(!JSON.stringify(saved).includes('PTAL_MAP_CONFIG'));
    const [csv]=await Promise.all([page.waitForEvent('download'),page.locator('#export-csv').click()]);assert.ok(fs.readFileSync(await csv.path(),'utf8').includes('AWT(min)'));
    await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'手机页面不应整体横向溢出');await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});
    await page.setViewportSize({width:1440,height:1080});
    const malicious={version:1,services:[{mode:'bus',route:'<img src=x onerror="window.xss=true">',stop:'<script>window.xss=true</script>',distance:400,freq:6}]};
    await page.locator('#import-file').setInputFiles({name:'safe.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(malicious))});
    await page.waitForFunction(()=>document.getElementById('search-status').textContent.includes('已导入'));
    assert.equal(await page.evaluate(()=>window.xss),undefined);assert.equal(await page.locator('#breakdown-body img').count(),0);
    await page.locator('#import-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{bad')});await page.waitForFunction(()=>document.getElementById('search-status').textContent.includes('导入失败'));assert.equal(await page.locator('#breakdown-body tr').count(),1);
    await page.locator('#clear-all').click();await page.evaluate(mockAMap);
    const input=page.locator('#map-input');
    await input.fill('世');await page.waitForTimeout(80);await input.fill('世纪');await page.waitForTimeout(80);await input.fill('世纪公园');
    await page.waitForFunction(()=>document.getElementById('place-choices').textContent.includes('世纪公园东门')&&!document.getElementById('place-choices').hidden);
    assert.equal(await page.evaluate(()=>fake.tips),1,'快速输入只请求最后一个关键字');assert.equal(await page.evaluate(()=>fake.map),null,'联想不应加载底图');assert.equal(await page.evaluate(()=>fake.nearby+fake.walk),0);
    await input.press('ArrowDown');assert.equal(await page.locator('#place-option-0').getAttribute('aria-selected'),'true');await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false');
    await input.fill('');await input.fill('世纪公园');await page.waitForFunction(()=>!document.getElementById('place-choices').hidden);assert.equal(await page.evaluate(()=>fake.tips),1,'重复关键字复用联想缓存');
    await input.fill('旧地点');await page.waitForFunction(()=>fake.tipWords.includes('旧地点'));await input.fill('新地点');await page.waitForFunction(()=>document.getElementById('place-choices').textContent.includes('新地点东门'));await page.waitForTimeout(900);assert.ok(!(await page.locator('#place-choices').innerText()).includes('旧地点'));
    const beforeComposition=await page.evaluate(()=>fake.tips);await input.dispatchEvent('compositionstart');await input.fill('pin yin');await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>fake.tips),beforeComposition);await input.fill('人民公园');await input.dispatchEvent('compositionend');await page.waitForFunction(()=>document.getElementById('place-choices').textContent.includes('人民公园东门'));assert.equal(await page.evaluate(()=>fake.tips),beforeComposition+1);
    const beforeClear=await page.evaluate(()=>fake.tips);await input.fill('还在输入的门');await page.locator('#clear-all').click();await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>fake.tips),beforeClear);assert.equal(await input.getAttribute('aria-expanded'),'false');
    await page.locator('#enable-map').click();await page.waitForFunction(()=>document.getElementById('map-state').textContent.includes('按需查询'));
    await page.locator('#map-input').fill('人民广场');assert.equal(await page.evaluate(()=>fake.search),0);
    await page.evaluate(()=>fake.map.click(121.4737,31.2304));assert.deepEqual(await page.evaluate(()=>[fake.nearby,fake.walk]),[0,0]);
    await page.locator('#search-btn').click();await page.waitForFunction(()=>!document.getElementById('cancel-btn').hidden);await page.waitForFunction(()=>document.getElementById('cancel-btn').hidden);
    assert.equal(await page.evaluate(()=>fake.walk),4);assert.equal(await page.locator('#bus-count').innerText(),'2');assert.equal(await page.locator('#rail-count').innerText(),'1');
    const nearest=page.locator('#breakdown-body tr').filter({hasText:'测试远站'});assert.ok((await nearest.innerText()).includes('计入'),'同线必须选择实际步行200米的站');
    assert.ok((await page.locator('#quality-note').innerText()).includes('规划失败'));assert.ok((await page.locator('#breakdown-body').innerText()).includes('未取得'));
    const callsBefore=await page.evaluate(()=>fake.walk+fake.nearby);await page.locator('#search-btn').click();await page.waitForFunction(()=>document.getElementById('cancel-btn').hidden&&document.getElementById('search-status').textContent.includes('候选'));
    assert.equal(await page.evaluate(()=>fake.walk+fake.nearby),callsBefore+1,'仅失败路线重新尝试，成功结果与站点应复用');
    const countBeforePath=await page.evaluate(()=>fake.walk+fake.nearby);await page.locator('[data-action=path]').first().click();assert.equal(await page.evaluate(()=>fake.walk+fake.nearby),countBeforePath);
    await page.locator('#settings-form [name=busMax]').fill('800');assert.equal(await page.locator('#result-state').innerText(),'范围待更新');assert.equal(await page.evaluate(()=>fake.walk+fake.nearby),countBeforePath);await page.locator('#reset-settings').click();
    await page.reload();await page.evaluate(mockAMap);await page.locator('#enable-map').click();await page.waitForFunction(()=>!document.getElementById('search-btn').disabled);await page.evaluate(()=>fake.map.click(121.4737,31.2304));await page.locator('#search-btn').click();await page.waitForFunction(()=>document.getElementById('search-status').textContent.includes('候选接入点已处理'));
    assert.equal(await page.evaluate(()=>fake.nearby),2);assert.equal(await page.evaluate(()=>fake.walk),4,'刷新后不复用持久化接口数据');
    await page.locator('#force-refresh').check();await page.locator('#search-btn').click();await page.waitForFunction(()=>document.getElementById('cancel-btn').hidden&&document.getElementById('search-status').textContent.includes('候选接入点已处理'));assert.equal(await page.evaluate(()=>fake.nearby),4);assert.equal(await page.evaluate(()=>fake.walk),8);
    await page.evaluate(()=>fake.slow=true);await page.locator('#search-btn').click();await page.locator('#clear-all').click();await page.waitForTimeout(1500);assert.equal(await page.locator('#ai-value').innerText(),'—');assert.equal(await page.locator('#bus-count').innerText(),'0');
    await page.evaluate(()=>{fake.slow=false;fake.fail=true;fake.map.click(121.48,31.24);});await page.locator('#search-btn').click();await page.waitForFunction(()=>document.getElementById('cancel-btn').hidden&&document.getElementById('search-status').textContent.includes('候选接入点已处理'));assert.equal(await page.locator('#ai-value').innerText(),'—');assert.equal(await page.locator('#band-code').innerText(),'—');
    await page.locator('#map-input').fill('测试地点');await page.locator('#map-input').press('Enter');await page.waitForFunction(()=>!document.getElementById('place-choices').hidden);assert.equal(await page.evaluate(()=>fake.search),0);assert.ok(await page.evaluate(()=>fake.tips)>0);
    await page.evaluate(()=>{fake.domainError=true;fake.map.click(121.49,31.25);});await page.locator('#search-btn').click();await page.waitForFunction(()=>document.getElementById('cancel-btn').hidden&&document.getElementById('search-status').textContent.includes('候选检索失败'));
    assert.ok((await page.locator('#search-status').innerText()).includes('白名单'));assert.equal(await page.locator('#ai-value').innerText(),'—');assert.equal(await page.locator('#result-state').innerText(),'查询失败');assert.ok((await page.locator('#candidate-summary').innerText()).includes('接口请求失败'));
    await page.evaluate(()=>{fake.domainError=false;fake.fail=false;});await input.fill('世纪公园');await page.waitForFunction(()=>!document.getElementById('place-choices').hidden);await input.press('ArrowDown');await input.press('ArrowDown');await input.press('Enter');await page.waitForFunction(()=>document.getElementById('cancel-btn').hidden&&document.getElementById('location-label').textContent.includes('世纪公园北门'));assert.equal(await page.evaluate(()=>fake.details),1,'无坐标入口通过POI详情定位');
    assert.equal(external.length,0,'测试禁止消耗任何外部 API');assert.deepEqual(errors,[]);
    console.log('浏览器回归通过：输入联想、防抖、中文输入法、门/入口候选、键盘选择、无坐标详情、联想缓存、旧响应取消、离线零请求、编辑重算、JSON/CSV、手机布局、实际步行去重、域名失败提示。真实高德请求：0。');
  }finally{await browser?.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
