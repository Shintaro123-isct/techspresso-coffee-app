import core from '../.cloudflare-build/core.mjs';

const names={cashier:'会計担当',handover:'受け渡し担当',display:'表示専用',admin:'管理者'};
const ttl=2*60*60*1000;
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const fail=message=>{throw Object.assign(new Error(message),{userSafe:true});};
const now=()=>Date.now();
const uuid=()=>crypto.randomUUID();
export async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
function stable(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(stable).join(',')+']';return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';}
async function equal(a,b){const [x,y]=await Promise.all([digest(a),digest(b)]);let diff=0;for(let i=0;i<x.length;i++)diff|=x.charCodeAt(i)^y.charCodeAt(i);return diff===0;}
function stmt(env,sql,...args){return env.DB.prepare(sql).bind(...args);}

async function state(env){
  let row=await stmt(env,'SELECT version,data FROM app_state WHERE id=1').first();
  if(!row){
    const empty=core.empty(),event=core.prepare(empty,'admin','addTickets',{labels:'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')},{id:'initial',requestId:'initial',at:new Date().toISOString(),actor:'初期設定'});
    const seeded=core.apply(empty,event);seeded.requestIds=[];
    await stmt(env,'INSERT OR IGNORE INTO app_state(id,version,data) VALUES(1,?,?)',seeded.version,JSON.stringify(seeded)).run();
    row=await stmt(env,'SELECT version,data FROM app_state WHERE id=1').first();
  }
  return {version:row.version,value:JSON.parse(row.data)};
}
async function adminEpoch(env){return env.ADMIN_CODE?digest(env.ADMIN_CODE):'';}
function publicPerson(token,person){const {epoch,...safe}=person;return {...safe,token};}
async function session(env,token){
  if(typeof token!=='string'||token.length<20||token.length>100)fail('ログインし直してください。');
  const key=await digest(token),row=await stmt(env,'SELECT data,expires_at FROM sessions WHERE token_hash=?',key).first();
  if(!row||row.expires_at<=now())fail('ログインし直してください。');
  const person=JSON.parse(row.data);
  if(!names[person.role]||person.expiresAt!==row.expires_at||(person.baseRole==='admin'&&person.epoch!==await adminEpoch(env)))fail('ログインし直してください。');
  return {key,person};
}
async function saveSession(env,key,person,create=false){
  if(create){await stmt(env,'INSERT INTO sessions(token_hash,data,expires_at) VALUES(?,?,?)',key,JSON.stringify(person),person.expiresAt).run();return;}
  const result=await stmt(env,'UPDATE sessions SET data=?,expires_at=? WHERE token_hash=? AND expires_at>?',JSON.stringify(person),person.expiresAt,key,now()).run();
  if(result.meta.changes!==1)fail('ログインし直してください。');
}
async function login(env,input,request){
  if(!input||!names[input.role])fail('担当を選んでください。');
  const bucket=Math.floor(now()/60000),ip=request.headers.get('CF-Connecting-IP')||'local';
  const key='login:'+await digest(bucket+'|'+ip);
  const rate=await stmt(env,'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',key,(bucket+2)*60000).first();
  if(rate.count>30)fail('ログインの試行が多いため、1分後にもう一度お試しください。');
  if(input.role==='admin'){
    if(typeof env.ADMIN_CODE!=='string'||env.ADMIN_CODE.length<12)fail('管理者コードは未設定です。CloudflareのSecretにADMIN_CODEを設定してください。');
    if(typeof input.code!=='string'||input.code.length>200||!await equal(input.code,env.ADMIN_CODE))fail('利用コードを確認してください。');
  }
  const token=uuid()+uuid(),person={name:names[input.role],role:input.role,baseRole:input.role==='admin'?'admin':'general',expiresAt:now()+ttl,epoch:input.role==='admin'?await adminEpoch(env):'general'};
  await saveSession(env,await digest(token),person,true);await state(env);
  return publicPerson(token,person);
}
async function snapshot(env,person,provided){
  const current=provided||await state(env),view=core.view(current.value,person.role);
  if(person.role==='admin'){
    const closed=await stmt(env,"SELECT data FROM orders WHERE returned_at<>'' ORDER BY returned_at DESC,created_at DESC LIMIT 200").all();
    view.orders.push(...closed.results.map(row=>JSON.parse(row.data)));
  }
  const setting=await stmt(env,"SELECT value FROM settings WHERE key='wait_minutes'").first();
  return {state:view,menu:core.menu,serverTime:new Date().toISOString(),retentionDays:30,waitThresholdMinutes:Number(setting?.value||15),expiresAt:person.expiresAt,cloudflare:{mode:env.APP_MODE||'preview',sheetsConnected:false},discordAlerts:{enabled:false,configured:false,lastStatus:'Cloudflare検証版の通知は未接続です。既存アプリの通知はそのままです。'}};
}
function changedOrders(value,event){
  const d=event.data;
  const ids=event.type==='createOrder'?[d.id]:event.type==='deliverBatch'?d.orders.map(o=>o.orderId):event.type==='returnTickets'?d.returns.map(o=>o.orderId):d.orderId?[d.orderId]:[];
  return value.orders.filter(o=>ids.includes(o.id));
}
async function repeated(env,requestId,signature,person){
  const prior=await stmt(env,'SELECT signature FROM events WHERE request_id=?',requestId).first();
  if(!prior)return null;
  if(prior.signature!==signature)fail('同じ操作IDで異なる内容は保存できません。元の操作を確認してください。');
  return {ok:true,repeated:true,snapshot:await snapshot(env,person)};
}
export async function mutate(env,auth,action,payload,requestId){
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(requestId))fail('操作IDが不正です。画面を開き直してください。');
  // Check authorization before replay lookup so a display-only caller cannot replay a write.
  const allowed={cashier:['createOrder','returnTickets','cancelOrder'],handover:['deliver','deliverBatch','collectTicket'],display:[],admin:['createOrder','returnTickets','cancelOrder','deliver','deliverBatch','collectTicket','addTickets','setTicketActive']};
  if(!allowed[auth.person.role]?.includes(action))fail('この担当では操作できません。');
  const signature=await digest(stable({action,payload}));
  const seen=await repeated(env,requestId,signature,auth.person);if(seen)return seen;
  for(let attempt=0;attempt<4;attempt++){
    const current=await state(env),value=current.value;
    let event;try{event=core.prepare(value,auth.person.role,action,payload,{id:uuid(),requestId,at:new Date().toISOString(),actor:auth.person.name});}
    catch(error){const again=await repeated(env,requestId,signature,auth.person);if(again)return again;throw error;}
    core.apply(value,event);const changed=changedOrders(value,event);
    // Keep only circulating orders in the frequently read row; history is independently indexed.
    value.orders=value.orders.filter(o=>!o.returnedAt);value.requestIds=[];
    const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).length>1500000)fail('対応中の注文が多いため保存できません。管理者へ連絡してください。');
    const touched={...auth.person,expiresAt:now()+ttl},commitId=uuid();
    const guard='EXISTS (SELECT 1 FROM app_state WHERE id=1 AND version=? AND last_commit_id=?)';
    const writes=[stmt(env,"UPDATE app_state SET version=?,data=?,last_commit_id=? WHERE id=1 AND version=? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>? AND json_extract(data,'$.role')=?)",value.version,raw,commitId,current.version,auth.key,now(),auth.person.role),
      stmt(env,`INSERT INTO events(request_id,signature,event,created_at) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(request_id) DO NOTHING`,requestId,signature,JSON.stringify(event),event.at,value.version,commitId)];
    for(const order of changed)writes.push(stmt(env,`INSERT INTO orders(id,created_at,returned_at,data) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET returned_at=excluded.returned_at,data=excluded.data`,order.id,order.createdAt,order.returnedAt||'',JSON.stringify(order),value.version,commitId));
    writes.push(stmt(env,`UPDATE sessions SET data=?,expires_at=? WHERE token_hash=? AND ${guard}`,JSON.stringify(touched),touched.expiresAt,auth.key,value.version,commitId));
    const results=await env.DB.batch(writes);
    if(results[0].meta.changes===1)return {ok:true,snapshot:await snapshot(env,touched,{value,version:value.version})};
    const again=await repeated(env,requestId,signature,auth.person);if(again)return again;
    const row=await stmt(env,'SELECT data,expires_at FROM sessions WHERE token_hash=?',auth.key).first();
    if(!row||row.expires_at<=now()||JSON.parse(row.data).role!==auth.person.role)fail('ログインし直してください。');
  }
  fail('ほかの端末の記録を保存中です。少し待って同じ操作を再送してください。');
}
async function rpc(env,args){
  const [token,action,payload={},requestId]=args,auth=await session(env,token),person=auth.person;
  if(person.role==='display'&&action!=='snapshot'&&action!=='switchRole')fail('表示専用では記録や設定を変更できません。');
  if(action==='snapshot')return snapshot(env,person);
  if(action==='switchRole'){
    if(!names[payload.role]||(payload.role==='admin'&&person.baseRole!=='admin'))fail('管理者は管理者用コードでログインしてください。');
    const next={...person,role:payload.role,name:names[payload.role],expiresAt:now()+ttl};await saveSession(env,auth.key,next);return {ok:true,person:publicPerson(token,next)};
  }
  if(action==='setWaitThreshold'){
    if(person.role!=='admin')fail('管理者だけが操作できます。');
    const minutes=Number(payload.minutes);if(!Number.isInteger(minutes)||minutes<1||minutes>180)fail('基準は1〜180分の整数で入力してください。');
    await stmt(env,"INSERT INTO settings(key,value) VALUES('wait_minutes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(minutes)).run();
    person.expiresAt=now()+ttl;await saveSession(env,auth.key,person);return {ok:true,minutes};
  }
  if(['syncSheets','setDiscordAlerts','testDiscordAlerts','removeNames'].includes(action)){
    if(person.role!=='admin')fail('管理者だけが操作できます。');
    fail('Cloudflare検証版では、この外部連携・管理処理は未接続です。旧アプリの記録には影響しません。');
  }
  return mutate(env,auth,action,payload,requestId);
}
export async function handle(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/health')return json({ok:true,service:'techspresso-coffee-app',mode:env.APP_MODE||'preview',storage:'D1',sheetsConnected:false});
  if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  if(request.method!=='POST')return json({ok:false,message:'POSTが必要です。'},405);
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({ok:false,message:'別のサイトからは操作できません。'},403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({ok:false,message:'JSONを送信してください。'},415);
  if(Number(request.headers.get('Content-Length')||0)>32768)return json({ok:false,message:'送信内容が大きすぎます。'},413);
  const method=url.pathname.slice(5);
  if(!['login','logout','rpc','staffOptions'].includes(method))return json({ok:false,message:'操作が見つかりません。'},404);
  try{
    const raw=await request.text();if(new TextEncoder().encode(raw).length>32768)return json({ok:false,message:'送信内容が大きすぎます。'},413);
    let body;try{body=JSON.parse(raw);}catch{ return json({ok:false,message:'JSONを確認してください。'},400); }
    if(!Array.isArray(body?.args)||body.args.length>4)return json({ok:false,message:'入力を確認してください。'},400);
    let result;
    if(method==='login')result=await login(env,body.args[0],request);
    else if(method==='logout'){
      if(typeof body.args[0]==='string')await stmt(env,'DELETE FROM sessions WHERE token_hash=?',await digest(body.args[0])).run();result=true;
    }else if(method==='staffOptions')result=Object.values(names);
    else result=await rpc(env,body.args);
    return json(result);
  }catch(error){
    const message=error.userSafe?error.message:'保存状態を確認できません。同じ操作を再送して確認してください。';
    const result={ok:false,message,uncertain:!error.userSafe,sessionExpired:message.includes('ログインし直')};
    return json(result,method==='rpc'?200:error.userSafe?400:503);
  }
}
export default {fetch:handle};
