import { loadDotEnv } from '../dist/env.js';
import { loadConfig } from '../dist/config.js';
import { NativeDesktopRpcTrigger } from '../dist/native-desktop-trigger.js';
import { RunJournal, runsDirectory } from '../dist/run-journal.js';
loadDotEnv();
const sid = process.argv[2];
const config = loadConfig();
if (process.argv[3] === 'cancel') {
  const journal = new RunJournal(runsDirectory(config), process.argv[4]);
  if (!journal.cancellationRequested() || journal.snapshot()?.sessionId !== sid || journal.request()?.sessionId !== sid) throw Error('Only the original session of an already cancelled queue attempt may be stopped');
}
const trigger = new NativeDesktopRpcTrigger(config, 18491, false);
const expression = `(async()=>{
  const mc = new MessageChannel(), pending = new Map(); let seq=0;
  let opened; const ready = new Promise(r=>opened=r);
  mc.port1.onmessage = event => {
    const f=event.data; if(f.kind==='open'){opened();return;} if(f.kind!=='message')return;
    const m=f.json??JSON.parse(f.text); const p=pending.get(m.id); if(!p)return;
    pending.delete(m.id);clearTimeout(p.timer);if(m.type==='error')p.reject(Error(m.error?.message));else p.resolve(m.result);
  }; mc.port1.start();
  window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[mc.port2]);
  const rpc=(channel,args)=>new Promise((resolve,reject)=>{const id='diag-'+(++seq);const timer=setTimeout(()=>reject(Error('timeout '+channel)),10000);pending.set(id,{resolve,reject,timer});mc.port1.postMessage({kind:'message',json:{id,type:'request',channel,args}});});
  await ready;
  try {
    ${process.argv[3] === 'load' ? `const before=await rpc('session:get',[${JSON.stringify(sid)}]);await rpc('session:load',[${JSON.stringify(sid)},{cwd:before.cwd,forceRendererHistoryReplay:true}]);` : ''}
    ${process.argv[3] === 'cancel' ? `await rpc('session:cancel',[${JSON.stringify(sid)}]);` : ''}
    const active=await rpc('daemon:getActiveSessions',[]);
    const s=await rpc('session:get',[${JSON.stringify(sid)}]);
    return {active:active?.map(a=>({sessionId:a.sessionId??a.id,cwd:a.cwd,status:a.status,isProcessing:a.isProcessing})),eventCount:s?.eventHistory?.length,eventTypes:s?.eventHistory?.slice(-12).map(e=>({type:e.type,update:e.update?.sessionUpdate})),sessionKeys:Object.keys(s??{}),session:Object.fromEntries(['id','sessionId','cwd','status','isProcessing','stopRequested','hasActiveTeamMembers','hasActiveToolCalls','pendingInputKind','model'].filter(k=>s?.[k]!==undefined).map(k=>[k,s[k]]))};
  } finally {mc.port1.close();}
})()`;
try { await trigger.connect(); console.log(JSON.stringify(await trigger.evaluateConnected(expression), null, 2)); }
finally { trigger.close(); }
