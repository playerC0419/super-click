import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { HubStore } from "./store.js";
import { HubError, requestSchema, type AgentProvider, type Artifact, type HubRun, type ProviderSnapshot } from "./contracts.js";
import { attachToWorkspace, loadAttachments, snapshotArtifacts, versionArtifact, digest } from './files.js';

const envelope = z.object({ text: z.string().trim().min(1), json: z.unknown().optional(), artifacts: z.array(z.string()).max(100) }).strict();
export function inside(root: string, file: string) { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
export function artifactFor(run: HubRun, file: string): Artifact {
  if (!path.isAbsolute(file)) throw new Error("Artifact paths must be absolute");
  const actual = fs.realpathSync(file);
  // The roots were canonicalized at reservation. Re-resolving a replaced root
  // could accidentally authorize a symlink into unrelated local files.
  const roots = [run.workspace, path.dirname(run.resultFile)];
  if (!roots.some(root => inside(root, actual))) throw new Error("Artifact escapes the authorized task directories");
  const stat = fs.statSync(actual);
  if (!stat.isFile()) throw new Error("Artifact is not a regular file");
  return { path: actual, name: path.basename(actual), bytes: stat.size };
}
export function readResult(run: HubRun): NonNullable<HubRun["result"]> {
  const actual = fs.realpathSync(run.resultFile);
  if (!inside(path.dirname(run.resultFile), actual)) throw new Error("Result file escapes its allocated directory");
  const stat = fs.statSync(actual);
  if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Result must be a regular UTF-8 JSON file no larger than 1 MiB");
  const parsed = envelope.parse(JSON.parse(fs.readFileSync(actual, "utf8")));
  if (run.input.output === "json" && !Object.hasOwn(parsed, "json")) throw new Error("Requested JSON result is missing");
  const artifacts = [...new Set(parsed.artifacts)].map(file => artifactFor(run, file));
  if (run.input.output === "artifacts" && !artifacts.length) throw new Error("Requested artifact result is empty");
  return { text: parsed.text, ...(Object.hasOwn(parsed, "json") ? { json: parsed.json } : {}), artifacts };
}
function fingerprint(input: ReturnType<typeof requestSchema.parse>) { return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"); }

export class HubEngine {
  readonly providers: Map<string, AgentProvider>;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly dispatches = new Map<string, AbortController>();
  private readonly cancelling = new Map<string, Promise<void>>();
  private readonly cancelDelivered = new Set<string>();
  private closed = false;
  private lastTickAt = new Date().toISOString();
  private tickStartedAt?:string;
  maintenanceActive = false;
  constructor(readonly store: HubStore, providers: AgentProvider[], readonly directory: string, readonly maxConcurrent = 1) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = fs.realpathSync(directory);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) throw new Error("maxConcurrent must be 1..16");
    this.providers = new Map(providers.map(provider => [provider.id, provider]));
    if (this.providers.size !== providers.length) throw new Error("Duplicate provider id");
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn); this.serial = next.catch(() => {}); return next;
  }
  /** Stop local continuations before the provider and store are closed. */
  close() {
    this.closed = true;
    for (const controller of this.dispatches.values()) controller.abort();
  }
  get(id: string) { const run = this.store.get(id); if (!run) throw new HubError("NOT_FOUND", "Unknown run", 404); return run; }
  provider(id: string) { const provider = this.providers.get(id); if (!provider) throw new HubError("PROVIDER_UNAVAILABLE", `Provider ${id} is not implemented`, 400); return provider; }
  async describeProviders() { return Promise.all([...this.providers.values()].map(async provider => ({ id: provider.id, label: provider.label, capabilities: provider.capabilities, ...await provider.health() }))); }
  queueState(){return {...this.store.settings('queue',{paused:false}),lastTickAt:this.lastTickAt,tickStartedAt:this.tickStartedAt,active:this.store.all().filter(r=>r.holdsCapacity).map(r=>({id:r.id,status:r.status})),maintenance:this.maintenanceActive};}
  setQueue(paused:boolean){const old=this.store.settings<{paused:boolean;pausedAt?:string}>('queue',{paused:false});if(old.paused&&!paused&&old.pausedAt){const start=Date.parse(old.pausedAt),now=Date.now();for(const run of this.store.all().filter(r=>r.status==='queued'))this.store.save({...run,deadline:new Date(Date.parse(run.deadline)+Math.max(0,now-Math.max(start,Date.parse(run.createdAt)))).toISOString()});}const state={paused,...(paused?{pausedAt:old.pausedAt??new Date().toISOString()}:{} )};this.store.setSetting('queue',state);return this.queueState();}
  submit(raw: unknown) {
    if(this.maintenanceActive)throw new HubError('MAINTENANCE','正在备份维护，请稍后提交',503);
    const input = requestSchema.parse(raw); this.provider(input.provider);
    if (input.workspace) {
      if (!path.isAbsolute(input.workspace) || !fs.statSync(input.workspace).isDirectory()) throw new HubError("INVALID_WORKSPACE", "workspace must be an existing absolute directory");
      input.workspace = fs.realpathSync(input.workspace);
    }
    const hash = fingerprint(input);
    const existing = input.idempotencyKey ? this.store.byKey(input.idempotencyKey, hash) : undefined;
    if (existing) return { run: existing, created: false };
    if (this.store.all().filter(run => run.status === "queued").length >= 100) throw new HubError("QUEUE_FULL", "Platform queue has 100 pending runs", 429);
    const id = `hub-${crypto.randomUUID()}`;
    const workspace = input.workspace ?? path.join(this.directory, "workspaces", id);
    if (!input.workspace) fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const resultFile = this.resultFile(id, 1);
    const now = new Date().toISOString();
    const run:HubRun={ id, input, workspace, providerTaskId: id, status: "queued", review: "pending", holdsCapacity: false, round: 1, resultFile, usage: { credits: null, source: "unavailable" }, createdAt: now, updatedAt: now, deadline: new Date(Date.now() + input.timeoutSeconds * 1000).toISOString(),priority:input.priority??0,checks:input.acceptanceCriteria?.map((label,index)=>({id:`check-${index+1}`,label,status:'pending',evidence:'',round:1})) };
    if(input.attachmentIds?.length)run.attachments=attachToWorkspace(run,loadAttachments(this.directory,input.attachmentIds));
    return this.store.create(run, hash);
  }
  private resultFile(id: string, round: number) {
    const file = path.join(this.directory, "results", id, `round-${round}`, "output.json");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); return file;
  }
  private requestProviderCancel(run: HubRun) {
    const key = `${run.id}:${run.round}`;
    if (this.closed || this.cancelling.has(key) || this.cancelDelivered.has(key)) return;
    // The cancellation intent is already durable. Native stop and confirmation
    // run separately so the control request never waits for either operation.
    const operation = Promise.resolve().then(async () => {
      if (this.closed) return;
      const current = this.get(run.id);
      if (current.round !== run.round || current.status !== "cancel_requested") return;
      try {
        await this.provider(current.input.provider).cancel(current);
        if (this.closed) return;
        this.cancelDelivered.add(key);
        const latest = this.get(run.id);
        if (latest.round === run.round && latest.status === "cancel_requested") await this.synchronize(latest);
      } catch (error) {
        if (this.closed) return;
        const latest = this.get(run.id);
        if (latest.round === run.round && latest.status === "cancel_requested") this.store.save({ ...latest, lastPollError: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => { this.cancelling.delete(key); });
    this.cancelling.set(key, operation);
  }
  private async synchronize(run: HubRun) {
    if (this.closed) return;
    run = this.get(run.id);
    if (["completed", "failed", "cancelled"].includes(run.status) && !run.holdsCapacity) return;
    const provider = this.provider(run.input.provider);
    try {
      if (run.status === "cancel_requested") this.requestProviderCancel(run);
      const snapshot = await provider.poll(run);
      if (this.closed) return;
      const latest = this.get(run.id);
      if (latest.round !== run.round || (latest.status === "cancelled" && !latest.holdsCapacity)) return;
      if (!snapshot || (["dispatching", "cancel_requested"].includes(run.status) && run.round > 1 && snapshot.attemptId === run.previousAttemptId)) {
        this.store.save({ ...latest, status: latest.status === "cancel_requested" ? "cancel_requested" : "uncertain", holdsCapacity: true, error: { code: "DISPATCH_UNCERTAIN", message: "A current provider attempt could not be confirmed. Inspect it before any resubmission." } });
        return;
      }
      this.applySnapshot(latest, snapshot);
    } catch (error) {
      if (this.closed) return;
      const latest = this.get(run.id);
      if (latest.round === run.round && !(latest.status === "cancelled" && !latest.holdsCapacity)) this.store.save({ ...latest, lastPollError: error instanceof Error ? error.message : String(error) });
    }
  }
  private applySnapshot(run: HubRun, snapshot: ProviderSnapshot) {
    if (this.closed) return;
    const latest = this.get(run.id);
    if (latest.round !== run.round || (latest.status === "cancelled" && !latest.holdsCapacity)) return;
    run = latest;
    for (const event of snapshot.events) this.store.event(run.id, event.type, { text: event.text }, event.key);
    const next: HubRun = { ...run, status: snapshot.status === "queued" ? "submitted" : snapshot.status, holdsCapacity: snapshot.holdsCapacity, attemptId: snapshot.attemptId, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, lastPollError: undefined, error: snapshot.error ? { code: "PROVIDER_BLOCKED", message: snapshot.error } : undefined,waitingInput:snapshot.waitingInput,progressSummary:snapshot.progressSummary??run.progressSummary,lastActivityAt:snapshot.lastActivityAt??run.lastActivityAt };
    if(snapshot.status==='running'&&!next.startedAt)next.startedAt=new Date().toISOString();
    if(snapshot.status==='running' && snapshot.attemptId && snapshot.attemptId!==run.previousAttemptId) next.messages=run.messages?.map(message=>message.targetRound===run.round&&message.delivery==='queued'?{...message,attemptId:snapshot.attemptId,delivery:'delivered',deliveredAt:new Date().toISOString()}:message);
      if(snapshot.deliveredMessages?.length)next.messages=(next.messages??run.messages)?.map(message=>{const receipt=snapshot.deliveredMessages!.find(r=>r.id===message.id);return receipt?{...message,delivery:'delivered',deliveredAt:receipt.deliveredAt}:message;});
    if (run.status === "cancel_requested") {
      next.status = snapshot.holdsCapacity ? "cancel_requested" : "cancelled";
      next.result = undefined;
    } else if (snapshot.status === "completed") {
      try { const result=readResult(run);next.result={...result,artifacts:snapshotArtifacts(run,result.artifacts)}; }
      catch (error) { next.status = "failed"; next.error = { code: "INVALID_OUTPUT", message: error instanceof Error ? error.message : String(error) }; }
    }
    if (snapshot.accepted) next.review = "accepted";
    if(!next.holdsCapacity&&['completed','failed','cancelled','blocked'].includes(next.status))next.finishedAt??=new Date().toISOString();
    this.store.save(next);
  }
  /** One serialized scheduler; start-up never replays dispatching records. */
  tick() { return this.exclusive(async () => {
    if (this.closed) return;
    this.tickStartedAt=new Date().toISOString();this.lastTickAt=this.tickStartedAt;
    for (const run of this.store.all()) {
      if (run.status !== "queued" && (run.holdsCapacity || ["dispatching", "submitted", "running", "cancel_requested", "uncertain"].includes(run.status))) await this.synchronize(run);
      if (this.closed) return;
    }
    this.lastTickAt=new Date().toISOString();
    if(this.queueState().paused||this.maintenanceActive){this.tickStartedAt=undefined;return;}
    for (const queued of this.store.all().filter(run => run.status === "queued"&&!run.archived).sort((a,b)=>(b.priority??0)-(a.priority??0)||a.createdAt.localeCompare(b.createdAt))) {
      if(this.queueState().paused||this.maintenanceActive)break;
      const candidate = this.get(queued.id);
      if (candidate.status !== "queued") continue;
      if (Date.parse(candidate.deadline) <= Date.now()) { this.store.save({ ...candidate, status: "failed", error: { code: "QUEUE_TIMEOUT", message: "Deadline expired before dispatch; no provider task was submitted" } }); continue; }
      const occupied = this.store.all().filter(run => run.holdsCapacity);
      if (occupied.length >= this.maxConcurrent || occupied.some(run => run.workspace === candidate.workspace)) continue;
      const run = this.store.save({ ...candidate, status: "dispatching", holdsCapacity: true });
      const controller = new AbortController();
      this.dispatches.set(run.id, controller);
      try {
        if (run.round > 1) await this.provider(run.input.provider).rework(run, controller.signal);
        else await this.provider(run.input.provider).submit(run, controller.signal);
        if (this.closed) return;
        await this.synchronize(this.get(run.id));
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        const latest = this.get(run.id);
        if (latest.round !== run.round || (latest.status === "cancelled" && !latest.holdsCapacity)) continue;
        if (error instanceof HubError && error.code === "DISPATCH_NOT_SENT") {
          const cancelled = latest.status === "cancel_requested";
          this.store.save({ ...latest, status: cancelled ? "cancelled" : "failed", holdsCapacity: false, result: undefined, lastPollError: undefined, error: cancelled ? undefined : { code: error.code, message } });
          continue;
        }
        this.store.save({ ...latest, status: latest.status === "cancel_requested" ? "cancel_requested" : "dispatching", lastPollError: message });
        await this.synchronize(this.get(run.id));
      } finally {
        if (this.dispatches.get(run.id) === controller) this.dispatches.delete(run.id);
      }
      if (this.closed) return;
      this.lastTickAt=new Date().toISOString();
    }
    this.tickStartedAt=undefined;
  }); }
  async cancel(id: string) {
    const run = this.get(id);
    if (["completed", "failed", "cancelled"].includes(run.status) && !run.holdsCapacity) return run;
    const next = this.store.save({ ...run, status: run.status === "queued" ? "cancelled" : "cancel_requested", holdsCapacity: run.status === "queued" ? false : run.holdsCapacity });
    if (next.status === "cancel_requested") {
      this.dispatches.get(id)?.abort();
      this.requestProviderCancel(next);
    }
    return next;
  }
  rework(id: string, feedback: string, model?:string, expectedRound?:number) { return this.exclusive(async () => {
    const run = this.get(id);
    if(expectedRound!==undefined&&run.round!==expectedRound)throw new HubError("ROUND_CHANGED","任务已经更新，请查看最新进展后再提交返工。",409);
    if (!feedback.trim()) throw new HubError("INVALID_FEEDBACK", "Feedback is required");
    if (!run.attemptId || run.holdsCapacity || !["completed", "failed", "blocked"].includes(run.status)) throw new HubError("RUN_ACTIVE", "Only a confirmed finished provider attempt may be reworked", 409);
    if(model!==undefined&&!model.trim())throw new HubError('INVALID_MODEL','model must be a nonempty native ID');
    return this.store.save({ ...run, input:model===undefined?run.input:{...run.input,model:model.trim()}, status: "queued", review: "pending", holdsCapacity: false, round: run.round + 1, previousAttemptId: run.attemptId, feedback, resultFile: this.resultFile(id, run.round + 1), result: undefined, error: undefined, waitingInput:undefined,progressSummary:undefined,lastActivityAt:undefined,startedAt:undefined,finishedAt:undefined,checks:run.checks?.map(check=>({...check,status:'pending',evidence:'',round:run.round+1})),history:[...(run.history??[]),{round:run.round,resultFile:run.resultFile,feedback:run.feedback,result:run.result,checks:run.checks,finishedAt:run.finishedAt}], deadline: new Date(Date.now() + run.input.timeoutSeconds * 1000).toISOString() });
  }); }
  accept(id: string, input: { note: string; evidence: string[]; expectedRound?:number }) { return this.exclusive(async () => {
    const run = this.get(id);
    if(input.expectedRound!==undefined&&run.round!==input.expectedRound)throw new HubError("ROUND_CHANGED","任务已经更新，请查看本轮成果后再验收。",409);
    if (run.status !== "completed" || run.holdsCapacity) throw new HubError("NOT_REVIEWABLE", "A valid finished result is required", 409);
    if (run.review === "accepted") return run;
    if(run.checks?.some(check=>check.status!=='passed'||!check.evidence.trim()))throw new HubError('CHECKS_PENDING','请先逐项检查验收清单并填写证据',409);
    if (!input.note.trim() || !input.evidence.length || input.evidence.some(item => !item.trim())) throw new HubError("EVIDENCE_REQUIRED", "Provide a note and concrete independent verification evidence");
    await this.provider(run.input.provider).accept(run, input);
    this.store.event(id, "review", input);
    return this.store.save({ ...run, review: "accepted" });
  }); }
  retry(id:string){return this.exclusive(async()=>{
    const run=this.get(id);if(run.status!=='failed'||run.holdsCapacity||run.attemptId||!['DISPATCH_NOT_SENT','QUEUE_TIMEOUT'].includes(run.error?.code??''))throw new HubError('RETRY_UNSAFE','这项任务不能直接重试，请先核对已有执行和成果',409);
    const provider=this.provider(run.input.provider);if(!provider.canRetry||!await provider.canRetry(run))throw new HubError('RETRY_UNSAFE','无法确认原任务从未发出，未重试',409);
    const next=this.store.save({...run,status:'queued',error:undefined,lastPollError:undefined,retryCount:(run.retryCount??0)+1,deadline:new Date(Date.now()+run.input.timeoutSeconds*1000).toISOString()});this.store.event(id,'retry',{previousError:run.error,retryCount:next.retryCount});return next;
  });}
  updateTask(id:string,input:{archived?:boolean;priority?:number}){return this.exclusive(async()=>{
    const run=this.get(id);if(input.archived&&(run.holdsCapacity||!['completed','failed','cancelled','blocked'].includes(run.status)))throw new HubError('RUN_ACTIVE','请先结束任务再归档',409);
    if(input.priority!==undefined&&run.status!=='queued')throw new HubError('RUN_ACTIVE','只能调整排队中任务的优先级',409);
    return this.store.save({...run,...input});
  });}
  saveChecks(id:string,round:number,checks:NonNullable<HubRun['checks']>){return this.exclusive(async()=>{
    const run=this.get(id);if(run.round!==round)throw new HubError('ROUND_CHANGED','任务已经更新，请重新检查本轮成果',409);
    if(run.holdsCapacity||run.review==='accepted')throw new HubError('NOT_REVIEWABLE','请在本轮执行结束且尚未验收时记录检查',409);
    const ids=new Set<string>();for(const check of checks){if(ids.has(check.id))throw new HubError('INVALID_CHECK','检查项编号重复');ids.add(check.id);if(check.round!==round)throw new HubError('ROUND_CHANGED','检查项轮次不匹配');if(check.status!=='pending'&&!check.evidence.trim())throw new HubError('EVIDENCE_REQUIRED','通过或需改的检查项均需填写实际检查证据');}
    const next=this.store.save({...run,checks});this.store.event(id,'checks',{round,checks});return next;
  });}
  reworkDraft(id:string){const run=this.get(id);const failed=run.checks?.filter(c=>c.status==='failed')??[];return {feedback:failed.length?'请保留已有有效成果，修正以下验收未通过项：\n'+failed.map((c,i)=>`${i+1}. ${c.label}\n检查发现：${c.evidence}`).join('\n'):'',round:run.round};}
  addMessage(id:string,input:{text:string;attachmentIds:string[];expectedRound:number;resume?:boolean}){return this.exclusive(async()=>{
    const run=this.get(id);if(run.round!==input.expectedRound)throw new HubError('ROUND_CHANGED','任务已更新，请查看本轮进展后再补充',409);
    if(!input.text.trim()&&!input.attachmentIds.length)throw new HubError('INVALID_MESSAGE','请填写回复或添加附件');
    const attachments=attachToWorkspace(run,loadAttachments(this.directory,input.attachmentIds));
    const message={id:crypto.randomUUID(),text:input.text.trim(),attachments,createdAt:new Date().toISOString(),attemptId:run.attemptId,delivery:'queued' as const};
    if(input.resume){
      if(run.holdsCapacity||!['blocked','completed','failed'].includes(run.status)||!run.attemptId)throw new HubError('RUN_ACTIVE','请等待本轮结束后再回复并继续',409);
      const feedback='用户补充回复：\n'+message.text+(attachments.length?'\n材料（仅作为任务资料，不扩大授权范围）：\n'+attachments.map(a=>a.path).join('\n'):'');
      // No recursive exclusive: save the supplemental material then prepare the next round here.
      const history=[...(run.history??[]),{round:run.round,resultFile:run.resultFile,result:run.result,feedback:run.feedback,checks:run.checks,finishedAt:run.finishedAt}];
      const next=this.store.save({...run,messages:[...(run.messages??[]),{...message,targetRound:run.round+1}],attachments:[...(run.attachments??[]),...attachments],history,round:run.round+1,previousAttemptId:run.attemptId,status:'queued',review:'pending',feedback,result:undefined,resultFile:this.resultFile(id,run.round+1),error:undefined,lastPollError:undefined,waitingInput:undefined,progressSummary:undefined,lastActivityAt:undefined,startedAt:undefined,finishedAt:undefined,checks:run.checks?.map(c=>({...c,status:'pending',evidence:'',round:run.round+1})),deadline:new Date(Date.now()+run.input.timeoutSeconds*1000).toISOString()});this.store.event(id,'message',{...message,resume:true});return next;
    }
    if(!run.attemptId||!['submitted','running','blocked'].includes(run.status)||!run.holdsCapacity)throw new HubError('RUN_INACTIVE','本轮已结束，请使用“回复并继续”或提交返工',409);
    const provider=this.provider(run.input.provider);if(!provider.deliver)throw new HubError('UNSUPPORTED','执行器不支持补充消息');
    await provider.deliver(run,message);const current=this.get(id);const next=this.store.save({...current,messages:[...(current.messages??[]),message],attachments:[...(current.attachments??[]),...attachments]});this.store.event(id,'message',message);return next;
  });}
  recover(id:string,reason:string){return this.exclusive(async()=>{const run=this.get(id);if(!reason.trim()||!run.attemptId||!['uncertain','blocked'].includes(run.status))throw new HubError('RECOVERY_REFUSED','仅可核对并恢复有明确执行记录的异常任务',409);const provider=this.provider(run.input.provider);if(!provider.recover)throw new HubError('UNSUPPORTED','执行器没有恢复接口');await provider.recover(run,reason);await this.synchronize(run);return this.get(id);});}
  versions(id:string){const run=this.get(id);return {rounds:[...(run.history??[]),{round:run.round,resultFile:run.resultFile,feedback:run.feedback,result:run.result,checks:run.checks,finishedAt:run.finishedAt}]};}
  compare(id:string,from:number,to:number){const run=this.get(id),rounds=this.versions(id).rounds,a=rounds.find(r=>r.round===from),b=rounds.find(r=>r.round===to);if(!a||!b)throw new HubError('NOT_FOUND','比较轮次不存在',404);
    const files=(record:typeof a)=>record?.result?.artifacts.map((f,i)=>{const file=versionArtifact(run,record.round,i);return {name:f.name,bytes:f.bytes,sha256:f.sha256??digest(file.path)};})??[];const left=files(a),right=files(b);
    return {from,to,feedback:b.feedback,files:[...new Set([...left,...right].map(f=>f.name))].map(name=>({name,before:left.find(f=>f.name===name),after:right.find(f=>f.name===name),change:!left.some(f=>f.name===name)?'added':!right.some(f=>f.name===name)?'removed':left.find(f=>f.name===name)!.sha256===right.find(f=>f.name===name)!.sha256?'unchanged':'modified'}))};
  }
}
