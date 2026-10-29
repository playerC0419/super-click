import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import type { NativeDesktopTrigger } from "./persistent-service.js";
import { hasProcess, sameExecutable, windowsProcessTable } from "./native-process.js";

// The desktop route began on macOS; these branches add the Windows equivalent
// (tasklist/netstat + WM_CLOSE relaunch) without changing the macOS behaviour.
const WINDOWS = process.platform === "win32";

// The renderer forwards requests into the desktop's existing local daemon.
// No UI controls, account tokens, CLI host or model are created by this code.
export const RENDERER_BRIDGE = String.raw`(async function(){
  if(globalThis.__codexNativeQueueBridgeV2?.revision===6&&globalThis.__codexNativeQueueBridgeV2.isOpen?.()) return true;
  globalThis.__codexNativeQueueBridgeV2?.close?.();
  const mc=new MessageChannel(), pending=new Map(), markers=new Map(), outgoing=new Map();
  let sequence=0, openResolve, closed=false;
  const opened=new Promise(resolve=>openResolve=resolve);
  const marker=(sid,id)=>{if(typeof id==='string'&&/^wake-run-[a-f0-9-]{36}$/.test(id)){if(!markers.has(sid))markers.set(sid,new Set());markers.get(sid).add(id);}};
  mc.port1.onmessage=event=>{
    const frame=event.data;
    if(frame.kind==='open'){openResolve();return;}
    if(frame.kind==='close'){closed=true;for(const q of pending.values()){clearTimeout(q.timer);q.reject(Error('Native desktop transport closed'));}pending.clear();return;}
    if(frame.kind!=='message')return;
    let message=frame.json;try{message??=JSON.parse(frame.text);}catch{return;}
    if(message.type==='event'&&typeof message.channel==='string'&&message.channel.startsWith('session:event:')){
      const data=message.result||{},update=data.update||{},sid=data.sessionId||message.channel.slice(14);
      if(update.sessionUpdate==='user_message_chunk'){
        const meta=(data._meta||{})['codebuddy.ai']||{};
        for(const key of ['requestId','userMessageId','messageRequestId'])marker(sid,meta[key]);
        const content=Array.isArray(update.content)?update.content:[update.content];
        for(const item of content){if(item?.type==='text'&&typeof item.text==='string'){const match=item.text.match(/\[CODEX_QUEUE_WAKE (wake-run-[a-f0-9-]{36})\]/);if(match)marker(sid,match[1]);}}
      }
      return;
    }
    const q=pending.get(message.id);if(!q)return;pending.delete(message.id);clearTimeout(q.timer);
    if(message.type==='error')q.reject(Error(typeof message.error?.message==='string'?message.error.message:'Native RPC failed'));
    else q.resolve(message.result);
  };
  mc.port1.start();
  window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[mc.port2]);
  let openTimer;try{await Promise.race([opened,new Promise((_,reject)=>openTimer=setTimeout(()=>reject(Error('Native port open timed out')),10000))]);}finally{clearTimeout(openTimer);}
  const rpc=(channel,args,timeout=15000)=>new Promise((resolve,reject)=>{
    if(closed){reject(Error('Native desktop transport closed'));return;}
    const id='codex-native-'+(++sequence);
    const timer=timeout?setTimeout(()=>{pending.delete(id);reject(Error('Native RPC timed out: '+channel));},timeout):undefined;
    pending.set(id,{resolve,reject,timer});mc.port1.postMessage({kind:'message',json:{id,type:'request',channel,args}});
  });
  const inspect=async sid=>{
    const active=await rpc('daemon:getActiveSessions',[]);
    if(!Array.isArray(active))throw Error('Incompatible native activity response');
    const session=await rpc('session:get',[sid]);
    if(!session||!session.cwd)throw Error('Native worker session was not found');
    const waiting=session.pendingInputKind||(session.pendingPermissions?.length)||(session.pendingQuestions?.length)||(session.pendingElicitations?.length);
    if(waiting)return {state:'waiting_input',workspace:session.cwd,reason:'WorkBuddy requires native permission or input'};
    // WorkBuddy 5.5.6 can derive a running taskState from initialization-only
    // configuration events. Permit only a never-prompted pending session whose
    // direct native view explicitly says no processing; all other activity blocks.
    const initUpdates=new Set(['config_option_update','available_commands_update','current_mode_update']);
    const initializingOnly=session.status==='pending'&&session.isProcessing===false&&Array.isArray(session.eventHistory)&&session.eventHistory.every(e=>initUpdates.has(e?.update?.sessionUpdate));
    const activeBlocks=active.some(s=>((s.sessionId||s.id)===sid||s.cwd===session.cwd)&&!(initializingOnly&&(s.sessionId||s.id)===sid&&s.status==='pending'));
    if(outgoing.has(sid)||activeBlocks||session.isProcessing||session.stopRequested||session.hasActiveTeamMembers||session.hasActiveToolCalls)return {state:'busy',workspace:session.cwd,reason:'Native WorkBuddy session is active'};
    if(!['completed','failed','cancelled','idle','stopped','pending'].includes(String(session.status).toLowerCase()))return {state:'busy',workspace:session.cwd,reason:'Native state is not confirmed idle: '+String(session.status)};
    return {state:'idle',workspace:session.cwd};
  };
  const findWake=async(sid,wakeId)=>{
    if(markers.get(sid)?.has(wakeId))return true;
    const session=await rpc('session:get',[sid]);
    await rpc('session:load',[sid,{cwd:session?.cwd,forceRendererHistoryReplay:true}]);
    return markers.get(sid)?.has(wakeId)===true;
  };
  const listModels=async sid=>{
    const product=await rpc('config:getProductConfiguration',[true],30000);
    if(product?.remoteProductConfigurationStatus==='pending')throw Error('WorkBuddy model configuration is still loading; retry the query');
    if(!Array.isArray(product?.models))throw Error('Incompatible native model list');
    const allowed=Array.isArray(product.availableModels)?new Set(product.availableModels):null;
    const models=product.models.filter(m=>m&&typeof m.id==='string'&&m.id.trim()&&(!allowed?.size||allowed.has(m.id)||allowed.has(m.id.replace(/^custom-local:/,'')))).map(m=>({id:m.id,name:m.name||m.id}));
    const session=sid?await rpc('session:get',[sid]):undefined;
    return {models,currentModel:session?.model||session?.config?.model,...sid?{sessionId:sid}:{}};
  };
  const applyModel=async(sid,model)=>{
    const available=await listModels(sid);
    if(!available.models.some(m=>m.id===model))throw Error('Model is not available in WorkBuddy: '+model);
    if(available.currentModel!==model){
      const result=await rpc('session:updateConfig',[sid,{model}],45000);
      if(result?.error||result?.errorCode||result?.success===false)throw Error('Native model configuration was rejected');
    }
    const session=await rpc('session:get',[sid]);
    const actual=session?.model||session?.config?.model;
    if(actual!==model)throw Error('Native model change was not confirmed; inspect the session before retrying');
    return {sessionId:sid,model:actual};
  };
  const setModel=async(sid,model)=>{
    const state=await inspect(sid);
    if(state.state!=='idle'||outgoing.has(sid))throw Error('Wait for the native WorkBuddy session to finish before changing its model');
    outgoing.set(sid,{configuration:true});
    try{return await applyModel(sid,model);}finally{outgoing.delete(sid);}
  };
  const wakeIdle=async(sid,wakeId,prompt,model)=>{
    if(markers.get(sid)?.has(wakeId))return {accepted:true,receipt:wakeId};
    const state=await inspect(sid);
    if(state.state!=='idle'||outgoing.has(sid))return {accepted:false};
    const operation={wakeId,error:undefined};outgoing.set(sid,operation);
    // A created session is not opened in the renderer yet. Several desktop
    // builds drop session:sendMessage until the conversation is loaded, and the
    // prompt then never reaches the native history. Load it first when needed.
    try{
      const active=await rpc('daemon:getActiveSessions',[]);
      const already=Array.isArray(active)&&active.some(s=>(s&&(s.sessionId||s.id)===sid)||(s&&state.workspace&&s.cwd===state.workspace));
      if(!already){const session=await rpc('session:get',[sid]);await rpc('session:load',[sid,{cwd:state.workspace||session?.cwd,forceRendererHistoryReplay:true}],45000);}
    }catch(error){outgoing.delete(sid);return {accepted:false,error:error.message};}
    // Lock before sending. Native sendMessage has no independent busy rejection.
    try{if(model)await applyModel(sid,model);}catch(error){outgoing.delete(sid);return {accepted:false,error:error.message};}
    const meta={'codebuddy.ai':{requestId:wakeId,userMessageId:wakeId,messageRequestId:wakeId,emitSyntheticUserPromptLive:true}};
    rpc('session:sendMessage',[sid,[{type:'text',text:prompt}],meta],0).then(()=>outgoing.delete(sid),error=>{operation.error=error.message;outgoing.delete(sid);});
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      if(markers.get(sid)?.has(wakeId))return {accepted:true,receipt:wakeId};
      if(operation.error)throw Error(operation.error);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Native submission receipt is uncertain; do not automatically replay');
  };
  // Windows returns the native cwd with backslashes; compare normalized paths
  // instead of raw strings so a real creation is not reported as a mismatch.
  const samePath=(a,b)=>{const n=v=>String(v??'').replace(/\\/g,'/').replace(/\/+$/,'');if(n(a)===n(b))return true;return /^[a-zA-Z]:\//.test(n(a))&&n(a).toLowerCase()===n(b).toLowerCase();};
  const createWorker=async(workspace,sessionId,title)=>{
    const initialized=await rpc('workspace:initialize',[{cwd:workspace}]);
    if(!initialized?.success)throw Error(initialized?.error||'Native workspace initialization failed');
    const created=await rpc('session:create',[{cwd:workspace,sessionId,isPlayground:false}],45000);
    if(created?.sessionId!==sessionId||!samePath(created?.cwd,workspace))throw Error('Native session creation returned a different identity or workspace; do not replay');
    if(title)await rpc('session:rename',[sessionId,title]);
    return {sessionId:created.sessionId,workspace:created.cwd};
  };
  globalThis.__codexNativeQueueBridgeV2={revision:6,inspect,findWake,wakeIdle,createWorker,listModels,setModel,isOpen:()=>!closed,close:()=>{closed=true;for(const q of pending.values()){clearTimeout(q.timer);q.reject(Error('Native desktop transport replaced'));}pending.clear();mc.port1.close();}};
  return true;
})()`;

/** A separate native control port leaves the existing wake receipt channel intact. */
export const NATIVE_CANCEL_OBSERVATION = String.raw`async function(sid,workspace,wakeId,sendStop){
  const mc=new MessageChannel(),pending=new Map();let seq=0,opened;
  const ready=new Promise(resolve=>opened=resolve);
  mc.port1.onmessage=event=>{
    const f=event.data;if(f.kind==='open'){opened();return;}if(f.kind!=='message')return;
    let m=f.json;try{m??=JSON.parse(f.text);}catch{return;}
    const q=pending.get(m.id);if(!q)return;pending.delete(m.id);clearTimeout(q.timer);
    if(m.type==='error')q.reject(Error(m.error?.message||'Native stop RPC failed'));else q.resolve(m.result);
  };mc.port1.start();
  window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[mc.port2]);
  const rpc=(channel,args)=>new Promise((resolve,reject)=>{
    const id='codex-stop-'+(++seq),timer=setTimeout(()=>{pending.delete(id);reject(Error('Native stop observation timed out'));},10000);
    pending.set(id,{resolve,reject,timer});mc.port1.postMessage({kind:'message',json:{id,type:'request',channel,args}});
  });
  const samePath=(a,b)=>{const n=v=>String(v??'').replace(/\\/g,'/').replace(/\/+$/,'');return n(a)===n(b)||(/^[a-zA-Z]:\//.test(n(a))&&n(a).toLowerCase()===n(b).toLowerCase());};
  const observe=async()=>{
    const active=await rpc('daemon:getActiveSessions',[]),session=await rpc('session:get',[sid]);
    if(!Array.isArray(active)||!session||!samePath(session.cwd,workspace))throw Error('Native stop session or workspace does not match the cancelled task');
    const busy=active.some(s=>(s.sessionId||s.id)===sid||samePath(s.cwd,workspace))||session.isProcessing||session.stopRequested||session.hasActiveToolCalls||session.hasActiveTeamMembers||!['completed','cancelled','failed','idle','stopped'].includes(String(session.status).toLowerCase());
    return {session,busy};
  };
  let timer;
  try{
    await Promise.race([ready,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Native stop port is not ready')),10000))]);clearTimeout(timer);
    let current=await observe();
    if(sendStop&&current.busy){
      const history=current.session.eventHistory;if(!Array.isArray(history))throw Error('Cannot verify which native prompt is being stopped');
      const last=history.findLast(e=>e?.update?.sessionUpdate==='user_message_chunk');
      const meta=(last?._meta||{})['codebuddy.ai']||{};
      const content=Array.isArray(last?.update?.content)?last.update.content:[last?.update?.content];
      const matches=['requestId','userMessageId','messageRequestId'].some(k=>meta[k]===wakeId)||content.some(x=>x?.type==='text'&&typeof x.text==='string'&&x.text.includes('[CODEX_QUEUE_WAKE '+wakeId+']'));
      if(!matches)throw Error('The native session has a different current prompt; no stop was sent');
      await rpc('session:cancel',[sid]);current=await observe();
    }
    return {state:current.busy?'busy':'idle',workspace:current.session.cwd,observedAt:new Date().toISOString(),stopRequested:sendStop};
  }finally{clearTimeout(timer);for(const q of pending.values())clearTimeout(q.timer);mc.port1.close();}
}`;

interface CdpResponse { id?: number; error?: {message?: string}; result?: { result?: {value?: unknown}; exceptionDetails?: {text?: string;exception?: {description?: string}} } }

export interface NativeDesktopProcessControl {
  run(file: string, args: string[], timeoutMs: number): string;
  launch(executable: string, cdpPort: number): void;
  pause(milliseconds: number): Promise<void>;
}

const DEFAULT_PROCESS_CONTROL: NativeDesktopProcessControl = {
  run: (file,args,timeoutMs) => execFileSync(file,args,{encoding:"utf8",timeout:timeoutMs,windowsHide:true}),
  launch(executable,cdpPort) {
    const child=spawn(executable,[],{detached:true,stdio:"ignore",windowsHide:true,env:{...process.env,WORKBUDDY_REMOTE_DEBUGGING_PORT:String(cdpPort)}});
    child.on("error",()=>undefined);child.unref();
  },
  pause: milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds)),
};

function noProcessMatch(error: unknown): boolean {
  const failure=error as {status?:number;stdout?:unknown};
  return failure?.status===1&&String(failure.stdout??"").trim()==="";
}

export class NativeDesktopRpcTrigger implements NativeDesktopTrigger {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private connection?: Promise<void>;
  private ready = false;
  private connectMutex?:Promise<void>;
  private generation = 0;
  constructor(private readonly config: Config, readonly cdpPort: number, private readonly autoLaunch = true, private readonly processControl: NativeDesktopProcessControl = DEFAULT_PROCESS_CONTROL, private readonly signal?: AbortSignal) {
    if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) throw new Error("Invalid native desktop CDP port");
  }

  private portState(): "absent" | "native" | "foreign" | "unavailable" {
    if (WINDOWS) return this.portStateWindows();
    let output:string;
    try {
      output = this.processControl.run("/usr/sbin/lsof", ["-nP", `-iTCP:${this.cdpPort}`, "-sTCP:LISTEN", "-Fp"], 3000);
    } catch(error) { return noProcessMatch(error)?"absent":"unavailable"; }
    const pids = [...output.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1]));
    if(pids.length===0)return output.trim()===""?"absent":"unavailable";
    try {
      return pids.length === 1 && this.processControl.run("/bin/ps", ["-p", String(pids[0]), "-o", "comm="], 3000).trim() === path.resolve(this.config.cliElectronPath) ? "native" : "foreign";
    } catch {return "unavailable";}
  }

  /** Windows port ownership is proven by the process that listens on it. */
  private portStateWindows(): "absent" | "native" | "foreign" | "unavailable" {
    let output: string;
    try { output = this.processControl.run("netstat", ["-ano", "-p", "tcp"], 10_000); }
    catch { return "unavailable"; }
    const pids: number[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (match && Number(match[1]) === this.cdpPort && Number(match[2]) > 0) pids.push(Number(match[2]));
    }
    if (pids.length === 0) return "absent";
    try {
      const table = windowsProcessTable();
      return pids.length === 1 && table.some((row) => row.pid === pids[0] && sameExecutable(row.exe, this.config.cliElectronPath)) ? "native" : "foreign";
    } catch { return "unavailable"; }
  }

  private ownerIsNative(): boolean {
    return this.portState()==="native";
  }

  private nativePids(): number[] {
    if (WINDOWS) return this.nativePidsWindows();
    const executable=path.resolve(this.config.cliElectronPath);
    const output = this.processControl.run("/bin/ps", ["-axo", "pid=,command="], 3000);
    return output.split("\n").flatMap(line => {const match=line.trim().match(/^(\d+)\s+(.+)$/);const command=match?.[2]??"";return match && (command===executable||command.startsWith(executable+" --"))&&!/--type=|--stdio|cli\/bin|sidecar-entry|daemon-app-server/.test(command) ? [Number(match[1])] : [];});
  }

  /** Root WorkBuddy processes: the executable matches and it is not a helper child. */
  private nativePidsWindows(): number[] {
    const executable = this.config.cliElectronPath;
    const table = windowsProcessTable();
    const byPid = new Map(table.map(row => [row.pid, row]));
    return table
      .filter((row) => sameExecutable(row.exe, executable) && !sameExecutable(byPid.get(row.ppid)?.exe, executable) && !/--type=|--stdio|sidecar-entry|daemon-app-server|cli[\\/]bin/i.test(row.commandLine ?? ""))
      .map((row) => row.pid);
  }

  private rootPidExists(pid:number): boolean {
    if (WINDOWS) return hasProcess(pid);
    try {return this.processControl.run("/bin/ps",["-p",String(pid),"-o","pid="],3000).trim()===String(pid);}
    catch(error){if(noProcessMatch(error))return false;throw error;}
  }

  /**
   * Close the native app the way the ordinary quit command does, then wait for
   * it to disappear so the startup switch can be applied by a fresh launch.
   */
  private async quitNativeWindows(pid: number): Promise<boolean> {
    try { this.processControl.run("taskkill", ["/PID", String(pid)], 10_000); } catch { /* already gone */ }
    for (let retry = 0; retry < 40 && hasProcess(pid); retry++) await this.processControl.pause(250);
    if (!hasProcess(pid)) return true;
    // Preserve the native session if ordinary close was ignored; do not force-kill it.
    return false;
  }

  private canEnablePortWithoutInterruptingWork(): boolean {
    let db:DatabaseSync|undefined;
    try {
      // Initial setup can be sent from a desktop without debugging enabled.
      // Wait for its configuration turn (and every other native task) to finish
      // before the one-time graceful restart needed for the startup setting.
      db=new DatabaseSync(path.join(this.config.workbuddyConfigDir,"workbuddy.db"),{readOnly:true});
      const rows=db.prepare("SELECT status FROM sessions WHERE deleted_at IS NULL").all();
      return rows.every(row=>['completed','failed','cancelled','idle','stopped','archived','terminated','error'].includes(String(row.status).trim().toLowerCase()));
    } catch {return false;} finally {db?.close();}
  }

  private async discover(): Promise<string> {
    this.signal?.throwIfAborted();
    if (WINDOWS) return this.discoverWindows();
    const portState=this.portState();
    if(portState==="foreign"||portState==="unavailable")throw new Error("Registered local port is occupied by another process or its owner cannot be verified; WorkBuddy was left running");
    if (portState!=="native") {
      if (!this.autoLaunch) throw new Error("Native desktop is offline");
      const running=this.nativePids();
      if (running.length) {
        if(running.length!==1||!this.canEnablePortWithoutInterruptingWork())throw new Error("Waiting for native WorkBuddy tasks to finish before enabling its persistent local port");
        const rootPid=running[0]!;
        const current=this.nativePids();
        if(current.length!==1||current[0]!==rootPid||this.portState()!=="absent")throw new Error("Native WorkBuddy changed during setup; no restart was requested");
        // WorkBuddy's SIGTERM handler calls process.exit directly. The native
        // application quit event runs its ordinary before-quit teardown instead.
        this.processControl.run("/usr/bin/osascript",["-e",'tell application id "com.tencent.workbuddy.mac" to quit'],15000);
        for(let retry=0;retry<40&&this.rootPidExists(rootPid);retry++)await this.processControl.pause(250);
        if(this.rootPidExists(rootPid))throw new Error("Native WorkBuddy did not finish its graceful setup restart");
        if(this.nativePids().length)throw new Error("Another WorkBuddy root appeared during setup; no replacement was launched");
      }
      if(this.portState()!=="absent")throw new Error("Registered local port changed during setup; no replacement was launched");
      if (!fs.statSync(this.config.cliElectronPath).isFile()) throw new Error("WorkBuddy desktop executable is missing");
      this.processControl.launch(this.config.cliElectronPath,this.cdpPort);
      for (let retry=0;retry<60&&!this.ownerIsNative();retry++) await this.processControl.pause(250);
      if (!this.ownerIsNative()) throw new Error("Native WorkBuddy local RPC port did not become available");
    }
    const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, {signal:AbortSignal.timeout(4000)});
    const targets = await response.json() as Array<{type?:string;url?:string;webSocketDebuggerUrl?:string}>;
    const executableRoot = path.resolve(this.config.cliElectronPath,"../../Resources/app.asar");
    const target = targets.find(item => item.type === "page" && item.url?.startsWith(`file://${executableRoot}/`) && !item.url.includes("splash") && item.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("WorkBuddy main renderer is not ready");
    const url = new URL(target.webSocketDebuggerUrl);
    if (!['127.0.0.1','localhost'].includes(url.hostname) || Number(url.port) !== this.cdpPort || url.protocol !== 'ws:') throw new Error("Native debugger target is not the registered loopback endpoint");
    return target.webSocketDebuggerUrl;
  }

  private async discoverWindows(): Promise<string> {
    this.signal?.throwIfAborted();
    const portState = this.portStateWindows();
    if (portState === "foreign" || portState === "unavailable") throw new Error("Registered local port is occupied by another process or its owner cannot be verified; WorkBuddy was left running");
    if (portState !== "native") {
      if (!this.autoLaunch) throw new Error("Native desktop is offline");
      const running = this.nativePidsWindows();
      if (running.length) {
        if (running.length !== 1 || !this.canEnablePortWithoutInterruptingWork()) throw new Error("Waiting for native WorkBuddy tasks to finish before enabling its persistent local port");
        const rootPid = running[0]!;
        if (this.nativePidsWindows().length !== 1 || this.nativePidsWindows()[0] !== rootPid || this.portStateWindows() !== "absent") throw new Error("Native WorkBuddy changed during setup; no restart was requested");
        if (!await this.quitNativeWindows(rootPid)) throw new Error("Native WorkBuddy did not finish its graceful setup restart");
        if (this.nativePidsWindows().length) throw new Error("Another WorkBuddy root appeared during setup; no replacement was launched");
      }
      if (this.portStateWindows() !== "absent") throw new Error("Registered local port changed during setup; no replacement was launched");
      if (!fs.statSync(this.config.cliElectronPath).isFile()) throw new Error("WorkBuddy desktop executable is missing");
      this.signal?.throwIfAborted();
      this.processControl.launch(this.config.cliElectronPath, this.cdpPort);
      for (let retry = 0; retry < 60 && !this.ownerIsNative(); retry++) { this.signal?.throwIfAborted(); await this.processControl.pause(250); }
      if (!this.ownerIsNative()) throw new Error("Native WorkBuddy local RPC port did not become available");
    }
    // Windows reports the renderer as file:///D:/<app>/resources/app.asar/renderer/index.html.
    const appAsar = path.join(path.dirname(path.resolve(this.config.cliElectronPath)), "resources", "app.asar").replaceAll("\\", "/").toLowerCase();
    // The debugger starts before the main window during a cold launch. Waiting
    // here only discovers a connection; no task or user prompt has been sent.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      this.signal?.throwIfAborted();
      let targets: Array<{type?:string;url?:string;webSocketDebuggerUrl?:string}> = [];
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(4000, deadline - Date.now())));
        const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, { signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout });
        if (response.ok) {
          const value: unknown = await response.json();
          if (Array.isArray(value)) targets = value;
        }
      } catch { /* The local debugger can briefly reset while the app initializes. */ }
      this.signal?.throwIfAborted();
      const target = targets.find((item) => item?.type === "page" && typeof item.url === "string" && item.webSocketDebuggerUrl && item.url.toLowerCase().includes(appAsar) && !item.url.toLowerCase().includes("splash"));
      if (target?.webSocketDebuggerUrl) {
        const url = new URL(target.webSocketDebuggerUrl);
        if (!['127.0.0.1','localhost'].includes(url.hostname) || Number(url.port) !== this.cdpPort || url.protocol !== 'ws:') throw new Error("Native debugger target is not the registered loopback endpoint");
        if (!this.ownerIsNative()) throw new Error("Registered local port changed while waiting for the WorkBuddy main renderer; no task was sent");
        return target.webSocketDebuggerUrl;
      }
      if (Date.now() < deadline) await this.processControl.pause(Math.min(500, deadline - Date.now()));
    }
    throw new Error("WorkBuddy main renderer is not ready after 45 seconds; no task was sent");
  }

  private connect(): Promise<void> {
    if(this.connectMutex)return this.connectMutex;
    const operation=this.connectOnce();this.connectMutex=operation;
    void operation.finally(()=>{if(this.connectMutex===operation)this.connectMutex=undefined;}).catch(()=>{});
    return operation;
  }
  private async connectOnce(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.connection) return this.connection;
    if (this.socket?.readyState === WebSocket.OPEN&&this.ready) {
      try{if(await this.evaluateConnected('globalThis.__codexNativeQueueBridgeV2?.isOpen?.()===true',3000))return;}catch{}
      this.close();
    }
    if (this.connection) return this.connection;
    const generation=this.generation;
    const connecting = (async () => {
      const endpoint=await this.discover();this.signal?.throwIfAborted();if(generation!==this.generation)throw new Error('Native connection was closed during discovery');
      const socket = new WebSocket(endpoint); this.socket = socket;this.ready=false;
      socket.addEventListener("message", event => {
        let frame:CdpResponse;try{frame=JSON.parse(String(event.data)) as CdpResponse;}catch{return;}
        if (!frame.id) return;
        const request=this.pending.get(frame.id);if(!request)return;this.pending.delete(frame.id);clearTimeout(request.timer);
        const exception=frame.result?.exceptionDetails;
        if(frame.error||exception)request.reject(new Error(frame.error?.message??exception?.exception?.description??exception?.text??"Native RPC evaluation failed"));
        else request.resolve(frame.result?.result?.value);
      });
      socket.addEventListener("close", () => {if(this.socket!==socket)return;this.socket=undefined;this.ready=false;for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error("Native desktop disconnected; submission outcome may be uncertain"));}this.pending.clear();});
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Native CDP connection timed out")),5000);socket.addEventListener("open",()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener("error",()=>{clearTimeout(timer);reject(new Error("Native CDP connection failed"));},{once:true});});
      await this.evaluateConnected(RENDERER_BRIDGE);
      this.ready=true;
    })();
    this.connection=connecting;
    try { await connecting; } catch(error){this.close();throw error;} finally { if(this.connection===connecting)this.connection=undefined; }
  }

  private evaluateConnected(expression: string, timeoutMs = 22000): Promise<unknown> {
    const socket=this.socket;if(socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error("Native desktop socket is closed"));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("Native evaluation timed out; never replay an uncertain submission"));},timeoutMs);this.pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:"Runtime.evaluate",params:{expression,awaitPromise:true,returnByValue:true}}));});
  }

  private async call(method: "inspect"|"findWake"|"wakeIdle"|"listModels"|"setModel", args: Array<string|undefined>): Promise<unknown> {
    await this.connect();
    return this.evaluateConnected(`globalThis.__codexNativeQueueBridgeV2.${method}(...${JSON.stringify(args)})`,90000);
  }
  async listModels(sessionId?: string): Promise<{models:Array<{id:string;name:string}>;currentModel?:string;sessionId?:string}> {
    return await this.call("listModels",[sessionId]) as Awaited<ReturnType<NativeDesktopRpcTrigger["listModels"]>>;
  }
  async setModel(sessionId: string, model: string): Promise<{sessionId:string;model:string}> {
    return await this.call("setModel",[sessionId,model]) as {sessionId:string;model:string};
  }
  async createWorker(workspace: string, sessionId: string, title?: string): Promise<{sessionId: string; workspace: string}> {
    if(!path.isAbsolute(workspace)||!fs.statSync(workspace).isDirectory())throw new Error("workspace must be an existing absolute directory");
    if(!/^[a-f0-9-]{36}$/.test(sessionId))throw new Error("A reserved native session UUID is required");
    await this.connect();
    this.signal?.throwIfAborted();
    return await this.evaluateConnected(`globalThis.__codexNativeQueueBridgeV2.createWorker(...${JSON.stringify([workspace,sessionId,title])})`,55000) as {sessionId:string;workspace:string};
  }
  async inspect(sessionId: string): ReturnType<NativeDesktopTrigger["inspect"]> {
    try { return await this.call("inspect",[sessionId]) as Awaited<ReturnType<NativeDesktopTrigger["inspect"]>>; }
    catch(error){return {state:"offline",reason:error instanceof Error?error.message:String(error)};}
  }
  async findWake(sessionId: string, wakeId: string): Promise<boolean> {return await this.call("findWake",[sessionId,wakeId])===true;}
  async wakeIdle(sessionId: string, wakeId: string, prompt: string, model?: string): ReturnType<NativeDesktopTrigger["wakeIdle"]> {
    if(!/^wake-run-[a-f0-9-]{36}$/.test(wakeId)||!prompt.startsWith(`[CODEX_QUEUE_WAKE ${wakeId}]`))throw new Error("Wake identity must match its queue marker");
    return await this.call("wakeIdle",[sessionId,wakeId,prompt,model]) as Awaited<ReturnType<NativeDesktopTrigger["wakeIdle"]>>;
  }
  async cancelSession(sessionId: string, workspace: string, wakeId: string, sendStop: boolean): Promise<{state:"idle"|"busy";workspace:string;observedAt:string;stopRequested:boolean}> {
    if (!/^wake-run-[a-f0-9-]{36}$/.test(wakeId) || !path.isAbsolute(workspace)) throw new Error("Native stop requires the original wake identity and workspace");
    await this.connect();
    return await this.evaluateConnected(`(${NATIVE_CANCEL_OBSERVATION})(...${JSON.stringify([sessionId,workspace,wakeId,sendStop])})`,45000) as Awaited<ReturnType<NativeDesktopRpcTrigger["cancelSession"]>>;
  }
  async probe():Promise<{state:string;message:string;checkedAt:string}>{
    const checkedAt=new Date().toISOString();
    if(!fs.existsSync(this.config.cliElectronPath))return {state:'offline',message:'未找到 WorkBuddy 程序',checkedAt};
    const state=this.portState();if(state!=='native')return {state:state==='absent'?'offline':state,message:state==='absent'?'WorkBuddy 尚未启动或未启用本机接口':'本机连接端口无法确认归属，请检查连接设置',checkedAt};
    try{const response=await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`,{signal:AbortSignal.timeout(2000)});const targets:unknown=await response.json();
      const root=WINDOWS?path.join(path.dirname(path.resolve(this.config.cliElectronPath)),'resources','app.asar').replaceAll('\\','/').toLowerCase():path.resolve(this.config.cliElectronPath,'../../Resources/app.asar').toLowerCase();
      const found=Array.isArray(targets)&&targets.some(t=>{try{const url=new URL(t.url);return t.type==='page'&&decodeURIComponent(url.pathname).toLowerCase().includes(root)&&!url.pathname.toLowerCase().includes('splash');}catch{return false;}});
      return {state:found?'ready':'starting',message:found?'WorkBuddy 主窗口可连接；登录和模型额度以实际调用为准':'WorkBuddy 正在加载主窗口',checkedAt};
    }catch{return {state:'unavailable',message:'WorkBuddy 本机接口暂未响应',checkedAt};}
  }
  close(): void { const socket=this.socket;this.socket=undefined;this.ready=false;this.generation++;socket?.close();for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('Native connection closed'));}this.pending.clear(); }
}

export function createNativeDesktopTrigger(config: Config, options: {cdpPort:number}): NativeDesktopRpcTrigger {
  return new NativeDesktopRpcTrigger(config,options.cdpPort);
}
