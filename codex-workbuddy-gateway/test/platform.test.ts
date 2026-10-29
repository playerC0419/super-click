import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import http from "node:http";
import { HubStore } from "../src/platform/store.js";
import { HubEngine, readResult } from "../src/platform/engine.js";
import { HubError, type AgentProvider, type HubRun, type ProviderSnapshot } from "../src/platform/contracts.js";
import { createHubServer } from "../src/platform/http.js";
import { AgentHubClient } from "../src/platform/client.js";
import { makeBackup,verifyBackup,restoreBackup,redact } from "../src/platform/maintenance.js";
import { dashboardHtml } from "../src/platform/ui.js";

class FakeProvider implements AgentProvider {
  constructor(readonly id = "workbuddy") {}
  readonly label = "Fake test provider"; readonly capabilities = {};
  snapshots = new Map<string, ProviderSnapshot>(); submitted: HubRun[] = []; reworked: HubRun[] = []; cancelled: string[] = []; accepted: string[] = [];
  sendError?: Error;
  async health() { return { state: "available", message: "test fixture only", usage: { credits: null, source: "unavailable" } as const }; }
  async models(sessionId?:string){return {models:[{id:'fast',name:'Fast'}],sessionId};}
  workspaces(){return {workers:[]};}
  async bindWorkspace(input:{workspace:string;sessionId?:string;model?:string}){return {ok:true,...input};}
  async submit(run: HubRun, _signal?: AbortSignal) { this.submitted.push(run); if (this.sendError) throw this.sendError; this.snapshots.set(run.id, { status: "queued", holdsCapacity: true, attemptId: `attempt-${run.round}`, sessionId: run.workspace, events: [] }); }
  async poll(run: HubRun) { return this.snapshots.get(run.id); }
  async cancel(run: HubRun) { this.cancelled.push(run.id); }
  async rework(run: HubRun, _signal?: AbortSignal) { this.reworked.push(run); this.snapshots.set(run.id, { status: "queued", holdsCapacity: true, attemptId: `attempt-${run.round}`, sessionId: run.workspace, events: [] }); }
  async accept(run: HubRun) { this.accepted.push(run.id); }
  finish(run: HubRun, result: unknown = { text: "test output", artifacts: [] }) {
    fs.writeFileSync(run.resultFile, JSON.stringify(result));
    this.snapshots.set(run.id, { status: "completed", holdsCapacity: false, attemptId: `attempt-${run.round}`, sessionId: run.workspace, runtimeSource: "fake_fixture", events: [{ key: `round-${run.round}:result`, type: "provider", text: "test fixture result" }] });
  }
}
function fixture(t: { after: (fn: () => void | Promise<void>) => void }, concurrency = 1) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-")));
  const store = new HubStore(path.join(directory, "hub.sqlite")); const provider = new FakeProvider();
  const engine = new HubEngine(store, [provider], directory, concurrency);
  t.after(() => { engine.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, provider, engine };
}

test("stable idempotency keys return original runs and reject changed requests, including after reopening storage", async t => {
  const f = fixture(t); const input = { task: "test objective", idempotencyKey: "stable" };
  const first = f.engine.submit(input);
  assert.equal(first.created, true); assert.equal(f.engine.submit(input).run.id, first.run.id);
  assert.throws(() => f.engine.submit({ ...input, task: "different" }), /different request/);
  const other = new HubStore(path.join(f.directory, "hub.sqlite"));
  try { const reopened = new HubEngine(other, [f.provider], f.directory); assert.equal(reopened.submit(input).created, false); }
  finally { other.close(); }
  assert.equal(fs.statSync(first.run.workspace).isDirectory(), true);
  assert.throws(() => f.engine.submit({ task: "x", provider: "deepseek" }), /not implemented/);
  const configured=f.engine.submit({ task: "x", model: "chosen", sessionId: "native-session" }).run;
  assert.equal(configured.input.model,"chosen");assert.equal(configured.input.sessionId,"native-session");
  assert.throws(() => f.engine.submit({ task: "x", unexpected: true }), /Unrecognized key/);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Control request waited for an unfinished provider operation")), 500); })]); }
  finally { clearTimeout(timer); }
}

test("cancel responds during slow dispatch, aborts preparation and cancels queued work without entering the scheduler", async t => {
  const f = fixture(t); const started = deferred<void>(); const finishDispatch = deferred<void>(); const finishCancel = deferred<void>();
  let dispatchSignal: AbortSignal | undefined;
  f.provider.submit = async (run, signal) => { f.provider.submitted.push(run); dispatchSignal = signal; started.resolve(); await finishDispatch.promise; throw new HubError("DISPATCH_NOT_SENT", "Preparation aborted before any dispatch"); };
  f.provider.cancel = async run => { f.provider.cancelled.push(run.id); await finishCancel.promise; };
  const active = f.engine.submit({ task: "slow preparation" }).run; const queued = f.engine.submit({ task: "queued" }).run;
  const tick = f.engine.tick(); await started.promise;
  const stoppedQueued = await promptly(f.engine.cancel(queued.id));
  assert.equal(stoppedQueued.status, "cancelled"); assert.equal(stoppedQueued.holdsCapacity, false);
  const requested = await promptly(f.engine.cancel(active.id));
  assert.equal(requested.status, "cancel_requested"); assert.equal(requested.holdsCapacity, true); assert.equal(dispatchSignal?.aborted, true);
  await promptly(f.engine.cancel(active.id));
  assert.deepEqual(f.provider.cancelled, [active.id], "A repeated click must not start concurrent native cancellation");
  finishDispatch.resolve(); await tick;
  assert.equal(f.engine.get(active.id).status, "cancelled"); assert.equal(f.engine.get(active.id).holdsCapacity, false); assert.equal(f.engine.get(active.id).error, undefined);
  assert.deepEqual(f.provider.submitted.map(run => run.id), [active.id]);
  finishCancel.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
});

test("slow native stop returns promptly and retains the claimed run slot until confirmed idle", async t => {
  const f = fixture(t); const finishedStop = deferred<void>();
  f.provider.cancel = async run => { f.provider.cancelled.push(run.id); await finishedStop.promise; };
  const active = f.engine.submit({ task: "claimed execution" }).run; await f.engine.tick();
  f.provider.snapshots.set(active.id, { status: "running", holdsCapacity: true, attemptId: "claimed-1", events: [] });
  const later = f.engine.submit({ task: "later task" }).run;
  const requested = await promptly(f.engine.cancel(active.id));
  assert.equal(requested.status, "cancel_requested"); assert.equal(requested.holdsCapacity, true);
  await promptly(f.engine.cancel(active.id)); await promptly(f.engine.tick());
  assert.deepEqual(f.provider.cancelled, [active.id]); assert.equal(f.engine.get(later.id).status, "queued");
  assert.equal(f.engine.get(active.id).status, "cancel_requested");
  f.provider.snapshots.set(active.id, { status: "cancelled", holdsCapacity: false, attemptId: "claimed-1", events: [] });
  finishedStop.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await f.engine.tick();
  assert.equal(f.engine.get(active.id).status, "cancelled"); assert.equal(f.engine.get(active.id).holdsCapacity, false);
  assert.equal(f.engine.get(later.id).status, "submitted");
});

test("a poll started before cancellation cannot overwrite the durable stop request", async t => {
  const f = fixture(t); const polling = deferred<void>(); const oldSnapshot = deferred<ProviderSnapshot>(); const finishStop = deferred<void>();
  const run = f.engine.submit({ task: "running fixture" }).run; await f.engine.tick();
  let firstPoll = true;
  f.provider.poll = async candidate => { if (firstPoll) { firstPoll = false; polling.resolve(); return oldSnapshot.promise; } return f.provider.snapshots.get(candidate.id); };
  f.provider.cancel = async candidate => { f.provider.cancelled.push(candidate.id); await finishStop.promise; };
  const tick = f.engine.tick(); await polling.promise;
  await promptly(f.engine.cancel(run.id));
  oldSnapshot.resolve({ status: "running", holdsCapacity: true, attemptId: "claimed-1", events: [] }); await tick;
  assert.equal(f.engine.get(run.id).status, "cancel_requested"); assert.equal(f.engine.get(run.id).holdsCapacity, true);
  finishStop.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.get(run.id).status, "cancel_requested");
});

test("a stale running poll cannot resurrect work after native stop is confirmed", async t => {
  const f = fixture(t); const polling = deferred<void>(); const oldSnapshot = deferred<ProviderSnapshot>(); const finishStop = deferred<void>();
  const run = f.engine.submit({ task: "fixture cancellation race" }).run; await f.engine.tick();
  let firstPoll = true;
  f.provider.poll = async candidate => { if (firstPoll) { firstPoll = false; polling.resolve(); return oldSnapshot.promise; } return f.provider.snapshots.get(candidate.id); };
  f.provider.cancel = async () => { await finishStop.promise; };
  const tick = f.engine.tick(); await polling.promise; await promptly(f.engine.cancel(run.id));
  f.provider.snapshots.set(run.id, { status: "cancelled", holdsCapacity: false, attemptId: "claimed-1", events: [] });
  finishStop.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.get(run.id).status, "cancelled");
  oldSnapshot.resolve({ status: "running", holdsCapacity: true, attemptId: "claimed-1", events: [] }); await tick;
  assert.equal(f.engine.get(run.id).status, "cancelled"); assert.equal(f.engine.get(run.id).holdsCapacity, false);
});

test("cancelled uncertain dispatch retains its intent and capacity instead of reverting to dispatching", async t => {
  const f = fixture(t); const started = deferred<void>(); const failedDispatch = deferred<void>(); const finishedStop = deferred<void>();
  f.provider.submit = async () => { started.resolve(); await failedDispatch.promise; throw new Error("Submission outcome could not be established"); };
  f.provider.cancel = async () => { await finishedStop.promise; };
  const run = f.engine.submit({ task: "uncertain preparation" }).run; const tick = f.engine.tick(); await started.promise;
  await promptly(f.engine.cancel(run.id)); failedDispatch.resolve(); await tick;
  assert.equal(f.engine.get(run.id).status, "cancel_requested"); assert.equal(f.engine.get(run.id).holdsCapacity, true);
  finishedStop.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
});

test("cancel can interrupt slow rework preparation without resubmitting the previous attempt", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "rework" }).run; await f.engine.tick(); f.provider.finish(run); await f.engine.tick();
  await f.engine.rework(run.id, "revise fixture"); const started = deferred<void>(); const finishedRework = deferred<void>(); const finishedStop = deferred<void>();
  let signal: AbortSignal | undefined;
  f.provider.rework = async (_run, inputSignal) => { signal = inputSignal; started.resolve(); await finishedRework.promise; throw new HubError("DISPATCH_NOT_SENT", "Rework not sent"); };
  f.provider.cancel = async () => { await finishedStop.promise; };
  const tick = f.engine.tick(); await started.promise; await promptly(f.engine.cancel(run.id)); assert.equal(signal?.aborted, true);
  finishedStop.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.engine.get(run.id).status, "cancel_requested", "The previous round's finished snapshot does not confirm the new dispatch stopped");
  assert.equal(f.engine.get(run.id).holdsCapacity, true);
  finishedRework.resolve(); await tick;
  assert.equal(f.engine.get(run.id).status, "cancelled"); assert.equal(f.engine.get(run.id).round, 2); assert.equal(f.provider.submitted.length, 1);
});

test("engine close prevents delayed native cancellation from accessing closed storage", async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-close-test-")));
  const store = new HubStore(path.join(directory, "hub.sqlite")); const provider = new FakeProvider(); const engine = new HubEngine(store, [provider], directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = engine.submit({ task: "shutdown fixture" }).run; await engine.tick();
  const stop = deferred<void>(); provider.cancel = async () => { await stop.promise; };
  await engine.cancel(run.id); engine.close(); store.close();
  stop.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
});

test("HTTP stop acknowledges before slow dispatch and native cancellation finish", async t => {
  const f = fixture(t); const token = "c".repeat(64); const server = createHubServer(f.engine, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const client = new AgentHubClient(`http://127.0.0.1:${address.port}`, token);
  const started = deferred<void>(); const finishDispatch = deferred<void>(); const finishStop = deferred<void>();
  f.provider.submit = async () => { started.resolve(); await finishDispatch.promise; throw new HubError("DISPATCH_NOT_SENT", "No provider message sent"); };
  f.provider.cancel = async run => { f.provider.cancelled.push(run.id); await finishStop.promise; };
  const { run } = await client.submit({ task: "HTTP fixture only" }); const tick = f.engine.tick(); await started.promise;
  const requested = await promptly(client.cancel(run.id));
  assert.equal(requested.status, "cancel_requested"); assert.equal(requested.holdsCapacity, true);
  await promptly(client.cancel(run.id)); assert.equal(f.provider.cancelled.length, 1);
  finishDispatch.resolve(); await tick; finishStop.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await client.get(run.id)).status, "cancelled");
});

test("global capacity and canonical per-project serial order allow other projects while one is occupied", async t => {
  const f = fixture(t, 2); const a = path.join(f.directory, "a"), b = path.join(f.directory, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  fs.symlinkSync(a, path.join(f.directory, "alias-a"),process.platform==="win32"?"junction":"dir");
  const first = f.engine.submit({ task: "a1", workspace: a }).run;
  const second = f.engine.submit({ task: "a2", workspace: path.join(f.directory, "alias-a") }).run;
  const third = f.engine.submit({ task: "b1", workspace: b }).run;
  await Promise.all([f.engine.tick(), f.engine.tick()]);
  assert.deepEqual(f.provider.submitted.map(run => run.id), [first.id, third.id]);
  assert.equal(f.engine.get(second.id).status, "queued");
  f.provider.finish(first); await f.engine.tick();
  assert.deepEqual(f.provider.submitted.map(run => run.id), [first.id, third.id, second.id]);
  assert.equal(f.engine.get(first.id).review, "pending");
});

test("a second adapter uses the same task contract and cannot overlap writes to an occupied project", async t => {
  const f = fixture(t, 2); const second = new FakeProvider("fixture-provider-two");
  const engine = new HubEngine(f.store, [f.provider, second], f.directory, 2);
  const first = engine.submit({ task: "one", workspace: f.directory }).run;
  const next = engine.submit({ provider: second.id, task: "two", workspace: f.directory }).run;
  await engine.tick(); assert.equal(second.submitted.length, 0);
  f.provider.finish(first); await engine.tick();
  assert.equal(second.submitted[0]?.id, next.id); assert.equal(engine.get(next.id).input.provider, second.id);
});

test("an interrupted dispatch reconciles a real attempt and never replays it on restart", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "crash window" }).run;
  f.store.save({ ...run, status: "dispatching", holdsCapacity: true });
  f.provider.snapshots.set(run.id, { status: "running", holdsCapacity: true, attemptId: "original", events: [] });
  const restarted = new HubEngine(f.store, [f.provider], f.directory);
  await restarted.tick(); assert.equal(restarted.get(run.id).attemptId, "original"); assert.equal(f.provider.submitted.length, 0);
});

test("uncertain submission stays occupied without blind replay; proven pre-dispatch errors release capacity", async t => {
  const f = fixture(t); f.provider.sendError = new Error("transport interrupted");
  const first = f.engine.submit({ task: "uncertain" }).run; const second = f.engine.submit({ task: "later" }).run;
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.engine.get(first.id).status, "uncertain"); assert.equal(f.engine.get(first.id).holdsCapacity, true);
  assert.equal(f.engine.get(second.id).status, "queued"); assert.equal(f.provider.submitted.length, 1);
  f.provider.snapshots.set(first.id, { status: "failed", holdsCapacity: false, attemptId: "found", error: "verified stopped", events: [] });
  f.provider.sendError = new HubError("DISPATCH_NOT_SENT", "workspace preparation failed before task reservation");
  await f.engine.tick(); assert.equal(f.engine.get(second.id).status, "failed"); assert.equal(f.engine.get(second.id).holdsCapacity, false);
});

test("a queued deadline expires without dispatch and invalid output fails independently of execution", async t => {
  const f = fixture(t); const expired = f.engine.submit({ task: "expired" }).run;
  f.store.save({ ...expired, deadline: new Date(Date.now() - 1000).toISOString() }); await f.engine.tick();
  assert.equal(f.provider.submitted.length, 0); assert.equal(f.engine.get(expired.id).error?.code, "QUEUE_TIMEOUT");
  const json = f.engine.submit({ task: "json", output: "json" }).run; await f.engine.tick();
  f.provider.finish(json, { text: "missing json", artifacts: [] }); await f.engine.tick();
  assert.equal(f.engine.get(json.id).error?.code, "INVALID_OUTPUT"); assert.equal(f.engine.get(json.id).holdsCapacity, false);
});

test("JSON null is valid, output success is not acceptance, and concrete evidence is required", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "structured", output: "json" }).run; await f.engine.tick();
  f.provider.finish(run, { text: "valid fixture", json: null, artifacts: [] }); await f.engine.tick();
  assert.equal(f.engine.get(run.id).status, "completed"); assert.equal(f.engine.get(run.id).result?.json, null); assert.equal(f.engine.get(run.id).review, "pending");
  await assert.rejects(() => f.engine.accept(run.id, { note: "checked", evidence: [] }), /concrete independent/);
  await f.engine.accept(run.id, { note: "checked fixture", evidence: ["Compared fixture output with expected null"] });
  assert.equal(f.engine.get(run.id).review, "accepted"); assert.deepEqual(f.provider.accepted, [run.id]);
});

test("rework gets a fresh result location, preserves provider task identity and cannot reuse old attempt output", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "rework" }).run; await f.engine.tick(); f.provider.finish(run); await f.engine.tick();
  const next = await f.engine.rework(run.id, "change fixture result");
  assert.notEqual(next.resultFile, run.resultFile); assert.equal(next.providerTaskId, run.providerTaskId); assert.equal(next.round, 2);
  await f.engine.tick(); assert.equal(f.provider.reworked.length, 1); assert.equal(f.engine.get(run.id).attemptId, "attempt-2");
  await assert.rejects(() => f.engine.rework(run.id, "overlapping"), /confirmed finished/);
  f.provider.finish(next, { text: "second output", artifacts: [] }); await f.engine.tick();
  assert.equal(f.engine.get(run.id).result?.text, "second output");
  assert.equal(f.store.events(run.id).filter(event => event.type === "provider").length, 2);
});

test("restart during rework does not mistake the previous completed attempt for the new one", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "rework crash" }).run; await f.engine.tick(); f.provider.finish(run); await f.engine.tick();
  const next = await f.engine.rework(run.id, "new round"); f.store.save({ ...next, status: "dispatching", holdsCapacity: true });
  await f.engine.tick(); assert.equal(f.engine.get(run.id).status, "uncertain"); assert.equal(f.provider.reworked.length, 0);
});

test("cancelled running work keeps its slot until actual stop while unsubmitted work cancels immediately", async t => {
  const f = fixture(t); const active = f.engine.submit({ task: "active" }).run, pending = f.engine.submit({ task: "pending" }).run;
  await f.engine.tick(); assert.equal((await f.engine.cancel(pending.id)).status, "cancelled");
  const cancelled = await f.engine.cancel(active.id); assert.equal(cancelled.status, "cancel_requested"); assert.equal(cancelled.holdsCapacity, true);
  const third = f.engine.submit({ task: "later" }).run; await f.engine.tick(); assert.equal(f.engine.get(third.id).status, "queued");
  f.provider.snapshots.set(active.id, { status: "cancelled", holdsCapacity: false, attemptId: "attempt-1", events: [] });
  await f.engine.tick(); assert.equal(f.engine.get(active.id).status, "cancelled"); assert.equal(f.engine.get(third.id).status, "submitted");
});

test("result validation rejects external files, directory symlinks, missing files and oversized results", t => {
  const f = fixture(t); const run = f.engine.submit({ task: "files", output: "artifacts" }).run;
  const outside = path.join(f.directory, "private.txt"); fs.writeFileSync(outside, "private fixture");
  fs.writeFileSync(run.resultFile, JSON.stringify({ text: "bad", artifacts: [outside] })); assert.throws(() => readResult(run), /escapes/);
  const symlink = path.join(run.workspace, "outside.txt"); fs.symlinkSync(f.directory,path.join(run.workspace,"external"),process.platform==="win32"?"junction":"dir");
  fs.writeFileSync(run.resultFile, JSON.stringify({ text: "bad", artifacts: [path.join(run.workspace,"external","private.txt")] })); assert.throws(() => readResult(run), /escapes/);
  fs.writeFileSync(run.resultFile, "x".repeat(1_048_577)); assert.throws(() => readResult(run), /1 MiB/);
  fs.rmSync(path.dirname(run.resultFile), { recursive: true }); fs.symlinkSync(f.directory, path.dirname(run.resultFile),process.platform==="win32"?"junction":"dir");
  fs.writeFileSync(path.join(f.directory, "output.json"), JSON.stringify({ text: "bad", artifacts: [] })); assert.throws(() => readResult(run), /escapes/);
});

test("events deduplicate provider observations and resume after persistent cursors", async t => {
  const f = fixture(t); const run = f.engine.submit({ task: "events" }).run; await f.engine.tick();
  f.provider.snapshots.set(run.id, { status: "running", holdsCapacity: true, attemptId: "attempt-1", events: [{ key: "progress-1", type: "provider", text: "one" }] });
  await f.engine.tick(); const events = f.store.events(run.id); const after = events.at(-1)!.id;
  await f.engine.tick(); assert.equal(f.store.events(run.id, after).length, 0);
  f.provider.finish(run); await f.engine.tick(); assert.ok(f.store.events(run.id, after).length >= 2);
  assert.equal(f.store.events(run.id).filter(event => event.type === "provider").length, 2);
});

test("HTTP authentication, Host/Origin checks, SDK waiting, SSE reconnect, files and errors share one engine", async t => {
  const f = fixture(t); const token = "a".repeat(64); const server = createHubServer(f.engine, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`; const client = new AgentHubClient(url, token);
  assert.equal((await fetch(url + "/v1/runs")).status, 401);
  assert.equal((await fetch(url + "/v1/runs", { headers: { authorization: `Bearer ${token}`, origin: "https://example.com" } })).status, 403);
  const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get(url + "/v1/runs", { headers: { authorization: `Bearer ${token}`, host: "evil.example" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(wrongHostStatus, 403);
  const navigation = await new Promise<number | undefined>((resolve, reject) => {
    http.get(url + "/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(navigation, 200, "A normal clicked link may open the dashboard; API access stays same-origin");
  const page = await fetch(url); assert.match(page.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/); assert.match(await page.text(), /Agent Hub/);
  assert.deepEqual(await client.models('native/session'),{models:[{id:'fast',name:'Fast'}],sessionId:'native/session'});
  assert.deepEqual(await client.workspaces(),{workers:[]});
  assert.deepEqual(await client.bindWorkspace({workspace:f.directory,sessionId:'native/session',model:'fast'}),{ok:true,workspace:f.directory,sessionId:'native/session',model:'fast'});
  await assert.rejects(()=>client.bindWorkspace({workspace:f.directory,model:''}),/at least 1 character/);
  const { run } = await client.submit({ task: "http", output: "artifacts" });
  const queued = await client.request<HubRun>(`/v1/runs/${run.id}/wait?timeoutSeconds=1`); assert.equal(queued.status, "queued");
  const controller = new AbortController();
  const stream = await fetch(`${url}/v1/runs/${run.id}/stream`, { headers: { authorization: `Bearer ${token}`, "Last-Event-ID": "0" }, signal: controller.signal });
  const reader = stream.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: state/); controller.abort(); await reader.cancel().catch(() => {});
  await f.engine.tick(); const file = path.join(run.workspace, "result.txt"); fs.writeFileSync(file, "fixture content"); f.provider.finish(run, { text: "file fixture", artifacts: [file] }); await f.engine.tick();
  assert.equal((await client.wait(run.id, { timeoutMs: 1000 })).status, "completed");
  const downloaded = await fetch(`${url}/v1/runs/${run.id}/artifacts/0`, { headers: { authorization: `Bearer ${token}` } }); assert.equal(await downloaded.text(), "fixture content");
  fs.writeFileSync(f.engine.get(run.id).result!.artifacts[0]!.snapshotPath!, "tampered snapshot");
  const swapped = await fetch(`${url}/v1/runs/${run.id}/artifacts/0`, { headers: { authorization: `Bearer ${token}` } }); assert.notEqual(swapped.status, 200);
  await assert.rejects(() => client.submit({ task: "different", idempotencyKey: "key", output: "invalid" }), /Invalid enum/);
  assert.throws(() => new AgentHubClient("https://example.com", token), /loopback/);
});

test("SDK wait timeout does not cancel work and dashboard script compiles", async t => {
  const f = fixture(t); const token = "b".repeat(64); const server = createHubServer(f.engine, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address"); const client = new AgentHubClient(`http://127.0.0.1:${address.port}`, token);
  const { run } = await client.submit({ task: "still queued" }); await assert.rejects(() => client.wait(run.id, { timeoutMs: 20 }), /remains available/); assert.equal(f.engine.get(run.id).status, "queued");
  for(const match of dashboardHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)){const script=match[1]!;assert.doesNotThrow(()=>new vm.Script(script));assert.ok(!script.includes("innerHTML"));}
});

test("HTTP rework and acceptance reject stale rounds while preserving the intended feedback",async t=>{
  const f=fixture(t),token="c".repeat(64),server=createHubServer(f.engine,token);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();if(!address||typeof address==="string")throw Error("address");
  const client=new AgentHubClient(`http://127.0.0.1:${address.port}`,token);
  const first=f.engine.submit({task:"Isolated rework routing fixture"}).run;
  await f.engine.tick();f.provider.finish(first);await f.engine.tick();
  const route=`/v1/runs/${first.id}`;
  await assert.rejects(client.request(route+"/rework","POST",{feedback:"wrong round",expectedRound:2}),e=>e instanceof HubError&&e.code==="ROUND_CHANGED"&&e.httpStatus===409);
  assert.equal(f.engine.get(first.id).round,1);assert.equal(f.engine.get(first.id).feedback,undefined);
  const revised=await client.request<HubRun>(route+"/rework","POST",{feedback:"Use yellow, 35 minutes and 3 video placeholders",expectedRound:1});
  assert.equal(revised.round,2);assert.equal(revised.feedback,"Use yellow, 35 minutes and 3 video placeholders");
  await f.engine.tick();f.provider.finish(revised);await f.engine.tick();
  await assert.rejects(client.request(route+"/accept","POST",{note:"old review",evidence:["old result"],expectedRound:1}),e=>e instanceof HubError&&e.code==="ROUND_CHANGED");
  assert.equal(f.engine.get(first.id).review,"pending");
  const accepted=await client.request<HubRun>(route+"/accept","POST",{note:"current review",evidence:["Current fixture verified"],expectedRound:2});
  assert.equal(accepted.review,"accepted");assert.equal(accepted.round,2);
});

test("dashboard stop gives immediate feedback, blocks duplicate clicks and waits for confirmed stop", async () => {
  class Element {
    children: Element[] = []; className = ""; textContent = ""; disabled = false; id = ""; style = {};
    onclick?: () => Promise<void>; ontoggle?: () => void;
    constructor(readonly tag: string) {}
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
    setAttribute(_name: string, _value: string) {}
    get lastChild() { return this.children.at(-1)!; }
  }
  const detail = new Element("section"); const response = deferred<{ ok: boolean; json: () => Promise<HubRun> }>();
  let requests = 0;
  const script = dashboardHtml().match(/<script>([\s\S]*)<\/script>/)![1]!.split("$('submit-form').onsubmit=")[0]!;
  const context = vm.createContext({
    document: { getElementById: (id: string) => id === "detail" ? detail : undefined, createElement: (tag: string) => new Element(tag) },
    location: { search: "?run=fixture-run" }, URLSearchParams,
    fetch: () => { requests++; return response.promise; },
  });
  vm.runInContext(script + "\nrefresh=async()=>{};globalThis.render=renderDetail;", context);
  const render = context.render as (run: HubRun) => void;
  const run = { id: "fixture-run", input: { task: "test fixture" }, round: 1, workspace: "fixture", review: "pending", status: "running", holdsCapacity: true } as HubRun;
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  const stopButton = () => all(detail).find(node => node.tag === "button" && /停止/.test(node.textContent))!;
  render(run); const button = stopButton(); const click = button.onclick!();
  assert.equal(button.disabled, true); assert.equal(button.textContent, "正在请求停止…");
  assert.ok(all(detail).some(node => node.textContent === "正在请求停止…"));
  await button.onclick!(); assert.equal(requests, 1);
  response.resolve({ ok: true, json: async () => ({ ...run, status: "cancel_requested" }) }); await click;
  assert.equal(stopButton().disabled, true); assert.equal(stopButton().textContent, "已请求停止");
  assert.ok(all(detail).some(node => node.textContent === "已请求停止，正在确认停止。"));
  render(run); assert.equal(stopButton().disabled, true, "An old UI refresh must not restore an enabled stop button");
  render({ ...run, status: "cancelled", holdsCapacity: false });
  assert.ok(all(detail).some(node => node.textContent === "已停止。"));
  assert.ok(all(detail).some(node => node.textContent === "已停止"));
});

test("A-J queue pause persists, priority wins and archived history remains searchable",async t=>{
 const f=fixture(t);f.engine.setQueue(true);const low=f.engine.submit({task:'low priority',priority:-1}).run;const high=f.engine.submit({task:'urgent priority',priority:9}).run;await f.engine.tick();assert.equal(f.provider.submitted.length,0);assert.equal(f.store.settings('queue',{paused:false}).paused,true);f.engine.setQueue(false);await f.engine.tick();assert.equal(f.provider.submitted[0]?.id,high.id);await f.engine.cancel(low.id);await f.engine.updateTask(low.id,{archived:true});assert.equal(f.store.query({q:'low'}).total,0);assert.equal(f.store.query({q:'low',archived:true}).total,1);
});

test("A-J safe retry preserves idempotency and refuses any possibly dispatched attempt",async t=>{
 const f=fixture(t);f.provider.sendError=new HubError('DISPATCH_NOT_SENT','fixture not sent');const run=f.engine.submit({task:'retry',idempotencyKey:'retry-key'}).run;await f.engine.tick();assert.equal(f.engine.get(run.id).status,'failed');await assert.rejects(f.engine.retry(run.id),/确认/);Object.assign(f.provider,{canRetry:async()=>true});await f.engine.retry(run.id);assert.equal(f.engine.submit({task:'retry',idempotencyKey:'retry-key'}).run.id,run.id);f.provider.sendError=undefined;await f.engine.tick();await assert.rejects(f.engine.retry(run.id),/不能/);assert.equal(f.engine.get(run.id).retryCount,1);
});

test("A-J immutable artifacts, evidence gate, generated feedback and round comparison",async t=>{
 const f=fixture(t);const run=f.engine.submit({task:'versioned fixture',acceptanceCriteria:['contains approved text']}).run;await f.engine.tick();const file=path.join(run.workspace,'result.txt');fs.writeFileSync(file,'first');f.provider.finish(run,{text:'fixture',artifacts:[file]});await f.engine.tick();const first=f.engine.get(run.id);assert.ok(first.result?.artifacts[0]?.snapshotPath);fs.writeFileSync(file,'outside change');assert.equal(fs.readFileSync(first.result!.artifacts[0]!.snapshotPath!,'utf8'),'first');await assert.rejects(f.engine.accept(run.id,{note:'premature',evidence:['x']}),/检查|验收/);const checks=first.checks!.map(c=>({...c,status:'failed' as const,evidence:'observed first, expected second'}));await f.engine.saveChecks(run.id,1,checks);assert.match(f.engine.reworkDraft(run.id).feedback,/expected second/);await f.engine.rework(run.id,f.engine.reworkDraft(run.id).feedback);await f.engine.tick();const second=f.engine.get(run.id);fs.writeFileSync(file,'second');f.provider.finish(second,{text:'fixture revision',artifacts:[file]});await f.engine.tick();assert.equal(f.engine.versions(run.id).rounds.length,2);assert.match(JSON.stringify(f.engine.compare(run.id,1,2)),/modified/);await f.engine.saveChecks(run.id,2,f.engine.get(run.id).checks!.map(c=>({...c,status:'passed' as const,evidence:'read actual second'})));await f.engine.accept(run.id,{note:'verified',evidence:['read actual file']});assert.equal(f.engine.get(run.id).review,'accepted');
});

test("A-J supplemental message receipts distinguish saved from actually claimed reply",async t=>{
 const f=fixture(t);const run=f.engine.submit({task:'ask fixture'}).run;await f.engine.tick();Object.assign(f.provider,{deliver:async()=>{}});const saved=await f.engine.addMessage(run.id,{text:'answer',attachmentIds:[],expectedRound:1});assert.equal(saved.messages?.[0]?.delivery,'queued');f.provider.snapshots.set(run.id,{status:'running',holdsCapacity:true,attemptId:'attempt-1',events:[],deliveredMessages:[{id:saved.messages![0]!.id,deliveredAt:new Date().toISOString()}]});await f.engine.tick();assert.equal(f.engine.get(run.id).messages?.[0]?.delivery,'delivered');f.provider.finish(run);await f.engine.tick();const resumed=await f.engine.addMessage(run.id,{text:'continue answer',attachmentIds:[],expectedRound:1,resume:true});assert.equal(resumed.messages?.[1]?.delivery,'queued');await f.engine.tick();assert.equal(f.engine.get(run.id).messages?.[1]?.delivery,'queued');f.provider.snapshots.set(run.id,{status:'running',holdsCapacity:true,attemptId:'attempt-2',events:[]});await f.engine.tick();assert.equal(f.engine.get(run.id).messages?.[1]?.delivery,'delivered');assert.equal(f.engine.get(run.id).messages?.[1]?.attemptId,'attempt-2');
});

test("A-J verified backup restores isolated database paused and detects tampering; diagnostics redact secrets",async t=>{
 const f=fixture(t);const root=path.join(f.directory,'installation');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'test-only'}));fs.writeFileSync(path.join(root,'.env'),'PUBLIC_VALUE=hello\nAPI_TOKEN=fixture-private-secret\n');const run=f.engine.submit({task:'backup fixture'}).run;await f.engine.cancel(run.id);const b=await makeBackup(f.engine,root);assert.equal(verifyBackup(f.directory,b.id).manifest.files.length,b.files);assert.ok(!fs.readFileSync(path.join(b.folder,'.env'),'utf8').includes('fixture-private-secret'));const restored=path.join(f.directory,'restored');await restoreBackup(f.directory,b.id,restored);const reopened=new HubStore(path.join(restored,'data/platform/hub.sqlite'));try{assert.equal(reopened.get(run.id)?.status,'cancelled');assert.equal(reopened.settings('queue',{paused:false}).paused,true);}finally{reopened.close();}fs.appendFileSync(path.join(b.folder,'package.json'),'tamper');assert.throws(()=>verifyBackup(f.directory,b.id));const value=redact('Bearer abcdef token=private-value leaseToken=lease-private ?accountSnapshot=private-url');assert.ok(!value.includes('private-value'));assert.ok(!value.includes('lease-private'));assert.ok(!value.includes('private-url'));
});

test("A-J authenticated upload copies only verified attachments and rejects changed bytes",async t=>{
 const f=fixture(t),token='a'.repeat(64),server=createHubServer(f.engine,token);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;const unauthorized=await fetch(base+'/v1/uploads',{method:'POST',body:'test'});assert.equal(unauthorized.status,401);const response=await fetch(base+'/v1/uploads',{method:'POST',headers:{authorization:'Bearer '+token,'X-File-Name':encodeURIComponent('../materials.txt')},body:'actual fixture material'});assert.equal(response.status,201);const upload=await response.json() as {id:string;path:string;name:string};assert.equal(upload.name,'materials.txt');const run=f.engine.submit({task:'read materials',attachmentIds:[upload.id]}).run;assert.equal(fs.readFileSync(run.attachments![0]!.path,'utf8'),'actual fixture material');assert.ok(run.attachments![0]!.path.startsWith(run.workspace));fs.writeFileSync(upload.path,'tampered');assert.throws(()=>f.engine.submit({task:'reject changed upload',attachmentIds:[upload.id]}));
});
