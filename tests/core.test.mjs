import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/core.js',import.meta.url),'utf8');
function fixture(){
  const ctx=vm.createContext({});vm.runInContext(source,ctx);const core=ctx.CoffeeCore_;let n=0;const events=[];
  function act(role,action,payload,actor='スタッフ甲'){
    const id='op-'+(++n);const e=core.prepare(core.replay(events),role,action,payload,{id,requestId:'request-'+id,at:'2026-10-05T01:00:00.000Z',actor});events.push(e);return core.replay(events);
  }
  act('admin','addTickets',{labels:['A','B','Z']});
  return {core,events,act,state:()=>core.replay(events)};
}
const items=[{menuId:'blend-hot',quantity:2}];
test('札は全杯提供・回収の後も、会計受領まで再利用不可',()=>{
  const f=fixture();let s=f.act('cashier','createOrder',{ticket:'A',items});let o=s.orders[0];
  assert.throws(()=>f.act('cashier','createOrder',{ticket:'A',items}),/会計に戻って/);
  assert.throws(()=>f.act('handover','collectTicket',{orderId:o.id,revision:1}),/未提供/);
  assert.throws(()=>f.act('handover','deliver',{orderId:o.id,revision:1,itemNumbers:[1],collectTicket:true}),/全て/);
  s=f.act('handover','deliver',{orderId:o.id,revision:1,itemNumbers:[1]},'スタッフ乙');o=s.orders[0];
  assert.equal(o.items[0].deliveredBy,'スタッフ乙');assert.equal(o.items[1].deliveredAt,'');
  s=f.act('handover','deliver',{orderId:o.id,revision:2,itemNumbers:[2]},'スタッフ丙');o=s.orders[0];
  assert.equal(s.tickets[0].location,'customer');assert.equal(o.items[1].deliveredBy,'スタッフ丙');
  s=f.act('handover','collectTicket',{orderId:o.id,revision:3});assert.equal(s.tickets[0].location,'collected');
  assert.throws(()=>f.act('cashier','createOrder',{ticket:'A',items}),/会計に戻って/);
  s=f.act('cashier','returnTickets',{labels:['A'],orderIds:{A:o.id}});assert.equal(s.tickets[0].location,'cashier');
  s=f.act('cashier','createOrder',{ticket:'A',items});assert.equal(s.orders.length,2);assert.notEqual(s.orders[0].id,s.orders[1].id);assert.ok(s.orders[0].returnedAt);
});
test('管理者が停止前注文の部分提供を整理し、実物回収・返却後だけ札を再利用できる',()=>{
  const f=fixture();let o=f.act('cashier','createOrder',{ticket:'A',items}).orders[0];
  f.act('handover','deliver',{orderId:o.id,revision:1,itemNumbers:[1]});
  assert.throws(()=>f.act('admin','collectTicket',{orderId:o.id,revision:2}),/未提供/);
  assert.throws(()=>f.act('admin','returnTickets',{labels:['A'],orderIds:{A:o.id}}),/回収済み/);
  f.act('admin','deliver',{orderId:o.id,revision:2,itemNumbers:[2]});
  assert.equal(f.state().tickets[0].location,'customer');
  f.act('admin','collectTicket',{orderId:o.id,revision:3});
  f.act('admin','returnTickets',{labels:['A'],orderIds:{A:o.id}});
  const s=f.act('cashier','createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]});
  assert.equal(s.orders.length,2);assert.ok(s.orders[0].returnedAt);assert.equal(s.orders[1].items.length,1);
});
test('事前担当を置かず、別の人が残りのカップを提供できる',()=>{
  const f=fixture();let o=f.act('cashier','createOrder',{ticket:'Z',items}).orders[0];
  let s=f.act('handover','deliver',{orderId:o.id,revision:1,itemNumbers:[1]},'甲');o=s.orders[0];
  assert.throws(()=>f.act('handover','deliver',{orderId:o.id,revision:1,itemNumbers:[2]},'乙'),/他の端末/);
  s=f.act('handover','deliver',{orderId:o.id,revision:2,itemNumbers:[2],collectTicket:true},'乙');
  assert.equal(s.orders[0].items[1].deliveredBy,'乙');assert.equal(s.tickets[2].location,'collected');
});
test('番号札の追加、重複防止、使用停止と再開',()=>{
  const f=fixture();let s=f.act('admin','addTickets',{labels:['aa','２７','B-1']});assert.equal(s.tickets[3].label,'AA');assert.equal(s.tickets[4].label,'27');
  assert.throws(()=>f.act('admin','addTickets',{labels:['AA']}),/登録済み/);
  assert.throws(()=>f.act('admin','addTickets',{labels:['x','X']}),/重複/);
  assert.throws(()=>f.act('admin','addTickets',{labels:['<script>']}),/文字/);
  f.act('admin','setTicketActive',{label:'AA',active:false});assert.throws(()=>f.act('cashier','createOrder',{ticket:'AA',items}),/使用可能/);
  f.act('admin','setTicketActive',{label:'AA',active:true});f.act('cashier','createOrder',{ticket:'AA',items});
  assert.throws(()=>f.act('admin','setTicketActive',{label:'AA',active:false}),/未使用/);
});
test('一括返却は全件検証してから記録する。古い注文で札を返却できない',()=>{
  const f=fixture();const a=f.act('cashier','createOrder',{ticket:'A',items:[{menuId:'fizz',quantity:1}]}).orders[0];
  f.act('handover','deliver',{orderId:a.id,revision:1,itemNumbers:[1],collectTicket:true});
  assert.throws(()=>f.act('cashier','returnTickets',{labels:['A','B'],orderIds:{A:a.id}}),/回収済み/);assert.equal(f.state().tickets[0].location,'collected');
  assert.throws(()=>f.act('cashier','returnTickets',{labels:['A'],orderIds:{A:'old-order'}}),/更新/);
});
test('札がない取消は会計だけで後から受領でき、受け渡し回収は不要',()=>{
  const f=fixture();let o=f.act('cashier','createOrder',{ticket:'B',items}).orders[0];
  f.act('cashier','cancelOrder',{orderId:o.id,revision:1});assert.equal(f.state().tickets[1].location,'customer');
  assert.throws(()=>f.act('handover','collectTicket',{orderId:o.id,revision:2}),/会計担当/);
  assert.throws(()=>f.act('cashier','returnTickets',{labels:['B'],orderIds:{B:'wrong-order'}}),/更新/);
  f.act('cashier','returnTickets',{labels:['B'],orderIds:{B:o.id}});assert.equal(f.state().tickets[1].location,'cashier');assert.ok(f.state().orders[0].returnedAt);
});

test('取消時に札が会計にある場合だけ同時に返却し、すぐ再使用できる',()=>{
  const f=fixture();const o=f.act('cashier','createOrder',{ticket:'A',items}).orders[0];
  const s=f.act('cashier','cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:true},'会計担当');
  assert.equal(s.orders[0].cancelled,true);assert.ok(s.orders[0].collectedAt);assert.ok(s.orders[0].returnedAt);
  assert.equal(s.orders[0].returnedBy,'会計担当');assert.equal(s.tickets[0].location,'cashier');assert.equal(s.tickets[0].orderId,'');
  assert.ok(s.orders[0].items.every(i=>!i.deliveredAt));
  f.act('cashier','createOrder',{ticket:'A',items});
  assert.throws(()=>f.act('cashier','cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:true}),/他の端末/);
  assert.equal(f.state().tickets[0].orderId,f.state().orders[1].id);
});

test('札がない取消と不正な選択は札を再使用可能にしない',()=>{
  const f=fixture(),o=f.act('cashier','createOrder',{ticket:'A',items}).orders[0];
  assert.throws(()=>f.act('cashier','cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:'true'}),/選んで/);
  assert.throws(()=>f.act('handover','cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:true}),/この担当/);
  f.act('cashier','cancelOrder',{orderId:o.id,revision:1,ticketAtCashier:false});
  assert.throws(()=>f.act('cashier','createOrder',{ticket:'A',items}),/会計に戻って/);
});
test('商品入力の検証と役割ごとの権限',()=>{
  const f=fixture();assert.equal(f.core.menu.length,7);
  for(const quantity of [0,-1,1.5,21,'1'])assert.throws(()=>f.act('cashier','createOrder',{ticket:'A',items:[{menuId:'blend-hot',quantity}]}),/数量/);
  assert.throws(()=>f.act('cashier','createOrder',{ticket:'A',items:[{menuId:'drip-bag',quantity:1}]}),/商品/);
  assert.throws(()=>f.act('handover','createOrder',{ticket:'A',items}),/この担当/);
  assert.throws(()=>f.act('cashier','addTickets',{labels:['C']}),/この担当/);
});
test('通常スタッフへ返却済みの履歴を送らない',()=>{
  const f=fixture();const o=f.act('cashier','createOrder',{ticket:'A',items:[{menuId:'peru-iced',quantity:1}]}).orders[0];
  f.act('handover','deliver',{orderId:o.id,revision:1,itemNumbers:[1],collectTicket:true});f.act('cashier','returnTickets',{labels:['A'],orderIds:{A:o.id}});
  assert.equal(f.core.view(f.state(),'handover').orders.length,0);assert.equal(f.core.view(f.state(),'admin').orders.length,1);
  assert.equal('requestIds' in f.core.view(f.state(),'admin'),false);
});
