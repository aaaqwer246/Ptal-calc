const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const tempRoot='E:\\Codex临时文件';
if(!fs.existsSync(tempRoot))throw Error('E盘临时目录不可用');
for(const name of ['TEMP','TMP','TMPDIR'])process.env[name]=tempRoot;
let pw;try{pw=require('playwright');}catch{pw=require(path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const root=path.resolve(__dirname,'..'),site='https://aaaqwer246.github.io/Ptal-calc/';
(async()=>{let browser;try{
  try{browser=await pw.chromium.launch({headless:true});}catch{browser=await pw.chromium.launch({channel:'msedge',headless:true});}
  const context=await browser.newContext(),workers=[],sdkKeys=[],errors=[];let defaultUnavailable=false;
  await context.route(/^https?:\/\//,async route=>{
    const url=new URL(route.request().url());
    if(url.href.startsWith(site)){
      const file=path.resolve(root,url.pathname.slice('/Ptal-calc/'.length)||'index.html');
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){await route.abort();return;}
      await route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});return;
    }
    if(url.hostname==='ptal-api.zhouguillaume111750.workers.dev'){
      if(defaultUnavailable&&url.pathname==='/api/map-config'){
        await route.fulfill({status:503,json:{error:{code:'MAP_NOT_CONFIGURED',message:'请在 Cloudflare Worker 中添加 AMAP_JS_KEY 和 AMAP_JS_SECRET'}},headers:{'Access-Control-Allow-Origin':new URL(site).origin}});return;
      }
      workers.push(url.pathname);const data=url.pathname==='/api/map-config'?{key:'shared-key',serviceHost:url.origin+'/_AMapService'}:{tips:[{name:'公共地点',location:'121,31'}]};
      await route.fulfill({json:data,headers:{'Access-Control-Allow-Origin':new URL(site).origin}});return;
    }
    if(url.hostname==='webapi.amap.com'&&url.pathname==='/maps'){
      sdkKeys.push(url.searchParams.get('key'));
      await route.fulfill({contentType:'application/javascript',body:`window.AMap={Map:class{constructor(id){document.getElementById(id).textContent='测试底图';}on(){}},Marker:class{},Circle:class{},Polyline:class{},PlaceSearch:class{},Walking:class{},AutoComplete:class{search(word,cb){cb('complete',{tips:[{name:'个人地点',location:[121,31]}]});}}};window.__ptalMapReady();`});return;
    }
    await route.abort();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(site);
  const checkText=async()=>assert.doesNotMatch(await page.locator('body').innerText(),/Cloudflare|Worker|AMAP_JS|wrangler|serviceHost/i);
  await checkText();
  await page.evaluate(()=>localStorage.setItem('ptal-map-config-v1',JSON.stringify({key:'saved-only-key'})));await page.reload();
  await page.locator('#map-input').fill('未补齐配置');await page.waitForFunction(()=>document.getElementById('place-status').textContent.includes('同时填写'));assert.equal(workers.length,0);
  await page.locator('#api-settings-toggle').click();await page.locator('#api-key').fill('personal-key');await page.getByRole('button',{name:'保存并应用',exact:true}).click();
  assert.match(await page.locator('#api-settings-status').innerText(),/同时填写/);assert.equal(workers.length,0);
  await page.locator('#api-security-code').fill('personal-code');await page.getByRole('button',{name:'保存并应用',exact:true}).click();
  await page.locator('#map-input').fill('公园');await page.waitForFunction(()=>document.getElementById('place-choices').textContent.includes('个人地点'));
  assert.equal(workers.length,0);assert.deepEqual(sdkKeys,['personal-key']);assert.deepEqual(await page.evaluate(()=>_AMapSecurityConfig),{securityJsCode:'personal-code'});
  await page.locator('#enable-map').click();await page.waitForFunction(()=>document.getElementById('map-state').textContent.includes('按需查询'));assert.equal(workers.length,0);
  await checkText();
  await page.locator('#api-key').fill('');await page.locator('#api-security-code').fill('');
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'保存并应用',exact:true}).click()]);
  await page.waitForFunction(()=>window.PTAL_MAP_CONFIG!==undefined);assert.equal(await page.evaluate(()=>PTAL_MAP_CONFIG.key),undefined);
  await page.locator('#map-input').fill('广场');await page.waitForFunction(()=>document.getElementById('place-choices').textContent.includes('公共地点'));
  assert.deepEqual(workers,['/api/tips']);
  await page.locator('#enable-map').click();await page.waitForFunction(()=>document.getElementById('map-state').textContent.includes('按需查询'));
  assert.deepEqual(workers,['/api/tips','/api/map-config']);assert.deepEqual(sdkKeys,['personal-key','shared-key']);
  assert.deepEqual(await page.evaluate(()=>_AMapSecurityConfig),{serviceHost:'https://ptal-api.zhouguillaume111750.workers.dev/_AMapService'});assert.deepEqual(errors,[]);
  await checkText();defaultUnavailable=true;await page.reload();await page.locator('#enable-map').click();
  await page.waitForFunction(()=>document.getElementById('search-status').textContent.includes('默认地图暂不可用'));await checkText();
  console.log('个人优先浏览器验证通过：半填拒绝、个人查询及地图不走Worker、清空后刷新并切回公共查询和地图；真实高德请求0次。');
}finally{await browser?.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
