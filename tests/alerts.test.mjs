import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture(){
  let now=Date.parse('2026-10-10T03:00:00Z'),held=false,fail=false;
  const properties=new Map([['DISCORD_ALERT_ENABLED','1'],['DISCORD_ALERT_BOT_TOKEN','test-token-for-unit-tests-only'],['DISCORD_ALERT_USER_ID','123456789012345678']]),calls=[],triggers=[];
  class Clock extends Date{static now(){return now;}}
  const state={orders:[]};
  const ctx=vm.createContext({Date:Clock,console,Utilities:{getUuid:()=> 'test-attempt'},PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties.get(k)||null,setProperty(k,v){assert.ok(v.length<9000);properties.set(k,v);return this;}})},LockService:{getScriptLock:()=>({tryLock(){if(held)return false;held=true;return true;},releaseLock(){held=false;}})},read_:()=>({state}),userError_:m=>Object.assign(new Error(m),{userSafe:true}),locked_:fn=>fn(),ScriptApp:{getProjectTriggers:()=>triggers,newTrigger:name=>({timeBased(){return this;},everyMinutes(){return this;},create(){const t={getHandlerFunction:()=>name};triggers.push(t);return t;}}),deleteTrigger(t){triggers.splice(triggers.indexOf(t),1);}},UrlFetchApp:{fetch(url,options){assert.equal(held,false,'HTTP must not hold order save lock');calls.push({url,options:{...options}});if(fail)throw Error('network failure with secret');return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({id:'223456789012345678'})};}}});
  vm.runInContext(fs.readFileSync(new URL('../src/alerts.gs',import.meta.url),'utf8'),ctx);
  const order=(id,age=16,extra={})=>({id,ticket:id,createdAt:new Date(now-age*60000).toISOString(),items:[{number:1},{number:2,deliveredAt:'done'}],...extra});
  return {ctx,properties,calls,state,triggers,order,advance:ms=>now+=ms,setHeld:v=>held=v,setFail:v=>fail=v};
}
test('当日・基準超過・未提供だけをDMし、宛先を固定してメンションせず秘密を返さない',()=>{
  const f=fixture();f.state.orders=[f.order('A'),f.order('B',15),f.order('C',32,{cancelled:true}),f.order('D',32,{returnedAt:'done'}),f.order('E',32,{items:[{deliveredAt:'done'}]}),f.order('F',1500)];
  f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,2);assert.equal(f.calls[0].url,'https://discord.com/api/v10/users/@me/channels');assert.equal(JSON.parse(f.calls[0].options.payload).recipient_id,'123456789012345678');
  const message=JSON.parse(f.calls[1].options.payload);assert.match(message.content,/札 A/);assert.match(message.content,/未提供 1杯/);for(const id of ['B','C','D','E','F'])assert.ok(!message.content.includes('札 '+id));assert.deepEqual(message.allowed_mentions,{parse:[]});assert.ok(!JSON.stringify(f.ctx.discordAlertStatus_()).includes('test-token'));
});
test('再チェック・重なった処理では重複せず、10分後に残っている注文だけを再通知',()=>{
  const f=fixture();f.state.orders=[f.order('A'),f.order('B')];f.ctx.checkDiscordAlerts_();f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,2);
  f.advance(60000);f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,2);f.state.orders[0].items.forEach(i=>i.deliveredAt='done');f.advance(9*60000);f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,4);assert.ok(!JSON.parse(f.calls[3].options.payload).content.includes('札 A'));assert.match(JSON.parse(f.calls[3].options.payload).content,/札 B/);
});
test('見出しは基準15分ではなく実経過時間で、25分と35分から強調する',()=>{
  const f=fixture();
  for(const [age,label] of [[24,'⚠️ 提供確認'],[25,'🔴 大幅遅延'],[34,'🔴 大幅遅延'],[35,'🚨 至急確認']]){
    const text=f.ctx.discordText_([f.order('A',age)],Date.parse('2026-10-10T03:00:00Z'),15);
    assert.ok(text.startsWith('【TECHSPRESSO・未提供注文の確認】'));
    assert.ok(text.includes('# '+label+'：受付から'+age+'分経過しています。'));
    assert.ok(text.includes('**札 A｜'+age+'分経過**'));
    assert.ok(!text.includes('受付から15分'));
  }
  const text=f.ctx.discordText_([f.order('A',25),f.order('B',35)],Date.parse('2026-10-10T03:00:00Z'),15);
  assert.match(text,/# 🚨 至急確認：受付から35分/);assert.match(text,/最も長く/);assert.match(text,/札 A｜25分/);assert.match(text,/札 B｜35分/);
});
test('通知OFF・保存ロック中・設定不足では外部送信せず、トリガーの再設定も重複しない',()=>{
  const f=fixture();f.triggers.push({getHandlerFunction:()=> 'cleanupExpiredNames_'});f.ctx.configureDiscordAlerts_(true);f.ctx.configureDiscordAlerts_(true);assert.equal(f.triggers.length,2);
  f.state.orders=[f.order('A')];f.setHeld(true);f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,0);f.setHeld(false);f.ctx.configureDiscordAlerts_(false);assert.equal(f.triggers.length,1);f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,0);
  f.properties.delete('DISCORD_ALERT_BOT_TOKEN');assert.throws(()=>f.ctx.configureDiscordAlerts_(true),/通知用Bot/);assert.equal(f.ctx.discordAlertStatus_().configured,false);
});
test('通信失敗は台帳を書き換えず短時間の再送を抑止し、秘密を含めず状態を記録する',()=>{
  const f=fixture();f.state.orders=[f.order('A')];const before=JSON.stringify(f.state);f.setFail(true);f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,1);assert.equal(JSON.stringify(f.state),before);assert.match(f.properties.get('DISCORD_ALERT_LAST_STATUS'),/通知失敗/);assert.ok(!f.properties.get('DISCORD_ALERT_LAST_STATUS').includes('secret'));f.advance(60000);f.ctx.checkDiscordAlerts_();assert.equal(f.calls.length,1);
});
test('多数の遅延注文でも10件ずつ通知し、本文と通知済み管理は上限内に収まる',()=>{
  const f=fixture();f.state.orders=Array.from({length:200},(_,i)=>f.order('00000000-0000-4000-8000-'+String(i).padStart(12,'0'),32));
  for(let i=0;i<10;i++){f.ctx.checkDiscordAlerts_();assert.ok(JSON.parse(f.calls.at(-1).options.payload).content.length<2000);f.advance(60000);}
  assert.equal(f.calls.length,20);assert.ok(f.properties.get('DISCORD_ALERT_STATE').length<9000);
});
test('Discordの失敗理由は番号のみ抽出し、レスポンス本文や秘密を表示しない',()=>{
  const f=fixture();
  for(const [status,body,expected] of [[401,{code:0,message:'private-token'},/Botトークン/],[403,{code:50007,message:'private-token'},/共通サーバー/],[404,{code:10013,message:'private-token'},/ユーザーID/],[429,{code:0,message:'private-token'},/送信制限/],[403,'secret HTML',/HTTP 403/]]){
    const failure=f.ctx.discordFailure_({getResponseCode:()=>status,getContentText:()=>typeof body==='string'?body:JSON.stringify(body)});
    const message=f.ctx.discordFailureText_(failure);assert.match(message,expected);assert.ok(!message.includes('private-token'));assert.ok(!message.includes('secret HTML'));assert.equal(failure.code,status);
  }
});
test('中継設定はHTTPSの専用経路だけを許可し、Botトークンを読み出さず送らない',()=>{
  const f=fixture();f.properties.set('DISCORD_ALERT_RELAY_URL','https://notify.example.workers.dev/notify');f.properties.set('DISCORD_ALERT_RELAY_KEY','a-safe-relay-key-at-least-32-characters');
  const config=f.ctx.discordConfig_();assert.ok(!('token' in config));assert.ok(!JSON.stringify(f.ctx.discordAlertStatus_()).includes(config.key));
  f.ctx.UrlFetchApp.fetch=(url,options)=>{assert.equal(url,config.relay);assert.deepEqual(Object.keys(JSON.parse(options.payload)),['content']);assert.ok(!options.payload.includes('test-token'));assert.equal(options.followRedirects,false);return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({ok:true,code:200})};};
  assert.equal(f.ctx.discordPost_(config,'test').ok,true);
  for(const url of ['http://notify.example.workers.dev/notify','https://evil.example/notify','https://notify.example.workers.dev/notify?token=secret']){f.properties.set('DISCORD_ALERT_RELAY_URL',url);assert.throws(()=>f.ctx.discordConfig_(),/中継/);}
});
