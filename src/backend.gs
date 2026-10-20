/* Only doGet, staffOptions, login, rpc and logout are callable by the browser. */
var APP_ = {ledger:'操作記録',retentionDays:30,maxEvents:20000,sessionSeconds:7200};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('TECHSPRESSO｜受け渡し管理')
    .addMetaTag('viewport','width=device-width, initial-scale=1');
}

// Run from the Apps Script editor after setting the three *_CODE script properties.
// Never callable by google.script.run because its name ends with an underscore.
function setup_() {
  return locked_(setupUnlocked_);
}
function selectWebRecordBook_() {
  var props=PropertiesService.getScriptProperties();
  if(props.getProperty('DATABASE_ID')) throw userError_('初期設定済みです。保存先は変更しません。');
  props.setProperty('TARGET_DATABASE_ID','1FYVF-qJ4iHtHTWXeM9CPwTqTK1i3s3pYrVa9q8I-asI');
  return '作成済みのWebアプリ専用記録シートを指定しました。3種類の利用コード設定後にsetup_を実行してください。';
}
function setupUnlocked_() {
  var props=PropertiesService.getScriptProperties();
  if(props.getProperty('DATABASE_ID')) throw userError_('初期設定済みです。既存の記録は変更しません。');
  var keys=['CASHIER_CODE','HANDOVER_CODE','ADMIN_CODE'];
  var codes=keys.map(function(k){var v=props.getProperty(k);if(!v || v.length<12) throw userError_(k+'を12文字以上で設定してください。');return v;});
  if(new Set(codes).size!==3) throw userError_('担当ごとに異なる利用コードを設定してください。');
  var target=props.getProperty('TARGET_DATABASE_ID'),book,log,initial;
  if(target) {
    book=SpreadsheetApp.openById(target);log=book.getSheetByName(APP_.ledger);
    var expected=['操作ID','再送確認ID','日時','操作','表示名','番号札／注文','操作内容JSON'];
    if(!log || JSON.stringify(log.getRange(1,1,1,7).getValues()[0])!==JSON.stringify(expected))
      throw userError_('指定した記録シートの見出しが一致しません。既存の記録は変更しません。');
    // This setup only adopts our unused seed workbook; never attach to existing sales.
    if(log.getLastRow()!==2) throw userError_('初期記録以外のデータがあります。初期設定を中止しました。');
    var r=log.getRange(2,1,1,7).getValues()[0],data;
    try {data=JSON.parse(r[6]);} catch(ignore) {throw userError_('初期記録を読み取れません。');}
    if(r[1]!=='initial-tickets' || r[3]!=='addTickets' || JSON.stringify(data)!==JSON.stringify({labels:'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')}))
      throw userError_('初期記録が想定と異なります。既存の記録は変更しません。');
    initial={id:r[0],requestId:r[1],at:r[2],type:r[3],actor:unescapeCell_(r[4]),data:data};
  } else {
    book=SpreadsheetApp.create('工大祭2026 TECHSPRESSO 受け渡し記録');
    log=book.getSheets()[0];log.setName(APP_.ledger);
    log.getRange(1,1,1,7).setValues([['操作ID','再送確認ID','日時','操作','表示名','番号札／注文','操作内容JSON']]);
    initial={id:Utilities.getUuid(),requestId:'initial-tickets',at:new Date().toISOString(),type:'addTickets',actor:'初期設定',data:{labels:'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')}};
    log.getRange(2,1,1,7).setValues([eventRow_(initial)]);
  }
  var salt=Utilities.getUuid()+Utilities.getUuid();
  props.setProperty('AUTH_SALT',salt);
  codes.forEach(function(code,i){props.setProperty(keys[i]+'_HASH',digest_(salt+'|'+code));props.deleteProperty(keys[i]);});
  props.setProperty('SESSION_EPOCH',Utilities.getUuid());
  style_(log,7);
  props.setProperty('DATABASE_ID',book.getId());
  writeViews_(book,CoffeeCore_.replay([initial]));
  // Cleanup is repeatable and does not erase order counts or ticket state.
  if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='cleanupExpiredNames_';}))
    ScriptApp.newTrigger('cleanupExpiredNames_').timeBased().everyDays(1).atHour(3).inTimezone('Asia/Tokyo').create();
  return '初期設定完了。記録は '+book.getUrl()+' に保存されます。共有設定は「制限付き」のままにしてください。';
}

function login(input) {
  input=input||{};
  var props=PropertiesService.getScriptProperties(), salt=props.getProperty('AUTH_SALT');
  if(!props.getProperty('DATABASE_ID') || !salt) throw userError_('まだ初期設定が完了していません。管理者に確認してください。');
  var role=input.role;
  if(['cashier','handover','admin','display'].indexOf(role)<0 || (input.roleOnly!==true && input.acceptPrivacy!==true)) throw userError_('担当を選び、表示名の扱いを確認してください。');
  var name=input.roleOnly===true?{cashier:'会計担当',handover:'受け渡し担当',admin:'管理者',display:'表示専用'}[role]:CoffeeCore_.cleanText(input.name,24,'表示名');
  var roster=input.roleOnly===true?[]:staffOptions();
  if(roster.length && roster.indexOf(name)<0) throw userError_('一覧から担当者の表示名を選択してください。');
  if(role==='admin' && (typeof input.code!=='string' || input.code.length>200)) throw userError_('利用コードを確認してください。');
  var guard=LockService.getScriptLock();guard.waitLock(5000);
  try {
    var cache=CacheService.getScriptCache(), key='login:'+Math.floor(Date.now()/60000), count=Number(cache.get(key)||0);
    if(count>=100) throw userError_('ログインの試行が多いため、1分後にもう一度お試しください。');
    cache.put(key,String(count+1),90);
    // General roles intentionally require no code. Admin authentication and server-side permissions remain mandatory.
    if(role==='admin'){
      var expected=props.getProperty('ADMIN_CODE_HASH'),supplied=digest_(salt+'|'+input.code);
      if(!expected || !constantTimeEqual_(supplied,expected)) throw userError_('利用コードを確認してください。');
    }
    var token=Utilities.getUuid()+Utilities.getUuid();
    var session={name:name,role:role,baseRole:role==='admin'?'admin':'general',expiresAt:Date.now()+APP_.sessionSeconds*1000,epoch:props.getProperty('SESSION_EPOCH')};
    cache.put('session:'+digest_(token),JSON.stringify(session),APP_.sessionSeconds);
    props.setProperty('SESSION_'+digest_(token),JSON.stringify(session));
    return {token:token,name:name,role:role,baseRole:session.baseRole,expiresAt:session.expiresAt};
  } finally {guard.releaseLock();}
}

function logout(token) {if(typeof token==='string'){CacheService.getScriptCache().remove('session:'+digest_(token));PropertiesService.getScriptProperties().deleteProperty('SESSION_'+digest_(token));}return true;}

function rpc(token,action,payload,requestId) {
  try { return rpc_(token,action,payload,requestId); }
  catch(error) { return {ok:false,message:error.userSafe?error.message:'保存状態を確認できません。再送して確認してください。',uncertain:!error.userSafe,sessionExpired:/ログインし直/.test(error.message||'')}; }
}
function userError_(message) { var error=new Error(message);error.userSafe=true;return error; }
function rpc_(token,action,payload,requestId) {
  var isMutation=['snapshot','switchRole','setWaitThreshold','syncSheets','removeNames','setDiscordAlerts','testDiscordAlerts'].indexOf(action)<0;
  var person=session_(token,!isMutation && action!=='snapshot');
  if(person.role==='display' && action!=='snapshot' && action!=='switchRole')throw userError_('表示専用では記録や設定を変更できません。');
  if(action==='setDiscordAlerts'||action==='testDiscordAlerts'){
    if(person.role!=='admin')throw userError_('管理者だけが操作できます。');
    if(action==='testDiscordAlerts')return testDiscordAlerts_();
    if(!payload||typeof payload.enabled!=='boolean')throw userError_('通知のON・OFFを選んでください。');
    return configureDiscordAlerts_(payload.enabled);
  }
  if(action==='switchRole') {
    var role=payload && payload.role;
    if(['cashier','handover','admin','display'].indexOf(role)<0 || (role==='admin' && person.baseRole!=='admin')) throw userError_('管理者は管理者用コードでログインしてください。');
    person.role=role;person.name={cashier:'会計担当',handover:'受け渡し担当',admin:'管理者',display:'表示専用'}[role];
    storeSession_(token,person);
    return {ok:true,person:Object.assign({token:token},person)};
  }
  if(action==='setWaitThreshold') {
    if(person.role!=='admin') throw userError_('管理者だけが操作できます。');
    var minutes=Number(payload && payload.minutes);
    if(!Number.isInteger(minutes) || minutes<1 || minutes>180) throw userError_('基準は1〜180分の整数で入力してください。');
    PropertiesService.getScriptProperties().setProperty('WAIT_THRESHOLD_MINUTES',String(minutes));
    return {ok:true,minutes:minutes};
  }
  if(action==='snapshot') {
    var data=read_();
    return snapshot_(data.state,person);
  }
  if(action==='syncSheets' || action==='removeNames') {
    if(person.role!=='admin') throw userError_('管理者だけが操作できます。');
    if(action==='removeNames' && (!payload || payload.confirm!=='表示名を除去')) throw userError_('確認の文字を入力してください。');
    return locked_(function(){
      var data=read_();
      if(action==='removeNames') {removeNames_(data.book,data.events,true);PropertiesService.getScriptProperties().setProperty('SESSION_EPOCH',Utilities.getUuid());data=read_();}
      writeViews_(data.book,data.state);
      return {ok:true,signedOut:action==='removeNames'};
    });
  }
  if(typeof requestId!=='string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw userError_('操作IDが不正です。画面を開き直してください。');
  return locked_(function(){
    // Recheck revocation after acquiring the lock.
    person=session_(token,true);
    var data=read_(), state=data.state;
    var signature=requestSignature_(action,payload);
    if(state.requestIds.indexOf(requestId)>=0) {
      var prior=data.events.find(function(e){return e.requestId===requestId;});
      if(prior && prior.data._requestSignature && prior.data._requestSignature!==signature)
        throw userError_('同じ操作IDで異なる内容は保存できません。元の操作を確認してください。');
      var retryDelayed=false;
      try {writeViews_(data.book,state);} catch(ignore) {PropertiesService.getScriptProperties().setProperty('VIEW_PROJECTION_DIRTY_'+data.book.getId(),'1');retryDelayed=true;}
      return {ok:true,repeated:true,projectionDelayed:retryDelayed,snapshot:snapshot_(state,person)};
    }
    if(data.events.length>=APP_.maxEvents) throw userError_('記録の上限に達しました。管理者に確認してください。');
    var event=CoffeeCore_.prepare(state,person.role,action,payload,{id:Utilities.getUuid(),requestId:requestId,at:new Date().toISOString(),actor:person.name});
    event.data._requestSignature=signature;
    data.book.getSheetByName(APP_.ledger).getRange(data.events.length+2,1,1,7).setValues([eventRow_(event)]);
    SpreadsheetApp.flush();
    var priorState=JSON.parse(JSON.stringify(state));
    CoffeeCore_.apply(state,event);
    // The single append above is the source of truth. A failed projection must not undo or duplicate it.
    var delayed=false;
    try {writeViews_(data.book,state,priorState);} catch(ignore) {PropertiesService.getScriptProperties().setProperty('VIEW_PROJECTION_DIRTY_'+data.book.getId(),'1');delayed=true;}
    return {ok:true,projectionDelayed:delayed,snapshot:snapshot_(state,person)};
  });
}

function storeSession_(token,person) {
  var raw=JSON.stringify(person),key=digest_(token);
  PropertiesService.getScriptProperties().setProperty('SESSION_'+key,raw);
  CacheService.getScriptCache().put('session:'+key,raw,APP_.sessionSeconds);
}
function session_(token,touch) {
  if(typeof token!=='string' || token.length>100) throw userError_('ログインし直してください。');
  var raw=PropertiesService.getScriptProperties().getProperty('SESSION_'+digest_(token)) || CacheService.getScriptCache().get('session:'+digest_(token));
  if(!raw) throw userError_('ログインし直してください。');
  var person=JSON.parse(raw);
  if(person.expiresAt<=Date.now() || person.epoch!==PropertiesService.getScriptProperties().getProperty('SESSION_EPOCH')) throw userError_('ログインし直してください。');
  person.baseRole=person.baseRole || (person.role==='admin'?'admin':'general');
  if(touch){person.expiresAt=Date.now()+APP_.sessionSeconds*1000;storeSession_(token,person);}
  return person;
}
function snapshot_(state,person) {
  return {state:CoffeeCore_.view(state,person.role),menu:CoffeeCore_.menu,serverTime:new Date().toISOString(),retentionDays:APP_.retentionDays,expiresAt:person.expiresAt,waitThresholdMinutes:Number(PropertiesService.getScriptProperties().getProperty('WAIT_THRESHOLD_MINUTES')||15),discordAlerts:person.role==='admin'?discordAlertStatus_():undefined};
}
function locked_(fn) {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) throw userError_('ほかの端末の記録を保存中です。少し待って再試行してください。');
  try {return fn();} finally {lock.releaseLock();}
}
function read_() {
  var id=PropertiesService.getScriptProperties().getProperty('DATABASE_ID');
  if(!id) throw userError_('初期設定が必要です。');
  var book=SpreadsheetApp.openById(id), log=book.getSheetByName(APP_.ledger);
  if(!log) throw userError_('操作記録シートが見つかりません。管理者に確認してください。');
  var n=log.getLastRow()-1;
  if(n>APP_.maxEvents) throw userError_('記録の上限を超えています。管理者に確認してください。');
  var events=n>0?log.getRange(2,1,n,7).getValues().map(function(r){return {id:r[0],requestId:r[1],at:r[2],type:r[3],actor:unescapeCell_(r[4]),data:JSON.parse(r[6])};}):[];
  return {book:book,events:events,state:CoffeeCore_.replay(events)};
}
function eventRow_(e) {
  var d=e.data;
  return [e.id,e.requestId,e.at,e.type,safeCell_(e.actor),safeCell_(d.ticket||d.label||d.orderId||(d.labels||[]).join(',')||(d.returns||[]).map(function(r){return r.label;}).join(',')||(d.orders||[]).map(function(r){return r.orderId;}).join(',')),JSON.stringify(d)];
}
function safeCell_(value) {var s=String(value||'');return /^[=+\-@']/.test(s)?"'"+s:s;}
function unescapeCell_(value) {var s=String(value||'');return /^'[=+\-@']/.test(s)?s.slice(1):s;}
function digest_(text) {return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');}
function constantTimeEqual_(a,b) {var diff=a.length^b.length;for(var i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i%b.length);return diff===0;}
function style_(sheet,width) {sheet.setFrozenRows(1);sheet.getRange(1,1,1,width).setBackground('#183b32').setFontColor('#ffffff').setFontWeight('bold');sheet.autoResizeColumns(1,width);}
function table_(book,name,headers,rows) {
  var sheet=book.getSheetByName(name)||book.insertSheet(name), values=[headers].concat(rows);
  if(sheet.getMaxRows()<values.length) sheet.insertRowsAfter(sheet.getMaxRows(),values.length-sheet.getMaxRows());
  sheet.getRange(1,1,values.length,headers.length).setValues(values);
  var last=sheet.getLastRow();
  if(last>values.length) sheet.getRange(values.length+1,1,last-values.length,headers.length).clearContent();
  if(sheet.getFrozenRows()!==1) style_(sheet,headers.length);
}
function viewTables_(state) {
  var location={cashier:'会計・使用可能',customer:'お客さん',collected:'回収済・会計への返却待ち'},tables={};
  tables['番号札一覧']=state.tickets.map(function(t){return [t.label,t.active?'有効':'無効',t.active?location[t.location]:'会計・使用停止',t.orderId];});
  ['当日注文一覧','注文_10月8日まで_テスト','注文_10月9日_前日テスト','注文_10月10日_1日目','注文_10月11日_2日目'].forEach(function(name){tables[name]=[];});
  state.orders.forEach(function(o){
    var name=orderDaySheet_(o.createdAt);if(!tables[name])tables[name]=[];
    o.items.forEach(function(i){
      var row=[new Date(o.createdAt),o.cancelled?'取消':i.deliveredAt?'提供済':'未提供',o.ticket,i.number+'/'+o.items.length,CoffeeCore_.displayName(i),i.temperature==='Hot'?'HOT':i.temperature==='Iced'?'ICE':'',o.collectedAt?new Date(o.collectedAt):'',o.returnedAt?new Date(o.returnedAt):'',o.id,i.name];
      tables[name].push(row);
      if(name==='注文_10月10日_1日目'||name==='注文_10月11日_2日目')tables['当日注文一覧'].push(row);
    });
  });return tables;
}
function writeViews_(book,state,priorState) {
  var props=PropertiesService.getScriptProperties(),dirty=props.getProperty('VIEW_PROJECTION_DIRTY_'+book.getId())==='1';
  var tables=viewTables_(state),before=priorState&&!dirty?viewTables_(priorState):null;
  var headers=['受付日時（会計担当）','提供状況（受け渡し担当）','札','カップ','商品名','HOT/ICE','札回収日時（受け渡し担当）','会計受領日時（会計担当）','注文ID','正式名称'];
  if(typeof Sheets!=='undefined' && Sheets.Spreadsheets && writeViewsBatch_(book,tables,before,headers)) {
    if(dirty)props.deleteProperty('VIEW_PROJECTION_DIRTY_'+book.getId());
    return;
  }
  var oldOrders=book.getSheetByName('注文一覧');
  if(oldOrders && !book.getSheetByName('当日注文一覧'))oldOrders.setName('当日注文一覧');
  Object.keys(tables).forEach(function(name){
    // Compare authoritative before/after state in memory, never cache uncommitted data.
    // Retry/admin repair uses the full path; a failed projection forces the next full repair.
    if(before && before[name] && JSON.stringify(before[name])===JSON.stringify(tables[name]) && book.getSheetByName(name))return;
    if(name==='番号札一覧')table_(book,name,['札','有効','所在','現在の注文ID'],tables[name]);
    else orderTable_(book,name,headers,tables[name]);
  });
  if(!book.getSheetByName('メニュー'))table_(book,'メニュー',['商品ID','商品','Hot／Iced','参考価格'],CoffeeCore_.menu.map(function(m){return [m.id,m.name,m.temperature,m.price];}));
  SpreadsheetApp.flush();
  if(dirty)props.deleteProperty('VIEW_PROJECTION_DIRTY_'+book.getId());
}

// Updates only projections. The durable ledger append remains a separate confirmed write.
// An API/network failure is propagated; never silently fall back and acknowledge stale views.
function writeViewsBatch_(book,tables,before,headers) {
  var budgetCache=CacheService.getScriptCache(),budgetKey='view-batch:'+Math.floor(Date.now()/60000),used=Number(budgetCache.get(budgetKey)||0);
  if(used>=40)return false; // Burst traffic uses the established SpreadsheetApp path.
  budgetCache.put(budgetKey,String(used+1),90);
  var meta=Sheets.Spreadsheets.get(book.getId(),{fields:'properties(timeZone),sheets(properties(sheetId,title,gridProperties))'});
  // Date serials below are local civil time. Keep unknown timezones on the established path.
  if(!meta.properties || meta.properties.timeZone!=='Asia/Tokyo')return false;
  var byName={};(meta.sheets||[]).forEach(function(s){byName[s.properties.title]=s.properties;});
  if(!byName['メニュー'] || Object.keys(tables).some(function(n){return !byName[n];}))return false;
  var requests=[];
  Object.keys(tables).forEach(function(name){
    if(before && before[name] && JSON.stringify(before[name])===JSON.stringify(tables[name]))return;
    var sheet=byName[name],h=name==='番号札一覧'?['札','有効','所在','現在の注文ID']:headers;
    var values=[h].concat(tables[name]),grid=sheet.gridProperties;
    if(values.length>grid.rowCount)requests.push({appendDimension:{sheetId:sheet.sheetId,dimension:'ROWS',length:values.length-grid.rowCount}});
    if(h.length>grid.columnCount)requests.push({appendDimension:{sheetId:sheet.sheetId,dimension:'COLUMNS',length:h.length-grid.columnCount}});
    requests.push({updateCells:{range:{sheetId:sheet.sheetId,startRowIndex:0,endRowIndex:values.length,startColumnIndex:0,endColumnIndex:h.length},rows:values.map(function(row){return {values:row.map(batchCell_)};}),fields:'userEnteredValue,userEnteredFormat.numberFormat'}});
    // Clearing values only preserves column widths, colors, notes and unrelated columns.
    var oldLength=before && before[name]?before[name].length+1:grid.rowCount;
    if(oldLength>values.length)requests.push({updateCells:{range:{sheetId:sheet.sheetId,startRowIndex:values.length,endRowIndex:oldLength,startColumnIndex:0,endColumnIndex:h.length},fields:'userEnteredValue'}});
  });
  if(requests.length)Sheets.Spreadsheets.batchUpdate({requests:requests},book.getId());
  return true;
}
function batchCell_(value) {
  if(value instanceof Date) {
    var at=value.getTime();if(!Number.isFinite(at))throw userError_('注文の日時を読み取れません。');
    return {userEnteredValue:{numberValue:(at+9*3600000)/86400000+25569},userEnteredFormat:{numberFormat:{type:'TIME',pattern:'h:mm'}}};
  }
  return {userEnteredValue:{stringValue:String(value==null?'':value)},userEnteredFormat:{numberFormat:{type:'TEXT'}}};
}

function cleanupExpiredNames_() {
  var props=PropertiesService.getScriptProperties(),all=props.getProperties();
  Object.keys(all).filter(function(k){return /^SESSION_[a-f0-9]{64}$/.test(k);}).forEach(function(k){
    try {var s=JSON.parse(all[k]);if(s.expiresAt<=Date.now() || s.epoch!==props.getProperty('SESSION_EPOCH'))props.deleteProperty(k);}catch(ignore){props.deleteProperty(k);}
  });
  return locked_(function(){var data=read_();removeNames_(data.book,data.events,false);writeViews_(data.book,read_().state);});
}

function orderTable_(book,name,headers,rows) {
  var existing=book.getSheetByName(name)||book.insertSheet(name);
  var currentHeaders=existing.getRange(1,1,1,10).getValues()[0];
  if(currentHeaders[0]!==headers[0]||currentHeaders[9]!=='正式名称'){
    // Configure whole columns once; avoid extra writes on every order.
    existing.getRange(2,3,existing.getMaxRows()-1,4).setNumberFormat('@');
    existing.getRange(2,9,existing.getMaxRows()-1,2).setNumberFormat('@');
    existing.getRange(1,10,existing.getMaxRows(),5).clearContent();
    [1,7,8].forEach(function(col){existing.getRange(2,col,existing.getMaxRows()-1,1).setNumberFormat('h:mm');});
  }
  table_(book,name,headers,rows);
}
function orderDaySheet_(createdAt) {
  var at=Date.parse(createdAt);
  if(!Number.isFinite(at))throw userError_('注文の受付日時を読み取れません。記録は削除せず管理者に確認してください。');
  var date=new Date(at+9*3600000).toISOString().slice(0,10);
  if(date<='2026-10-08')return '注文_10月8日まで_テスト';
  if(date==='2026-10-09')return '注文_10月9日_前日テスト';
  if(date==='2026-10-10')return '注文_10月10日_1日目';
  if(date==='2026-10-11')return '注文_10月11日_2日目';
  return '注文_その他の日付';
}
function syncDailyRecords_() {
  return locked_(function(){var data=read_();writeViews_(data.book,data.state);return '日付別の注文記録を作成・更新しました。注文の受付日（日本時間）で分類しています。';});
}
function staffOptions() {
  var props=PropertiesService.getScriptProperties(),id=props.getProperty('DATABASE_ID')||props.getProperty('TARGET_DATABASE_ID');
  if(!id) return [];
  var sheet=SpreadsheetApp.openById(id).getSheetByName('メニュー');
  if(!sheet || sheet.getRange(1,7,1,1).getValues()[0][0]!=='スタッフ表示名（編集可）') return [];
  var names=sheet.getRange(2,7,99,1).getValues().map(function(r){return String(r[0]||'').trim();}).filter(Boolean);
  names.forEach(function(n){CoffeeCore_.cleanText(n,24,'表示名');});
  if(new Set(names).size!==names.length) throw userError_('スタッフ表示名に重複があります。管理者に確認してください。');
  if(!names.length) throw userError_('スタッフ表示名をメニューシートのG列へ登録してください。');
  return names;
}
function requestSignature_(action,payload) {
  function stable(v) {
    if(Array.isArray(v)) return v.map(stable);
    if(v && typeof v==='object') {var out={};Object.keys(v).sort().forEach(function(k){out[k]=stable(v[k]);});return out;}
    return v;
  }
  return digest_(JSON.stringify([action,stable(payload||{})]));
}
// Editor-only rotation after the owner has entered new *_CODE properties.
function rotateStaffAdminCodes_() {
  return locked_(function(){
    var props=PropertiesService.getScriptProperties();
    if(!props.getProperty('DATABASE_ID')) throw userError_('先に初期設定を完了してください。');
    var keys=['STAFF_CODE','ADMIN_CODE'];
    var codes=keys.map(function(k){var value=props.getProperty(k);if(!value || value.length<12 || value.length>200)throw userError_(k+'を12〜200文字で設定してください。');return value;});
    if(codes[0]===codes[1])throw userError_('一般スタッフと管理者は異なる利用コードを設定してください。');
    var salt=Utilities.getUuid()+Utilities.getUuid();
    props.setProperty('AUTH_SALT',salt);
    keys.forEach(function(k,i){props.setProperty(k+'_HASH',digest_(salt+'|'+codes[i]));props.deleteProperty(k);});
    ['CASHIER_CODE','HANDOVER_CODE','CASHIER_CODE_HASH','HANDOVER_CODE_HASH'].forEach(function(k){props.deleteProperty(k);});
    props.setProperty('SESSION_EPOCH',Utilities.getUuid());
    return '一般スタッフ・管理者の利用コードを反映しました。全員ログインし直してください。注文記録は維持しています。';
  });
}
function rotateAccessCodes_() {
  return locked_(function(){
    var props=PropertiesService.getScriptProperties();
    if(!props.getProperty('DATABASE_ID')) throw userError_('先に初期設定を完了してください。');
    var keys=['CASHIER_CODE','HANDOVER_CODE','ADMIN_CODE'];
    var codes=keys.map(function(k){var value=props.getProperty(k);if(!value || value.length<12)throw userError_(k+'を12文字以上で設定してください。');return value;});
    if(new Set(codes).size!==3)throw userError_('担当ごとに異なる利用コードを設定してください。');
    var salt=Utilities.getUuid()+Utilities.getUuid();
    props.setProperty('AUTH_SALT',salt);
    codes.forEach(function(code,i){props.setProperty(keys[i]+'_HASH',digest_(salt+'|'+code));props.deleteProperty(keys[i]);});
    props.setProperty('SESSION_EPOCH',Utilities.getUuid());
    return '利用コードを更新しました。全員ログインし直してください。注文と番号札の記録は保持しています。';
  });
}
function removeNames_(book,events,all) {
  if(!events.length)return;
  var before=Date.now()-APP_.retentionDays*86400000;
  var names=events.map(function(e){return [safeCell_((all || Date.parse(e.at)<before)?'表示名除去済':e.actor)];});
  book.getSheetByName(APP_.ledger).getRange(2,5,names.length,1).setValues(names);
  SpreadsheetApp.flush();
}
