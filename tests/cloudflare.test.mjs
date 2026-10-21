import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handle,digest} from '../cloudflare/worker.mjs';
import {parseOrder,deliveryRequest} from '../cloudflare/order-qr.mjs';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import vm from 'node:vm';

test('提供画面: 1札は単独API、複数札は一括API。部分提供と回収確認を区別する',async()=>{
 const f=fixture(),cash=await f.login(),hand=await f.login('handover');const o=await order(f,cash);
 assert.throws(()=>deliveryRequest([o],{[o.id+':1']:true},false),/回収/);
 const p=deliveryRequest([o],{[o.id+':1']:true},true);assert.equal(p.action,'deliver');assert.equal((await f.rpc(hand,p.action,p.payload)).ok,true);
 assert.equal((await f.rpc(cash,'returnTickets',{labels:['A'],orderIds:{A:o.id}})).ok,true);
 const a=await order(f,cash),b=await order(f,cash,'B'),both={[a.id+':1']:true,[b.id+':1']:true};
 const batch=deliveryRequest([a,b],both,true);assert.equal(batch.action,'deliverBatch');assert.equal((await f.rpc(hand,batch.action,batch.payload)).ok,true);
 assert.equal(deliveryRequest([{id:'partial',revision:1,items:[{number:1},{number:2}]}],{'partial:1':true},false).payload.collectTicket,false);
});

test('注文ページ: オフライン時は公開ページだけを復元し、注文APIとスタッフ一覧はキャッシュしない',async()=>{
 const listeners={},cache=new Map(),tasks=[];let online=true;
 vm.runInNewContext(fs.readFileSync(new URL('../.cloudflare-build/public-development/order-sw.js',import.meta.url),'utf8'),{
  URL,self:{location:{origin:'https://coffee.example'},skipWaiting(){},clients:{claim(){}},addEventListener(k,fn){listeners[k]=fn;}},
  caches:{async open(){return {async add(url){cache.set(url,new Response('offline order page'));},async put(url,response){cache.set(url,response);}};},async match(url){return cache.get(url);}},
  fetch:async()=>{if(!online)throw Error('offline');return new Response('live order page');}
 });
 listeners.install({waitUntil:p=>tasks.push(p)});await Promise.all(tasks);online=false;
 let result;listeners.fetch({request:new Request('https://coffee.example/order'),respondWith:p=>{result=p;},waitUntil:p=>tasks.push(p)});assert.equal(await(await result).text(),'offline order page');
 for(const path of ['/api/rpc','/','/legacy']){let intercepted=false;listeners.fetch({request:new Request('https://coffee.example'+path),respondWith(){intercepted=true;}});assert.equal(intercepted,false);}
});

test('注文QR: 実際に生成した画像から商品・個数・注文識別番号だけを復号できる',()=>{
 const data={v:1,id:crypto.randomUUID(),items:[{menuId:'blend-iced',quantity:2}]},qr=qrcode(0,'M');qr.addData(JSON.stringify(data));qr.make();
 const size=qr.getModuleCount(),scale=5,width=(size+8)*scale,pixels=new Uint8ClampedArray(width*width*4).fill(255);
 for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(qr.isDark(r,c))for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){const i=(((r+4)*scale+y)*width+(c+4)*scale+x)*4;pixels[i]=pixels[i+1]=pixels[i+2]=0;}
 assert.deepEqual(JSON.parse(jsQR(pixels,width,width).data),data);
});

test('注文QR: 数量・不明商品・重複商品・不正IDを拒否し、価格は登録メニューから計算',()=>{
 const menu=[{id:'a',price:600}],base={v:1,id:crypto.randomUUID(),items:[{menuId:'a',quantity:2,price:1}]};assert.equal(parseOrder({...base,price:1},menu).total,1200);
 for(const items of [[{menuId:'b',quantity:1}],[{menuId:'a',quantity:0}],[{menuId:'a',quantity:1.5}],[{menuId:'a',quantity:21}],[{menuId:'a',quantity:1},{menuId:'a',quantity:1}],[]])assert.throws(()=>parseOrder({...base,items},menu));
 assert.throws(()=>parseOrder({...base,id:'x'},menu));assert.throws(()=>parseOrder('x'.repeat(2001),menu));
});

test('注文QR: 別レジ・別札で同時読取しても1件だけ登録、返却後や取消後も再受付しない',async()=>{
 const f=fixture(),a=await f.login(),b=await f.login(),qr={v:1,id:crypto.randomUUID(),items:item};
 const rs=await Promise.all([f.rpc(a,'createOrder',{ticket:'A',qr,price:1}),f.rpc(b,'createOrder',{ticket:'B',qr,price:1})]);assert.equal(rs.filter(r=>r.ok).length,1);assert.equal(f.orders().length,1);
 const order=JSON.parse(f.orders()[0].data);assert.equal(order.total,500);assert.equal(order.payment,'cash');
 await f.rpc(a,'cancelOrder',{orderId:order.id,revision:1,ticketAtCashier:true});assert.equal((await f.rpc(b,'createOrder',{ticket:'C',qr})).ok,false);assert.equal(f.orders().length,1);
 // A new customer with an identical basket gets a different identifier.
 assert.equal((await f.rpc(a,'createOrder',{ticket:'C',qr:{...qr,id:crypto.randomUUID()}})).ok,true);
});

test('注文QR: 通信切断の再送は1件だけで、価格や個数の改ざんを受け付けない',async()=>{
 const f=fixture(),cash=await f.login(),qr={v:1,id:crypto.randomUUID(),items:item},payload={ticket:'A',qr};
 const first=await f.rpc(cash,'createOrder',payload);assert.equal(first.ok,true);const retry=await f.rpc(cash,'createOrder',payload);assert.equal(retry.repeated,true);assert.equal(f.orders().length,1);
 assert.equal((await f.rpc(cash,'createOrder',{ticket:'A',qr:{...qr,items:[{menuId:'blend-hot',quantity:2}]}})).ok,false);assert.equal(f.orders().length,1);
});

test('注文QR: 現金受領前に受付済みを確認でき、提供・返却後も受付済みのまま',async()=>{
 const f=fixture(),cash=await f.login(),display=await f.login('display'),qr={v:1,id:crypto.randomUUID(),items:item};
 assert.equal((await f.rpc(cash,'checkOrderQR',{qr})).registered,false);
 const r=await f.rpc(cash,'createOrder',{ticket:'A',qr}),o=r.snapshot.state.orders[0];
 assert.equal((await f.rpc(cash,'checkOrderQR',{qr})).ticket,'A');assert.equal((await f.rpc(display,'checkOrderQR',{qr})).ok,false);
 await f.rpc(cash,'cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:true});assert.equal((await f.rpc(cash,'checkOrderQR',{qr})).registered,true);
});

function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/0001_initial.sql',import.meta.url),'utf8'));
  const DB={failStep:-1,prepare(query){return {bind(...values){return {async first(){return sql.prepare(query).get(...values)||null;},async all(){return {results:sql.prepare(query).all(...values)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...values).changes)}};},_query:query,_values:values};}};},async batch(statements){
    sql.exec('BEGIN');try{const result=statements.map((s,i)=>{if(i===DB.failStep){DB.failStep=-1;throw Error('simulated outage');}return {meta:{changes:Number(sql.prepare(s._query).run(...s._values).changes)}};});sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}
  }};
  const env={DB,ADMIN_CODE:'admin-code-only-for-local-tests',APP_MODE:'preview',ASSETS:{fetch:()=>new Response('static asset')}};
  async function api(method,args,extra={}){const response=await handle(new Request('https://coffee.example/api/'+method,{method:'POST',headers:{'Content-Type':'application/json',...extra.headers},body:JSON.stringify({args})}),env);return response.json();}
  const login=async(role='cashier',code='')=>api('login',[{role,code}]);
  const rpc=(person,action,payload={},requestId=crypto.randomUUID())=>api('rpc',[person.token,action,payload,requestId]);
  return {env,sql,api,login,rpc,orders:()=>sql.prepare('SELECT * FROM orders').all(),events:()=>sql.prepare('SELECT * FROM events').all()};
}
const item=[{menuId:'blend-hot',quantity:1}];
const order=async(f,cash,ticket='A')=>{const r=await f.rpc(cash,'createOrder',{ticket,items:item});assert.equal(r.ok,true,JSON.stringify(r));return r.snapshot.state.orders.find(o=>o.ticket===ticket);};

test('Cloudflare: コードなし担当・管理者認証・表示専用の権限をサーバーで検証',async()=>{
  const f=fixture(),cash=await f.login(),display=await f.login('display');assert.equal(cash.role,'cashier');assert.equal(display.role,'display');
  assert.equal((await f.login('admin','wrong')).ok,false);assert.equal((await f.login('admin',f.env.ADMIN_CODE)).role,'admin');
  assert.equal((await f.rpc(display,'createOrder',{ticket:'A',items:item})).ok,false);assert.equal((await f.rpc(cash,'switchRole',{role:'admin'})).ok,false);
  assert.equal((await f.rpc(cash,'setWaitThreshold',{minutes:25})).ok,false);assert.equal(f.events().length,0);
  const admin=await f.login('admin',f.env.ADMIN_CODE);assert.equal((await f.rpc(admin,'setWaitThreshold',{minutes:25})).ok,true);assert.equal((await f.rpc(cash,'snapshot')).waitThresholdMinutes,25);
});

test('Cloudflare: 2時間セッションは読み取りで延長せず、操作で延長し、ログアウト後は復元不可',async()=>{
  const f=fixture(),cash=await f.login(),key=await digest(cash.token),before=f.sql.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(key).expires_at;
  await f.rpc(cash,'snapshot');assert.equal(f.sql.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(key).expires_at,before);
  const state=f.sql.prepare('SELECT data FROM sessions WHERE token_hash=?').get(key),person=JSON.parse(state.data);person.expiresAt=Date.now()+60000;
  f.sql.prepare('UPDATE sessions SET data=?,expires_at=? WHERE token_hash=?').run(JSON.stringify(person),person.expiresAt,key);
  await order(f,cash);assert.ok(f.sql.prepare('SELECT expires_at FROM sessions WHERE token_hash=?').get(key).expires_at>Date.now()+7100000);
  await f.api('logout',[cash.token]);assert.equal((await f.rpc(cash,'snapshot')).sessionExpired,true);
});

test('Cloudflare: 同じ札への同時登録は一方だけ成功し、データベースにも1注文だけ残る',async()=>{
  const f=fixture(),a=await f.login(),b=await f.login();
  const results=await Promise.all([f.rpc(a,'createOrder',{ticket:'A',items:item}),f.rpc(b,'createOrder',{ticket:'A',items:item})]);
  assert.equal(results.filter(x=>x.ok).length,1);assert.equal(f.orders().length,1);assert.equal(f.events().length,1);
});

test('Cloudflare: 同一操作IDの同時再送でも1イベント・1注文、本文の変更は拒否',async()=>{
  const f=fixture(),cash=await f.login(),id=crypto.randomUUID(),payload={ticket:'A',items:item};
  const results=await Promise.all([f.rpc(cash,'createOrder',payload,id),f.rpc(cash,'createOrder',payload,id)]);
  assert.ok(results.every(x=>x.ok));assert.equal(f.events().length,1);assert.equal(f.orders().length,1);assert.equal(results.filter(x=>x.repeated).length,1);
  assert.equal((await f.rpc(cash,'createOrder',{ticket:'B',items:item},id)).ok,false);assert.equal(f.orders().length,1);
});

test('Cloudflare: 4担当の別札への同時入力は欠落せず、二重提供は一方だけ成功',async()=>{
  const f=fixture(),cash=await f.login(),hand1=await f.login('handover'),hand2=await f.login('handover'),admin=await f.login('admin',f.env.ADMIN_CODE);
  const results=await Promise.all(['A','B','C','D'].map(ticket=>f.rpc(cash,'createOrder',{ticket,items:item})));assert.ok(results.every(r=>r.ok));assert.equal(f.orders().length,4);
  const o=results[0].snapshot.state.orders.find(o=>o.ticket==='A'),p={orderId:o.id,revision:o.revision,itemNumbers:[1],collectTicket:true};
  const delivered=await Promise.all([f.rpc(hand1,'deliver',p),f.rpc(hand2,'deliver',p)]);assert.equal(delivered.filter(r=>r.ok).length,1);
  assert.equal((await f.rpc(admin,'snapshot')).state.orders.length,4);
});

test('Cloudflare: 2札の一括提供は全件同時に反映し、競合なら全件未変更',async()=>{
  const f=fixture(),cash=await f.login(),hand=await f.login('handover'),a=await order(f,cash),b=await order(f,cash,'B');
  const p={orders:[a,b].map(o=>({orderId:o.id,revision:1,itemNumbers:[1],collectTicket:true}))};
  const r=await f.rpc(hand,'deliverBatch',p);assert.equal(r.ok,true);assert.ok(r.snapshot.state.orders.every(o=>o.collectedAt));
  const count=f.events().length;assert.equal((await f.rpc(hand,'deliverBatch',p)).ok,false);assert.equal(f.events().length,count);
});

test('Cloudflare: 札あり取消は即再使用し、遅れた取消再送が次の注文を解放しない',async()=>{
  const f=fixture(),cash=await f.login(),o=await order(f,cash),id=crypto.randomUUID(),p={orderId:o.id,revision:1,ticketAtCashier:true};
  assert.equal((await f.rpc(cash,'cancelOrder',p,id)).ok,true);const next=await order(f,cash);
  assert.equal((await f.rpc(cash,'cancelOrder',p,id)).repeated,true);const snap=await f.rpc(cash,'snapshot');assert.equal(snap.state.tickets[0].orderId,next.id);
  assert.equal(snap.state.orders.length,1);assert.equal(f.orders().length,2);
});

test('Cloudflare: 札なし取消も会計だけで受領でき、受け渡し回収は不要',async()=>{
  const f=fixture(),cash=await f.login(),hand=await f.login('handover'),o=await order(f,cash);
  assert.equal((await f.rpc(cash,'cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:false})).ok,true);
  assert.equal((await f.rpc(cash,'createOrder',{ticket:'A',items:item})).ok,false);assert.equal((await f.rpc(hand,'collectTicket',{orderId:o.id,revision:2})).ok,false);
  assert.equal((await f.rpc(cash,'returnTickets',{labels:['A'],orderIds:{A:o.id}})).ok,true);await order(f,cash);assert.equal(f.orders().length,2);
});

test('Cloudflare: D1トランザクション失敗は状態と履歴をロールバックし、同じIDで安全に再送',async()=>{
  const f=fixture(),cash=await f.login(),id=crypto.randomUUID();f.env.DB.failStep=1;
  const r=await f.rpc(cash,'createOrder',{ticket:'A',items:item},id);assert.equal(r.uncertain,true);assert.equal(f.orders().length,0);assert.equal(f.events().length,0);
  assert.equal((await f.rpc(cash,'createOrder',{ticket:'A',items:item},id)).ok,true);assert.equal(f.orders().length,1);
});

test('Cloudflare: 他サイト・不正JSON・巨大リクエストを拒否し、保存前に検証する',async()=>{
  const f=fixture();
  for(const [body,content,origin,status]of [['{}','text/plain','',415],['{','application/json','',400],['{"args":[]}','application/json','https://evil.example',403],['x'.repeat(32769),'application/json','',413]]){
    const r=await handle(new Request('https://coffee.example/api/login',{method:'POST',headers:{'Content-Type':content,...origin?{Origin:origin}:{}},body}),f.env);assert.equal(r.status,status);
  }
  assert.equal(f.events().length,0);
});

test('Cloudflare: 管理者コードを変えると以前の管理者セッションは失効し、一般担当には影響しない',async()=>{
  const f=fixture(),admin=await f.login('admin',f.env.ADMIN_CODE),cash=await f.login();f.env.ADMIN_CODE='another-code-only-for-local-tests';
  assert.equal((await f.rpc(admin,'snapshot')).sessionExpired,true);assert.ok((await f.rpc(cash,'snapshot')).state);
  delete f.env.ADMIN_CODE;assert.match((await f.login('admin','')).message,/未設定/);
});

test('Cloudflare: 検証版の公開画面は実APIを使い、旧Sheetsへ書き込む表示を残さない',()=>{
  const html=fs.readFileSync(new URL('../.cloudflare-build/public-development/index.html',import.meta.url),'utf8');
  assert.match(html,/window.TECHSPRESSO_CLOUDFLARE=true/);assert.match(html,/fetch\('\/api\//);assert.match(html,/Cloudflare検証版/);assert.match(html,/売上シミュレーションとは未接続/);
  assert.doesNotMatch(html,/BUILD_CLIENT|BUILD_LOGO|BUILD_STYLES/);
});

test('Cloudflare: 開発用とスタッフ用は異なるWorkerとDBを使い、画面の環境名も分離する',async()=>{
  const config=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.notEqual(config.name,config.env.dev.name);assert.notEqual(config.d1_databases[0].database_id,config.env.dev.d1_databases[0].database_id);
  assert.equal(config.vars.APP_MODE,'production');assert.equal(config.env.dev.vars.APP_MODE,'development');
  const production=fs.readFileSync(new URL('../.cloudflare-build/public-production/index.html',import.meta.url),'utf8');assert.match(production,/スタッフ用（公開環境）/);assert.doesNotMatch(production,/Cloudflare検証版（開発用）/);
  const dev=fixture(),live=fixture(),cash=await dev.login();await order(dev,cash);
  assert.equal(live.orders().length,0);assert.equal((await live.rpc(cash,'snapshot')).sessionExpired,true);
});
