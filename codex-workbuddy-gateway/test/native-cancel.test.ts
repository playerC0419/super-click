import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import vm from "node:vm";
import { NATIVE_CANCEL_OBSERVATION } from "../src/native-desktop-trigger.js";

function fixture(t: TestContext) {
  const sid="native-cancel-fixture",workspace="C:/native-cancel-fixture",wakeId="wake-run-11111111-1111-4111-8111-111111111111";
  const ports: MessagePort[]=[],requests:string[]=[];
  const session={sessionId:sid,cwd:workspace,status:"working",isProcessing:true,stopRequested:false,hasActiveToolCalls:false,hasActiveTeamMembers:false,eventHistory:[{update:{sessionUpdate:"user_message_chunk",content:[{type:"text",text:`[CODEX_QUEUE_WAKE ${wakeId}] fixture`}]}}]};
  const window={postMessage(_:unknown,__:unknown,transfer:MessagePort[]){
    const port=transfer[0]!;ports.push(port);
    port.onmessage=event=>{
      const m=event.data.json;requests.push(m.channel);
      let result:unknown;
      if(m.channel==="daemon:getActiveSessions")result=session.isProcessing?[{sessionId:sid,cwd:workspace}]:[];
      else if(m.channel==="session:get")result=session;
      else if(m.channel==="session:cancel"){assert.deepEqual(m.args,[sid]);session.stopRequested=true;}
      else throw Error("Unexpected native method "+m.channel);
      port.postMessage({kind:"message",json:{id:m.id,type:"response",result}});
    };port.start();port.postMessage({kind:"open"});
  }};
  t.after(()=>ports.forEach(p=>p.close()));
  const context=vm.createContext({window,MessageChannel,setTimeout,clearTimeout,Date});
  const observe=vm.runInContext(`(${NATIVE_CANCEL_OBSERVATION})`,context) as (sid:string,workspace:string,wakeId:string,send:boolean)=>Promise<{state:string;workspace:string}>;
  return {sid,workspace,wakeId,session,requests,observe};
}

test("native stop sends cancel only for the current queue prompt and awaits real idle state",async t=>{
  const f=fixture(t);
  assert.equal((await f.observe(f.sid,f.workspace,f.wakeId,true)).state,"busy");
  assert.equal(f.requests.filter(x=>x==="session:cancel").length,1);
  f.session.isProcessing=false;f.session.stopRequested=false;f.session.status="completed";
  assert.equal((await f.observe(f.sid,f.workspace,f.wakeId,false)).state,"idle");
  assert.equal(f.requests.filter(x=>x==="session:cancel").length,1);
});

test("native stop refuses another current prompt or mismatched workspace",async t=>{
  const f=fixture(t);
  f.session.eventHistory[0]!.update.content[0]!.text="A newer unrelated user prompt";
  await assert.rejects(f.observe(f.sid,f.workspace,f.wakeId,true),/different current prompt/);
  await assert.rejects(f.observe(f.sid,"C:/another-project",f.wakeId,true),/workspace does not match/);
  assert.equal(f.requests.includes("session:cancel"),false);
});

test("native tool activity or pending stop keeps the cancellation unconfirmed",async t=>{
  const f=fixture(t);
  f.session.isProcessing=false;f.session.status="completed";f.session.hasActiveToolCalls=true;
  assert.equal((await f.observe(f.sid,f.workspace,f.wakeId,false)).state,"busy");
  f.session.hasActiveToolCalls=false;f.session.stopRequested=true;
  assert.equal((await f.observe(f.sid,f.workspace,f.wakeId,false)).state,"busy");
});
