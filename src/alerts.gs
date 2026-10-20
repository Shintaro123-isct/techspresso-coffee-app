// Notifications run separately from order saving. Never return/log the Bot secret.
var DISCORD_ALERT_={enabled:'DISCORD_ALERT_ENABLED',token:'DISCORD_ALERT_BOT_TOKEN',user:'DISCORD_ALERT_USER_ID',state:'DISCORD_ALERT_STATE',handler:'checkDiscordAlerts_',intervalMs:600000};
function discordConfig_(){
  var p=PropertiesService.getScriptProperties(),relay=p.getProperty('DISCORD_ALERT_RELAY_URL'),key=p.getProperty('DISCORD_ALERT_RELAY_KEY');
  if(relay||key){if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/notify$/.test(relay||'')||typeof key!=='string'||key.length<32||key.length>200||/\s/.test(key))throw userError_('DM送信中継のURLと接続キーを確認してください。');return {relay:relay,key:key};}
  var token=p.getProperty(DISCORD_ALERT_.token),user=p.getProperty(DISCORD_ALERT_.user);
  if(typeof token!=='string'||token.length<20||token.length>300||/\s/.test(token)||!/^\d{17,20}$/.test(user||''))throw userError_('通知用BotトークンとDiscordユーザーIDをスクリプトプロパティに設定してください。');
  return {token:token,user:user};
}
function discordAlertStatus_(){
  var p=PropertiesService.getScriptProperties(),valid=true;try{discordConfig_();}catch(ignore){valid=false;}return {enabled:p.getProperty(DISCORD_ALERT_.enabled)==='1',configured:valid,lastStatus:p.getProperty('DISCORD_ALERT_LAST_STATUS')||'未設定'};
}
function configureDiscordAlerts_(enabled){
  return locked_(function(){
    var p=PropertiesService.getScriptProperties();
    if(enabled){discordConfig_();if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()===DISCORD_ALERT_.handler;}))ScriptApp.newTrigger(DISCORD_ALERT_.handler).timeBased().everyMinutes(1).create();}
    else ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===DISCORD_ALERT_.handler;}).forEach(function(t){ScriptApp.deleteTrigger(t);});
    p.setProperty(DISCORD_ALERT_.enabled,enabled?'1':'0');p.setProperty('DISCORD_ALERT_LAST_STATUS',enabled?'監視中（約1分ごと）':'停止中');return {ok:true};
  });
}
function overdueToday_(state,now,threshold){
  var day=new Date(now+9*3600000).toISOString().slice(0,10);
  return state.orders.filter(function(o){var at=Date.parse(o.createdAt);return Number.isFinite(at)&&new Date(at+9*3600000).toISOString().slice(0,10)===day&&!o.cancelled&&!o.returnedAt&&o.items.some(function(i){return !i.deliveredAt;})&&now-at>threshold*60000;}).sort(function(a,b){return Date.parse(a.createdAt)-Date.parse(b.createdAt);});
}
function discordText_(orders,now,threshold){
  var ages=orders.map(function(o){return Math.max(0,Math.floor((now-Date.parse(o.createdAt))/60000));}),oldest=Math.max.apply(null,ages);
  function severity(minutes){return minutes>=35?'🚨 至急確認':minutes>=25?'🔴 大幅遅延':'⚠️ 提供確認';}
  var lines=['【TECHSPRESSO・未提供注文の確認】','# '+severity(oldest)+'：受付から'+oldest+'分経過しています。'];
  if(orders.length>1)lines.push('最も長く待っている注文の経過時間です。各札の時間は以下をご確認ください。');
  orders.forEach(function(o,index){var t=new Date(Date.parse(o.createdAt)+9*3600000).toISOString().slice(11,16);lines.push(severity(ages[index])+'｜**札 '+o.ticket+'｜'+ages[index]+'分経過**｜受付 '+t+'｜未提供 '+o.items.filter(function(i){return !i.deliveredAt;}).length+'杯');});
  lines.push('実物とアプリの最新一覧を確認してください。音による通知はありません。');return lines.join('\n');
}
function discordPost_(config,content){
  if(config.relay)return discordRelayPost_(config,content);
  try {
    var options={method:'post',contentType:'application/json',headers:{Authorization:'Bot '+config.token,'User-Agent':'DiscordBot (https://script.google.com, 1.0)'},muteHttpExceptions:true,followRedirects:false};
    options.payload=JSON.stringify({recipient_id:config.user});var dm=UrlFetchApp.fetch('https://discord.com/api/v10/users/@me/channels',options),code=dm.getResponseCode();if(code<200||code>=300)return discordFailure_(dm);
    var id=String(JSON.parse(dm.getContentText()).id||'');if(!/^\d{17,20}$/.test(id))return {ok:false,code:0};
    options.payload=JSON.stringify({content:content,allowed_mentions:{parse:[]}});var r=UrlFetchApp.fetch('https://discord.com/api/v10/channels/'+id+'/messages',options);return r.getResponseCode()>=200&&r.getResponseCode()<300?{ok:true,code:r.getResponseCode()}:discordFailure_(r);
  }
  catch(ignore){return {ok:false,code:0};}
}
function discordRelayPost_(config,content){
  try{
    var response=UrlFetchApp.fetch(config.relay,{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+config.key},payload:JSON.stringify({content:content}),muteHttpExceptions:true,followRedirects:false});
    if(response.getResponseCode()!==200)return {ok:false,code:response.getResponseCode(),relay:true};
    var body=JSON.parse(response.getContentText());if(typeof body.ok!=='boolean'||!Number.isSafeInteger(body.code)||body.code<0||body.code>599)return {ok:false,code:0,relay:true};
    return {ok:body.ok&&body.code>=200&&body.code<300,code:body.code,apiCode:Number.isSafeInteger(body.apiCode)&&body.apiCode>0?body.apiCode:0};
  }catch(ignore){return {ok:false,code:0,relay:true};}
}
function discordFailure_(response){
  var apiCode=0;try{var body=JSON.parse(response.getContentText());if(Number.isSafeInteger(body.code)&&body.code>0)apiCode=body.code;}catch(ignore){}
  return {ok:false,code:response.getResponseCode(),apiCode:apiCode};
}
function discordFailureText_(r){
  var hint='通知先とGoogleの外部通信権限を確認してください。';
  if(r.relay)hint='通知用クラウドのURL・接続キー・設定を確認してください。';
  else if(r.apiCode===40333)hint='Discord側がこの通信を拒否しています。通知用クラウドの送信経路を確認してください。';
  else if(r.code===401)hint='通知用Botトークンを確認してください。';
  else if(r.apiCode===50007)hint='このユーザーへDMできません。Botとの共通サーバー・DM受信設定・ブロックを確認してください。';
  else if(r.code===429)hint='Discordの送信制限です。時間を置いて再試行してください。';
  else if(r.apiCode===10013)hint='DiscordユーザーIDを確認してください。';
  return hint+'（HTTP '+Number(r.code||0)+(r.apiCode?'／Discord '+r.apiCode:'')+'）';
}
function testDiscordAlerts_(){
  var p=PropertiesService.getScriptProperties(),config=discordConfig_(),r=discordPost_(config,'【TECHSPRESSO・通知テスト】全体指揮向けの未提供注文通知です。テスト送信により注文の記録は変更されません。');
  p.setProperty('DISCORD_ALERT_LAST_STATUS',r.ok?'テスト送信成功':'テスト送信失敗：'+discordFailureText_(r));if(!r.ok)throw userError_('Discordへ通知を送れませんでした。'+discordFailureText_(r));return {ok:true};
}
function checkDiscordAlerts_(){
  var p=PropertiesService.getScriptProperties();if(p.getProperty(DISCORD_ALERT_.enabled)!=='1')return;
  var config;try{config=discordConfig_();}catch(ignore){p.setProperty('DISCORD_ALERT_LAST_STATUS','通知先の設定が不正');return;}
  var lock=LockService.getScriptLock();if(!lock.tryLock(100))return;
  var now=Date.now(),batch=[],state,threshold=Number(p.getProperty('WAIT_THRESHOLD_MINUTES')||15);
  try{
    var raw=p.getProperty(DISCORD_ALERT_.state);state=raw?JSON.parse(raw):{};
    var late=overdueToday_(read_().state,now,threshold),active={};late.forEach(function(o){active[o.id]=true;});
    Object.keys(state).forEach(function(id){if(!active[id]||now-state[id]>=DISCORD_ALERT_.intervalMs)delete state[id];});
    // Reserve one batch per minute, including overlapping or manually repeated runs.
    var last=Number(p.getProperty('DISCORD_ALERT_LAST_ATTEMPT')||0);if(now-last<60000)return;
    batch=late.filter(function(o){return !state[o.id];}).slice(0,10);
    batch.forEach(function(o){state[o.id]=now;});p.setProperty(DISCORD_ALERT_.state,JSON.stringify(state));if(batch.length)p.setProperty('DISCORD_ALERT_LAST_ATTEMPT',String(now));
  }catch(ignore){p.setProperty('DISCORD_ALERT_LAST_STATUS','記録の確認に失敗（次回再試行）');return;}
  finally{lock.releaseLock();}
  if(!batch.length)return;
  // External HTTP happens after releasing the order-save lock. A lost HTTP response may
  // have been delivered; retain the attempt time to prevent rapid duplicate notifications.
  if(p.getProperty(DISCORD_ALERT_.enabled)!=='1')return;
  var r=discordPost_(config,discordText_(batch,now,threshold));
  p.setProperty('DISCORD_ALERT_LAST_STATUS',r.ok?'通知成功 '+new Date(now+9*3600000).toISOString().slice(11,16):'通知失敗：'+discordFailureText_(r)+' 約10分後に再試行・注文保存は継続');
}
