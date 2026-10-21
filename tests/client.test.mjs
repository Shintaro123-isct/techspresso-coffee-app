import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture(options={}){
  const storage=new Map(),nodes={},handlers={},buttons=[{disabled:false}],cards=[];
  const app={innerHTML:'',querySelectorAll(q){if(q==='[data-order]')return cards;if(q==='button')return buttons;return [];},querySelector(){return null;},addEventListener(){}};
  const node=id=>nodes[id]??={innerHTML:'',hidden:true};nodes.app=app;
  let source=fs.readFileSync(new URL('../src/client.js',import.meta.url),'utf8');
  source=source.slice(0,source.indexOf('  try{pending=JSON.parse'))+`
    testHooks.ui={configure:function(p,s){person=p;snapshot=s;lastSynced=Date.now();tab='handover';},setMutate:function(fn){mutate=fn;},setSelections:function(value){cupSelections=value;},selectedDeliveries:selectedDeliveries,updateBatchDelivery:updateBatchDelivery,renderDisplay:renderDisplay,renderReturns:renderReturns,updateWarnings:updateWarnings,renderOrders:renderOrders,render:render,remember:rememberInputs,sessionStore:sessionStore,pendingStore:pendingStore,setPending:function(p){pending=p;busy=!!p;},getSelections:function(){return cupSelections;},setTab:function(t){tab=t;},setCall:function(fn){call=fn;},refresh:refresh,mutate:mutate,getSnapshot:function(){return snapshot;},getPerson:function(){return person;}};
  }());`;
  const ctx=vm.createContext({...(options.cloudflare?{window:{TECHSPRESSO_CLOUDFLARE:true,location:{replace:url=>{handlers.redirect=url;}}}}:{}),testHooks:{},crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},google:{script:{run:{}}},document:{getElementById:node,body:{classList:{toggle(){},remove(){}},appendChild(){}},createElement(){if(options.makeDialog)return options.makeDialog(handlers);const parts={p:{style:{}},'[data-no]':{},'[data-yes]':{}};return {className:'',innerHTML:'',querySelector:q=>parts[q],close(){},remove(){},showModal(){handlers.confirmText=parts.p.textContent;Promise.resolve().then(()=>parts[options.confirmBatch?'[data-yes]':'[data-no]'].onclick());}};}},localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)||null,removeItem:k=>storage.delete(k)},Date:options.Date||Date,console,setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(source,ctx);
  return {ui:ctx.testHooks.ui,storage,node,cards,buttons,handlers};
}
test('残り全杯を選ぶと札回収もチェックし、1杯を外すと回収を解除する',()=>{
  const f=fixture(),cups=[{dataset:{cup:'2'},checked:false},{dataset:{cup:'3'},checked:false}],collect={checked:false},deliver={disabled:true};
  f.cards.push({dataset:{order:'order-1'},querySelectorAll:q=>q==='[data-cup]'?cups:[],querySelector:q=>({'[data-collect-with]':collect,'[data-deliver]':deliver}[q]||null)});
  f.ui.configure({role:'handover'}, {serverTime:new Date().toISOString(),state:{orders:[{id:'order-1',ticket:'A',revision:2,createdAt:new Date().toISOString(),cashier:'会計担当',items:[{number:1,name:'Coffee',temperature:'Hot',deliveredAt:'done'},{number:2,name:'Coffee',temperature:'Hot'},{number:3,name:'Coffee',temperature:'Hot'}]}]}});
  f.ui.renderOrders();cups[0].checked=true;cups[0].onchange();assert.equal(collect.checked,false);
  cups[1].checked=true;cups[1].onchange();assert.equal(collect.checked,true);assert.equal(deliver.disabled,false);
  cups[0].checked=false;cups[0].onchange();assert.equal(collect.checked,false);
  assert.deepEqual(JSON.parse(f.storage.get('techspresso-inputs')).cupSelections['order-1'].numbers,[3]);
});

test('受け渡しでは4商品すべて日本語の大見出しと正式名称を表示する',()=>{
  const f=fixture(),names=['Dark Roast Blend','Nicaragua Los Altiplanos Pacamara Washed','Peru Classic Puno Washed','Bittersweet Fizz'];
  f.ui.configure({role:'handover'},{serverTime:new Date().toISOString(),state:{orders:[{id:'a',ticket:'A',revision:1,createdAt:new Date().toISOString(),items:names.map((name,i)=>({name,number:i+1,temperature:'Hot'}))}]}});
  f.ui.renderOrders();const html=f.node('workspace').innerHTML;
  for(const [i,label]of ['ブレンド','ニカラグア','ペルー','フィズ'].entries()){
    assert.ok(html.includes('class="cuptitle">'+label+'</span><span class="cupformal">'+names[i]+'</span>'));
  }
});
test('指定基準より古い未提供注文だけを目立たせる',()=>{
  const f=fixture();const now=Date.now();
  f.ui.configure({role:'handover'}, {waitThresholdMinutes:15,serverTime:new Date(now).toISOString(),state:{orders:[{id:'o',ticket:'A',revision:0,createdAt:new Date(now-16*60000).toISOString(),cashier:'会計担当',items:[{number:1,name:'Coffee',temperature:'Hot'}]}]}});
  f.ui.renderOrders();assert.match(f.node('workspace').innerHTML,/order-card old/);assert.match(f.node('workspace').innerHTML,/15分/);
  f.ui.configure({role:'handover'}, {waitThresholdMinutes:20,serverTime:new Date(now).toISOString(),state:{orders:[{id:'o',ticket:'A',revision:0,createdAt:new Date(now-16*60000).toISOString(),cashier:'会計担当',items:[{number:1,name:'Coffee',temperature:'Hot'}]}]}});
  f.ui.renderOrders();assert.doesNotMatch(f.node('workspace').innerHTML,/order-card old/);
});

test('会計の全7商品は旧英語表示名が届いても日本語見出しと正式名称を併記する',()=>{
  const f=fixture(),names=['Dark Roast Blend','Nicaragua Los Altiplanos Pacamara Washed','Peru Classic Puno Washed','Bittersweet Fizz'];
  const menu=names.flatMap((name,i)=>(i===3?['']:['Hot','Iced']).map(temperature=>({id:i+'-'+temperature,name,temperature,displayName:i===1?'Nicaragua':name})));
  f.ui.configure({role:'cashier'},{menu,serverTime:new Date().toISOString(),state:{tickets:[],orders:[]}});f.ui.setTab('cashier');f.ui.render();
  const html=f.node('workspace').innerHTML;
  for(const [i,label]of ['ブレンド','ニカラグア','ペルー','フィズ'].entries()){
    assert.ok(html.includes('<h3>'+label+'</h3><div class="detail">'+names[i]+'</div>'));
  }
  assert.equal((html.match(/<article class="menu-item /g)||[]).length,7);
});

test('受け渡しにも注文確認タブを表示し、確認画面には取消・提供の操作を出さない',()=>{
  const f=fixture(),snap={serverTime:new Date().toISOString(),state:{tickets:[],orders:[{id:'a',ticket:'A',revision:1,createdAt:new Date().toISOString(),cashier:'会計担当',items:[{number:1,name:'Dark Roast Blend',temperature:'Hot'}]}]}};
  f.ui.configure({role:'handover'},snap);f.ui.setTab('orders');f.ui.render();
  assert.match(f.node('app').innerHTML,/data-tab="handover"/);assert.match(f.node('app').innerHTML,/data-tab="orders"/);
  const html=f.node('workspace').innerHTML;assert.match(html,/ブレンド/);assert.match(html,/Dark Roast Blend/);assert.match(html,/残り 1杯/);
  for(const attr of ['data-cancel','data-cup=','data-deliver','data-collect'])assert.ok(!html.includes(attr));
  f.ui.configure({role:'cashier'},snap);f.ui.setTab('orders');f.ui.render();assert.match(f.node('workspace').innerHTML,/data-cancel/);
});
test('セッションと未確認操作はタブを超えて残るlocalStorageへ保存する',()=>{
  const f=fixture();f.ui.sessionStore({token:'sample-session',role:'cashier'});f.ui.setPending({action:'returnTickets',payload:{labels:['A']},requestId:'same-id',message:'saved'});f.ui.pendingStore();
  assert.equal(JSON.parse(f.storage.get('techspresso-session')).token,'sample-session');
  assert.equal(JSON.parse(f.storage.get('techspresso-pending')).requestId,'same-id');
  f.ui.sessionStore(null);assert.equal(f.storage.has('techspresso-session'),false);
});

test('会計の取消は札のある・ないを必須選択し、戻る場合は保存しない',async()=>{
  for(const answer of ['yes','no',null]){
    const calls=[],cancel={},choice={value:''},submit={disabled:true},back={},p={};
    const f=fixture({makeDialog(){return {innerHTML:'',querySelector:q=>({p,'[data-ticket-held]':choice,'[data-yes]':submit,'[data-no]':back}[q]),close(){},remove(){},showModal(){
      assert.match(this.innerHTML,/番号札は手元にありますか/);assert.match(this.innerHTML,/value="yes">ある/);assert.match(this.innerHTML,/value="no">ない/);assert.match(this.innerHTML,/data-yes class="danger" disabled/);
      Promise.resolve().then(()=>{submit.onclick();assert.equal(calls.length,0);if(answer===null)back.onclick();else{choice.value=answer;choice.onchange();assert.equal(submit.disabled,false);submit.onclick();}});
    }};}});
    f.cards.push({dataset:{order:'cancel-me'},querySelectorAll:()=>[],querySelector:q=>q==='[data-cancel]'?cancel:null});
    f.ui.configure({role:'cashier'},{serverTime:new Date().toISOString(),state:{orders:[{id:'cancel-me',ticket:'A',revision:7,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee',temperature:'Hot'}]}]}});
    f.ui.setTab('orders');f.ui.setMutate((action,payload)=>calls.push({action,payload}));f.ui.renderOrders();await cancel.onclick();
    assert.equal(calls.length,answer===null?0:1);if(answer!==null){assert.equal(calls[0].action,'cancelOrder');assert.equal(calls[0].payload.ticketAtCashier,answer==='yes');assert.equal(calls[0].payload.revision,7);}
  }
});

test('取消して札がない注文は会計の受領確認に出し、受け渡し一覧には出さない',()=>{
  const f=fixture(),snap={serverTime:new Date().toISOString(),state:{tickets:[{label:'A',orderId:'cancelled',location:'customer'},{label:'B',orderId:'live',location:'customer'},{label:'C',orderId:'done',location:'collected'}],orders:[{id:'cancelled',ticket:'A',cancelled:true,revision:2,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee'}]},{id:'live',ticket:'B',revision:1,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee'}]}]}};
  f.ui.configure({role:'cashier'},snap);f.ui.renderReturns();const html=f.node('workspace').innerHTML;
  assert.match(html,/data-return="A"/);assert.match(html,/取消済み・会計で未受領/);assert.match(html,/data-return="C"/);assert.doesNotMatch(html,/data-return="B"/);
  f.ui.configure({role:'handover'},snap);f.ui.setTab('handover');f.ui.renderOrders();
  assert.doesNotMatch(f.node('workspace').innerHTML,/data-order="cancelled"/);assert.match(f.node('workspace').innerHTML,/data-order="live"/);
});

test('古いタブの自動更新は別タブで最後に選んだ担当を上書きしない',async()=>{
  const f=fixture(),snap={serverTime:new Date().toISOString(),expiresAt:Date.now()+7200000,state:{orders:[],tickets:[]}};
  const old={token:'shared',role:'display',baseRole:'general',expiresAt:1};
  const latest={token:'shared',role:'handover',baseRole:'general',expiresAt:2};
  f.ui.configure(old,snap);f.ui.sessionStore(latest);f.ui.setCall(async()=>snap);
  await f.ui.refresh(true);assert.deepEqual(JSON.parse(f.storage.get('techspresso-session')),latest);
  f.ui.configure(latest,snap);await f.ui.refresh(true);
  assert.equal(JSON.parse(f.storage.get('techspresso-session')).expiresAt,snap.expiresAt);
});

test('古い表示専用タブの失効・自動再認証は新しいログインを上書きしない',async()=>{
  const f=fixture(),snap={serverTime:new Date().toISOString(),state:{orders:[],tickets:[]}};
  const latest={token:'latest',role:'cashier',baseRole:'general',expiresAt:Date.now()+7200000};let reads=0;
  f.ui.configure({token:'old',role:'display',baseRole:'general'},snap);f.ui.sessionStore(latest);
  f.ui.setCall(async(method)=>method==='login'?{token:'renewed',role:'display',baseRole:'general'}:++reads===1?{ok:false,message:'ログインし直してください。'}:snap);
  await f.ui.refresh(true);assert.deepEqual(JSON.parse(f.storage.get('techspresso-session')),latest);
});

test('保存より遅れて到着した古い一覧は保存後の状態を上書きしない',async()=>{
  const f=fixture(),snap=version=>({serverTime:new Date().toISOString(),state:{version,orders:[],tickets:[]}});
  f.ui.configure({role:'handover',token:'test'},snap(1));let finishRead;
  f.ui.setCall((method,args)=>args[1]==='snapshot'?new Promise(resolve=>{finishRead=resolve;}):Promise.resolve({ok:true,snapshot:snap(2)}));
  const read=f.ui.refresh(true);await f.ui.mutate('deliver',{},null,'保存済み');finishRead(snap(1));await read;
  assert.equal(f.ui.getSnapshot().state.version,2);
});

test('別端末との競合で保存を拒否されたら最新一覧を取得し古い杯選択を外す',async()=>{
  const f=fixture(),snap=revision=>({serverTime:new Date().toISOString(),state:{orders:[{id:'a',ticket:'A',revision,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee',temperature:'Hot',deliveredAt:revision===2?'done':''},{number:2,name:'Coffee',temperature:'Hot'}]}],tickets:[]}});
  f.ui.configure({role:'handover',token:'test'},snap(1));
  f.ui.getSelections().a={revision:1,numbers:[2],collect:false};let reads=0;
  f.ui.setCall((method,args)=>{if(args[1]==='snapshot'){reads++;return Promise.resolve(snap(2));}return Promise.resolve({ok:false,uncertain:false,message:'他の端末でこの注文が更新されました。'});});
  await f.ui.mutate('deliver',{orderId:'a',revision:1,itemNumbers:[2]},null,'保存済み');
  assert.equal(reads,1);assert.equal(f.ui.getSnapshot().state.orders[0].revision,2);
  assert.equal(f.ui.getSelections().a,undefined);
  assert.equal(f.storage.has('techspresso-pending'),false);
});

test('競合時に旧一覧の通信が残っていても完了後に最新一覧を取り直す',async()=>{
  const f=fixture(),snap=v=>({serverTime:new Date().toISOString(),state:{version:v,orders:[],tickets:[]}});f.ui.configure({role:'handover',token:'test'},snap(1));let oldRead,reads=0;
  f.ui.setCall((method,args)=>{if(args[1]==='snapshot'){reads++;return reads===1?new Promise(resolve=>{oldRead=resolve;}):Promise.resolve(snap(2));}return Promise.resolve({ok:false,uncertain:false,message:'他の端末でこの注文が更新されました。'});});
  const reading=f.ui.refresh(true);await f.ui.mutate('deliver',{},null,'保存済み');oldRead(snap(1));await reading;
  assert.equal(reads,2);assert.equal(f.ui.getSnapshot().state.version,2);
});

test('保存結果が不明なら同じ再送IDを保持し新しい保存を重ねない',async()=>{
  const f=fixture();f.ui.configure({role:'handover',token:'test'},{serverTime:new Date().toISOString(),state:{orders:[],tickets:[]}});let writes=0;
  f.ui.setCall(()=>{writes++;return Promise.resolve({ok:false,uncertain:true,message:'保存状態を確認できません。'});});
  await f.ui.mutate('deliver',{orderId:'a',revision:1,itemNumbers:[1]},null,'保存済み');const original=f.storage.get('techspresso-pending');
  assert.ok(JSON.parse(original).requestId);assert.equal(f.node('uncertain').hidden,false);
  await f.ui.mutate('deliver',{orderId:'b',revision:1,itemNumbers:[1]},null,'保存済み');assert.equal(writes,1);assert.equal(f.storage.get('techspresso-pending'),original);
});

test('選択中でも時間の境界で赤警告だけ更新し、杯・回収チェックと保存中表示を維持する',()=>{
  let now=Date.now();class Clock extends Date{static now(){return now;}}
  const f=fixture({Date:Clock}),badge={hidden:true,textContent:''},age={textContent:''},cup={checked:true},collect={checked:true},classes=new Set();
  f.cards.push({dataset:{order:'a'},classList:{toggle(k,on){if(on)classes.add(k);else classes.delete(k);}},querySelector:q=>({'[data-late-badge]':badge,'[data-order-age]':age,'[data-cup]':cup,'[data-collect-with]':collect}[q]||null)});
  f.ui.configure({role:'handover'},{waitThresholdMinutes:15,serverTime:new Date(now).toISOString(),state:{orders:[{id:'a',ticket:'A',revision:1,createdAt:new Date(now-15*60000).toISOString(),items:[{number:1,name:'Coffee'}]}]}});
  f.ui.getSelections().a={revision:1,numbers:[1],collect:true};f.ui.setPending({action:'deliver',requestId:'keep'});
  f.ui.updateWarnings();assert.equal(classes.has('old'),false);now+=1000;f.ui.updateWarnings();assert.equal(classes.has('old'),true);assert.equal(badge.hidden,false);assert.match(badge.textContent,/未提供1杯/);assert.equal(f.node('late-warning').hidden,false);
  assert.equal(cup.checked,true);assert.equal(collect.checked,true);assert.deepEqual(f.ui.getSelections().a.numbers,[1]);
  f.ui.getSnapshot().state.orders[0].items[0].deliveredAt='done';f.ui.updateWarnings();assert.equal(classes.has('old'),false);assert.equal(badge.hidden,true);assert.equal(f.node('late-warning').hidden,true);
});

test('複数札の提供ボタンは選択杯のみを数え、古い選択を除き、11枚以上を止める',()=>{
  const f=fixture(),orders=Array.from({length:11},(_,i)=>({id:'o'+i,ticket:String(i),revision:1,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee'},{number:2,name:'Coffee'}]}));
  f.ui.configure({role:'handover'},{serverTime:new Date().toISOString(),state:{orders}});
  f.ui.setSelections({o0:{revision:1,numbers:[1],collect:false},o1:{revision:1,numbers:[1,2],collect:true},o2:{revision:0,numbers:[1],collect:false}});
  f.ui.updateBatchDelivery();assert.equal(f.node('batch-delivery').hidden,false);assert.equal(f.node('batch-summary').textContent,'2枚の番号札・計3杯を選択中');assert.equal(f.node('batch-deliver').disabled,false);
  assert.equal(f.ui.selectedDeliveries().length,2);
  f.ui.setSelections(Object.fromEntries(orders.map(o=>[o.id,{revision:1,numbers:[1],collect:false}])));f.ui.updateBatchDelivery();assert.equal(f.node('batch-deliver').disabled,true);
  f.ui.setSelections({o0:{revision:1,numbers:[1],collect:false}});f.ui.updateBatchDelivery();assert.equal(f.node('batch-delivery').hidden,true);
});

test('一括提供は札・カップ・回収の確認を出し、戻る場合は保存しない',async()=>{
  for(const confirmBatch of [false,true]){
    const f=fixture({confirmBatch}),orders=[{id:'a',ticket:'A',revision:1,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee'}]},{id:'b',ticket:'B',revision:2,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee'},{number:2,name:'Coffee'}]}],calls=[];
    f.ui.configure({role:'handover'},{serverTime:new Date().toISOString(),state:{orders}});
    f.ui.setSelections({a:{revision:1,numbers:[1],collect:true},b:{revision:2,numbers:[2],collect:false}});
    f.ui.setMutate((action,payload)=>calls.push({action,payload}));f.ui.renderOrders();await f.node('batch-deliver').onclick();
    assert.match(f.handlers.confirmText,/札 A：1杯.*番号札も回収/);assert.match(f.handlers.confirmText,/札 B：1杯.*札回収は記録しない/);
    assert.equal(calls.length,confirmBatch?1:0);if(confirmBatch){assert.equal(calls[0].action,'deliverBatch');assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload.orders)).map(e=>e.itemNumbers),[[1],[2]]);}
  }
});

test('表示専用は通常・時間超過を左右に分け、提供済みを除き操作ボタンを出さない',()=>{
  const f=fixture(),now=Date.now(),order=(id,age,done=false)=>({id,ticket:id,createdAt:new Date(now-age*60000).toISOString(),items:[{number:1,name:'Dark Roast Blend',temperature:'Hot',deliveredAt:done?'done':''}]});
  f.ui.configure({role:'display'},{serverTime:new Date(now).toISOString(),state:{orders:[order('A',10),order('B',25),order('C',35),order('D',40,true)],tickets:[]},waitThresholdMinutes:15});
  f.ui.render();const html=f.node('display-board').innerHTML;
  assert.ok(html.indexOf('受付済み')<html.indexOf('時間超過'));assert.match(html,/25分経過/);assert.match(html,/10分超過/);assert.match(html,/至急確認/);assert.ok(!html.includes('call-ticket">D'));assert.ok(!/<button|<input|<form/.test(html));assert.ok(!f.node('app').innerHTML.includes('注文登録'));
});
test('表示専用は以前の杯選択が残っていても自動更新する',async()=>{
  const f=fixture(),snapshot={serverTime:new Date().toISOString(),state:{orders:[],tickets:[]},waitThresholdMinutes:15};let reads=0;
  f.ui.configure({role:'display',token:'display-token'},snapshot);f.ui.setSelections({old:{revision:1,numbers:[1],collect:false}});
  f.ui.setCall(async()=>{reads++;return snapshot;});await f.ui.refresh(false);assert.equal(reads,1);
});

test('表示専用の2時間失効後は読み取り担当だけで再認証し、管理者権限を引き継がない',async()=>{
  const f=fixture(),snapshot={serverTime:new Date().toISOString(),state:{orders:[],tickets:[]},waitThresholdMinutes:15};let reads=0,logins=0;
  f.ui.configure({role:'display',baseRole:'admin',token:'expired'},snapshot);
  f.ui.setCall(async(method,args)=>{if(method==='login'){logins++;assert.equal(args[0].role,'display');assert.equal(args[0].code,'');return {role:'display',baseRole:'general',token:'new'};}if(++reads===1)return {ok:false,message:'ログインし直してください。'};return snapshot;});
  await f.ui.refresh(false);assert.equal(logins,1);assert.equal(reads,2);assert.equal(f.ui.getPerson().baseRole,'general');
});


test('全選択は未提供杯だけ選び、複数札の確認へ渡し、選択だけでは保存しない',async()=>{
  const f=fixture({confirmBatch:true}),calls=[],controls=[];
  const orders=['A','B'].map((ticket,k)=>({id:'all-'+k,ticket,revision:3,createdAt:new Date().toISOString(),items:[{number:1,name:'Coffee',temperature:'Hot',deliveredAt:'done'},{number:2,name:'Coffee',temperature:'Hot'},{number:3,name:'Coffee',temperature:'Iced'}]}));
  for(const o of orders){
    const cups=[2,3].map(n=>({dataset:{cup:String(n)},checked:false})),all={checked:false},collect={checked:false},deliver={disabled:true};
    controls.push({cups,all,collect,deliver});
    f.cards.push({dataset:{order:o.id},querySelectorAll:q=>q==='[data-cup]'?cups:[],querySelector:q=>({'[data-select-all]':all,'[data-collect-with]':collect,'[data-deliver]':deliver}[q]||null)});
  }
  f.ui.configure({role:'handover'},{serverTime:new Date().toISOString(),state:{orders}});f.ui.setMutate((action,payload)=>calls.push({action,payload}));f.ui.renderOrders();
  assert.match(f.node('workspace').innerHTML,/data-select-all/);
  for(const c of controls){c.all.checked=true;c.all.onchange();assert.ok(c.cups.every(x=>x.checked));assert.equal(c.collect.checked,true);assert.equal(c.deliver.disabled,false);}
  assert.equal(calls.length,0);assert.equal(f.node('batch-delivery').hidden,false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ui.selectedDeliveries())).map(e=>e.itemNumbers),[[2,3],[2,3]]);
  controls[0].cups[0].checked=false;controls[0].cups[0].onchange();assert.equal(controls[0].all.checked,false);assert.equal(controls[0].all.indeterminate,true);assert.equal(controls[0].collect.checked,false);
  controls[0].all.checked=true;controls[0].all.onchange();await f.node('batch-deliver').onclick();assert.equal(calls.length,1);assert.equal(calls[0].action,'deliverBatch');assert.equal(calls[0].payload.orders.length,2);
  controls[0].all.checked=false;controls[0].all.onchange();assert.ok(controls[0].cups.every(x=>!x.checked));assert.equal(controls[0].collect.checked,false);assert.equal(controls[0].deliver.disabled,true);assert.equal(f.node('batch-delivery').hidden,true);
});


test('受け渡しは未提供を受付順で先に置き、提供済み返却待ちは後ろへ置く',()=>{
 const f=fixture(),order=(id,time,done,cancelled=false)=>({id,ticket:id,revision:1,createdAt:'2026-10-09T'+time+':00+09:00',cancelled,items:[{number:1,name:'Coffee',deliveredAt:done?'done':''}]});
 f.ui.configure({role:'handover'},{serverTime:new Date().toISOString(),state:{orders:[order('done','10:00',true),order('later','12:00',false),order('early','11:00',false),order('cancel','09:00',false,true)]}});
 f.ui.renderOrders();const html=f.node('workspace').innerHTML;
 const pos=id=>html.indexOf('data-order="'+id+'"');assert.ok(pos('early')<pos('later'));assert.ok(pos('later')<pos('done'));assert.equal(pos('cancel'),-1);
 f.ui.setSelections({early:{revision:1,numbers:[1],collect:true},later:{revision:1,numbers:[1],collect:true}});f.ui.updateBatchDelivery();assert.equal(f.node('batch-deliver').textContent,'選択した2札・計2杯を提供完了');assert.match(html,/batch-delivery-bar/);
});


test('Cloudflare管理: 会計・提供を選ぶと現在の画面へ移り、セッションを引き継ぐ',()=>{
 for(const target of ['cashier','handover']){const f=fixture({cloudflare:true}),person={role:'admin',baseRole:'admin',token:'local-session',expiresAt:Date.now()+60000};f.ui.configure(person,{state:{}});f.ui.setTab(target);f.ui.render();assert.equal(f.handlers.redirect,'/?screen='+target);assert.equal(JSON.parse(f.storage.get('tc-qr-v1-person-'+target)).token,'local-session');assert.doesNotMatch(f.node('app').innerHTML,/menu-item|data-deliver/);}
});

test('Cloudflare管理: 保存結果が不明な間は古い注文画面や別担当へ進めない',()=>{
 const f=fixture({cloudflare:true});f.ui.configure({role:'cashier'},{state:{}});f.ui.setTab('cashier');f.ui.setPending({action:'createOrder'});f.ui.render();assert.equal(f.handlers.redirect,undefined);assert.match(f.node('app').innerHTML,/保存状態を確認/);
});
