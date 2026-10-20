/* Shared state machine for Apps Script and the browser-only trial. */
var CoffeeCore_ = (function () {
  'use strict';
  var menu = [
    {id:'blend-hot', name:'Dark Roast Blend', temperature:'Hot', price:500},
    {id:'blend-iced', name:'Dark Roast Blend', temperature:'Iced', price:600},
    {id:'nicaragua-hot', name:'Nicaragua Los Altiplanos Pacamara Washed', temperature:'Hot', price:800},
    {id:'nicaragua-iced', name:'Nicaragua Los Altiplanos Pacamara Washed', temperature:'Iced', price:900},
    {id:'peru-hot', name:'Peru Classic Puno Washed', temperature:'Hot', price:800},
    {id:'peru-iced', name:'Peru Classic Puno Washed', temperature:'Iced', price:900},
    {id:'fizz', name:'Bittersweet Fizz', temperature:'', price:700}
  ];
  var roles = {display:[],cashier:['createOrder','returnTickets','cancelOrder'], handover:['deliver','deliverBatch','collectTicket'], admin:['createOrder','returnTickets','cancelOrder','deliver','deliverBatch','collectTicket','addTickets','setTicketActive']};
  function fail(message) { var error=new Error(message);error.userSafe=true;throw error; }
  function cleanText(value, max, title) {
    if (typeof value !== 'string') fail(title+'を入力してください。');
    var text=value.normalize('NFKC').trim();
    if (!text || text.length>max || /[\u0000-\u001f\u007f<>]/.test(text)) fail(title+'は1〜'+max+'文字で入力してください。');
    return text;
  }
  function label(value) {
    var text=cleanText(value,12,'番号札').toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(text)) fail('番号札は英字・数字・ハイフンで指定してください。');
    return text;
  }
  function empty() { return {tickets:[],orders:[],requestIds:[],version:0}; }
  function ticket(state, value) {
    var result=state.tickets.find(function(t){return t.label===value;});
    if (!result) fail('番号札が見つかりません。');
    return result;
  }
  function order(state, id) {
    var result=state.orders.find(function(o){return o.id===id;});
    if (!result) fail('注文が見つかりません。最新の一覧を確認してください。');
    return result;
  }
  function requireRevision(o, revision) {
    if (o.revision!==revision) fail('他の端末でこの注文が更新されました。最新の状態を確認して、もう一度操作してください。');
  }
  function finished(o) { return o.cancelled || o.items.every(function(i){return !!i.deliveredAt;}); }
  function authorize(role, action) {
    if (!roles[role] || roles[role].indexOf(action)<0) fail('この担当では操作できません。');
  }
  function prepare(state, role, action, p, meta) {
    authorize(role,action); p=p||{};
    var data, t, o;
    if (action==='addTickets') {
      if (!Array.isArray(p.labels) || !p.labels.length || p.labels.length>100) fail('番号札は1〜100枚ずつ追加してください。');
      var labels=p.labels.map(label);
      if (new Set(labels).size!==labels.length) fail('追加する番号札が重複しています。');
      labels.forEach(function(l){if(state.tickets.some(function(x){return x.label===l;})) fail(l+'は登録済みです。');});
      if (state.tickets.length+labels.length>500) fail('番号札は最大500枚です。');
      data={labels:labels};
    } else if(action==='setTicketActive') {
      t=ticket(state,label(p.label));
      if (typeof p.active!=='boolean') fail('有効・無効を選択してください。');
      if (t.location!=='cashier' || t.orderId) fail('会計にある未使用の札だけ変更できます。紛失時は札が戻るまで再利用しないでください。');
      data={label:t.label,active:p.active};
    } else if(action==='createOrder') {
      t=ticket(state,label(p.ticket));
      if (!t.active || t.location!=='cashier' || t.orderId) fail('この札は会計に戻っていません。使用可能な札を選んでください。');
      if (!Array.isArray(p.items) || !p.items.length || p.items.length>menu.length) fail('ドリンクを選んでください。');
      var cups=[],seen={};
      p.items.forEach(function(line){
        var item=menu.find(function(m){return m.id===line.menuId;});
        if (!item || seen[line.menuId]) fail('商品を正しく選択してください。');
        if (!Number.isInteger(line.quantity) || line.quantity<1 || line.quantity>20) fail('各商品の数量は1〜20杯です。');
        seen[line.menuId]=true;
        for(var j=0;j<line.quantity;j++) cups.push({menuId:item.id,name:item.name,temperature:item.temperature});
      });
      if (cups.length>30) fail('1注文は最大30杯です。');
      if (state.orders.length>=3000) fail('この記録の注文上限に達しました。管理者へ連絡してください。');
      data={id:meta.id,ticket:t.label,items:cups};
    } else if(action==='deliver') {
      o=order(state,p.orderId); requireRevision(o,p.revision);
      if (o.cancelled || o.returnedAt) fail('この注文の提供状況は変更できません。');
      if (!Array.isArray(p.itemNumbers) || !p.itemNumbers.length) fail('実際に渡したカップを選んでください。');
      var nums=p.itemNumbers;
      if (new Set(nums).size!==nums.length) fail('同じカップを二重に選択できません。');
      nums.forEach(function(n){
        if (!Number.isInteger(n) || n<1 || n>o.items.length || o.items[n-1].deliveredAt) fail('選択したカップは提供済み、または存在しません。');
      });
      if (p.collectTicket===true && o.items.some(function(i){return !i.deliveredAt && nums.indexOf(i.number)<0;})) fail('全てのドリンクを提供してから札を回収してください。');
      data={orderId:o.id,itemNumbers:nums,collectTicket:p.collectTicket===true};
    } else if(action==='deliverBatch') {
      if(!Array.isArray(p.orders)||p.orders.length<2||p.orders.length>10) fail('まとめて提供する番号札は2〜10枚で選択してください。');
      if(new Set(p.orders.map(function(entry){return entry&&entry.orderId;})).size!==p.orders.length) fail('同じ注文を二重に選択できません。');
      // Validate every order against the same locked state before applying anything.
      data={orders:p.orders.map(function(entry){return prepare(state,role,'deliver',entry,meta).data;})};
    } else if(action==='collectTicket') {
      o=order(state,p.orderId); requireRevision(o,p.revision);
      if(o.cancelled)fail('取消した注文の札は会計担当が受領確認してください。');
      if (!finished(o)) fail('未提供のドリンクがあります。全て渡してから札を回収してください。');
      if (o.collectedAt || o.returnedAt) fail('この札は既に回収されています。');
      data={orderId:o.id};
    } else if(action==='returnTickets') {
      if (!Array.isArray(p.labels) || !p.labels.length || p.labels.length>100) fail('実際に受け取った札を選んでください。');
      var returns=p.labels.map(label);
      if (new Set(returns).size!==returns.length) fail('番号札が重複しています。');
      data={returns:returns.map(function(l){
        t=ticket(state,l);
        if(!t.orderId) fail(l+'は回収済みではありません。');
        o=order(state,t.orderId);
        if(!o.cancelled&&t.location!=='collected')fail(l+'は回収済みではありません。');
        if(!finished(o) || (!o.cancelled&&!o.collectedAt) || o.returnedAt) fail(l+'の状態を確認してください。');
        // Expected order IDs prevent a delayed retry from returning a later use of the same ticket.
        if(!p.orderIds || p.orderIds[l]!==o.id) fail(l+'の注文が更新されました。最新の一覧で確認してください。');
        return {label:l,orderId:o.id};
      })};
    } else if(action==='cancelOrder') {
      o=order(state,p.orderId); requireRevision(o,p.revision);
      if(o.cancelled || o.collectedAt || o.returnedAt || o.items.some(function(i){return !!i.deliveredAt;})) fail('提供・回収済みの注文は取消できません。管理者へ確認してください。');
      if(p.ticketAtCashier!==undefined && typeof p.ticketAtCashier!=='boolean') fail('番号札が会計の手元にあるか選んでください。');
      t=ticket(state,o.ticket);if(t.orderId!==o.id || t.location!=='customer') fail('番号札の状態が更新されました。最新の一覧で確認してください。');
      data={orderId:o.id};
      if(p.ticketAtCashier===true)data.ticketAtCashier=true;
    } else fail('操作が見つかりません。');
    return {id:meta.id,requestId:meta.requestId,at:meta.at,actor:meta.actor,type:action,data:data};
  }
  function apply(state,event) {
    var d=event.data, t, o;
    function deliver(entry){
      var target=order(state,entry.orderId);
      entry.itemNumbers.forEach(function(n){target.items[n-1].deliveredAt=event.at;target.items[n-1].deliveredBy=event.actor;});
      if(entry.collectTicket){target.collectedAt=event.at;target.collectedBy=event.actor;ticket(state,target.ticket).location='collected';}
      target.revision++;
    }
    if(event.type==='addTickets') d.labels.forEach(function(l){state.tickets.push({label:l,active:true,location:'cashier',orderId:''});});
    else if(event.type==='setTicketActive') ticket(state,d.label).active=d.active;
    else if(event.type==='createOrder') {
      t=ticket(state,d.ticket);t.location='customer';t.orderId=d.id;
      state.orders.push({id:d.id,ticket:d.ticket,createdAt:event.at,cashier:event.actor,revision:1,cancelled:false,collectedAt:'',collectedBy:'',returnedAt:'',returnedBy:'',items:d.items.map(function(i,n){return {number:n+1,menuId:i.menuId,name:i.name,temperature:i.temperature,deliveredAt:'',deliveredBy:''};})});
    } else if(event.type==='deliver') {
      deliver(d);
    } else if(event.type==='deliverBatch') {
      d.orders.forEach(deliver);
    } else if(event.type==='collectTicket') {
      o=order(state,d.orderId);o.collectedAt=event.at;o.collectedBy=event.actor;o.revision++;ticket(state,o.ticket).location='collected';
    } else if(event.type==='returnTickets') d.returns.forEach(function(r){
      o=order(state,r.orderId);if(o.cancelled&&!o.collectedAt){o.collectedAt=event.at;o.collectedBy=event.actor;}o.returnedAt=event.at;o.returnedBy=event.actor;o.revision++;
      t=ticket(state,r.label);t.location='cashier';t.orderId='';
    });
    else if(event.type==='cancelOrder') {o=order(state,d.orderId);o.cancelled=true;o.revision++;if(d.ticketAtCashier===true){o.collectedAt=event.at;o.collectedBy=event.actor;o.returnedAt=event.at;o.returnedBy=event.actor;t=ticket(state,o.ticket);t.location='cashier';t.orderId='';}}
    state.requestIds.push(event.requestId);state.version++;
    return state;
  }
  function replay(events) {var s=empty();events.forEach(function(e){apply(s,e);});return s;}
  function view(state,role) {
    var result=JSON.parse(JSON.stringify(state));delete result.requestIds;
    // Ordinary staff only receive orders still in circulation. Historical names stay admin-only.
    if(role!=='admin') result.orders=result.orders.filter(function(o){return !o.returnedAt;});
    if(role==='display'){result.tickets=[];result.orders=result.orders.filter(function(o){return !o.cancelled&&o.items.some(function(i){return !i.deliveredAt;});}).map(function(o){return {id:o.id,ticket:o.ticket,createdAt:o.createdAt,items:o.items.map(function(i){return {number:i.number,menuId:i.menuId,name:i.name,temperature:i.temperature,deliveredAt:i.deliveredAt};})};});}
    return result;
  }
  function displayName(item) {
    var id=item.menuId||item.id||'';
    var entry=menu.find(function(m){return m.id===id||m.name===item.name;});
    if(!entry)return item.name||'';
    return entry.id.indexOf('blend')===0?'ブレンド':entry.id.indexOf('nicaragua')===0?'ニカラグア':entry.id.indexOf('peru')===0?'ペルー':'フィズ';
  }
  menu.forEach(function(m){m.displayName=displayName(m);});
  return {menu:menu,displayName:displayName,empty:empty,label:label,cleanText:cleanText,prepare:prepare,apply:apply,replay:replay,view:view,finished:finished};
}());
