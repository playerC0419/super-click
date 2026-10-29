import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "../src/config.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { RunJournal, writePrivateJson } from "../src/run-journal.js";
import { requestSchema, type HubRun } from "../src/platform/contracts.js";
import { WorkBuddyProvider } from "../src/platform/workbuddy.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-rework-unit-"));
  // All state and the native registration are unit fixtures. Explicit session
  // routing and an absent service configuration prevent real desktop access.
  const config: Config = {
    ...loadConfig(), backend: "desktop-queue", dbFile: path.join(dir, "tasks.sqlite"),
    workbuddyConfigDir: dir, runsDir: path.join(dir, "runs"),
    serviceConfigFile: path.join(dir, "missing-unit-service.json"),
    tokenFile: path.join(dir, "unused-unit-token.json"),
    cliElectronPath: path.join(dir, "no-real-workbuddy.exe"),
  };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL)").run("unit-rework-session", dir);
  native.close();
  const provider = new WorkBuddyProvider(config, () => { throw new Error("Unit rework must not contact native WorkBuddy"); });
  // This actor is a simulation for transport assertions, never execution proof.
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const now = new Date().toISOString();
  const run: HubRun = {
    id: "hub-unit-rework", providerTaskId: "provider-unit-rework",
    input: requestSchema.parse({
      task: "Unit fixture: produce the document with title INITIAL_TITLE.",
      workspace: dir, sessionId: "unit-rework-session", model: "unit-model", output: "json",
      constraints: ["Keep all edits inside the authorized fixture directory", "Preserve the approved document body"],
    }),
    workspace: dir, status: "running", review: "pending", holdsCapacity: true, round: 1,
    resultFile: path.join(dir, "hub-results", "round-1", "result.json"),
    usage: { credits: null, source: "unavailable" }, createdAt: now, updatedAt: now,
    deadline: new Date(Date.now() + 120_000).toISOString(),
  };
  t.after(() => { provider.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, provider, queue, run };
}

test("provider rework sends the current feedback once, before a single objective, with only the current result contract", async t => {
  const f = fixture(t);
  await f.provider.submit(f.run);
  const original = f.provider.store.get(f.run.providerTaskId)!;
  const firstJournal = new RunJournal(f.queue.root, original.attemptId!);
  const firstRequest = firstJournal.request();
  assert.ok(firstRequest.prompt.includes(f.run.resultFile));
  // Simulate model readiness within the fixture; no real model is selected.
  writePrivateJson(path.join(firstJournal.dir, "model-ready.json"), { model: f.run.input.model, sessionId: "unit-rework-session", attemptId: original.attemptId });
  const first = await f.queue.claim("unit-rework-session", 0);
  if (first.status !== "task") throw new Error("Expected an isolated unit transport claim");
  f.queue.report({ ...first, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: simulated unit transport report only", artifacts: [] });
  const completed = await f.provider.poll(f.run);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.holdsCapacity, false);

  const feedback = "Replace INITIAL_TITLE with REVISED_TITLE.\nKeep the approved body unchanged; deliver the revised JSON format.";
  const secondRun: HubRun = {
    ...f.run, status: "dispatching", round: 2, previousAttemptId: first.attemptId,
    resultFile: path.join(f.dir, "hub-results", "round-2", "result.json"), feedback,
  };
  await f.provider.rework(secondRun);
  const reworked = f.provider.store.get(f.run.providerTaskId)!;
  const secondJournal = new RunJournal(f.queue.root, reworked.attemptId!);
  const request = secondJournal.request();
  assert.equal(request.prompt.split(f.run.input.task).length - 1, 1);
  assert.equal(request.prompt.split(feedback).length - 1, 1);
  assert.ok(request.prompt.indexOf(feedback) < request.prompt.indexOf(f.run.input.task));
  assert.match(request.prompt, /在已授权范围内.*冲突.*按本轮返工要求修订/);
  assert.ok(request.prompt.includes(secondRun.resultFile));
  assert.equal(request.prompt.split(secondRun.resultFile).length - 1, 1);
  assert.equal(request.prompt.includes(f.run.resultFile), false);
  assert.equal(request.prompt.split("平台结果要求（本轮）").length - 1, 1);
  for (const constraint of f.run.input.constraints) assert.ok(request.prompt.includes(constraint));
  assert.equal(request.taskId, f.run.providerTaskId);
  assert.equal(request.workspace, f.run.workspace);
  assert.equal(request.sessionId, first.sessionId);
  assert.equal(request.sessionMode, "existing");
  assert.equal(request.model, f.run.input.model);
  assert.notEqual(request.attemptId, first.attemptId);
  assert.equal(reworked.attempt, 2);
  assert.equal(reworked.taskId, original.taskId);
  assert.equal(reworked.objective, original.objective);
  assert.deepEqual(reworked.constraints, original.constraints);
  assert.equal(reworked.workspace, original.workspace);
  assert.equal(reworked.sessionId, original.sessionId);
  assert.equal(f.provider.store.listAttempts(f.run.providerTaskId).length, 2);

  writePrivateJson(path.join(secondJournal.dir, "model-ready.json"), { model: f.run.input.model, sessionId: "unit-rework-session", attemptId: reworked.attemptId });
  const second = await f.queue.claim("unit-rework-session", 0);
  if (second.status !== "task") throw new Error("Expected the isolated unit rework claim");
  assert.equal(second.prompt, request.prompt);
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.workspace, first.workspace);
  assert.equal(fs.existsSync(f.run.resultFile), false);
  assert.equal(fs.existsSync(secondRun.resultFile), false);
});
