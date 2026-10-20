import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
const sources=['core.js','backend.gs','alerts.gs'].map(f=>fs.readFileSync(new URL('../src/'+f,import.meta.url),'utf8')).join('\n');
function fixture(options={}){
  const FixtureDate=options.now?class extends Date{constructor(...args){super(...(args.length?args:[options.now]));}static now(){return Date.parse(options.now);}}:Date;
  const properties=new Map([['CASHIER_CODE','cashier-test-code'],['HANDOVER_CODE','handover-test-code'],['ADMIN_CODE','admin-test-code']]),cache=new Map(),books=new Map(),triggers=[];
  let lockHeld=false,failProjection=false,batchCalls=0;
  class Sheet{
    constructor(name){this.id=Math.floor(Math.random()*1000000000);this.name=name;this.rows=[];this.frozen=0;this.maxRows=1000;this.writes=0;this.reads=0;}
    setName(name){this.name=name;return this;}
    getName(){return this.name;}getLastRow(){let n=this.rows.length;while(n&&!this.rows[n-1]?.some(x=>x!==''&&x!=null))n--;return n;}
    getMaxRows(){return this.maxRows;}insertRowsAfter(_,n){this.maxRows+=n;return this;}setFrozenRows(n){this.frozen=n;return this;}getFrozenRows(){return this.frozen;}autoResizeColumns(){return this;}
    getRange(row,col,n,w){const sheet=this;return {setValues(values){sheet.writes++;if(failProjection&&sheet.name!=='操作記録')throw new Error('simulated projection outage');assert.equal(values.length,n);for(let i=0;i<n;i++){assert.equal(values[i].length,w);sheet.rows[row+i-1]??=[];for(let j=0;j<w;j++)sheet.rows[row+i-1][col+j-1]=values[i][j];}return this;},getValues(){sheet.reads++;return Array.from({length:n},(_,i)=>Array.from({length:w},(_,j)=>sheet.rows[row+i-1]?.[col+j-1]??''));},clearContent(){for(let i=0;i<n;i++)for(let j=0;j<w;j++)if(sheet.rows[row+i-1])sheet.rows[row+i-1][col+j-1]='';return this;},setNumberFormat(){return this;},setBackground(){return this;},setFontColor(){return this;},setFontWeight(){return this;}};}
  }
  class Book{constructor(){this.id=randomUUID();this.sheets=[new Sheet('Sheet1')];}getId(){return this.id;}getUrl(){return 'https://example.invalid/'+this.id;}getSheets(){return this.sheets;}getSheetByName(name){return this.sheets.find(s=>s.name===name);}insertSheet(name){const s=new Sheet(name);this.sheets.push(s);return s;}}
  const ctx=vm.createContext({console,Date:FixtureDate,PropertiesService:{getScriptProperties:()=>({getProperties:()=>Object.fromEntries(properties),getProperty:k=>properties.get(k)||null,setProperty(k,v){properties.set(k,v);return this;},deleteProperty(k){properties.delete(k);return this;}})},CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put(k,v){cache.set(k,v);},remove(k){cache.delete(k);}})},Utilities:{getUuid:randomUUID,DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,v)=>Array.from(createHash('sha256').update(v).digest())},LockService:{getScriptLock:()=>({tryLock(){if(lockHeld)return false;lockHeld=true;return true;},waitLock(){if(lockHeld)throw new Error('locked');lockHeld=true;},releaseLock(){lockHeld=false;}})},SpreadsheetApp:{create(){const b=new Book();books.set(b.id,b);return b;},openById:id=>books.get(id),flush(){}},ScriptApp:{getProjectTriggers:()=>triggers,newTrigger(name){const t={getHandlerFunction:()=>name,timeBased(){return this;},everyDays(){return this;},atHour(){return this;},inTimezone(){return this;},create(){triggers.push(this);return this;}};return t;}}});
  vm.runInContext(sources,ctx);
  if(options.seed){
    const b=new Book();books.set(b.id,b);const log=b.sheets[0];log.setName('操作記録');
    log.rows=[['操作ID','再送確認ID','日時','操作','表示名','番号札／注文','操作内容JSON'],
      [randomUUID(),'initial-tickets','2026-10-07T00:00:00.000Z','addTickets','初期設定','A,B',JSON.stringify({labels:'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')})]];
    if(options.badHeader)log.rows[0][0]='別の台帳';
    if(options.extraRow)log.rows.push([...log.rows[1]]);
    properties.set('TARGET_DATABASE_ID',b.id);
  }
  if(!options.skipSetup)ctx.setup_();
  const login=(role,name='表示名')=>ctx.login({role,name,code:role+'-test-code',acceptPrivacy:true});
  const invoke=(user,action,payload,id=randomUUID())=>ctx.rpc(user.token,action,payload,id);
  if(options.batch)ctx.Sheets={Spreadsheets:{
    get(id){return {properties:{timeZone:'Asia/Tokyo'},sheets:books.get(id).sheets.map(s=>({properties:{sheetId:s.id,title:s.name,gridProperties:{rowCount:s.maxRows,columnCount:26}}}))};},
    batchUpdate(body,id){batchCalls++;if(failProjection)throw new Error('batch outage');
      const b=books.get(id);for(const req of body.requests){
        const u=req.updateCells;if(!u){const a=req.appendDimension;const sh=b.sheets.find(s=>s.id===a.sheetId);if(a.dimension==='ROWS')sh.maxRows+=a.length;continue;}
        const g=u.range,sh=b.sheets.find(s=>s.id===g.sheetId);assert.ok(g.endRowIndex<=sh.maxRows);
        if(!u.rows){sh.getRange(g.startRowIndex+1,g.startColumnIndex+1,g.endRowIndex-g.startRowIndex,g.endColumnIndex-g.startColumnIndex).clearContent();continue;}
        assert.equal(u.rows.length,g.endRowIndex-g.startRowIndex);
        const vals=u.rows.map(row=>row.values.map(c=>c.userEnteredValue.numberValue!==undefined?new Date(Math.round((c.userEnteredValue.numberValue-25569)*86400000)-9*3600000):c.userEnteredValue.stringValue));
        sh.getRange(g.startRowIndex+1,g.startColumnIndex+1,vals.length,g.endColumnIndex-g.startColumnIndex).setValues(vals);
      }return {};
    }
  }};
  return {ctx,properties,cache,books,triggers,login,invoke,batchCalls:()=>batchCalls,projectionFailure(value){failProjection=value;},ledger:()=>[...books.values()][0].getSheetByName('操作記録')};
}
test('会計で札を持つ取消は一度だけ返却し、再使用後の遅延再送でも新注文を変更しない',()=>{
  const f=fixture({batch:true}),cash=f.login('cashier');
  f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:1}]});
  const o=f.ctx.read_().state.orders[0],payload={orderId:o.id,revision:o.revision,ticketAtCashier:true},id=randomUUID();
  f.projectionFailure(true);const r=f.invoke(cash,'cancelOrder',payload,id);assert.equal(r.ok,true);assert.equal(r.projectionDelayed,true);
  f.projectionFailure(false);const retried=f.invoke(cash,'cancelOrder',payload,id);assert.equal(retried.repeated,true);
  const book=[...f.books.values()][0],row=book.getSheetByName(f.ctx.orderDaySheet_(o.createdAt)).rows[1];
  assert.equal(row[1],'取消');assert.ok(row[6] instanceof Date);assert.ok(row[7] instanceof Date);
  assert.equal(f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]}).ok,true);
  const count=f.ledger().getLastRow(),next=f.ctx.read_().state.orders[1];
  assert.equal(f.invoke(cash,'cancelOrder',payload,id).repeated,true);assert.equal(f.ledger().getLastRow(),count);
  assert.equal(f.ctx.read_().state.tickets.find(t=>t.label==='A').orderId,next.id);assert.equal(f.ctx.read_().state.orders[1].cancelled,false);
  assert.equal(f.invoke(cash,'cancelOrder',payload).ok,false);
  assert.equal(f.invoke(cash,'cancelOrder',{...payload,ticketAtCashier:false},id).ok,false);
});

test('札がない取消も会計の受領だけで再使用でき、受領の遅延再送は新注文に影響しない',()=>{
  const f=fixture(),cash=f.login('cashier'),hand=f.login('handover');f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]});
  const o=f.ctx.read_().state.orders[0];assert.equal(f.invoke(cash,'cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:false}).ok,true);
  assert.equal(f.invoke(hand,'collectTicket',{orderId:o.id,revision:2}).ok,false);
  const payload={labels:['A'],orderIds:{A:o.id}},id=randomUUID();assert.equal(f.invoke(cash,'returnTickets',payload,id).ok,true);
  assert.equal(f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:1}]}).ok,true);
  const next=f.ctx.read_().state.orders[1];assert.equal(f.invoke(cash,'returnTickets',payload,id).repeated,true);
  assert.equal(f.ctx.read_().state.tickets.find(t=>t.label==='A').orderId,next.id);assert.equal(f.invoke(cash,'returnTickets',payload).ok,false);
});

test('停止時の一覧は未提供の残杯・札・商品・時刻を区別し、提供整理は注文数を増やさない',()=>{
  const f=fixture(),cash=f.login('cashier'),admin=f.login('admin'),book=[...f.books.values()][0];
  f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:1},{menuId:'fizz',quantity:1}]});
  let o=f.ctx.read_().state.orders[0];
  assert.equal(f.invoke(admin,'deliver',{orderId:o.id,revision:o.revision,itemNumbers:[1]}).ok,true);
  const rows=book.getSheetByName(f.ctx.orderDaySheet_(o.createdAt)).rows.slice(1);
  assert.equal(rows.length,2);assert.equal(rows[0][1],'提供済');assert.equal(rows[1][1],'未提供');
  assert.equal(rows[1][8],o.id);assert.equal(rows[1][2],'A');assert.equal(rows[1][3],'2/2');assert.equal(rows[1][4],'フィズ');assert.equal(rows[1][9],'Bittersweet Fizz');assert.equal(rows[1][0].toISOString(),o.createdAt);
  o=f.ctx.read_().state.orders[0];f.invoke(admin,'deliver',{orderId:o.id,revision:o.revision,itemNumbers:[2],collectTicket:true});
  f.invoke(admin,'returnTickets',{labels:['A'],orderIds:{A:o.id}});
  assert.equal(f.ctx.read_().state.orders.length,1);assert.equal(f.ctx.read_().state.orders[0].items.length,2);
});
test('日本時間の境界で4期間へ分類し、期間外は別に残す',()=>{
  const f=fixture();
  for(const [at,name] of [
    ['2026-10-08T14:59:59.999Z','注文_10月8日まで_テスト'],
    ['2026-10-08T15:00:00.000Z','注文_10月9日_前日テスト'],
    ['2026-10-09T15:00:00.000Z','注文_10月10日_1日目'],
    ['2026-10-10T15:00:00.000Z','注文_10月11日_2日目'],
    ['2026-10-11T15:00:00.000Z','注文_その他の日付']])assert.equal(f.ctx.orderDaySheet_(at),name);
  assert.throws(()=>f.ctx.orderDaySheet_('bad-date'),/受付日時/);
});
test('全カップを受付日のみに分類し、翌日提供も元の日を更新、再集計は重複しない',()=>{
  const f=fixture(),book=[...f.books.values()][0],cash=f.login('cashier');
  assert.equal(f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:2}]}).ok,true);
  const data=f.ctx.read_(),o=data.state.orders[0];o.createdAt='2026-10-09T14:59:59.000Z';
  o.items[0].deliveredAt='2026-10-09T15:01:00.000Z';o.items[0].deliveredBy='受け渡し担当';
  f.ctx.writeViews_(book,data.state);f.ctx.writeViews_(book,data.state);
  assert.equal(book.getSheetByName('注文_10月9日_前日テスト').getLastRow(),3);
  assert.equal(book.getSheetByName('注文_10月10日_1日目').getLastRow(),1);
  assert.equal(book.getSheetByName('注文_10月9日_前日テスト').rows[1][1],'提供済');
  assert.equal(book.getSheetByName('当日注文一覧').getLastRow(),1);assert.equal(book.getSheetByName('注文一覧'),undefined);
  assert.equal(f.ledger().getLastRow(),3);
  const day1=JSON.parse(JSON.stringify(o)),day2=JSON.parse(JSON.stringify(o));
  day1.id='day1';day1.createdAt='2026-10-09T15:00:00.000Z';day2.id='day2';day2.createdAt='2026-10-10T15:00:00.000Z';
  data.state.orders.push(day1,day2);f.ctx.writeViews_(book,data.state);
  assert.equal(book.getSheetByName('当日注文一覧').getLastRow(),5);
  assert.equal(book.getSheetByName('注文_10月9日_前日テスト').getLastRow(),3);
  assert.equal(book.getSheetByName('注文_10月10日_1日目').getLastRow(),3);
  assert.equal(book.getSheetByName('注文_10月11日_2日目').getLastRow(),3);
});
test('STAFF_CODEとADMIN_CODEだけで変更し旧コード・旧認証を無効化する',()=>{
  const f=fixture(),old=f.login('cashier'),before=JSON.stringify(f.ledger().rows);
  f.properties.set('STAFF_CODE','staff-new-test-code');f.properties.set('ADMIN_CODE','admin-new-test-code');f.ctx.rotateStaffAdminCodes_();
  for(const role of ['cashier','handover'])assert.equal(f.ctx.login({role,roleOnly:true,code:'staff-new-test-code'}).role,role);
  assert.equal(f.ctx.login({role:'admin',roleOnly:true,code:'admin-new-test-code'}).role,'admin');
  assert.throws(()=>f.ctx.login({role:'admin',roleOnly:true,code:'staff-new-test-code'}),/利用コード/);
  assert.equal(f.login('cashier').role,'cashier');assert.equal(f.login('handover').role,'handover');
  assert.equal(f.invoke(old,'snapshot',{}).sessionExpired,true);assert.equal(JSON.stringify(f.ledger().rows),before);
  for(const key of ['STAFF_CODE','ADMIN_CODE','CASHIER_CODE_HASH','HANDOVER_CODE_HASH'])assert.equal(f.properties.has(key),false);
});
test('新コードが短い・同一・片方未設定なら現在の認証と記録を維持する',()=>{
  for(const pair of [['short','admin-new-test-code'],['same-new-test-code','same-new-test-code'],['staff-new-test-code',null]]){
    const f=fixture(),before=Object.fromEntries(f.properties);
    f.properties.set('STAFF_CODE',pair[0]);if(pair[1])f.properties.set('ADMIN_CODE',pair[1]);
    assert.throws(()=>f.ctx.rotateStaffAdminCodes_(),/12〜200|異なる/);
    assert.equal(f.properties.get('AUTH_SALT'),before.AUTH_SALT);assert.equal(f.properties.get('SESSION_EPOCH'),before.SESSION_EPOCH);
    assert.equal(f.login('cashier').role,'cashier');
  }
});
test('基準は初期15分、管理者だけ変更できる',()=>{
  const f=fixture(),admin=f.login('admin'),cash=f.login('cashier');
  assert.equal(f.invoke(cash,'snapshot',{}).waitThresholdMinutes,15);
  assert.equal(f.invoke(cash,'setWaitThreshold',{minutes:20}).ok,false);
  for(const n of [0,181,1.5])assert.equal(f.invoke(admin,'setWaitThreshold',{minutes:n}).ok,false);
  assert.equal(f.invoke(admin,'setWaitThreshold',{minutes:25}).ok,true);
  assert.equal(f.invoke(cash,'snapshot',{}).waitThresholdMinutes,25);
});
test('一般担当の共通コードと切替、管理者への昇格拒否、管理者の復帰',()=>{
  const f=fixture(),general=f.ctx.login({role:'handover',roleOnly:true,code:'cashier-test-code'});
  assert.equal(general.baseRole,'general');
  let r=f.invoke(general,'switchRole',{role:'cashier'});assert.equal(r.ok,true);assert.equal(r.person.role,'cashier');
  assert.equal(f.invoke(general,'switchRole',{role:'admin'}).ok,false);
  const admin=f.login('admin');assert.equal(admin.baseRole,'admin');assert.equal(f.invoke(admin,'switchRole',{role:'handover'}).ok,true);
  assert.equal(f.invoke(admin,'addTickets',{labels:['AA']}).ok,false);
  assert.equal(f.invoke(admin,'switchRole',{role:'admin'}).ok,true);
  assert.equal(f.invoke(admin,'addTickets',{labels:['AA']}).ok,true);
});
test('キャッシュ消去後も認証を維持し、2時間失効と操作による延長・読込だけの非延長',()=>{
  const f=fixture(),u=f.login('admin'),key='SESSION_'+f.ctx.digest_(u.token);
  f.cache.clear();assert.equal(f.invoke(u,'snapshot',{}).waitThresholdMinutes,15);
  const s=JSON.parse(f.properties.get(key));s.expiresAt=Date.now()+10000;f.properties.set(key,JSON.stringify(s));
  f.invoke(u,'snapshot',{});assert.equal(JSON.parse(f.properties.get(key)).expiresAt,s.expiresAt);
  assert.equal(f.invoke(u,'switchRole',{role:'cashier'}).ok,true);assert.ok(JSON.parse(f.properties.get(key)).expiresAt>Date.now()+7190000);
  const expired=JSON.parse(f.properties.get(key));expired.expiresAt=Date.now()-1;f.properties.set(key,JSON.stringify(expired));
  assert.equal(f.invoke(u,'snapshot',{}).sessionExpired,true);
  f.ctx.cleanupExpiredNames_();assert.equal(f.properties.has(key),false);
});
test('ログアウト後は永続セッションも復元不可',()=>{
  const f=fixture(),u=f.login('admin');f.ctx.logout(u.token);assert.equal(f.invoke(u,'snapshot',{}).sessionExpired,true);
});
test('担当のみで認証し、送信された任意の表示名を記録に使わない',()=>{
  const f=fixture();
  for(const role of ['cashier','handover','admin']){
    const u=f.ctx.login({role,roleOnly:true,name:'偽の名前',code:role+'-test-code'});
    assert.equal(u.name,{cashier:'会計担当',handover:'受け渡し担当',admin:'管理者'}[role]);
    if(role==='cashier'){
      assert.equal(f.invoke(u,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]}).ok,true);
      assert.equal(f.ledger().rows[2][4],'会計担当');
    }
  }
  assert.throws(()=>f.ctx.login({role:'admin',roleOnly:true,code:'wrong'}),/利用コード/);
});
test('作成済みの専用記録シートを採用し、初期札やファイルを重複作成しない',()=>{
  const f=fixture({seed:true});assert.equal(f.books.size,1);assert.equal(f.ledger().getLastRow(),2);
  assert.equal(f.properties.get('DATABASE_ID'),f.properties.get('TARGET_DATABASE_ID'));
});
test('見出し違い・既存注文がある台帳は初期化せずコードも保持する',()=>{
  for(const options of [{badHeader:true},{extraRow:true}]){
    const f=fixture({seed:true,skipSetup:true,...options}),before=JSON.stringify(f.ledger().rows);
    assert.throws(()=>f.ctx.setup_(),/見出し|初期記録以外/);
    assert.equal(JSON.stringify(f.ledger().rows),before);assert.equal(f.properties.get('CASHIER_CODE'),'cashier-test-code');
    assert.equal(f.properties.has('DATABASE_ID'),false);
  }
});
test('同じ再送IDで内容を変えた場合は拒否し、キー順だけの違いは許可',()=>{
  const f=fixture(),cash=f.login('cashier'),id=randomUUID();
  const p={ticket:'A',items:[{menuId:'fizz',quantity:1}]};assert.equal(f.invoke(cash,'createOrder',p,id).ok,true);
  assert.equal(f.invoke(cash,'createOrder',{items:p.items,ticket:'A'},id).repeated,true);
  const changed=f.invoke(cash,'createOrder',{ticket:'B',items:p.items},id);
  assert.equal(changed.ok,false);assert.match(changed.message,/異なる内容/);assert.equal(f.ledger().getLastRow(),3);
});
test('スタッフ一覧から表示名を選び、任意名や重複設定は拒否',()=>{
  const f=fixture(),book=[...f.books.values()][0],menu=book.getSheetByName('メニュー');
  menu.getRange(1,7,3,1).setValues([['スタッフ表示名（編集可）'],['会計1'],['提供1']]);
  assert.equal(f.ctx.staffOptions().join(','),'会計1,提供1');
  assert.throws(()=>f.login('cashier','任意名'),/一覧から/);assert.equal(f.login('cashier','会計1').name,'会計1');
  menu.getRange(3,7,1,1).setValues([['会計1']]);assert.throws(()=>f.ctx.staffOptions(),/重複/);
});
test('初期設定は非公開シートを作り、平文利用コードを除去し、日次処理を設定',()=>{
  const f=fixture();assert.ok(f.properties.get('DATABASE_ID'));assert.equal(f.properties.get('CASHIER_CODE'),undefined);assert.equal(f.properties.get('CASHIER_CODE_HASH').length,64);assert.equal(f.triggers.length,1);assert.throws(()=>f.ctx.setup_(),/初期設定済/);
});
test('ログイン・役割のサーバー側検証・セッション失効',()=>{
  const f=fixture();assert.throws(()=>f.ctx.login({role:'admin',name:'甲',code:'wrong',acceptPrivacy:true}),/利用コード/);
  assert.throws(()=>f.ctx.login({role:'admin',name:'甲',code:'admin-test-code',acceptPrivacy:false}),/表示名の扱い/);
  const hand=f.login('handover');const r=f.invoke(hand,'addTickets',{labels:['AA']});assert.equal(r.ok,false);assert.match(r.message,/この担当/);
  f.ctx.logout(hand.token);const dead=f.invoke(hand,'snapshot',{});assert.equal(dead.ok,false);assert.equal(dead.sessionExpired,true);
});
test('同じ操作IDの再送は1回だけ記録。返却後の遅延再送でも新しい注文を変更しない',()=>{
  const f=fixture(),cash=f.login('cashier','会計甲'),hand=f.login('handover','提供乙');
  const request=randomUUID(),payload={ticket:'A',items:[{menuId:'blend-hot',quantity:1}]};
  let r=f.invoke(cash,'createOrder',payload,request);assert.equal(r.ok,true);assert.equal(r.snapshot.state.orders.length,1);const order=r.snapshot.state.orders[0];
  r=f.invoke(cash,'createOrder',payload,request);assert.equal(r.repeated,true);assert.equal(f.ledger().getLastRow(),3);
  f.invoke(hand,'deliver',{orderId:order.id,revision:1,itemNumbers:[1],collectTicket:true});
  const returned=randomUUID();f.invoke(cash,'returnTickets',{labels:['A'],orderIds:{A:order.id}},returned);
  f.invoke(cash,'createOrder',payload);
  r=f.invoke(cash,'returnTickets',{labels:['A'],orderIds:{A:order.id}},returned);assert.equal(r.repeated,true);assert.equal(r.snapshot.state.tickets[0].location,'customer');
  assert.equal(r.snapshot.state.orders.length,1);
});
test('2端末が同じ札を登録しても一方だけ成功する',()=>{
  const f=fixture(),one=f.login('cashier','甲'),two=f.login('cashier','乙'),p={ticket:'B',items:[{menuId:'fizz',quantity:1}]};
  assert.equal(f.invoke(one,'createOrder',p).ok,true);const r=f.invoke(two,'createOrder',p);assert.equal(r.ok,false);assert.match(r.message,/会計に戻って/);assert.equal(f.ledger().getLastRow(),3);
});
test('表の更新失敗でも操作は保存済み。再送で重複しない',()=>{
  const f=fixture(),cash=f.login('cashier'),id=randomUUID(),p={ticket:'Z',items:[{menuId:'peru-iced',quantity:1}]};
  f.projectionFailure(true);let r=f.invoke(cash,'createOrder',p,id);assert.equal(r.ok,true);assert.equal(r.projectionDelayed,true);
  f.projectionFailure(false);r=f.invoke(cash,'createOrder',p,id);assert.equal(r.repeated,true);assert.equal(f.ledger().getLastRow(),3);
  assert.equal([...f.books.values()][0].getSheetByName(f.ctx.orderDaySheet_(r.snapshot.state.orders[0].createdAt)).getLastRow(),2);
  assert.equal(f.invoke(f.login('admin'),'syncSheets',{}).ok,true);
});
test('氏名はJSONに複製せず、表示名一括除去で表と履歴から取り除き全セッションを無効化',()=>{
  const f=fixture(),cash=f.login('cashier','=ニックネーム甲'),admin=f.login('admin','管理乙');
  f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:1}]});
  const values=f.ledger().rows;assert.equal(values[2][4],"'=ニックネーム甲");assert.equal(values[2][6].includes('ニックネーム'),false);
  let r=f.invoke(admin,'removeNames',{confirm:'表示名を除去'});assert.equal(r.ok,true);assert.equal(r.signedOut,true);
  assert.ok(f.ledger().rows.slice(1).every(row=>row[4]==='表示名除去済'));
  const fresh=f.login('admin','管理丙');r=f.invoke(fresh,'snapshot',{});assert.equal(r.state.orders[0].cashier,'表示名除去済');assert.equal(f.invoke(cash,'snapshot',{}).sessionExpired,true);
});
test('30日経過分だけ表示名を除去する日次処理',()=>{
  const f=fixture(),cash=f.login('cashier','期間テスト');f.invoke(cash,'createOrder',{ticket:'B',items:[{menuId:'fizz',quantity:1}]});
  f.ledger().rows[1][2]='2020-01-01T00:00:00.000Z';f.ctx.cleanupExpiredNames_();assert.equal(f.ledger().rows[1][4],'表示名除去済');assert.equal(f.ledger().rows[2][4],'期間テスト');
});
test('利用コード変更は注文を保持し、古いコードとセッションを失効する',()=>{
  const f=fixture(),cash=f.login('cashier');f.invoke(cash,'createOrder',{ticket:'Z',items:[{menuId:'fizz',quantity:1}]});
  for(const role of ['cashier','handover','admin'])f.properties.set(role.toUpperCase()+'_CODE',role+'-new-test-code');
  f.ctx.rotateAccessCodes_();assert.equal(f.invoke(cash,'snapshot',{}).sessionExpired,true);assert.throws(()=>f.login('admin'),/利用コード/);
  const fresh=f.ctx.login({role:'admin',name:'管理テスト',code:'admin-new-test-code',acceptPrivacy:true});assert.equal(f.invoke(fresh,'snapshot',{}).state.orders.length,1);
  assert.equal(f.properties.get('ADMIN_CODE'),undefined);
});


test('通常保存では変更のない日別一覧を読み書きせず、キャッシュなしで成立する',()=>{
  const f=fixture(),cash=f.login('cashier'),admin=f.login('admin'),book=[...f.books.values()][0];
  const unaffected=book.getSheetByName('注文_10月11日_2日目'),before=[unaffected.reads,unaffected.writes];
  f.cache.clear();assert.equal(f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:1}]}).ok,true);
  const ticket=book.getSheetByName('番号札一覧'),ticketWrites=ticket.writes,o=f.ctx.read_().state.orders[0];
  assert.equal(f.invoke(admin,'deliver',{orderId:o.id,revision:o.revision,itemNumbers:[1]}).ok,true);
  assert.deepEqual([unaffected.reads,unaffected.writes],before);assert.equal(ticket.writes,ticketWrites);
  assert.equal(book.getSheetByName(f.ctx.orderDaySheet_(o.createdAt)).rows[1][1],'提供済');
});
test('一覧更新失敗後は次の別操作でも全一覧を修復し、再送IDや台帳を増やさない',()=>{
  const f=fixture(),cash=f.login('cashier'),admin=f.login('admin'),book=[...f.books.values()][0];
  f.projectionFailure(true);const id=randomUUID(),p={ticket:'A',items:[{menuId:'fizz',quantity:1}]};
  assert.equal(f.invoke(cash,'createOrder',p,id).projectionDelayed,true);
  assert.equal(f.properties.get('VIEW_PROJECTION_DIRTY_'+book.id),'1');
  f.projectionFailure(false);assert.equal(f.invoke(admin,'addTickets',{labels:['AA']}).ok,true);
  assert.equal(f.properties.has('VIEW_PROJECTION_DIRTY_'+book.id),false);
  const o=f.ctx.read_().state.orders[0];assert.equal(book.getSheetByName(f.ctx.orderDaySheet_(o.createdAt)).rows[1][4],'フィズ');
  const n=f.ledger().getLastRow();assert.equal(f.invoke(cash,'createOrder',p,id).repeated,true);assert.equal(f.ledger().getLastRow(),n);
});


test('一括更新は日付・杯番号・日本語名を保持し、提供・回収・返却を重複なしで反映',()=>{
  const f=fixture({batch:true,now:'2026-10-10T03:00:00.000Z'}),cash=f.login('cashier'),admin=f.login('admin'),book=[...f.books.values()][0];
  assert.equal(f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:1},{menuId:'fizz',quantity:1}]}).ok,true);
  const o=f.ctx.read_().state.orders[0];let day=book.getSheetByName(f.ctx.orderDaySheet_(o.createdAt));
  assert.ok(Math.abs(day.rows[1][0].getTime()-Date.parse(o.createdAt))<1);assert.equal(day.rows[1][3],'1/2');assert.equal(day.rows[2][4],'フィズ');
  assert.equal(f.invoke(admin,'deliver',{orderId:o.id,revision:o.revision,itemNumbers:[1,2],collectTicket:true}).ok,true);
  assert.equal(f.invoke(admin,'returnTickets',{labels:['A'],orderIds:{A:o.id}}).ok,true);
  assert.equal(day.rows[1][1],'提供済');assert.ok(day.rows[1][6] instanceof Date);assert.ok(day.rows[1][7] instanceof Date);
  assert.equal(book.getSheetByName('番号札一覧').rows[1][2],'会計・使用可能');assert.equal(f.batchCalls(),3);assert.equal(f.ledger().getLastRow(),5);
});
test('一括更新障害でも台帳を失わず同じ操作IDの再送で一覧を修復',()=>{
  const f=fixture({batch:true}),cash=f.login('cashier'),id=randomUUID(),p={ticket:'A',items:[{menuId:'fizz',quantity:1}]};
  f.projectionFailure(true);let r=f.invoke(cash,'createOrder',p,id);assert.equal(r.ok,true);assert.equal(r.projectionDelayed,true);assert.equal(f.ledger().getLastRow(),3);
  f.projectionFailure(false);r=f.invoke(cash,'createOrder',p,id);assert.equal(r.repeated,true);assert.equal(r.projectionDelayed,false);assert.equal(f.ledger().getLastRow(),3);
  const o=f.ctx.read_().state.orders[0];assert.equal([...f.books.values()][0].getSheetByName(f.ctx.orderDaySheet_(o.createdAt)).getLastRow(),2);
});
test('全再同期は余剰行だけ消し、隣の独自入力と文字列の数式安全性を維持',()=>{
  const f=fixture({batch:true}),book=[...f.books.values()][0],sheet=book.getSheetByName('注文_10月10日_1日目');sheet.rows[10]=Array(10).fill('古い余剰');sheet.rows[10][10]='独自入力';
  f.ctx.writeViews_(book,f.ctx.read_().state);assert.equal(sheet.rows[10][0],'');assert.equal(sheet.rows[10][10],'独自入力');
  const c=f.ctx.batchCell_('=1+1');assert.equal(c.userEnteredValue.stringValue,'=1+1');assert.equal(c.userEnteredValue.formulaValue,undefined);
});


test('一括更新が必要行数まで行を増やし、15分境界の日時を集計先へ保持する',()=>{
  const f=fixture({batch:true}),book=[...f.books.values()][0],state=f.ctx.read_().state;
  const e=f.ctx.CoffeeCore_.prepare(state,'admin','createOrder',{ticket:'A',items:[{menuId:'blend-iced',quantity:2}]},{id:randomUUID(),requestId:randomUUID(),at:'2026-10-10T02:45:00.000Z',actor:'会計担当'});
  f.ctx.CoffeeCore_.apply(state,e);const sheet=book.getSheetByName('注文_10月10日_1日目');sheet.maxRows=1;
  f.ctx.writeViews_(book,state);assert.equal(sheet.maxRows,3);assert.equal(sheet.rows[1][0].toISOString(),'2026-10-10T02:45:00.000Z');
  const raw=sheet.rows.map(row=>row.map(v=>v instanceof Date?f.ctx.batchCell_(v).userEnteredValue.numberValue:v));
  assert.equal(raw.length,3);assert.equal(new Date(Math.round((raw[1][0]-25569)*86400000)).toISOString(),'2026-10-10T11:45:00.000Z');
  if(process.env.TEST_WEB_SYNC==='1'){
    const sim=vm.createContext({Date});vm.runInContext(fs.readFileSync(new URL('../../sales_simulation/web_app_sales_sync.gs',import.meta.url),'utf8'),sim);
    const items=sim.salesParseWebTable(raw,'2026-10-10');assert.equal(items.length,2);assert.equal(items[0].minute,705);
  }
});


test('集中操作時はAPI枠を使い続けず通常書込へ切替え、注文と一覧を保持',()=>{
  const f=fixture({batch:true}),cash=f.login('cashier');f.cache.set('view-batch:'+Math.floor(Date.now()/60000),'40');
  assert.equal(f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]}).ok,true);
  assert.equal(f.batchCalls(),0);const o=f.ctx.read_().state.orders[0],book=[...f.books.values()][0];assert.equal(book.getSheetByName(f.ctx.orderDaySheet_(o.createdAt)).rows[1][4],'フィズ');
});

test('4担当の独立保存は全24通りの処理順で欠落・重複なく同じ結果になる',()=>{
  const perms=a=>a.length?a.flatMap((v,i)=>perms(a.filter((_,j)=>i!==j)).map(p=>[v,...p])):[[]];
  for(const sequence of perms([0,1,2,3])){
    const f=fixture({batch:true}),cash=f.login('cashier'),h1=f.login('handover'),h2=f.login('handover'),admin=f.login('admin');
    for(const [ticket,quantity]of [['A',2],['B',2],['C',1]])assert.equal(f.invoke(cash,'createOrder',{ticket,items:[{menuId:'blend-hot',quantity}]}).ok,true);
    const [a,b,c]=f.ctx.read_().state.orders;
    assert.equal(f.invoke(h1,'deliver',{orderId:c.id,revision:1,itemNumbers:[1],collectTicket:true}).ok,true);
    const actions=[[cash,'createOrder',{ticket:'D',items:[{menuId:'fizz',quantity:2}]}],[h1,'deliver',{orderId:a.id,revision:1,itemNumbers:[1,2],collectTicket:true}],[h2,'deliver',{orderId:b.id,revision:1,itemNumbers:[1,2],collectTicket:true}],[admin,'returnTickets',{labels:['C'],orderIds:{C:c.id}}]];
    for(const i of sequence)assert.equal(f.invoke(...actions[i]).ok,true);
    const d=f.ctx.read_();assert.equal(d.events.length,9);assert.equal(d.state.orders.length,4);assert.equal(d.state.orders.flatMap(o=>o.items).filter(i=>i.deliveredAt).length,5);
    assert.equal(d.state.orders.find(o=>o.id===c.id).returnedAt.length>0,true);
    assert.equal(d.book.getSheetByName(f.ctx.orderDaySheet_(a.createdAt)).getLastRow(),8);
  }
});

test('同じ注文の異なる杯でも古い版を拒否し、更新後の再確認だけを受理する',()=>{
  for(const first of [1,2]){
    const f=fixture({batch:true}),cash=f.login('cashier'),h1=f.login('handover'),h2=f.login('handover');
    f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity:2}]});const o=f.ctx.read_().state.orders[0],second=3-first;
    assert.equal(f.invoke(h1,'deliver',{orderId:o.id,revision:1,itemNumbers:[first]}).ok,true);
    const before=f.ledger().getLastRow(),r=f.invoke(h2,'deliver',{orderId:o.id,revision:1,itemNumbers:[second]});
    assert.equal(r.ok,false);assert.equal(r.uncertain,false);assert.match(r.message,/他の端末/);assert.equal(f.ledger().getLastRow(),before);
    const current=f.invoke(h2,'snapshot',{}).state.orders[0];assert.equal(current.revision,2);
    assert.equal(f.invoke(h2,'deliver',{orderId:o.id,revision:2,itemNumbers:[second],collectTicket:true}).ok,true);
    const replay=f.ctx.read_().state.orders[0];assert.equal(replay.items.filter(i=>i.deliveredAt).length,2);assert.equal(replay.revision,3);
    assert.equal(f.invoke(h1,'deliver',{orderId:o.id,revision:3,itemNumbers:[first]}).ok,false);
  }
});

test('保存ロック取得失敗は未保存と明示し、閲覧は保存ロック中も使える',()=>{
  const f=fixture(),cash=f.login('cashier'),admin=f.login('admin'),lock=f.ctx.LockService.getScriptLock();lock.tryLock();const before=f.ledger().getLastRow();
  const r=f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]});assert.equal(r.ok,false);assert.equal(r.uncertain,false);assert.match(r.message,/保存中/);
  assert.ok(f.invoke(admin,'snapshot',{}).state);assert.equal(f.ledger().getLastRow(),before);lock.releaseLock();
});

test('一般スタッフはDiscord通知の設定・テストを実行できず、秘密は一覧へ送らない',()=>{
  const f=fixture(),cash=f.login('cashier'),hand=f.login('handover');f.properties.set('DISCORD_ALERT_BOT_TOKEN','test-token-not-real-123456789');f.properties.set('DISCORD_ALERT_USER_ID','123456789012345678');
  for(const user of [cash,hand])for(const action of ['setDiscordAlerts','testDiscordAlerts'])assert.match(f.invoke(user,action,{enabled:true}).message,/管理者/);
  assert.ok(!JSON.stringify(f.invoke(cash,'snapshot',{})).includes('test-token-not-real'));assert.equal(f.ledger().getLastRow(),2);
});

test('一般担当はコードなしで入り、管理者認証・管理操作を回避できない',()=>{
  const f=fixture();
  for(const role of ['cashier','handover']){
    const general=f.ctx.login({role,roleOnly:true,baseRole:'admin'});
    assert.equal(general.baseRole,'general');
    assert.equal(f.invoke(general,'switchRole',{role:'admin'}).ok,false);
    for(const action of ['setWaitThreshold','setDiscordAlerts','testDiscordAlerts','syncSheets','removeNames'])assert.equal(f.invoke(general,action,{}).ok,false);
  }
  for(const code of [undefined,'','wrong'])assert.throws(()=>f.ctx.login({role:'admin',roleOnly:true,code}),/利用コード/);
  assert.equal(f.login('admin').baseRole,'admin');
});

test('複数札の提供は一括保存・再送しても一度だけ反映、部分提供と回収を分ける',()=>{
  const f=fixture({batch:true}),cash=f.login('cashier'),hand=f.login('handover');
  for(const ticket of ['A','B'])assert.equal(f.invoke(cash,'createOrder',{ticket,items:[{menuId:'blend-hot',quantity:2}]}).ok,true);
  const orders=f.invoke(hand,'snapshot',{}).state.orders;
  const payload={orders:orders.map((o,i)=>({orderId:o.id,revision:o.revision,itemNumbers:i?[1,2]:[1],collectTicket:!!i}))},id=randomUUID(),before=f.ledger().getLastRow();
  let result=f.invoke(hand,'deliverBatch',payload,id);assert.equal(result.ok,true);assert.equal(f.ledger().getLastRow(),before+1);
  result=f.invoke(hand,'deliverBatch',payload,id);assert.equal(result.repeated,true);assert.equal(f.ledger().getLastRow(),before+1);
  assert.equal(result.snapshot.state.orders[0].items[1].deliveredAt,'');assert.ok(result.snapshot.state.orders[1].collectedAt);
  assert.equal(result.snapshot.state.tickets.find(t=>t.label==='A').location,'customer');assert.equal(result.snapshot.state.tickets.find(t=>t.label==='B').location,'collected');
  assert.equal(result.snapshot.state.orders.length,2);
});
test('複数札のうち一件でも競合・不正があれば全件未保存、会計からの一括提供も拒否',()=>{
  const f=fixture(),cash=f.login('cashier'),hand=f.login('handover');
  for(const ticket of ['A','B'])f.invoke(cash,'createOrder',{ticket,items:[{menuId:'fizz',quantity:2}]});
  const orders=f.invoke(hand,'snapshot',{}).state.orders;
  const entries=orders.map(o=>({orderId:o.id,revision:o.revision,itemNumbers:[1],collectTicket:false}));
  f.invoke(hand,'deliver',{...entries[1]});const before=f.ledger().getLastRow();
  for(const [user,payload]of [[hand,{orders:entries}],[cash,{orders:entries}],[hand,{orders:[entries[0],entries[0]]}],[hand,{orders:[entries[0],{...entries[1],revision:2,itemNumbers:[2],collectTicket:true}]}]]){
    // The last payload is valid, so make it fail on an invalid cup instead.
    if(payload.orders[1].collectTicket)payload.orders[1].itemNumbers=[3];
    assert.equal(f.invoke(user,'deliverBatch',payload).ok,false);assert.equal(f.ledger().getLastRow(),before);
  }
  assert.equal(f.invoke(hand,'snapshot',{}).state.orders[0].items[0].deliveredAt,'');
});
test('複数提供の一覧書込障害後は再送で修復し、杯数・操作記録を増やさない',()=>{
  const f=fixture({batch:true}),cash=f.login('cashier'),hand=f.login('handover');
  for(const ticket of ['A','B'])f.invoke(cash,'createOrder',{ticket,items:[{menuId:'fizz',quantity:1}]});
  const orders=f.invoke(hand,'snapshot',{}).state.orders,payload={orders:orders.map(o=>({orderId:o.id,revision:o.revision,itemNumbers:[1],collectTicket:true}))},id=randomUUID();
  f.projectionFailure(true);const result=f.invoke(hand,'deliverBatch',payload,id);assert.equal(result.ok,true);assert.equal(result.projectionDelayed,true);const count=f.ledger().getLastRow();
  f.projectionFailure(false);const retry=f.invoke(hand,'deliverBatch',payload,id);assert.equal(retry.repeated,true);assert.equal(f.ledger().getLastRow(),count);assert.ok(retry.snapshot.state.orders.every(o=>o.items[0].deliveredAt));
});

test('同時の一括提供は異なる操作IDでも一方だけ受理し、重なる札があれば全体を拒否',()=>{
  const f=fixture(),cash=f.login('cashier'),h1=f.login('handover'),h2=f.login('handover');
  for(const ticket of ['A','B','C'])f.invoke(cash,'createOrder',{ticket,items:[{menuId:'fizz',quantity:1}]});
  const orders=f.invoke(h1,'snapshot',{}).state.orders,entry=o=>({orderId:o.id,revision:o.revision,itemNumbers:[1],collectTicket:true});
  const payload={orders:orders.slice(0,2).map(entry)},before=f.ledger().getLastRow();
  assert.equal(f.invoke(h1,'deliverBatch',payload).ok,true);
  assert.equal(f.invoke(h2,'deliverBatch',payload).ok,false);
  assert.equal(f.invoke(h2,'deliverBatch',{orders:orders.slice(1).map(entry)}).ok,false);
  assert.equal(f.ledger().getLastRow(),before+1);
  const state=f.invoke(h1,'snapshot',{}).state;
  assert.ok(state.orders[0].items[0].deliveredAt);assert.ok(state.orders[1].items[0].deliveredAt);assert.equal(state.orders[2].items[0].deliveredAt,'');
});
test('一括提供の遅れた再送は札再利用後の注文に反映せず、同じ操作IDの内容変更も拒否',()=>{
  const f=fixture(),cash=f.login('cashier'),hand=f.login('handover');
  const create=()=>{for(const ticket of ['A','B'])f.invoke(cash,'createOrder',{ticket,items:[{menuId:'fizz',quantity:1}]});};
  create();const orders=f.invoke(hand,'snapshot',{}).state.orders,payload={orders:orders.map(o=>({orderId:o.id,revision:o.revision,itemNumbers:[1],collectTicket:true}))},id=randomUUID();
  assert.equal(f.invoke(hand,'deliverBatch',payload,id).ok,true);
  assert.equal(f.invoke(cash,'returnTickets',{labels:['A','B'],orderIds:Object.fromEntries(orders.map(o=>[o.ticket,o.id]))}).ok,true);create();
  const before=f.ledger().getLastRow(),repeat=f.invoke(hand,'deliverBatch',payload,id);
  assert.equal(repeat.repeated,true);assert.equal(f.ledger().getLastRow(),before);
  assert.ok(repeat.snapshot.state.orders.every(o=>!o.items[0].deliveredAt));
  const changed={orders:payload.orders.map(o=>({...o,collectTicket:false}))};
  assert.equal(f.invoke(hand,'deliverBatch',changed,id).ok,false);assert.equal(f.ledger().getLastRow(),before);
});

test('表示専用はコードなしで閲覧できるが、記録・管理・重複再送の呼出しも拒否する',()=>{
  const f=fixture(),cash=f.login('cashier');f.invoke(cash,'createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]});
  const display=f.ctx.login({role:'display',roleOnly:true}),before=f.ledger().getLastRow();
  const snapshot=f.invoke(display,'snapshot',{});assert.equal(snapshot.state.orders.length,1);assert.equal(snapshot.state.orders[0].cashier,undefined);assert.equal(snapshot.discordAlerts,undefined);
  for(const action of ['createOrder','deliver','deliverBatch','collectTicket','returnTickets','cancelOrder','addTickets','setTicketActive','setWaitThreshold','syncSheets','removeNames','setDiscordAlerts','testDiscordAlerts'])assert.equal(f.invoke(display,action,{}).ok,false);
  assert.equal(f.ledger().getLastRow(),before);assert.equal(f.invoke(display,'switchRole',{role:'admin'}).ok,false);
  assert.equal(f.invoke(display,'switchRole',{role:'handover'}).ok,true);assert.equal(f.invoke(display,'switchRole',{role:'display'}).ok,true);
});
