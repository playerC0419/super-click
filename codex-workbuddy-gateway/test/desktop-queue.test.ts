import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { DesktopQueue, assertDesktopCaller } from "../src/desktop-queue.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { RunJournal } from "../src/run-journal.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-queue-unit-"));
  const config: Config = { ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"), workbuddyConfigDir: dir, runsDir: path.join(dir, "runs") };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("unit-session", dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  // Unit fixture only. Production CLI always uses actual native process ancestry.
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (taskId = "unit-task") => coordinator.send({ taskId, objective: "Unit transport fixture", workspace: dir, sessionId: "unit-session", constraints: ["Keep original constraint"], timeoutSeconds: 120 });
  return { dir, config, store, client, coordinator, queue, send };
}

test("queue dispatch does not claim provenance; native claim/report survive reconnect and same-session rework", async (t) => {
  const f = fixture(t);
  await f.send();
  const initial = f.store.get("unit-task")!;
  assert.equal(initial.runtimeSource, undefined);
  const claim = await f.queue.claim("unit-session", 0);
  assert.equal(claim.status, "task");
  if (claim.status !== "task") throw new Error("Expected claim");
  const firstAttempt = claim.attemptId;
  assert.equal((await f.coordinator.sync("unit-task")).state, "working");
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "", artifacts: [] }), /empty report/);
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: unit fixture report", artifacts: [] });
  const restarted = new TaskCoordinator(f.config, f.store, new WorkBuddyClient(f.config));
  const result = await restarted.sync("unit-task");
  assert.equal(result.state, "needs_review");
  assert.equal(result.runtimeSource, "desktop_queue");
  await restarted.continue({ taskId: "unit-task", feedback: "Correct the third item" });
  const second = await f.queue.claim("unit-session", 0);
  if (second.status !== "task") throw new Error("Expected rework claim");
  assert.notEqual(second.attemptId, firstAttempt);
  assert.equal(second.sessionId, claim.sessionId);
  assert.match(second.prompt, /Keep original constraint/);
  assert.match(second.prompt, /Correct the third item/);
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "late old report", artifacts: [] }), /no longer active/);
  f.queue.report({ ...second, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: rework fixture report", artifacts: [] });
  assert.equal((await restarted.accept("unit-task", "Unit state-machine verification", ["Verified unit transport report and same session identity"])).state, "accepted");
});

test("queue rejects wrong leases, sessions and overlapping claims", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  assert.throws(() => f.queue.progress({ ...claim, leaseToken: "wrong", text: "x" }), /execution lease/);
  assert.throws(() => f.queue.progress({ ...claim, sessionId: "other", text: "x" }), /execution lease/);
  await f.send("second-task");
  await assert.rejects(() => f.queue.claim("unit-session", 0), /unfinished queue task/);
  const r = { attemptId: RunJournal.newId(), taskId: "unsupported", prompt: "x", timeoutSeconds: 10, sessionId: "unit-session" };
  f.queue.start({ ...r, model: "different" });
  assert.equal(new RunJournal(f.config.runsDir!, r.attemptId).request().model, "different");
  assert.throws(() => f.queue.start({ ...r, sessionMode: "new" }), /dedicated native/);
  assert.throws(() => f.queue.start({ ...r, workspace: path.join(f.dir, "other") }), /workspace differs/);
});

test("queue cancellation is observed by native report; deadline blocks without resending", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  f.coordinator.cancel("unit-task");
  assert.equal(f.queue.progress({ ...claim, text: "Checking cancellation" }).cancellationRequested, true);
  assert.equal(f.queue.report({ ...claim, status: "completed", text: "Stopped", artifacts: [] }).status, "cancelled");
  await f.send("deadline-task");
  const task = f.store.get("deadline-task")!;
  const journal = new RunJournal(f.queue.root, task.attemptId!);
  journal.save({ ...journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  const blocked = await f.coordinator.sync("deadline-task");
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.blockingReason!, /no automatic resend/);
  assert.equal((await f.queue.claim("unit-session", 0)).status, "retry");
});

test("cancellation before claim is definitive and cannot be claimed later", async t => {
  const f = fixture(t); await f.send(); const task = f.store.get("unit-task")!;
  assert.equal(f.client.cancel(task.messageId), true);
  const journal = new RunJournal(f.queue.root, task.attemptId!);
  assert.equal(journal.snapshot()?.stopReason, "cancelled_before_claim");
  assert.equal((await f.queue.claim("unit-session", 0)).status, "retry");
  assert.equal((await f.coordinator.sync("unit-task")).state, "cancelled");
  assert.equal(fs.existsSync(path.join(journal.dir, "claim.json")), false);
});

test("native cancellation confirmation requires a prior cancel request and current claimed identity", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  const input = { taskId: "unit-task", attemptId: claim.attemptId, sessionId: claim.sessionId, workspace: f.dir, observedAt: new Date().toISOString() };
  assert.throws(() => f.queue.confirmCancelledStop(input), /existing cancel request or workspace/);
  assert.equal(journal.snapshot()?.status, "working");
  assert.equal(fs.existsSync(path.join(journal.dir, "native-cancellation.json")), false);

  f.coordinator.cancel("unit-task");
  assert.throws(() => f.queue.confirmCancelledStop({ ...input, taskId: "wrong-task" }), /current claimed task attempt and original session/);
  assert.throws(() => f.queue.confirmCancelledStop({ ...input, sessionId: "wrong-session" }), /current claimed task attempt and original session/);
  const stored = f.store.get("unit-task")!;
  f.store.update("unit-task", { attemptId: RunJournal.newId() });
  assert.throws(() => f.queue.confirmCancelledStop(input), /current claimed task attempt and original session/);
  f.store.update("unit-task", { attemptId: stored.attemptId });
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal(fs.existsSync(path.join(journal.dir, "native-cancellation.json")), false);
  assert.equal(journal.events(0, Infinity).filter(event => event.type === "result").length, 0);
});

test("native cancellation confirmation rejects wrong workspace, stale observations and changed registration", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  f.coordinator.cancel("unit-task");
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  const input = { taskId: "unit-task", attemptId: claim.attemptId, sessionId: claim.sessionId, workspace: f.dir, observedAt: new Date().toISOString() };
  assert.throws(() => f.queue.confirmCancelledStop({ ...input, workspace: path.join(f.dir, "other") }), /existing cancel request or workspace/);
  for (const observedAt of [new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 60_000).toISOString(), "invalid"]) {
    assert.throws(() => f.queue.confirmCancelledStop({ ...input, observedAt }), /fresh idle observation/);
  }

  const native = new DatabaseSync(path.join(f.dir, "workbuddy.db"));
  try {
    native.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run(path.join(f.dir, "other"), claim.sessionId);
    assert.throws(() => f.queue.confirmCancelledStop(input), /native registration no longer matches/);
    native.prepare("UPDATE sessions SET cwd = ?, deleted_at = 1 WHERE id = ?").run(f.dir, claim.sessionId);
    assert.throws(() => f.queue.confirmCancelledStop(input), /native registration no longer matches/);
  } finally { native.close(); }
  assert.equal(journal.snapshot()?.status, "working");
  assert.equal(journal.snapshot()?.stopReason, undefined);
  assert.equal(fs.existsSync(path.join(journal.dir, "native-cancellation.json")), false);
});

test("native cancellation confirmation is idempotent, preserves artifacts and releases the session without a business report", async (t) => {
  const f = fixture(t);
  await f.send();
  const claim = await f.queue.claim("unit-session", 0);
  if (claim.status !== "task") throw new Error("Expected claim");
  const artifact = path.join(f.dir, "existing-unit-artifact.txt");
  const artifactBytes = Buffer.from("Existing unit fixture content\n", "utf8");
  fs.writeFileSync(artifact, artifactBytes);
  const journal = new RunJournal(f.queue.root, claim.attemptId);
  journal.save({ ...journal.snapshot()!, artifacts: [artifact] });
  f.store.update("unit-task", { artifacts: [artifact] });
  const originalReport = f.store.get("unit-task")?.report;
  await f.send("second-task");
  f.coordinator.cancel("unit-task");
  await assert.rejects(() => f.queue.claim("unit-session", 0), /unfinished queue task/);

  const input = { taskId: "unit-task", attemptId: claim.attemptId, sessionId: claim.sessionId, workspace: f.dir, observedAt: new Date().toISOString() };
  assert.deepEqual(f.queue.confirmCancelledStop(input), { ok: true, alreadyStopped: false });
  const snapshot = journal.snapshot()!;
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.stopReason, "native_cancel_verified");
  assert.equal(snapshot.text, undefined);
  assert.deepEqual(snapshot.artifacts, [artifact]);
  const evidencePath = path.join(journal.dir, "native-cancellation.json");
  const evidenceBytes = fs.readFileSync(evidencePath);
  assert.deepEqual(JSON.parse(evidenceBytes.toString("utf8")), { ...input, source: "native_rpc_stop_confirmation", taskCompleted: false });
  const events = journal.events(0, Infinity);
  assert.equal(events.filter(event => event.type === "result").length, 0);
  const stopEvents = events.filter(event => event.metadata?.nativeCancellation === true);
  assert.equal(stopEvents.length, 1);
  assert.equal(stopEvents[0]?.type, "status");
  assert.equal(stopEvents[0]?.metadata?.stopReason, "native_cancel_verified");
  assert.equal(stopEvents[0]?.metadata?.status, "cancelled");
  assert.equal((await f.coordinator.sync("unit-task")).state, "cancelled");
  assert.deepEqual(f.store.get("unit-task")?.report, originalReport);
  assert.deepEqual(f.store.get("unit-task")?.artifacts, [artifact]);
  assert.deepEqual(fs.readFileSync(artifact), artifactBytes);

  // Retries must retain the original evidence and emit no duplicate status.
  assert.deepEqual(f.queue.confirmCancelledStop({ ...input, observedAt: new Date(Date.now() - 60_000).toISOString() }), { ok: true, alreadyStopped: true });
  assert.deepEqual(fs.readFileSync(evidencePath), evidenceBytes);
  assert.deepEqual(journal.events(0, Infinity), events);
  const next = await f.queue.claim("unit-session", 0);
  assert.equal(next.status, "task");
  if (next.status !== "task") throw new Error("Expected second task after native stop confirmation");
  assert.equal(next.taskId, "second-task");
  assert.notEqual(next.attemptId, claim.attemptId);
  assert.equal(next.sessionId, claim.sessionId);
  assert.throws(() => f.queue.report({ ...claim, status: "completed", text: "late unit fixture report", artifacts: [] }), /no longer active/);
  assert.deepEqual(f.store.get("unit-task")?.report, originalReport);
  assert.equal(journal.events(0, Infinity).filter(event => event.type === "result").length, 0);
});

test("production worker rejects Codex-side invocation", (t) => {
  const f = fixture(t);
  assert.throws(() => assertDesktopCaller({ ...f.config, cliElectronPath: path.join(f.dir, "nonexistent-native-desktop") }), /real WorkBuddy desktop/);
});

test("active queue listeners are visible only during native claim wait", async (t) => {
  const f = fixture(t);
  const waiting = f.queue.claim("unit-session", 0.3);
  assert.equal(f.queue.listeners().length, 1);
  assert.equal((await f.client.health("unit-session")).ready, true);
  assert.equal((await waiting).status, "retry");
  assert.equal(f.queue.listeners().length, 0);
});

test("bootstrap instructions do not pretend to start a worker and preserve quoted installation paths", (t) => {
  const f = fixture(t);
  const prepared = f.queue.prepare("unit-session");
  assert.equal(prepared.started, false);
  assert.equal(prepared.workspace, f.dir);
  assert.match(prepared.prompt, /claim --session-id 'unit-session'/);
  assert.match(prepared.prompt, /立即再次运行 claim/);
  assert.throws(() => f.queue.prepare("missing-session"), /not registered/);
});

test("a rejected queue dispatch remains inspectable and can be corrected without losing its task", async (t) => {
  const f = fixture(t);
  const rejected = await f.coordinator.send({ taskId: "rejected-mode", objective: "Fixture task", workspace: f.dir, sessionId: "unit-session", sessionMode: "new" });
  assert.equal(rejected.ok, false);
  assert.equal((await f.coordinator.sync("rejected-mode")).state, "blocked");
  await f.coordinator.continue({ taskId: "rejected-mode", feedback: "Use the native desktop model already selected" });
  assert.equal((await f.queue.claim("unit-session", 0)).status, "task");
});
