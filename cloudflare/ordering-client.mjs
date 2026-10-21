import {parseOrder,deliveryRequest} from './order-qr.mjs';
const menu=/* BUILD_MENU */[];
const $=s=>document.querySelector(s),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const customer=/^\/order(?:\.html)?\/?$/.test(location.pathname),screen=new URLSearchParams(location.search).get('screen')==='handover'?'handover':'cashier';
const key='tc-qr-v1-',load=(k,f)=>{try{return JSON.parse(localStorage.getItem(key+k))??f;}catch{return f;}},save=(k,v)=>{try{localStorage.setItem(key+k,JSON.stringify(v));return true;}catch{return false;}};
let draft=load(customer?'customer':'cashier',{}),qrOrder=customer?load('customerQR',null):load('scanned',null),ticket='',cash=false,person=null,snapshot=null,busy=false,pending=load('pending-'+screen,null),stream=null,scanGeneration=0,selection={},lastSuccess=0,refreshing=false,collected=false;
const title=m=>m.displayName||m.name;
const roleNames={cashier:'会計担当',handover:'受け渡し担当',display:'表示専用（タブレット表示）',admin:'管理者'};
function updateRoleLabel(){if($('#staff-role'))$('#staff-role').textContent=person?.baseRole==='admin'?'管理者 · '+roleNames[screen]:roleNames[screen];}
function changeRole(){
 if(busy||pending){status('保存完了後に担当を変更してください。',true);return;}
 stopScan();const dialog=document.createElement('dialog');dialog.className='role-dialog';
 dialog.innerHTML='<h2>担当を変更</h2><form><label>担当<select name="role">'+Object.entries(roleNames).map(([role,name])=>'<option value="'+role+'">'+name+'</option>').join('')+'</select></label><label data-code hidden>管理者の利用コード<input name="code" type="password" autocomplete="off" disabled></label><p class="muted">管理者は管理者用コードでの認証が必要です。</p><p data-error class="danger" role="alert" hidden></p><div class="role-actions"><button type="button" data-cancel>戻る</button><button type="submit" class="primary">変更する</button></div></form><button type="button" data-logout>ログインを終了する</button>';
 document.body.appendChild(dialog);const select=dialog.querySelector('[name="role"]'),code=dialog.querySelector('[name="code"]'),submit=dialog.querySelector('[type="submit"]'),error=dialog.querySelector('[data-error]');select.value=screen;
 function close(){code.value='';dialog.close();dialog.remove();}
 select.onchange=()=>{const needsCode=select.value==='admin'&&person?.baseRole!=='admin';dialog.querySelector('[data-code]').hidden=!needsCode;code.disabled=!needsCode;code.required=needsCode;if(!needsCode)code.value='';error.hidden=true;};
 dialog.querySelector('[data-cancel]').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
 dialog.querySelector('form').onsubmit=async e=>{
  e.preventDefault();const role=select.value;submit.disabled=true;error.hidden=true;
  try{
   const next=role==='admin'&&person?.baseRole!=='admin'?await api('login',[{role,code:code.value}]):person?(await api('rpc',[person.token,'openRole',{role}])).person:await api('login',[{role}]);
   if(!save('person-'+role,next))throw Error('担当を保存できません。ブラウザーの保存設定を確認してください。');
   if(role==='admin'||role==='display')localStorage.setItem('techspresso-session',JSON.stringify(next));
   close();window.location.assign(role==='admin'?'/staff?tab=admin':role==='display'?'/staff?tab=display':'/?screen='+role);
  }catch(e){code.value='';error.textContent=e.message;error.hidden=false;submit.disabled=false;}
 };
 dialog.querySelector('[data-logout]').onclick=async()=>{submit.disabled=true;try{if(person)await api('logout',[person.token]);save('person-'+screen,null);person=null;snapshot=null;close();$('#content').innerHTML='<section class="panel"><h2>担当を選択してください</h2><p>上の「担当を変更」から利用を開始できます。</p></section>';status('ログインを終了しました。');}catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}};
 dialog.showModal();
}
function status(text,error=false){if(!error&&text.startsWith('最新の一覧')&&$('#status').dataset.keep==='true')return;$('#status').dataset.keep=String(error&&/受付済み|読み取り済み/.test(text));$('#status').textContent=text;$('#status').className=error?'notice danger':'notice';}
function lines(){return menu.filter(m=>Number(draft[m.id])>0).map(m=>({menuId:m.id,quantity:Number(draft[m.id])}));}
function validated(id=crypto.randomUUID()){if(Object.values(draft).some(n=>!Number.isInteger(Number(n))||Number(n)<0||Number(n)>20))throw Error('各商品の杯数は0〜20の整数で入力してください。');return parseOrder({v:1,id,items:lines()},menu);}
function list(items){return items.map(i=>{const m=menu.find(m=>m.id===i.menuId);return '<div class="line">'+esc(title(m))+' '+esc(m.temperature||'Iced')+' × '+i.quantity+'</div>';}).join('');}
function storeDraft(){save(customer?'customer':'cashier',draft);}
function editor(){
 const total=lines().reduce((n,i)=>n+i.quantity,0);
 return '<div class="grid menu-grid">'+menu.map(m=>{const n=Number(draft[m.id]||0),label=title(m)+' '+(m.temperature||'Iced'),temperature=m.temperature||'Fizz';
  return '<article class="menu-item '+(n?'has-quantity':'')+'"><span class="tag '+(m.temperature==='Hot'?'hot':m.temperature==='Iced'?'iced':'')+'">'+esc(temperature)+'</span><h3>'+esc(title(m))+'</h3><div class="detail">'+esc(m.name)+'</div><p class="unit-price">'+m.price+'円</p><div class="quantity-control"><button data-minus="'+m.id+'" aria-label="'+esc(label)+'を1杯減らす" '+(!n?'disabled':'')+'>−</button><output aria-label="'+esc(label)+'の杯数" aria-live="polite">'+n+'</output><button data-plus="'+m.id+'" aria-label="'+esc(label)+'を1杯増やす" '+(n>=20||total>=30?'disabled':'')+'>＋</button></div></article>';
 }).join('')+'</div>';
}
function bindEditor(){for(const [attr,delta]of [['plus',1],['minus',-1]])document.querySelectorAll('[data-'+attr+']').forEach(el=>el.onclick=()=>{if(busy||pending)return;const id=el.dataset[attr],n=Number(draft[id]||0)+delta,total=lines().reduce((n,i)=>n+i.quantity,0);if(n<0||n>20||(delta>0&&total>=30))return;draft[id]=n;storeDraft();if(customer){qrOrder=null;save('customerQR',null);$('#qr').hidden=true;updateCustomerTotal();}else{qrOrder=null;save('scanned',null);cash=false;updateReceipt();status('手入力で注文を編集しています。');}$('#'+(customer?'menu-editor':'edit')).innerHTML=editor();bindEditor();});}
function updateCustomerTotal(){
 const selected=lines(),count=selected.reduce((n,i)=>n+i.quantity,0),total=selected.reduce((n,i)=>n+menu.find(m=>m.id===i.menuId).price*i.quantity,0);
 $('#customer-total').textContent='合計 '+total.toLocaleString('ja-JP')+'円';$('#customer-count').textContent=count+'杯';
}
function customerRender(){
 $('#content').innerHTML='<h2>メニューを選ぶ</h2><p>注文QRをレジで提示してください。まだ注文・支払いは確定しません。QR表示後は通信不要です。</p><section id="customer-summary" class="panel customer-summary" aria-label="選択中の合計金額" aria-live="polite" aria-atomic="true"><strong id="customer-total" class="price">合計 0円</strong><span id="customer-count">0杯</span></section><div id="menu-editor">'+editor()+'</div><button id="make" class="primary">注文を確認してQRを表示</button><section id="qr" class="panel" hidden></section>';
 bindEditor();updateCustomerTotal();$('#make').onclick=()=>{try{const p=validated();qrOrder={v:1,id:p.id,items:p.items};save('customerQR',qrOrder);showQR();}catch(e){status(e.message,true);}};if(qrOrder)showQR();
}
function newCustomerOrder(){
 draft={};qrOrder=null;save('customerQR',null);storeDraft();customerRender();status('新しい注文を作成できます。商品と杯数を選んでください。');$('#menu-editor').scrollIntoView({block:'start'});$('#menu-editor [data-plus]')?.focus({preventScroll:true});
}
function showQR(){try{const p=parseOrder(qrOrder,menu),code=qrcode(0,'M');code.addData(JSON.stringify({v:1,id:p.id,items:p.items}));code.make();$('#qr').hidden=false;$('#qr').innerHTML='<h2>レジでこのQRを提示</h2>'+code.createSvgTag({cellSize:5,margin:4,scalable:true})+list(p.items)+'<p>現在のメニューで '+p.total.toLocaleString()+'円（現金）</p><p class="muted">注文ID '+esc(p.id)+'<br>同じQRは1回だけ受付できます。</p><button id="new-customer-order" class="primary">新しい注文を作る</button><p class="muted">商品選択をリセットして、別の注文QRを作れます。受付済みの注文はそのまま残ります。</p>';$('#new-customer-order').onclick=newCustomerOrder;$('#qr').scrollIntoView({behavior:'smooth'});}catch{qrOrder=null;save('customerQR',null);}}
async function api(method,args){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{const r=await fetch('/api/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({args}),signal:controller.signal});const data=await r.json();if(data.ok===false)throw Object.assign(Error(data.message),{safe:!data.uncertain,expired:data.sessionExpired});if(!r.ok)throw Error('通信を確認してください。');return data;}finally{clearTimeout(timer);}}
async function login(){
 const old=load('person-'+screen,null);
 if(old?.expiresAt>Date.now()){
  try{person=(await api('rpc',[old.token,'openRole',{role:screen}])).person;}
  catch(e){if(!e.expired)throw e;person=await api('login',[{role:screen}]);}
 }else person=await api('login',[{role:screen}]);
 save('person-'+screen,person);updateRoleLabel();await refresh();
}
async function refresh(){if(refreshing||busy)return;refreshing=true;try{const next=await api('rpc',[person.token,'snapshot']);if(!snapshot||next.state.version>=snapshot.state.version)snapshot=next;lastSuccess=Date.now();if(pending)await reconcile();if(screen==='cashier'&&!$('#receipt'))cashierRender();if(screen==='cashier')updateReceipt();else handoverRender();status('最新の一覧を取得しました（'+new Date().toLocaleTimeString('ja-JP')+'）');}catch(e){if(e.expired){person=null;save('person-'+screen,null);}status('更新できません。古い一覧です。新規登録前に接続を確認してください。 '+e.message,true);}finally{refreshing=false;}}
function cashierRender(){
 $('#content').innerHTML='<h2>レジ · 会計</h2><section class="panel"><button id="scan" class="primary">注文QRをカメラで読み取る</button> <button id="manual">手入力に切り替え</button></section><div class="cashier-grid"><div id="edit"></div><section id="receipt" class="panel cashier-receipt"></section></div>';
 $('#scan').onclick=startScan;$('#manual').onclick=()=>{if(busy||pending)return status('保存状態の確認が先です。',true);stopScan();qrOrder=null;save('scanned',null);draft={};cash=false;ticket='';storeDraft();$('#edit').innerHTML=editor();bindEditor();updateReceipt();status('手入力で注文を登録できます。');};
 if(qrOrder){try{const p=parseOrder(qrOrder,menu);draft=Object.fromEntries(p.items.map(i=>[i.menuId,i.quantity]));}catch{qrOrder=null;save('scanned',null);}}else{$('#edit').innerHTML=editor();bindEditor();}updateReceipt();
}
async function acceptQR(text){
 if(busy||pending)throw Error('先に保存中の注文を確認してください。');
 stopScan();const p=parseOrder(text,menu);busy=true;updateReceipt();
 try{
  const check=await api('rpc',[person.token,'checkOrderQR',{qr:{v:1,id:p.id,items:p.items}}]);
  if(check.registered)throw Error('この注文は既に受け付けています（札 '+check.ticket+'・受付済み）。代金を再受領せず、既存の注文を確認してください。');
  if(qrOrder?.id===p.id)throw Error('この注文QRは読み取り済みですが、受付はまだ確定していません。'+(ticket?'選択中の番号札は '+ticket+' です。':'')+'表示中の注文内容・代金受領・番号札を確認し、確定してください。');
  cash=false;ticket='';qrOrder={v:1,id:p.id,items:p.items};draft=Object.fromEntries(p.items.map(i=>[i.menuId,i.quantity]));save('scanned',qrOrder);storeDraft();$('#edit').innerHTML='';status('QRを読み取りました。内容と代金受領を確認してください。');
 }finally{busy=false;updateReceipt();}
}

async function startScan(){
 if(busy||pending)return status('保存状態を確認してから、次のQRを読み取ってください。',true);
 stopScan();status('カメラで注文QRを読み取ります。');const generation=++scanGeneration;
 $('#scanner-slot').innerHTML='<section id="camera" class="panel scanner" aria-label="注文QRカメラ"><div class="scanner-heading"><h2>注文QRを読み取る</h2><button id="stop">カメラを閉じる</button></div><p id="scan-feedback" role="status">カメラを準備しています。アクセス許可が表示されたら許可してください。</p><video playsinline muted aria-label="QR読み取り用カメラ"></video></section>';
 $('#stop').onclick=stopScan;$('#camera').scrollIntoView({block:'start'});
 try{
  const opened=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if(generation!==scanGeneration){opened.getTracks().forEach(t=>t.stop());return;}
  stream=opened;const video=$('#camera video');video.srcObject=stream;await video.play();
  if(generation!==scanGeneration)return;
  $('#scan-feedback').textContent='お客様の注文QR全体をカメラに映してください。';
  const c=document.createElement('canvas');
  async function frame(){
   if(!stream||generation!==scanGeneration)return;
   try{
    if(video.readyState>=2&&video.videoWidth>0){c.width=Math.min(video.videoWidth,900);c.height=video.videoHeight*c.width/video.videoWidth;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(video,0,0,c.width,c.height);const d=x.getImageData(0,0,c.width,c.height),code=jsQR(d.data,c.width,c.height);if(code){await acceptQR(code.data);return;}}
    setTimeout(frame,200);
   }catch(e){stopScan();status('QRを受け付けられませんでした。'+e.message,true);$('#status').dataset.keep='true';$('#status').scrollIntoView({block:'start'});}
  }
  await frame();
 }catch(e){if(generation!==scanGeneration)return;stopScan();status(e.name==='NotAllowedError'?'カメラが許可されていません。ブラウザーのカメラ許可を確認するか、手入力を使ってください。':'カメラを開けません。ほかのアプリで使用中でないか確認するか、手入力を使ってください。',true);$('#status').dataset.keep='true';}
}
function stopScan(){scanGeneration++;stream?.getTracks().forEach(t=>t.stop());stream=null;if($('#scanner-slot'))$('#scanner-slot').innerHTML='';}
function updateReceipt(){if(!$('#receipt')||!snapshot)return;let p;try{p=validated(qrOrder?.id);}catch{p={items:[],total:0,count:0};}const available=snapshot.state.tickets.filter(t=>t.active&&t.location==='cashier'&&!t.orderId);if(!available.some(t=>t.label===ticket))ticket='';
 $('#receipt').innerHTML='<h2>'+(qrOrder?'QRの注文内容':'手入力の注文内容')+'</h2>'+list(p.items)+'<p><strong class="price">合計 '+p.total.toLocaleString()+'円</strong> · '+p.count+'杯</p><label><input id="paid" type="checkbox" '+(cash?'checked':'')+'> 代金を受け取りました</label><h2>実物の番号札を選択</h2><div class="tickets">'+available.map(t=>'<button data-ticket="'+esc(t.label)+'" class="'+(ticket===t.label?'selected':'')+'">'+esc(t.label)+'</button>').join('')+'</div><p class="muted">紙の伝票で使っている札は選ばないでください。</p><button id="confirm" class="primary" '+(busy||pending||!cash||!ticket||!p.count?'disabled':'')+'>代金受領・札 '+esc(ticket||'未選択')+' で確定</button>';
 $('#paid').onchange=e=>{cash=e.target.checked;updateReceipt();};document.querySelectorAll('[data-ticket]').forEach(b=>b.onclick=()=>{ticket=b.dataset.ticket;updateReceipt();});const returns=snapshot.state.orders.filter(o=>!o.returnedAt&&(o.cancelled||o.collectedAt));const returnBox=document.createElement('section');returnBox.innerHTML='<h2>会計へ戻った札</h2><p class="muted">実物が手元に戻ってから受領してください。</p>'+returns.map(o=>'<button data-return="'+o.id+'">札 '+esc(o.ticket)+' を受領・再使用可能にする</button>').join('');$('#receipt').append(returnBox);document.querySelectorAll('[data-return]').forEach(b=>{b.disabled=busy||!!pending;b.onclick=()=>{const o=returns.find(o=>o.id===b.dataset.return);pending={action:'returnTickets',payload:{labels:[o.ticket],orderIds:{[o.ticket]:o.id}},id:crypto.randomUUID()};if(!save('pending-'+screen,pending)){pending=null;return status('再送情報を保存できません。',true);}sendPending();};});$('#confirm').onclick=()=>{try{if(Date.now()-lastSuccess>15000)throw Error('一覧が古いため、更新してから確定してください。');const p=validated(qrOrder?.id);pending={action:'createOrder',payload:{ticket,items:p.items,...qrOrder?{qr:qrOrder}:{}},id:p.id};if(!save('pending-'+screen,pending)){pending=null;throw Error('端末に再送情報を保存できません。ブラウザーの保存設定を確認するか、紙を使ってください。');}sendPending();}catch(e){status(e.message,true);}};
}
async function reconcile(){if(!pending)return;const found=snapshot.state.orders.find(o=>o.customerOrderId===pending.id);if(found&&pending.action==='createOrder'){pending=null;save('pending-'+screen,null);draft={};qrOrder=null;save('scanned',null);storeDraft();$('#pending').hidden=true;}}
async function sendPending(){if(busy||!pending)return;busy=true;showPending();if(screen==='cashier')updateReceipt();try{const result=await api('rpc',[person.token,pending.action,pending.payload,pending.id]);snapshot=result.snapshot;lastSuccess=Date.now();const was=pending.action;pending=null;save('pending-'+screen,null);$('#pending').hidden=true;if(was==='createOrder'){draft={};qrOrder=null;cash=false;ticket='';save('scanned',null);storeDraft();cashierRender();}else{selection={};collected=false;if(screen==='cashier')cashierRender();else handoverRender();}status('保存しました。提供画面への表示も確認してください。');}catch(e){status(e.message,true);if(e.expired){person=null;save('person-'+screen,null);}if(e.safe&&!e.expired){pending=null;save('pending-'+screen,null);$('#pending').hidden=true;}else showPending();}finally{busy=false;if(pending)showPending();if(screen==='cashier')updateReceipt();else handoverRender();}}
function showPending(){if(!pending)return;$('#pending').hidden=false;$('#pending').innerHTML='<strong>保存状態を確認中：新しい電子注文は登録しないでください。</strong><p>30秒を超えて確認できない場合は責任者へ連絡してください。紙に切り替える前に提供側と重複を確認します。</p><button id="retry">同じ注文の保存確認</button>';$('#retry').disabled=busy;$('#retry').onclick=async()=>{try{if(!person){person=await api('login',[{role:screen}]);save('person-'+screen,person);}await sendPending();}catch(e){status(e.message,true);}};}
function handoverRender(){if(!snapshot)return;const orders=snapshot.state.orders.filter(o=>!o.cancelled&&o.items.some(i=>!i.deliveredAt)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));$('#content').innerHTML='<h2>提供待ち · '+orders.length+'件</h2><p>実際に渡した杯にチェックを入れ、提供済みにします。全杯提供した注文は一覧から消えます。</p><label><input id="collected" type="checkbox" '+(collected?'checked':'')+'> 全杯を提供する番号札は、お客様から回収しました</label><button id="deliver" class="primary" '+(busy||pending?'disabled':'')+'>選択した杯をまとめて提供済みにする</button><div>'+orders.map(o=>{const mins=Math.floor((Date.now()-Date.parse(o.createdAt))/60000),late=mins>=snapshot.waitThresholdMinutes;return '<article class="panel '+(late?'danger':'')+'"><h2>札 '+esc(o.ticket)+' · '+mins+'分経過</h2><time>'+new Date(o.createdAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})+'</time><label><input type="checkbox" data-all="'+o.id+'" '+(o.items.filter(i=>!i.deliveredAt).every(i=>selection[o.id+':'+i.number])?'checked':'')+'> 残りすべてを選択</label>'+o.items.filter(i=>!i.deliveredAt).map(i=>'<label><input type="checkbox" data-cup="'+o.id+':'+i.number+'" '+(selection[o.id+':'+i.number]?'checked':'')+'> '+esc(title(menu.find(m=>m.id===i.menuId)))+' '+esc(i.temperature||'Iced')+' · '+i.number+'/'+o.items.length+'</label>').join('')+'</article>';}).join('')+'</div>';
 $('#collected').onchange=e=>{collected=e.target.checked;};document.querySelectorAll('[data-cup]').forEach(c=>c.onchange=()=>{selection[c.dataset.cup]=c.checked;handoverRender();});document.querySelectorAll('[data-all]').forEach(c=>c.onchange=()=>{orders.find(o=>o.id===c.dataset.all).items.filter(i=>!i.deliveredAt).forEach(i=>selection[c.dataset.all+':'+i.number]=c.checked);handoverRender();});$('#deliver').onclick=()=>{try{pending={...deliveryRequest(orders,selection,collected),id:crypto.randomUUID()};}catch(e){return status(e.message,true);}if(!save('pending-'+screen,pending)){pending=null;return status('再送情報を保存できません。紙で管理してください。',true);}sendPending();};
}
if(!customer){$('#change-role').onclick=changeRole;updateRoleLabel();const hub=$('[data-staff-hub]');hub.onclick=e=>{if(busy||pending){e.preventDefault();status('保存状態を確認してから担当を変更してください。',true);return;}try{if(person)localStorage.setItem('techspresso-session',JSON.stringify(person));}catch{}};const reload=document.createElement('button');reload.textContent='一覧を更新';reload.onclick=()=>person?refresh():login().catch(e=>status(e.message,true));$('header nav').append(reload);}
if(customer){$('header nav').hidden=true;$('#environment').textContent=$('#environment').textContent.replace('スタッフ用（公開環境）','お客様用（公開環境）');customerRender();if('serviceWorker' in navigator)navigator.serviceWorker.register('/order-sw.js').catch(()=>{});}else{status('接続中…');login().catch(e=>status(e.message,true));setInterval(()=>{if(person&&!document.hidden)refresh();},5000);if(pending)showPending();}
window.addEventListener('pagehide',stopScan);
