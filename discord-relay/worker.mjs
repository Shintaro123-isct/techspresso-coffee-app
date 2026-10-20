// Notification-only relay. No Sheets access, arbitrary recipients, or token in requests.
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function authorized(actual,expected){
  if(typeof expected!=='string'||expected.length<32||expected.length>200)return false;
  if(typeof actual!=='string'||actual.length>220)return false;
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(actual)));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('Bearer '+expected)));
  let different=0;for(let i=0;i<a.length;i++)different|=a[i]^b[i];return different===0;
}
async function failure(response){
  let apiCode=0;try{const body=await response.json();if(Number.isSafeInteger(body.code)&&body.code>0)apiCode=body.code;}catch{}
  return reply({ok:false,code:response.status,apiCode});
}
async function timedSend(send,url,options){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{return await send(url,{...options,signal:controller.signal});}
  finally{clearTimeout(timer);}
}
export async function handle(request,env,send=(url,options)=>fetch(url,options)){
  if(new URL(request.url).pathname!=='/notify'||request.method!=='POST')return reply({ok:false},404);
  if(!await authorized(request.headers.get('Authorization'),env.RELAY_KEY))return reply({ok:false},401);
  if(!/^\d{17,20}$/.test(env.DISCORD_USER_ID||'')||typeof env.DISCORD_BOT_TOKEN!=='string'||env.DISCORD_BOT_TOKEN.length<20||/\s/.test(env.DISCORD_BOT_TOKEN))return reply({ok:false,code:0},503);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return reply({ok:false},415);
  // Bound the streamed body, including chunked requests with no Content-Length.
  let data='';const reader=request.body?.getReader();if(!reader)return reply({ok:false},400);
  const decoder=new TextDecoder();let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>10000){await reader.cancel();return reply({ok:false},413);}data+=decoder.decode(value,{stream:true});}data+=decoder.decode();
  let body;try{body=JSON.parse(data);}catch{return reply({ok:false},400);}
  if(!body||Object.keys(body).some(k=>k!=='content')||typeof body.content!=='string'||body.content.length>2000||!/^【TECHSPRESSO・(?:通知テスト|未提供注文の確認)】/.test(body.content))return reply({ok:false},400);
  const headers={'Authorization':'Bot '+env.DISCORD_BOT_TOKEN,'Content-Type':'application/json','User-Agent':'DiscordBot (https://script.google.com, 1.0)'};
  let stage='create-dm';
  try{
    const dm=await timedSend(send,'https://discord.com/api/v10/users/@me/channels',{method:'POST',headers,body:JSON.stringify({recipient_id:env.DISCORD_USER_ID}),redirect:'manual'});
    if(!dm.ok)return failure(dm);
    const {id}=await dm.json();if(!/^\d{17,20}$/.test(id||''))return reply({ok:false,code:0});
    stage='send-message';
    const message=await timedSend(send,'https://discord.com/api/v10/channels/'+id+'/messages',{method:'POST',headers,body:JSON.stringify({content:body.content,allowed_mentions:{parse:[]}}),redirect:'manual'});
    return message.ok?reply({ok:true,code:message.status}):failure(message);
  }catch(error){
    const reason=['TypeError','TimeoutError','AbortError','SyntaxError'].includes(error?.name)?error.name:'NetworkError';
    const message=String(error?.message||'');
    const detail=/redirect/i.test(message)?'redirect-mode':/invocation|receiver|this/i.test(message)?'fetch-binding':/signal|abort/i.test(message)?'abort-support':/header/i.test(message)?'request-header':/fetch|network/i.test(message)?'network-fetch':/function/i.test(message)?'missing-function':'other';
    console.warn(JSON.stringify({event:'discord-send-failed',stage,reason,detail}));return reply({ok:false,code:0});
  }
}
export default {fetch(request,env){return handle(request,env);}};
