// 高德官方 serviceHost 接入；只开放本工具底图初始化和样式接口。
const paths=new Map([
  ['/_AMapService/v4/map/init','https://restapi.amap.com/v4/map/init'],
  ['/_AMapService/v4/map/styles','https://webapi.amap.com/v4/map/styles']
]);
export const isMapPath=path=>paths.has(path);
export function mapParams(url,key){
  if(!isMapPath(url.pathname)||url.search.length>8192)throw Error('不支持的地图请求');
  const params=new URLSearchParams(url.searchParams);
  if([...params].length>32)throw Error('地图参数过多');
  for(const [name,value] of params){
    if(!/^[a-zA-Z0-9_]+$/.test(name)||value.length>2048||/[\x00-\x1f]/.test(value)||params.getAll(name).length!==1)throw Error('地图参数格式错误');
    if(['url','host','target','proxy','jscode','sig'].includes(name.toLowerCase()))throw Error('不允许的地图参数');
    if(name==='key'&&value!==key)throw Error('地图 Key 与站点配置不匹配');
    if(['callback','jsonp'].includes(name)&&!/^[$A-Z_a-z][\w$]*(?:\.[$A-Z_a-z][\w$]*)*$/.test(value))throw Error('地图回调格式错误');
  }
  params.set('key',key);
  return params;
}
export async function forwardMap(url,params,env){
  const target=new URL(paths.get(url.pathname));
  params.set('jscode',env.AMAP_JS_SECRET);target.search=params.toString();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(target,{signal:controller.signal,redirect:'manual',cache:'no-store'});
    if(!response.ok)return Response.json({error:{code:'MAP_UPSTREAM',message:'高德地图服务异常，请稍后重试'}},{status:502});
    const type=response.headers.get('Content-Type')||'';
    if(!/(?:json|javascript)/i.test(type))return Response.json({error:{code:'MAP_RESPONSE',message:'高德地图响应格式异常'}},{status:502});
    const body=await response.text();
    if(body.includes(env.AMAP_JS_SECRET)||(env.AMAP_KEY&&body.includes(env.AMAP_KEY)))return Response.json({error:{code:'MAP_RESPONSE',message:'高德地图响应异常'}},{status:502});
    return new Response(body,{headers:{'Content-Type':type,'Cache-Control':'no-store'}});
  }catch(error){return Response.json({error:{code:'MAP_UNAVAILABLE',message:error.name==='AbortError'?'高德地图请求超时':'高德地图连接失败'}},{status:error.name==='AbortError'?504:502});}
  finally{clearTimeout(timer);}
}
