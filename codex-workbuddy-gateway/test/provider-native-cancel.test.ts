import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal } from "../src/run-journal.js";
import { requestSchema, type HubRun } from "../src/platform/contracts.js";
import { WorkBuddyProvider } from "../src/platform/workbuddy.js";

interface StopCall { sessionId: string; workspace: string; wakeId: string; sendStop: boolean; }
interface StopObservation { state: "idle" | "busy"; workspace: string; observedAt: string; stopRequested: boolean; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: { after: (fn: () => void) => void }, observe: (call: StopCall) => Promise<StopObservation>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-native-cancel-unit-"));
  // Every path and registration belongs to this isolated unit fixture. No real
  // WorkBuddy service, native renderer, process or business artifact is used.
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), workbuddyConfigDir: dir, runsDir: path.join(dir, "runs"), serviceConfigFile: path.join(dir, "missing-unit-service.json"), tokenFile: path.join(dir, "unused-unit-token.json"), cliElectronPath: path.join(dir, "no-real-workbuddy.exe") };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("unit-session", dir);
  native.close();
  const calls: StopCall[] = [];
  const factoryPorts: number[] = [];
  let closed = 0;
  const provider = new WorkBuddyProvider(config, port => {
    factoryPorts.push(port);
    return {
      async cancelSession(sessionId: string, workspace: string, wakeId: string, sendStop: boolean) {
        const call = { sessionId, workspace, wakeId, sendStop };
        calls.push(call);
        return observe(call);
      },
      close() { closed += 1; },
    };
  });
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const now = new Date().toISOString();
  const run: HubRun = { id: "hub-unit-cancel", providerTaskId: "provider-unit-task", input: requestSchema.parse({ task: "Unit cancellation fixture only", workspace: dir, sessionId: "unit-session" }), workspace: dir, status: "running", review: "pending", holdsCapacity: true, round: 1, resultFile: path.join(dir, "never-created-business-result.json"), usage: { credits: null, source: "unavailable" }, createdAt: now, updatedAt: now, deadline: new Date(Date.now() + 120_000).toISOString() };
  t.after(() => { provider.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, provider, queue, run, calls, factoryPorts, closed: () => closed };
}

test("provider native cancellation deduplicates concurrent stop requests, then confirms idle on a later poll without a worker report", async t => {
  const firstObservation = deferred<StopObservation>();
  const f = fixture(t, call => call.sendStop
    ? firstObservation.promise
    : Promise.resolve({ state: "idle", workspace: call.workspace, observedAt: new Date().toISOString(), stopRequested: true }));
  // Explicit session and absent fixture service registration avoid automatic
  // workspace preparation, which would otherwise contact the real desktop.
  const sent = await f.provider.coordinator.send({ taskId: f.run.providerTaskId, objective: f.run.input.task, workspace: f.dir, sessionId: "unit-session", timeoutSeconds: 120 });
  assert.equal(sent.ok, true);
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected isolated fixture claim");
  await f.provider.coordinator.sync(f.run.providerTaskId);
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  const originalClaim = fs.readFileSync(path.join(journal.dir, "claim.json"));

  const stopping = f.provider.cancel(f.run);
  const duplicate = f.provider.cancel(f.run);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { sessionId: claim.sessionId, workspace: f.dir, wakeId: `wake-${claim.attemptId}`, sendStop: true });
  assert.equal(journal.cancellationRequested(), true);
  assert.equal(fs.existsSync(path.join(journal.dir, "native-cancellation.json")), false);
  firstObservation.resolve({ state: "busy", workspace: f.dir, observedAt: new Date().toISOString(), stopRequested: true });
  await Promise.all([stopping, duplicate]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.closed(), 1);
  assert.equal(journal.snapshot()?.status, "working");
  assert.equal(journal.snapshot()?.stopReason, undefined);
  const receiptFile = path.join(journal.dir, "native-stop-request.json");
  const receiptBytes = fs.readFileSync(receiptFile);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  assert.equal(receipt.attemptId, claim.attemptId);
  assert.equal(receipt.sessionId, claim.sessionId);
  assert.equal(receipt.source, "native_rpc_cancel");
  assert.deepEqual(fs.readFileSync(path.join(journal.dir, "claim.json")), originalClaim);
  const busy = await f.provider.poll(f.run);
  assert.equal(busy?.status, "running");
  assert.equal(busy?.holdsCapacity, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.provider.store.get(f.run.providerTaskId)?.report, undefined);

  const stopped = await f.provider.poll({ ...f.run, status: "cancel_requested" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]?.sendStop, false);
  assert.equal(f.calls[1]?.sessionId, claim.sessionId);
  assert.equal(f.calls[1]?.workspace, f.dir);
  assert.equal(f.calls[1]?.wakeId, `wake-${claim.attemptId}`);
  assert.deepEqual(f.factoryPorts, [18491, 18491]);
  assert.equal(f.closed(), 2);
  assert.equal(stopped?.status, "cancelled");
  assert.equal(stopped?.holdsCapacity, false);
  assert.equal(stopped?.attemptId, claim.attemptId);
  assert.equal(journal.snapshot()?.status, "cancelled");
  assert.equal(journal.snapshot()?.stopReason, "native_cancel_verified");
  const evidence = JSON.parse(fs.readFileSync(path.join(journal.dir, "native-cancellation.json"), "utf8"));
  assert.equal(evidence.taskId, f.run.providerTaskId);
  assert.equal(evidence.attemptId, claim.attemptId);
  assert.equal(evidence.source, "native_rpc_stop_confirmation");
  assert.equal(evidence.taskCompleted, false);
  assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes);
  assert.equal(f.provider.store.get(f.run.providerTaskId)?.report, undefined);
  assert.equal(journal.events(0, Infinity).filter(event => event.type === "result").length, 0);
  assert.equal(journal.events(0, Infinity).filter(event => event.metadata?.nativeCancellation === true).length, 1);
  assert.equal(fs.existsSync(f.run.resultFile), false);

  // Further cancellation polls must not contact or send another stop to native.
  await f.provider.poll({ ...f.run, status: "cancel_requested" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.closed(), 2);
  assert.equal(journal.events(0, Infinity).filter(event => event.type === "result").length, 0);
});

test("provider cancellation shutdown does not write a delayed native observation after storage closes",async t=>{
  const observation=deferred<StopObservation>(),f=fixture(t,()=>observation.promise);
  await f.provider.coordinator.send({taskId:f.run.providerTaskId,objective:f.run.input.task,workspace:f.dir,sessionId:"unit-session",timeoutSeconds:120});
  const claim=await f.queue.claim("unit-session",0);
  if(claim.status!=="task")throw Error("Expected fixture claim");
  const journal=new RunJournal(f.queue.root,claim.attemptId);
  const polling=f.provider.poll({...f.run,status:"cancel_requested"});
  f.provider.close();
  observation.resolve({state:"idle",workspace:f.dir,observedAt:new Date().toISOString(),stopRequested:true});
  assert.equal(await polling,undefined);
  assert.equal(fs.existsSync(path.join(journal.dir,"native-cancellation.json")),false);
  assert.equal(fs.existsSync(path.join(journal.dir,"native-stop-request.json")),false);
  assert.equal(journal.snapshot()?.status,"working");
  assert.equal(f.closed(),1);
});
