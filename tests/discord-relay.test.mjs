import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../discord-relay/worker.mjs';
const env={RELAY_KEY:'relay-secret-32-chars-for-local-testing',DISCORD_BOT_TOKEN:'fake-local-only-token-do-not-use',DISCORD_USER_ID:'123456789012345678'};
const content='【TECHSPRESSO・通知テスト】テスト';
const request=(body={content},key=env.RELAY_KEY)=>new Request('https://sample.owner.workers.dev/notify',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
test('認証済みの通知だけを固定のDM宛先へ送り、秘密とメンションを返さない',async()=>{
  const calls=[];const result=await handle(request(),env,async(url,options)=>{calls.push({url,options});return Response.json({id:'223456789012345678'},{status:200});});
  assert.deepEqual(await result.json(),{ok:true,code:200});assert.equal(calls.length,2);assert.equal(JSON.parse(calls[0].options.body).recipient_id,env.DISCORD_USER_ID);assert.deepEqual(JSON.parse(calls[1].options.body).allowed_mentions,{parse:[]});assert.equal(calls[1].options.redirect,'manual');
});
test('キー不正・不正宛先指定・長い入力・任意本文は送信しない',async()=>{
  let sent=0;const send=()=>{sent++;throw Error('unexpected');};
  for(const req of [request({content},'wrong-key'),request({content,recipient:'other'}),request({content:'arbitrary'}),request({content:'x'.repeat(11000)})])assert.ok((await handle(req,env,send)).status>=400);
  assert.equal(sent,0);
});
test('Discordエラーと通信失敗は番号だけ返し、本文・秘密を漏らさない',async()=>{
  const denied=await handle(request(),env,async()=>Response.json({code:50007,message:env.DISCORD_BOT_TOKEN},{status:403}));assert.deepEqual(await denied.json(),{ok:false,code:403,apiCode:50007});
  const network=await handle(request(),env,async()=>{throw Error(env.DISCORD_BOT_TOKEN);});assert.deepEqual(await network.json(),{ok:false,code:0});
});
test('設定不足・別パス・ブラウザーの事前通信は送信しない',async()=>{
  let sent=0;const send=()=>sent++;
  assert.equal((await handle(request(),{...env,DISCORD_BOT_TOKEN:''},send)).status,503);
  assert.equal((await handle(new Request('https://sample.owner.workers.dev/other'),env,send)).status,404);
  assert.equal((await handle(new Request('https://sample.owner.workers.dev/notify',{method:'OPTIONS'}),env,send)).status,404);assert.equal(sent,0);
});
test('AbortSignal.timeoutがない実行環境でも送信できる',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
  Object.defineProperty(AbortSignal,'timeout',{value:undefined,configurable:true});
  try{
    const result=await handle(request(),env,async(url,options)=>{
      assert.ok(options.signal instanceof AbortSignal);assert.equal(options.signal.aborted,false);
      return Response.json({id:'223456789012345678'});
    });
    assert.deepEqual(await result.json(),{ok:true,code:200});
  }finally{Object.defineProperty(AbortSignal,'timeout',descriptor);}
});
test('実環境で許可されるmanual指定を使い、転送先へ追従しない',async()=>{
  let calls=0;
  const result=await handle(request(),env,async(url,options)=>{
    calls++;assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{Location:'https://untrusted.example/'}});
  });
  assert.equal(calls,1);assert.deepEqual(await result.json(),{ok:false,code:302,apiCode:0});
});
