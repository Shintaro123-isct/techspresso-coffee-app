import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const out=path.join(root,'.cloudflare-build');
const core=vm.runInNewContext(read('src/core.js')+';CoffeeCore_');
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'core.mjs'),read('src/core.js')+'\nexport default CoffeeCore_;\n');
const logo='<svg class="brand-logo" viewBox="270 420 540 540" role="img" aria-label="TECHSPRESSO公式ロゴ" xmlns="http://www.w3.org/2000/svg" overflow="hidden"><image width="1080" height="1350" href="data:image/png;base64,'+fs.readFileSync(path.join(root,'assets/techspresso-official.png')).toString('base64')+'"/></svg>';
for(const mode of ['development','production']){
  const production=mode==='production',dir=path.join(out,'public-'+mode);fs.mkdirSync(dir,{recursive:true});
  const title=production?'スタッフ用（公開環境）':'Cloudflare検証版（開発用）';
  let html=read('src/Index.html').replace('<!-- BUILD_LOGO -->',()=>logo).replace('/* BUILD_STYLES */',()=>read('src/styles.css')).replace('/* BUILD_CORE */',()=> 'window.TECHSPRESSO_CLOUDFLARE=true;').replace('/* BUILD_CLIENT */',()=>read('src/client.js'));
  html=html.replace('<div id="demo-banner" hidden>体験版 · この端末内だけの動作です。Googleスプレッドシートには接続していません。</div>','<div id="cloudflare-banner" style="background:'+(production?'#e8efe8':'#fff0c7')+';padding:10px;text-align:center;font-weight:600">'+title+' · '+(production?'開発用とは別の記録です。スプレッドシート・通知は未接続です。':'テスト専用の記録です。スタッフ用の注文は変わりません。旧アプリ・売上シミュレーションとは未接続です。')+'</div>');
  html=html.replace(/<details class="panel"[\s\S]*?<\/details>/,'<details class="panel" style="max-width:1100px;margin:20px auto;padding:20px"><summary>'+title+'について</summary><p>開発用とスタッフ用の記録は別々です。旧Apps Script版とは独立しており、本番営業の接続先は切り替えていません。</p><p>保存中は結果を待ち、不明な場合は同じ操作を再送してください。画面で選んだだけでは提供済みになりません。取消時に札がない場合は、会計担当が実物の受領を確認するまで再使用できません。</p><p>既存のスプレッドシート、シミュレーション、Discord通知にはまだ接続していません。管理者コードは各環境のCloudflare Secretに設定します。</p></details>');
  html=html.replaceAll('Airレジで会計を済ませてから','現金の受領を確認してから').replaceAll('会計はAirレジで行います。','会計は現金で行います。');
  fs.writeFileSync(path.join(dir,'legacy.html'),html);
  const client=read('cloudflare/order-qr.mjs').replaceAll('export function','function')+'\n'+read('cloudflare/ordering-client.mjs').replace("import {parseOrder,deliveryRequest} from './order-qr.mjs';",'window.TECHSPRESSO_CLOUDFLARE=true;').replace('/* BUILD_MENU */[]',()=>JSON.stringify(core.menu));
  const ordering=read('cloudflare/ordering.html').replace('<!-- BUILD_LOGO -->',()=>logo).replace('BUILD_ENVIRONMENT',()=>title+' · '+(production?'開発用とは別の記録です。':'テスト専用 · 売上シミュレーションとは未接続')).replace('/* QR_GENERATOR */',()=>read('node_modules/qrcode-generator/dist/qrcode.js')).replace('/* QR_DECODER */',()=>read('node_modules/jsqr/dist/jsQR.js')).replace('/* ORDERING_CLIENT */',()=>client);
  fs.writeFileSync(path.join(dir,'index.html'),ordering);
  fs.writeFileSync(path.join(dir,'order.html'),ordering);
  fs.writeFileSync(path.join(dir,'third-party-licenses.txt'),'jsQR (Apache-2.0)\n'+read('node_modules/jsqr/LICENSE')+'\nqrcode-generator (MIT)\n'+`Copyright (c) 2009 Kazuhiko Arase
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`);
  fs.writeFileSync(path.join(dir,'order-sw.js'),`const CACHE='techspresso-order-v1';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.add('/order')));self.skipWaiting();});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method==='GET'&&u.origin===self.location.origin&&(u.pathname==='/order'||u.pathname==='/order.html')){e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put('/order',copy)));}return r;}).catch(()=>caches.match('/order')));}});
`);
  fs.writeFileSync(path.join(dir,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Cache-Control: no-cache\n  Content-Security-Policy: default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\'; frame-ancestors \'none\'; base-uri \'none\'; form-action \'self\'\n');
}
console.log('開発用・スタッフ用の画面と共通状態機械をビルドしました。');
