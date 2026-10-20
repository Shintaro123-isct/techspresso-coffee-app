(function () {
  'use strict';
  var demo=typeof google==='undefined' || !google.script || !google.script.run;
  var app=document.getElementById('app'), identity=document.getElementById('identity');
  var person=null, snapshot=null, tab='cashier', draft={},chosenTicket='',cupSelections={},returnSelections={},busy=false,pending=null,loading=false,lastSynced=0,noticeTimer,lastRegistered=null;
  var roleNames={cashier:'会計担当',handover:'受け渡し担当',admin:'管理者',display:'表示専用'};
  var demoEvents=[],demoTokens={},formInputs={};
  var snapshotGeneration=0,refreshQueued=false;
  if(demo){
    document.getElementById('demo-banner').hidden=false;
    try{demoEvents=JSON.parse(localStorage.getItem('techspresso-demo-events')||'[]');}catch(ignore){}
    if(!demoEvents.length) demoEvents=[{id:'initial',requestId:'initial',at:new Date().toISOString(),actor:'初期設定',type:'addTickets',data:{labels:'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')}}];
  }
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function uid(){return crypto.randomUUID?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(24)),function(n){return n.toString(16).padStart(2,'0');}).join('');}
  function clock(s){return s?new Date(s).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'}):'';}
  function toast(text,error){var n=document.getElementById('notice');n.textContent=text;n.className=error?'error':'';n.hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(function(){n.hidden=true;},error?9000:4500);}
  function confirmAction(text){return new Promise(function(resolve){
    var dialog=document.createElement('dialog');dialog.className='confirm-dialog';
    dialog.innerHTML='<h2>操作の確認</h2><p></p><div class="dialog-actions"><button data-no>戻る</button><button data-yes class="primary">確認して実行する</button></div>';
    dialog.querySelector('p').textContent=text;dialog.querySelector('p').style.whiteSpace='pre-line';document.body.appendChild(dialog);
    function done(value){dialog.close();dialog.remove();resolve(value);}
    dialog.querySelector('[data-no]').onclick=function(){done(false);};dialog.querySelector('[data-yes]').onclick=function(){done(true);};dialog.oncancel=function(e){e.preventDefault();done(false);};dialog.showModal();
  });}
  function sessionStore(value){try{if(value)localStorage.setItem('techspresso-session',JSON.stringify(value));else localStorage.removeItem('techspresso-session');}catch(ignore){}}
  function confirmCancellation(ticket){return new Promise(function(resolve){
    var dialog=document.createElement('dialog');dialog.className='confirm-dialog';
    dialog.innerHTML='<h2>注文の取消</h2><p></p><label class="field">番号札は手元にありますか？<select data-ticket-held><option value="">選んでください</option><option value="yes">ある</option><option value="no">ない</option></select></label><p class="help">「ある」：会計で再使用できます。「ない」：会計で実物を受け取った後に受領確認してください。受け渡し担当の操作は不要です。Airレジ側の取消・返金は別途行ってください。</p><div class="dialog-actions"><button data-no>戻る</button><button data-yes class="danger" disabled>注文を取り消す</button></div>';
    dialog.querySelector('p').textContent='番号札 '+ticket+' の注文を取り消します。';document.body.appendChild(dialog);
    var choice=dialog.querySelector('[data-ticket-held]'),submit=dialog.querySelector('[data-yes]');
    choice.onchange=function(){submit.disabled=choice.value!=='yes'&&choice.value!=='no';};
    function done(value){dialog.close();dialog.remove();resolve(value);}
    dialog.querySelector('[data-no]').onclick=function(){done(null);};submit.onclick=function(){if(choice.value==='yes'||choice.value==='no')done(choice.value==='yes');};dialog.oncancel=function(e){e.preventDefault();done(null);};dialog.showModal();
  });}
  function sessionUpdate(value,previous){try{var expected=previous||value,saved=JSON.parse(localStorage.getItem('techspresso-session')||'null');if(saved&&expected&&saved.token===expected.token&&saved.role===expected.role&&saved.baseRole===expected.baseRole)sessionStore(value);}catch(ignore){}}
  function pendingStore(){try{if(pending)localStorage.setItem('techspresso-pending',JSON.stringify({action:pending.action,payload:pending.payload,requestId:pending.requestId,message:pending.message}));else localStorage.removeItem('techspresso-pending');}catch(ignore){}}
  function rememberInputs(){try{app.querySelectorAll('form input[name]:not([type="password"])').forEach(function(f){if(f.name==='code')return;var key=f.form.id+':'+f.name;formInputs[key]=f.type==='checkbox'?f.checked:f.value;});localStorage.setItem('techspresso-inputs',JSON.stringify({draft:draft,chosenTicket:chosenTicket,cupSelections:cupSelections,returnSelections:returnSelections,tab:tab,formInputs:formInputs}));}catch(ignore){}}
  function restoreForms(){app.querySelectorAll('form input[name]:not([type="password"])').forEach(function(f){var key=f.form.id+':'+f.name;if(!(key in formInputs))return;if(f.type==='checkbox')f.checked=formInputs[key];else f.value=formInputs[key];});}
  function call(method,args){
    if(demo)return new Promise(function(resolve,reject){setTimeout(function(){try{resolve(demoCall(method,args));}catch(e){reject(e);}},120);});
    return new Promise(function(resolve,reject){google.script.run.withSuccessHandler(resolve).withFailureHandler(function(e){reject(new Error(e.message||'通信できませんでした。'));})[method].apply(google.script.run,args);});
  }
  function demoCall(method,args){
    if(method==='staffOptions')return ['会計担当','受け渡し担当','管理者'];
    if(method==='login'){
      var input=args[0],session={token:uid(),name:roleNames[input.role],role:input.role,baseRole:input.role==='admin'?'admin':'general',expiresAt:Date.now()+7200000};
      if(!roleNames[input.role])throw new Error('担当を選択してください。');
      demoTokens[session.token]=session;return session;
    }
    if(method==='logout'){delete demoTokens[args[0]];return true;}
    var staff=demoTokens[args[0]]||person;
    if(!staff || staff.token!==args[0])throw new Error('ログインし直してください。');
    var action=args[1],payload=args[2],state=CoffeeCore_.replay(demoEvents);
    if(staff.role==='display'&&action!=='snapshot'&&action!=='switchRole')return {ok:false,message:'表示専用では記録や設定を変更できません。'};
    function snap(){return {state:CoffeeCore_.view(state,staff.role),menu:CoffeeCore_.menu,serverTime:new Date().toISOString(),retentionDays:30,waitThresholdMinutes:Number(localStorage.getItem('techspresso-demo-threshold')||15),expiresAt:staff.expiresAt};}
    if(action==='switchRole'){if(payload.role==='admin'&&staff.baseRole!=='admin')return {ok:false,message:'管理者用コードが必要です。'};staff.role=payload.role;staff.name=roleNames[staff.role];return {ok:true,person:staff};}
    if(action==='setWaitThreshold'){if(staff.role!=='admin')return {ok:false,message:'管理者だけが操作できます。'};var minutes=Number(payload.minutes);if(!Number.isInteger(minutes)||minutes<1||minutes>180)return {ok:false,message:'基準は1〜180分の整数で入力してください。'};localStorage.setItem('techspresso-demo-threshold',String(minutes));return {ok:true};}
    if(action==='setDiscordAlerts'||action==='testDiscordAlerts')return {ok:false,message:'Discord通知は本番アプリで設定してください。体験版からは送信しません。'};
    if(action==='snapshot')return snap();
    if(action==='syncSheets')return {ok:true};
    if(action==='removeNames'){
      if(staff.role!=='admin' || payload.confirm!=='表示名を除去')return {ok:false,message:'管理者として確認してください。'};
      demoEvents.forEach(function(e){e.actor='表示名除去済';});demoTokens={};localStorage.setItem('techspresso-demo-events',JSON.stringify(demoEvents));return {ok:true,signedOut:true};
    }
    if(state.requestIds.indexOf(args[3])>=0)return {ok:true,repeated:true,snapshot:snap()};
    try{
      var event=CoffeeCore_.prepare(state,staff.role,action,payload,{id:uid(),requestId:args[3],at:new Date().toISOString(),actor:staff.name});
      demoEvents.push(event);CoffeeCore_.apply(state,event);localStorage.setItem('techspresso-demo-events',JSON.stringify(demoEvents));return {ok:true,snapshot:snap()};
    }catch(e){return {ok:false,message:e.message};}
  }
  function loginScreen(){
    var warning=document.getElementById('late-warning');if(warning)warning.hidden=true;
    identity.innerHTML='';document.body.classList.remove('display-mode');
    app.innerHTML='<section class="login"><p class="eyebrow">STAFF ACCESS</p><p class="intro">注文の確認、提供の記録、番号札の返却。<br>担当を選択して利用を開始してください。</p><form id="login-form" class="panel"><label class="field">担当<select name="role"><option value="cashier">会計担当</option><option value="handover">受け渡し担当</option><option value="display">表示専用（タブレット表示）</option><option value="admin">管理者</option></select></label>'+(demo?'':'<label class="field" data-admin-code hidden>管理者の利用コード<input name="code" type="password" autocomplete="off" disabled placeholder="管理者用コード"></label>')+'<p class="help">操作記録には選択した担当名が残ります。</p><button class="primary full" style="margin-top:20px" type="submit">利用を開始する</button><p class="help">担当を交代するときは「担当を変更」を押してください。'+(demo?'体験版には実名や実際の利用コードを入力しないでください。':'会計担当・受け渡し担当・表示専用はコード不要です。管理者の利用コードは保存しません。操作から2時間以内は、この端末で再開できます。')+'</p></form></section>';
    var loginForm=app.querySelector('#login-form'),startButton=loginForm.querySelector('button');
    loginForm.querySelector('[name="role"]').addEventListener('change',function(){var label=loginForm.querySelector('[data-admin-code]');if(!label)return;var isAdmin=this.value==='admin',code=label.querySelector('input');label.hidden=!isAdmin;code.disabled=!isAdmin;code.required=isAdmin;if(!isAdmin)code.value='';});
    loginForm.addEventListener('submit',async function(e){
      e.preventDefault();var form=e.currentTarget,button=form.querySelector('button');button.disabled=true;
      try{var fields=new FormData(form);person=await call('login',[{role:fields.get('role'),code:fields.get('code')||'',roleOnly:true}]);sessionStore(person);tab=person.role==='display'?'display':person.role==='handover'?'handover':'cashier';snapshot=null;if(pending&&person.role!=='display')await sendPending();else await refresh(true);}
      catch(error){toast(error.message,true);button.disabled=false;}
    });
  }
  function titleFor(m){var id=m.menuId||m.id||'',entry=(snapshot&&snapshot.menu||[]).find(function(x){return x.id===id||x.name===m.name;}),labels={'Dark Roast Blend':'ブレンド','Nicaragua Los Altiplanos Pacamara Washed':'ニカラグア','Peru Classic Puno Washed':'ペルー','Bittersweet Fizz':'フィズ'};return labels[m.name]||(entry&&labels[entry.name])||m.displayName||(entry&&entry.displayName)||m.name||'';}
  function tempTag(m){return m.temperature?'<span class="tag '+m.temperature.toLowerCase()+'">'+esc(m.temperature)+'</span>':'<span class="tag">Fizz</span>';}
  function available(){return snapshot.state.tickets.filter(function(t){return t.active&&t.location==='cashier'&&!t.orderId;});}
  function circulating(){return snapshot.state.orders.filter(function(o){return !o.returnedAt;});}
  function orderAge(o){return Math.max(0,(Date.parse(snapshot.serverTime)+(Date.now()-lastSynced)-Date.parse(o.createdAt))/60000);}
  function lateOrders(){return circulating().filter(function(o){return !o.cancelled&&o.items.some(function(i){return !i.deliveredAt;})&&orderAge(o)>(snapshot.waitThresholdMinutes||15);});}
  function lateText(o){return '札 '+o.ticket+'：受付から'+Math.floor(orderAge(o))+'分・未提供'+o.items.filter(function(i){return !i.deliveredAt;}).length+'杯';}
  // Update warning text/styles only; never replace inputs or selected cups on this timer.
  function updateWarnings(){
    if(!person||!snapshot)return;
    if(person.role==='display'){var displayWarning=document.getElementById('late-warning');if(displayWarning)displayWarning.hidden=true;renderDisplay();return;}
    var late=lateOrders(),banner=document.getElementById('late-warning');
    if(banner){banner.hidden=!late.length;var text=late.length?'<strong>提供の確認が必要な注文：'+late.length+'件</strong><div>'+late.map(function(o){return esc(lateText(o));}).join('<br>')+'</div><small>最後の取得 '+clock(lastSynced)+'。提供済みかどうかは最新一覧と実物を確認してください。</small>':'';if(banner.innerHTML!==text)banner.innerHTML=text;}
    app.querySelectorAll('[data-order]').forEach(function(card){var o=snapshot.state.orders.find(function(x){return x.id===card.dataset.order;});if(!o)return;var overdue=late.some(function(x){return x.id===o.id;});card.classList.toggle('old',overdue);var badge=card.querySelector('[data-late-badge]');if(badge){badge.hidden=!overdue;badge.textContent=lateText(o);}var age=card.querySelector('[data-order-age]');if(age)age.textContent=Math.floor(orderAge(o))+'分前';});
  }
  function render(){
    if(!person || !snapshot)return;
    identity.innerHTML='<div class="person"><div><strong>'+roleNames[person.role]+'</strong></div><button id="change-user">担当を変更</button></div>';
    document.getElementById('change-user').onclick=signOut;
    document.body.classList.toggle('display-mode',person.role==='display');
    if(person.role==='display'){app.innerHTML='<section id="display-board" aria-label="注文の表示専用画面"></section>';var displayWarning=document.getElementById('late-warning');if(displayWarning)displayWarning.hidden=true;renderDisplay();return;}
    var waiting=circulating().filter(function(o){return !o.cancelled&&o.items.some(function(i){return !i.deliveredAt;});}).length;
    var returned=ticketsAwaitingReceipt().length;
    var tabs=person.role==='admin'?['cashier','handover','returns','admin']:person.role==='cashier'?['cashier','orders','returns']:['handover','orders'];
    var labels={cashier:'注文登録',handover:'受け渡し',orders:'注文の確認',returns:'札の返却確認',admin:'管理',privacy:'表示名の扱い'};
    var headline=tab==='cashier'?'ドリンクの注文登録':tab==='handover'?'受け渡しを記録する':tab==='orders'?'注文の確認':tab==='returns'?'会計に戻った札を確認':tab==='admin'?'番号札と記録の管理':'表示名の扱い';
    app.innerHTML='<div class="topline"><div><p class="eyebrow">FESTIVAL OPERATIONS</p><h1>'+headline+'</h1></div><div class="sync">'+(lastSynced?'更新 '+clock(lastSynced):'読込中')+'<br><button id="refresh">一覧を更新</button></div></div><div class="stats"><div class="stat"><span>未提供の注文</span><strong>'+waiting+'</strong></div><div class="stat"><span>会計への返却待ち</span><strong>'+returned+'</strong></div><div class="stat"><span>使用可能な札</span><strong>'+available().length+'</strong></div></div><nav class="tabs" aria-label="担当の操作">'+tabs.map(function(t){return '<button data-tab="'+t+'" class="'+(t===tab?'selected':'')+'" aria-current="'+(t===tab?'page':'false')+'">'+labels[t]+'</button>';}).join('')+'</nav><section id="workspace"></section>';
    document.getElementById('refresh').onclick=function(){refresh(true);};
    app.querySelectorAll('[data-tab]').forEach(function(b){b.onclick=function(){tab=b.dataset.tab;render();if(tab==='cashier')scrollToFirstQuantity();};});
    if(tab==='cashier')renderCashier();else if(tab==='handover'||tab==='orders')renderOrders();else if(tab==='returns')renderReturns();else if(tab==='admin')renderAdmin();else renderPrivacy();
    if(busy && (!pending || pending.action!=='returnTickets'))app.querySelectorAll('button').forEach(function(b){b.disabled=true;});
    restoreForms();rememberInputs();updateWarnings();
  }
  function scrollToFirstQuantity(){
    var first=app.querySelector('.menu-item .quantity');
    if(first)first.scrollIntoView({behavior:'smooth',block:'center'});
  }
  function renderCashier(){
    var menu=snapshot.menu,availableTickets=available(),lines=menu.filter(function(m){return draft[m.id]>0;}),total=lines.reduce(function(n,m){return n+draft[m.id];},0);
    if(!availableTickets.some(function(t){return t.label===chosenTicket;}))chosenTicket='';
    var cupPlan=lastRegistered?'<section class="registration-note"><strong>登録完了 · 札 '+esc(lastRegistered.ticket)+' · 受付 '+clock(lastRegistered.createdAt)+'</strong><p class="help">カップの商品・Hot/Iced・札・注文時刻・杯数番号を確認し、抽出担当へ渡してください。</p>'+lastRegistered.items.map(function(i){return '<div class="help">'+i.number+'/'+lastRegistered.items.length+' · '+esc(i.name)+' · '+esc(i.temperature||'Fizz')+'</div>';}).join('')+'</section>':'';
    document.getElementById('workspace').innerHTML='<p class="help">Airレジで会計を済ませてから、ドリンクだけを登録してください。物販は登録不要です。</p>'+cupPlan+'<div class="cashier-grid"><div class="menu-grid">'+menu.map(function(m){var n=draft[m.id]||0;return '<article class="menu-item '+(n?'has-quantity':'')+'">'+tempTag(m)+'<h3>'+esc(titleFor(m))+'</h3><div class="detail">'+esc(m.name)+'</div><div class="quantity"><button data-minus="'+m.id+'" aria-label="'+esc(m.name+' '+m.temperature)+'を1杯減らす" '+(!n?'disabled':'')+'>−</button><output>'+n+'</output><button data-plus="'+m.id+'" aria-label="'+esc(m.name+' '+m.temperature)+'を1杯追加する" '+(n>=20||total>=30?'disabled':'')+'>＋</button></div></article>';}).join('')+'</div><section class="panel sticky" style="margin-top:0"><h2>番号札を選ぶ</h2><div class="ticket-picker">'+availableTickets.map(function(t){return '<button data-ticket="'+esc(t.label)+'" class="'+(chosenTicket===t.label?'selected':'')+'" aria-pressed="'+(chosenTicket===t.label)+'">'+esc(t.label)+'</button>';}).join('')+'</div>'+(!availableTickets.length?'<p class="help">使用可能な札がありません。会計に戻った札を確認してください。</p>':'')+'<ul class="summary">'+lines.map(function(m){return '<li><span>'+esc(titleFor(m)+' '+m.temperature)+'</span><strong>×'+draft[m.id]+'</strong></li>';}).join('')+'</ul><div class="receipt-total"><span>札 '+esc(chosenTicket||'未選択')+'</span><span>'+total+'杯</span></div><button id="create-order" class="primary full" '+(!total||!chosenTicket?'disabled':'')+'>注文を登録する</button><p class="help">カップに商品・Hot/Iced・札・注文時刻・1/2などの杯数番号を記入し、登録完了を確認してから抽出担当へ渡してください。番号札は会計時にお客様へ渡します。</p></section></div>';
    app.querySelectorAll('[data-plus]').forEach(function(b){b.onclick=function(){draft[b.dataset.plus]=(draft[b.dataset.plus]||0)+1;renderCashier();};});
    app.querySelectorAll('[data-minus]').forEach(function(b){b.onclick=function(){draft[b.dataset.minus]--;renderCashier();};});
    app.querySelectorAll('[data-ticket]').forEach(function(b){b.onclick=function(){chosenTicket=b.dataset.ticket;renderCashier();};});
    document.getElementById('create-order').onclick=function(){mutate('createOrder',{ticket:chosenTicket,items:lines.map(function(m){return {menuId:m.id,quantity:draft[m.id]};})},function(){draft={};chosenTicket='';},'注文を登録しました。札とカップの記載を確認してください。');};
  }
  function renderDisplay(){
    var board=document.getElementById('display-board');if(!board||!snapshot)return;
    var threshold=snapshot.waitThresholdMinutes||15,normal=[],overdue=[];
    circulating().filter(function(o){return !o.cancelled&&o.items.some(function(i){return !i.deliveredAt;});}).sort(function(a,b){return Date.parse(a.createdAt)-Date.parse(b.createdAt);}).forEach(function(o){(orderAge(o)>threshold?overdue:normal).push(o);});
    function card(o,late){
      var age=Math.floor(orderAge(o)),over=Math.max(0,age-threshold),remaining=o.items.filter(function(i){return !i.deliveredAt;}),counts={};
      remaining.forEach(function(i){var key=titleFor(i)+' '+(i.temperature==='Hot'?'HOT':i.temperature==='Iced'?'ICE':'');counts[key]=(counts[key]||0)+1;});
      return '<article class="call-card '+(late?'call-late ':'')+(age>=35?'call-urgent':'')+'"><div class="call-ticket">'+esc(o.ticket)+'</div><div class="call-time">受付 '+clock(o.createdAt)+' · '+age+'分経過</div>'+(late?'<div class="call-excess">'+(age>=35?'🚨 至急確認 · ':age>=25?'🔴 大幅遅延 · ':'')+(over?over+'分超過':'超過1分未満')+'</div>':'')+'<div class="call-products">'+Object.keys(counts).map(function(k){return esc(k)+' ×'+counts[k];}).join('<br>')+'</div><div class="call-remaining">未提供 '+remaining.length+'杯</div></article>';
    }
    var stale=Date.now()-lastSynced>45000;
    var html='<div class="call-status '+(stale?'call-stale':'')+'">'+(stale?'⚠ 更新が止まっています。表示は最新とは限りません。':'表示専用 · 約15秒ごとに自動更新')+'<span>最終更新 '+clock(lastSynced)+'</span></div><div class="call-board"><section class="call-column"><h1>受付済み <span>'+normal.length+'件</span></h1><p class="help">未提供の注文 · 基準 '+threshold+'分以内</p><div class="call-cards">'+(normal.length?normal.map(function(o){return card(o,false);}).join(''):'<p class="call-empty">該当する注文はありません</p>')+'</div></section><section class="call-column call-overdue"><h1>時間超過 <span>'+overdue.length+'件</span></h1><p class="help">受付から'+threshold+'分を超えた未提供の注文</p><div class="call-cards">'+(overdue.length?overdue.map(function(o){return card(o,true);}).join(''):'<p class="call-empty">時間超過の注文はありません</p>')+'</div></section></div>';
    if(board.innerHTML!==html)board.innerHTML=html;
  }
  function selectedDeliveries(){
    return circulating().filter(function(o){var selected=cupSelections[o.id];return !o.cancelled&&!o.collectedAt&&selected&&selected.revision===o.revision&&selected.numbers.length;}).map(function(o){var selected=cupSelections[o.id];return {orderId:o.id,revision:selected.revision,itemNumbers:selected.numbers.slice(),collectTicket:selected.collect};});
  }
  function updateBatchDelivery(){
    var box=document.getElementById('batch-delivery'),button=document.getElementById('batch-deliver'),summary=document.getElementById('batch-summary');
    if(!box||!button||!summary)return;
    var entries=selectedDeliveries(),cups=entries.reduce(function(n,e){return n+e.itemNumbers.length;},0);
    box.hidden=entries.length<2;button.disabled=busy||entries.length>10;button.textContent='選択した'+entries.length+'札・計'+cups+'杯を提供完了';
    summary.textContent=entries.length+'枚の番号札・計'+cups+'杯を選択中'+(entries.length>10?'（一度に10枚まで）':'');
  }
  function renderOrders(){
    var orders=circulating().filter(function(o){return tab!=='handover'||!o.cancelled;}).slice().sort(function(a,b){var aWaiting=!a.cancelled&&a.items.some(function(i){return !i.deliveredAt;}),bWaiting=!b.cancelled&&b.items.some(function(i){return !i.deliveredAt;});if(tab==='handover'&&aWaiting!==bWaiting)return aWaiting?-1:1;return Date.parse(a.createdAt)-Date.parse(b.createdAt);});
    var readonly=tab==='orders';
    document.getElementById('workspace').innerHTML='<p class="help">'+(readonly?'受付した注文を確認できます。':'原則すべて揃えて提供し、完成時間に大きな差がある場合は部分提供します。お客様へ実際に渡した杯だけ選んで記録してください。')+'<br>受付から'+(snapshot.waitThresholdMinutes||15)+'分を超えた未提供注文は、赤い枠と警告で目立たせます。音は鳴りません。カップが見つからなければ全体指揮へ報告してください。</p>'+(!readonly?'<div id="batch-delivery" class="panel batch-delivery-bar" hidden><p id="batch-summary"></p><button id="batch-deliver" class="primary full">選択した複数の札のカップをまとめて提供済みにする</button><p class="help">複数札をまとめて記録します。実際に渡した杯だけ選択してください。次の画面で札と杯数を確認します。</p></div>':'')+'<div class="order-grid">'+orders.map(function(o){
      var remaining=o.items.filter(function(i){return !i.deliveredAt;}).length, age=Math.max(0,(Date.parse(snapshot.serverTime)+(Date.now()-lastSynced)-Date.parse(o.createdAt))/60000),selected=cupSelections[o.id];
      if(selected&&selected.revision!==o.revision){delete cupSelections[o.id];selected=null;}
      return '<article class="order-card '+(remaining&&age>(snapshot.waitThresholdMinutes||15)&&!o.cancelled?'old':'')+'" data-order="'+esc(o.id)+'"><div class="late-badge" data-late-badge '+(remaining&&age>(snapshot.waitThresholdMinutes||15)&&!o.cancelled?'':'hidden')+'>'+esc(lateText(o))+'</div><div class="order-head"><div class="ticket-big longlabel"><small>番号札</small>'+esc(o.ticket)+'</div><div class="order-meta">受付 '+clock(o.createdAt)+' · <span data-order-age>'+Math.floor(age)+'分前</span><br>会計 '+esc(o.cashier)+'<br>注文 '+esc(o.id.slice(0,8))+'</div></div><div class="progress"><span>'+ (o.cancelled?'取消済み':remaining?'残り '+remaining+'杯':'全て提供済み')+'</span><span>'+(o.items.length-remaining)+' / '+o.items.length+'杯</span></div>'+(!readonly&&remaining&&!o.cancelled?'<label class="checkline"><input type="checkbox" data-select-all '+(selected&&selected.numbers.length===remaining?'checked':'')+'>残りの杯をすべて選択</label>':'')+o.items.map(function(i){return '<label class="cup '+(i.deliveredAt?'done':'')+'">'+(!readonly&&!i.deliveredAt&&!o.cancelled?'<input type="checkbox" data-cup="'+i.number+'" '+(selected&&selected.numbers.indexOf(i.number)>=0?'checked':'')+'>':'<span aria-hidden="true">'+(i.deliveredAt?'✓':'・')+'</span>')+'<span><span class="cupnumber">'+i.number+'/'+o.items.length+' '+tempTag(i)+'</span><span class="cuptitle">'+esc(titleFor(i))+'</span><span class="cupformal">'+esc(i.name)+'</span>'+(i.deliveredAt?'<small>'+clock(i.deliveredAt)+' · '+esc(i.deliveredBy)+'が提供</small>':'')+'</span></label>';}).join('')+(!readonly&&!o.collectedAt&&!o.cancelled&&remaining?'<div class="cup-actions"><label class="checkline"><input type="checkbox" data-collect-with '+(selected&&selected.collect?'checked':'')+'>全て渡し、番号札も回収した</label><button data-deliver class="primary" '+(!selected||!selected.numbers.length?'disabled':'')+'>選んだカップを提供済みにする</button></div>':'')+(!readonly&&!o.collectedAt&&!o.cancelled&&!remaining?'<button data-collect class="primary full" style="margin-top:14px">番号札を回収した</button>':'')+(o.collectedAt?'<p class="status-text">札回収済み · '+esc(o.collectedBy)+'<br>会計への返却を待っています。</p>':'')+((person.role==='cashier'||person.role==='admin')&&!o.cancelled&&!o.collectedAt&&remaining===o.items.length?'<button data-cancel class="danger full" style="margin-top:12px">この注文を取り消す</button>':'')+'</article>';
    }).join('')+'</div>'+(!orders.length?'<div class="empty">現在、未完了の注文はありません。</div>':'');
    app.querySelectorAll('[data-order]').forEach(function(card){
      var o=orders.find(function(x){return x.id===card.dataset.order;});
      card.querySelectorAll('[data-cup]').forEach(function(c){c.onchange=function(){var record=cupSelections[o.id]||{revision:o.revision,numbers:[],collect:false};var number=Number(c.dataset.cup);record.numbers=record.numbers.filter(function(n){return n!==number;});if(c.checked)record.numbers.push(number);record.collect=record.numbers.length===o.items.filter(function(i){return !i.deliveredAt;}).length;cupSelections[o.id]=record;var all=card.querySelector('[data-select-all]');if(all){all.checked=record.collect;all.indeterminate=record.numbers.length>0&&!record.collect;}var autoCollect=card.querySelector('[data-collect-with]');if(autoCollect)autoCollect.checked=record.collect;rememberInputs();var button=card.querySelector('[data-deliver]');if(button)button.disabled=!record.numbers.length;updateBatchDelivery();};});
      var selectAll=card.querySelector('[data-select-all]');if(selectAll){var current=cupSelections[o.id];selectAll.indeterminate=!!(current&&current.numbers.length&&!selectAll.checked);selectAll.onchange=function(){var checked=selectAll.checked;var record={revision:o.revision,numbers:checked?o.items.filter(function(i){return !i.deliveredAt;}).map(function(i){return i.number;}):[],collect:checked};cupSelections[o.id]=record;card.querySelectorAll('[data-cup]').forEach(function(c){c.checked=checked;});var collectBox=card.querySelector('[data-collect-with]');if(collectBox)collectBox.checked=checked;var saveButton=card.querySelector('[data-deliver]');if(saveButton)saveButton.disabled=!record.numbers.length;rememberInputs();updateBatchDelivery();};}
      var collectWith=card.querySelector('[data-collect-with]');if(collectWith)collectWith.onchange=function(){var record=cupSelections[o.id]||{revision:o.revision,numbers:[],collect:false};record.collect=collectWith.checked;cupSelections[o.id]=record;rememberInputs();updateBatchDelivery();};
      var deliver=card.querySelector('[data-deliver]');if(deliver)deliver.onclick=function(){var selected=cupSelections[o.id];if(!selected||!selected.numbers.length)return;mutate('deliver',{orderId:o.id,revision:selected.revision,itemNumbers:selected.numbers.slice(),collectTicket:selected.collect},function(){delete cupSelections[o.id];},'提供を記録しました。');};
      var collect=card.querySelector('[data-collect]');if(collect)collect.onclick=function(){mutate('collectTicket',{orderId:o.id,revision:o.revision},null,'番号札の回収を記録しました。会計に戻るまでは再利用できません。');};
      var cancel=card.querySelector('[data-cancel]');if(cancel)cancel.onclick=async function(){var held=await confirmCancellation(o.ticket);if(held!==null)mutate('cancelOrder',{orderId:o.id,revision:o.revision,ticketAtCashier:held},function(){delete cupSelections[o.id];},held?'注文を取り消しました。番号札を再使用できます。':'注文を取り消しました。番号札が会計に戻るまで再使用できません。');};
    });
    if(!readonly){
      var batchButton=document.getElementById('batch-deliver');
      if(batchButton)batchButton.onclick=async function(){
        if(busy||pending)return;
        var entries=selectedDeliveries();if(entries.length<2||entries.length>10)return;
        var details=entries.map(function(e){var o=orders.find(function(x){return x.id===e.orderId;});return '札 '+o.ticket+'：'+e.itemNumbers.length+'杯（カップ '+e.itemNumbers.join('・')+'）／'+(e.collectTicket?'番号札も回収':'札回収は記録しない');});
        if(await confirmAction(details.join('\n')+'\n\n上記の杯をすべて実際に渡しましたか？ 回収にチェックした札は実物も回収済みですか？'))
          mutate('deliverBatch',{orders:entries},function(){entries.forEach(function(e){delete cupSelections[e.orderId];});},'まとめて提供を記録しました。');
      };updateBatchDelivery();
    }
  }
  function ticketsAwaitingReceipt(){return snapshot.state.tickets.filter(function(t){return t.location==='collected'||snapshot.state.orders.some(function(o){return o.id===t.orderId&&o.cancelled&&!o.returnedAt;});});}
  function renderReturns(){
    var tickets=ticketsAwaitingReceipt();
    Object.keys(returnSelections).forEach(function(l){if(!tickets.some(function(t){return t.label===l&&t.orderId===returnSelections[l];}))delete returnSelections[l];});
    document.getElementById('workspace').innerHTML='<p class="help">実物が会計の手元にある札だけ選んでください。取消した注文の札も、この画面で会計が直接受領確認できます。<br><strong>この確認が完了した札だけ、新しい注文に使用できます。</strong></p><div class="return-grid">'+tickets.map(function(t){return '<label class="return-card"><input type="checkbox" data-return="'+esc(t.label)+'" '+(returnSelections[t.label]?'checked':'')+'><span><strong>'+esc(t.label)+'</strong><small>'+ (snapshot.state.orders.some(function(o){return o.id===t.orderId&&o.cancelled;})?'取消済み・会計で未受領':'会計への返却待ち')+'</small></span></label>';}).join('')+'</div>'+(!tickets.length?'<div class="empty">会計への返却待ちの札はありません。</div>':'<button id="return-confirm" class="primary" '+(!Object.keys(returnSelections).length?'disabled':'')+'>選んだ札を会計が受け取った</button>');
    app.querySelectorAll('[data-return]').forEach(function(c){c.onchange=function(){var t=tickets.find(function(x){return x.label===c.dataset.return;});if(c.checked)returnSelections[t.label]=t.orderId;else delete returnSelections[t.label];rememberInputs();document.getElementById('return-confirm').disabled=!Object.keys(returnSelections).length;};});
    var button=document.getElementById('return-confirm');if(button && pending && pending.action==='returnTickets'){button.disabled=true;button.textContent='返却を保存中…（他の画面は操作できます）';}if(button)button.onclick=async function(){var labels=Object.keys(returnSelections),orderIds=Object.assign({},returnSelections);if(await confirmAction(labels.join('・')+' の実物が会計の手元にありますか？'))mutate('returnTickets',{labels:labels,orderIds:orderIds},function(){returnSelections={};},'会計への返却を確認しました。札を再利用できます。');};
  }
  function renderAdmin(){
    document.getElementById('workspace').innerHTML='<div class="admin-grid"><section class="panel" style="margin-top:0"><h2>番号札を追加する</h2><form id="add-tickets"><label class="field">追加する番号札<input name="labels" placeholder="例：AA, AB, AC または 27, 28, 29" required></label><p class="help">カンマ・空白・改行で区切ります。英字・数字・ハイフン、各12文字以内。実物の札を用意し、会計の手元に置いてから追加してください。</p><label class="checkline"><input name="physical" type="checkbox" required>追加する札の実物が会計にあります</label><button class="primary full" style="margin-top:16px">番号札を追加する</button></form></section><section class="panel" style="margin-top:0"><h2>番号札の使用・停止</h2><p class="help">会計にある未使用の札だけ変更できます。停止した札は注文登録に表示されません。</p><div class="ticket-list">'+snapshot.state.tickets.map(function(t){return '<button data-active-ticket="'+esc(t.label)+'" '+(t.location!=='cashier'||t.orderId?'disabled':'')+'>'+esc(t.label)+'<span>'+(t.active?(t.location==='cashier'?'使用可能':t.location==='customer'?'お客さん':'返却待ち'):'使用停止')+'</span></button>';}).join('')+'</div></section></div><section class="panel"><h2>記録用の表を更新する</h2><p class="help">操作記録をもとに、スプレッドシートの「番号札一覧」「当日注文一覧」と日付別の注文記録を更新します。操作の記録自体は毎回保存されます。</p><button id="sync-sheets">表を更新する</button></section><section class="panel"><h2>表示名の管理</h2><p class="help">通常は記録から30日後に順次除去します。開催後に表示名をまとめて除去することもできます。操作後は全員がログインし直す必要があります。Googleの変更履歴には残る場合があります。</p><form id="remove-names" class="danger-box"><label class="field">確認のため「表示名を除去」と入力<input name="confirmation" autocomplete="off" required></label><button class="danger">全記録の表示名を除去する</button></form></section>';
    document.getElementById('workspace').insertAdjacentHTML('afterbegin','<section class="panel"><h2>未提供注文を目立たせる基準</h2><form id="wait-threshold"><label class="field">受付からの経過時間（分）<input name="minutes" type="number" min="1" max="180" step="1" value="'+(snapshot.waitThresholdMinutes||15)+'" required></label><button class="primary">基準を保存する</button></form></section>');
    document.getElementById('wait-threshold').onsubmit=function(e){e.preventDefault();special('setWaitThreshold',{minutes:Number(new FormData(e.currentTarget).get('minutes'))},'基準を更新しました。');};
    var discord=snapshot.discordAlerts||{enabled:false,configured:false,lastStatus:'未設定'};
    document.getElementById('workspace').insertAdjacentHTML('afterbegin','<section class="panel"><h2>全体指揮へのDiscord DM通知</h2><p class="help">当日受付した未提供注文を約1分ごとに確認します。赤い警告と同じ基準を使用し、同じ注文の再通知は約10分おきです。端末の音は鳴らしません。</p><p>'+esc(discord.lastStatus)+'</p>'+(!discord.configured?'<p class="help">Apps Scriptのスクリプトプロパティに DISCORD_ALERT_BOT_TOKEN（通知用Botトークン）と DISCORD_ALERT_USER_ID（あなたのユーザーID）を設定してください。トークンをチャットへ送らないでください。</p>':'')+'<button id="discord-toggle" '+(!discord.configured&&!discord.enabled?'disabled':'')+'>'+ (discord.enabled?'Discord通知を停止する':'Discord通知を開始する')+'</button> <button id="discord-test" '+(!discord.configured?'disabled':'')+'>通知先へテスト送信</button></section>');
    document.getElementById('discord-toggle').onclick=function(){special('setDiscordAlerts',{enabled:!discord.enabled},discord.enabled?'Discord通知を停止しました。':'Discord通知を開始しました。');};
    document.getElementById('discord-test').onclick=function(){special('testDiscordAlerts',{},'Discordへテスト通知を送りました。');};
    document.getElementById('add-tickets').onsubmit=function(e){e.preventDefault();var f=new FormData(e.currentTarget);if(f.get('physical')!=='on')return;var labels=String(f.get('labels')).split(/[,、\s]+/).filter(Boolean);mutate('addTickets',{labels:labels},null,'番号札を追加しました。');};
    app.querySelectorAll('[data-active-ticket]').forEach(function(b){b.onclick=async function(){var t=snapshot.state.tickets.find(function(x){return x.label===b.dataset.activeTicket;});if(await confirmAction(t.label+'を'+(t.active?'使用停止':'使用可能')+'にしますか？'))mutate('setTicketActive',{label:t.label,active:!t.active},null,'番号札の設定を更新しました。');};});
    document.getElementById('sync-sheets').onclick=function(){special('syncSheets',{},'スプレッドシートの表を更新しました。');};
    document.getElementById('remove-names').onsubmit=async function(e){e.preventDefault();var text=new FormData(e.currentTarget).get('confirmation');if(text!=='表示名を除去'){toast('「表示名を除去」と入力してください。',true);return;}if(await confirmAction('記録に含まれる表示名を除去します。操作時刻・商品・番号札の記録は残ります。実行しますか？'))special('removeNames',{confirm:text},'表示名を除去しました。');};
  }
  function renderPrivacy(){
    document.getElementById('workspace').innerHTML='<section class="panel"><h2>必要な情報だけを記録します</h2><ul class="privacy-list"><li>表示名：本名は不要です。スタッフ間で分かるニックネームを使えます。</li><li>利用目的：提供漏れの確認、記録の確認、スタッフへの問い合わせ。</li><li>記録する内容：表示名、担当区分、注文・提供・札回収・返却の操作時刻。お客さんの個人情報は取得しません。</li><li>保存先：管理者が所有するGoogleスプレッドシート。アプリはGoogleアカウントのメールアドレスを取得・記録しません。</li><li>閲覧範囲：スタッフは対応中の注文の表示名を確認できます。返却済みの履歴は管理者と記録用シートの共有先が確認できます。</li><li>保存期間：操作記録の表示名は30日経過後の日次処理で順次除去します。Googleの変更履歴・バックアップ等の消去は、このアプリでは保証できません。</li><li>端末への保存：利用セッションをこのタブに保存します。利用コードは保存しません。セッションは最大6時間で、早く失効する場合もあります。</li><li>端末交代：「利用者を変更」で前の利用者を終了してください。</li><li>表示名の訂正・除去、運用上の問い合わせ：工大祭TECHSPRESSOの運営管理者へ申し出てください。</li></ul><p class="help">運営管理者は、スプレッドシートを「制限付き」にし、必要な管理者だけに共有してください。開催後、保存が不要になった記録ファイルは、変更履歴も含めて管理者が削除方針に従って処理してください。ニックネームもスタッフと結びつく場合は個人情報として扱います。</p></section>';
  }
  async function refresh(force){
    if(force&&loading){refreshQueued=true;return;}
    if(!person||loading||busy||(pending&&person.role!=='display'))return;
    if(!force&&(document.hidden||(person.role!=='display'&&(app.querySelector('input:focus')||Object.keys(cupSelections).some(function(id){return cupSelections[id].numbers.length;})||Object.keys(returnSelections).length||tab==='admin'))))return;
    refreshQueued=false;loading=true;var readGeneration=snapshotGeneration,readToken=person.token;
    try{var next=await call('rpc',[readToken,'snapshot',{},'']);if(!person||person.token!==readToken||snapshotGeneration!==readGeneration)return;if(next.ok===false)throw new Error(next.message);snapshot=next;if(next.expiresAt){person.expiresAt=next.expiresAt;sessionUpdate(person);}lastSynced=Date.now();render();}
    catch(error){if(!person||person.token!==readToken||snapshotGeneration!==readGeneration)return;toast(error.message,true);if(/ログインし直/.test(error.message)){var expiredPerson=person;if(person.role==='display'){try{person=await call('login',[{role:'display',code:'',roleOnly:true}]);sessionUpdate(person,expiredPerson);refreshQueued=true;}catch(ignore){person=null;sessionUpdate(null,expiredPerson);loginScreen();}}else{person=null;sessionUpdate(null,expiredPerson);loginScreen();}}}
    finally{loading=false;if(refreshQueued&&person&&!busy&&!pending)await refresh(true);}
  }
  async function mutate(action,payload,success,message){
    if(busy||pending){toast('保存中です。入力内容は保持されています。保存が終わってから登録してください。',true);return;}
    snapshotGeneration++;pending={action:action,payload:payload,requestId:uid(),success:success,message:message};pendingStore();await sendPending();
  }
  async function sendPending(){
    if(!pending||busy)return;
    snapshotGeneration++;busy=true;var refreshRejected=false,orderRegistered=false;render();if(pending.action==='returnTickets')toast('返却を保存中です。他の画面の入力は続けられます。');
    try{
      var result=await call('rpc',[person.token,pending.action,pending.payload,pending.requestId]);
      if(!result.ok){
        if(result.sessionExpired){person=null;sessionStore(null);document.getElementById('uncertain').hidden=true;loginScreen();toast('同じ担当でログインし直すと、保存状態を確認します。',true);return;}
        if(result.uncertain)throw new Error(result.message);var failed=result.message;pending=null;pendingStore();document.getElementById('uncertain').hidden=true;refreshRejected=true;toast(failed,true);
      }
      else{var saved=pending;orderRegistered=saved.action==='createOrder';pending=null;pendingStore();document.getElementById('uncertain').hidden=true;if(saved.success)saved.success();else if(saved.action==='createOrder'){draft={};chosenTicket='';}else if(saved.action==='deliver')delete cupSelections[saved.payload.orderId];else if(saved.action==='deliverBatch')saved.payload.orders.forEach(function(e){delete cupSelections[e.orderId];});else if(saved.action==='returnTickets')returnSelections={};if(result.snapshot){snapshot=result.snapshot;if(snapshot.expiresAt){person.expiresAt=snapshot.expiresAt;sessionStore(person);}lastSynced=Date.now();if(saved.action==='createOrder')lastRegistered=snapshot.state.orders.filter(function(o){return o.ticket===saved.payload.ticket;}).slice(-1)[0]||null;}toast(saved.message+(result.projectionDelayed?' 表の反映は管理画面から再実行してください。':''));}
    }catch(error){var box=document.getElementById('uncertain');box.hidden=false;box.innerHTML='保存できたか確認できません。別の操作をせず、同じ操作IDで再送して確認してください。重複登録は防止されます。<br><button id="retry-save">再送して保存状態を確認する</button>';document.getElementById('retry-save').onclick=sendPending;}
    finally{busy=false;if(person){render();if(!pending && (refreshRejected || !snapshot))await refresh(true);if(orderRegistered&&tab==='cashier')scrollToFirstQuantity();}}
  }
  async function special(action,payload,message){
    if(busy||pending)return;snapshotGeneration++;busy=true;render();
    try{var result=await call('rpc',[person.token,action,payload,'']);if(!result.ok)throw new Error(result.message);toast(message);if(result.signedOut){person=null;sessionStore(null);loginScreen();}}
    catch(error){toast(error.message,true);}finally{busy=false;if(person){render();refresh(true);}}
  }
  async function signOut(){
    if(busy||(pending&&person.role!=='display')){toast('保存完了後に担当を変更してください。',true);return;}
    var dialog=document.createElement('dialog');dialog.className='confirm-dialog';
    dialog.innerHTML='<h2>担当を変更</h2><label class="field">担当<select id="switch-role"><option value="cashier">会計担当</option><option value="handover">受け渡し担当</option><option value="display">表示専用（タブレット表示）</option><option value="admin">管理者</option></select></label><p class="help">管理者は管理者用コードでの認証が必要です。</p><div class="dialog-actions"><button id="switch-cancel">戻る</button><button class="primary" id="switch-go">変更する</button></div><button id="end-session">ログインを終了する</button>';
    document.body.appendChild(dialog);dialog.querySelector('#switch-role').value=person.role;
    function close(){dialog.close();dialog.remove();}
    dialog.querySelector('#switch-cancel').onclick=close;dialog.oncancel=function(e){e.preventDefault();close();};
    dialog.querySelector('#end-session').onclick=async function(){var token=person.token;close();person=null;snapshot=null;sessionStore(null);loginScreen();try{await call('logout',[token]);}catch(ignore){}};
    dialog.querySelector('#switch-go').onclick=async function(){var role=dialog.querySelector('#switch-role').value;
      snapshotGeneration++;
      if(role==='admin'&&person.baseRole!=='admin'&&person.role!=='admin'){close();person=null;snapshot=null;sessionStore(null);loginScreen();app.querySelector('[name="role"]').value='admin';app.querySelector('[name="role"]').dispatchEvent(new Event('change'));return;}
      dialog.querySelector('#switch-go').disabled=true;
      try{var result=await call('rpc',[person.token,'switchRole',{role:role},'']);if(!result.ok)throw Error(result.message);person=result.person;sessionStore(person);tab=role==='display'?'display':role==='handover'?'handover':'cashier';snapshot=null;close();if(pending&&person.role!=='display')await sendPending();else await refresh(true);}catch(error){toast(error.message,true);dialog.querySelector('#switch-go').disabled=false;}
    };dialog.showModal();
  }
  try{pending=JSON.parse(localStorage.getItem('techspresso-pending')||'null');var saved=JSON.parse(localStorage.getItem('techspresso-session')||'null');if(saved&&(saved.expiresAt>Date.now()||saved.role==='display')){person=saved;if(demo)demoTokens[saved.token]=saved;tab=saved.role==='display'?'display':saved.role==='handover'?'handover':'cashier';}}catch(ignore){}
  try{var inputs=JSON.parse(localStorage.getItem('techspresso-inputs')||'null');if(inputs){formInputs=inputs.formInputs||{};draft=inputs.draft||{};chosenTicket=inputs.chosenTicket||'';cupSelections=inputs.cupSelections||{};returnSelections=inputs.returnSelections||{};if(person&&['cashier','handover','returns','admin','orders','display'].indexOf(inputs.tab)>=0 && ((person.role==='display'&&inputs.tab==='display')||(person.role==='admin'&&inputs.tab!=='display')||(person.role==='cashier'&&['cashier','orders','returns'].indexOf(inputs.tab)>=0)||person.role==='handover'&&['handover','orders'].indexOf(inputs.tab)>=0))tab=inputs.tab;}}catch(ignore){}
  app.addEventListener('input',rememberInputs);app.addEventListener('change',rememberInputs);app.addEventListener('click',rememberInputs);window.addEventListener('pagehide',rememberInputs);
  if(person){app.innerHTML='<div class="empty">注文を読み込んでいます…</div>';if(pending&&person.role!=='display')sendPending();else refresh(true);}else loginScreen();
  setInterval(function(){refresh(false);},15000);
  setInterval(updateWarnings,1000);
}());
