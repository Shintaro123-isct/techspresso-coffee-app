// Shared validation. A unique, non-personal ID distinguishes identical baskets.
export function parseOrder(value, menu) {
  if (typeof value === 'string') { if(value.length>2000)throw Error('QRが長すぎます。'); try{value=JSON.parse(value);}catch{throw Error('TECHSPRESSOの注文QRではありません。お客様の注文画面に表示されたQRを読み取ってください。');} }
  if (!value || value.v!==1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id||'')) throw Error('TECHSPRESSOの注文QRではありません。');
  if(!Array.isArray(value.items)||!value.items.length||value.items.length>menu.length)throw Error('商品数を確認してください。');
  const seen=new Set();let count=0,total=0;
  const items=value.items.map(line=>{
    const m=menu.find(m=>m.id===line.menuId);
    if(!m||seen.has(m.id)||!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>20)throw Error('商品・数量が不正です。');
    seen.add(m.id);count+=line.quantity;total+=m.price*line.quantity;
    return {menuId:m.id,quantity:line.quantity};
  }).sort((a,b)=>a.menuId.localeCompare(b.menuId));
  if(count>30)throw Error('1注文は最大30杯です。');
  return {v:1,id:value.id,items,total,count};
}

export function deliveryRequest(orders, selection, collected) {
  const chosen=orders.map(o=>{
    const remaining=o.items.filter(i=>!i.deliveredAt);
    return {orderId:o.id,revision:o.revision,itemNumbers:remaining.filter(i=>selection[o.id+':'+i.number]).map(i=>i.number),collectTicket:remaining.every(i=>selection[o.id+':'+i.number])};
  }).filter(o=>o.itemNumbers.length);
  if(!chosen.length)throw Error('渡した杯を選択してください。');
  if(chosen.length>10)throw Error('一度に提供できる番号札は10枚までです。');
  if(chosen.some(o=>o.collectTicket)&&!collected)throw Error('全杯を渡す番号札を回収し、回収確認にチェックしてください。');
  return {action:chosen.length===1?'deliver':'deliverBatch',payload:chosen.length===1?chosen[0]:{orders:chosen}};
}
