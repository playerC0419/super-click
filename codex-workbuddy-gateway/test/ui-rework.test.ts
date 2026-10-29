import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dashboardHtml } from "../src/platform/ui.js";
import type { HubRun } from "../src/platform/contracts.js";

class Element {
  children: Element[] = []; className = ""; textContent = ""; disabled = false; id = ""; style = {}; value = ""; placeholder = "";
  onclick?: () => Promise<void>; oninput?: () => void; ontoggle?: () => void;
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(_name: string, _value: string) {}
  get lastChild() { return this.children.at(-1)!; }
  get classList() { return { contains: (name: string) => this.className.split(" ").includes(name) }; }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function completed(id = "run-a", round = 1): HubRun { return { id, input: { task: "fixture " + id }, round, workspace: "fixture", review: "pending", status: "completed", holdsCapacity: false, attemptId: "attempt-" + round, createdAt: "2026-10-14T00:00:00.000Z" } as HubRun; }
function response(value: unknown, ok = true) { return { ok, json: async () => value }; }
interface Request { route: string; method: string; body: Record<string, unknown> | undefined }
function dashboard(storage = new Map<string, string>()) {
  const nodes = new Map(["detail", "count-active", "count-queued", "count-done", "tasks", "footer"].map(id => [id, new Element("div")]));
  const requests: Request[] = []; const snapshots = new Map<string, HubRun>();
  const document: { activeElement?: Element; getElementById: (id: string) => Element | undefined; createElement: (tag: string) => Element } = {
    getElementById: id => nodes.get(id) || all(nodes.get("detail")!).find(node => node.id === id),
    createElement: tag => new Element(tag),
  };
  let handle = async (request: Request): Promise<ReturnType<typeof response>> => {
    if (request.route === "/v1/runs") return response({ runs: [...snapshots.values()] });
    if (request.route.includes("/events?")) return response({ events: [] });
    return response(snapshots.get(request.route.slice("/v1/runs/".length)));
  };
  const context = vm.createContext({ document, location: { search: "?run=run-a" }, URLSearchParams,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    fetch: (route: string, input: { method: string; body?: string }) => { const request = { route, method: input.method, body: input.body ? JSON.parse(input.body) as Record<string, unknown> : undefined }; requests.push(request); return handle(request); },
  });
  const script = dashboardHtml().match(/<script>([\s\S]*)<\/script>/)![1]!.split("$('submit-form').onsubmit=")[0]!;
  vm.runInContext(script + "\nglobalThis.render=renderDetail;globalThis.realRefresh=refresh;globalThis.setSelected=id=>{selected=id;detailFingerprint='';};refresh=async()=>{};", context);
  return {
    document, requests, snapshots, storage, context,
    render: context.render as (run: HubRun) => void,
    refresh: context.realRefresh as () => Promise<void>,
    select: context.setSelected as (id: string) => void,
    handle: (next: typeof handle) => { handle = next; },
    nodes: () => all(nodes.get("detail")!),
    textarea: (index = 0) => all(nodes.get("detail")!).filter(node => node.tag === "textarea")[index]!,
    button: (text: string) => all(nodes.get("detail")!).find(node => node.tag === "button" && node.textContent === text)!,
  };
}

test("rework captures its task and round, gives immediate feedback and prevents duplicate submission", async () => {
  const f = dashboard(); const run = completed(); f.render(run); const input = f.textarea(); input.value = "只调整第三项\n保留其他内容"; input.oninput!();
  const button = f.button("提交返工"); const result = deferred<ReturnType<typeof response>>(); f.handle(() => result.promise);
  f.select("run-b"); // A row change must not redirect an already rendered action to another task.
  const first = button.onclick!();
  assert.equal(button.disabled, true); assert.equal(button.textContent, "正在提交返工…"); assert.equal(input.disabled, true);
  assert.ok(f.nodes().some(node => node.textContent === "正在提交返工要求…"));
  await button.onclick!(); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.route, "/v1/runs/run-a/rework");
  assert.deepEqual(f.requests[0]?.body, { feedback: "只调整第三项\n保留其他内容", expectedRound: 1 });
  result.resolve(response({ ...run, round: 2, status: "queued", feedback: input.value })); await first;
  assert.equal(f.storage.has("agent-hub:draft:run-a:1:rework"), false);
});

test("accept captures its task and round and retains failed evidence", async () => {
  const f = dashboard(); f.render(completed("run-a", 3)); const input = f.textarea(1); input.value = "已读取实际成果并核对第三项"; input.oninput!();
  const button = f.button("记录验收通过"); f.select("run-b"); f.handle(async () => response({ error: { message: "轮次已变化，请查看最新成果" } }, false));
  await button.onclick!();
  assert.equal(f.requests[0]?.route, "/v1/runs/run-a/accept"); assert.equal(f.requests[0]?.body?.expectedRound, 3);
  assert.equal(f.storage.get("agent-hub:draft:run-a:3:accept"), "已读取实际成果并核对第三项");
  assert.equal(button.disabled, false);
});

test("rework drafts survive polling, task changes and a page reload, and stay isolated by round", () => {
  const f = dashboard(); const run = completed(); f.render(run); f.textarea().value = "修改颜色为蓝色"; f.textarea().oninput!();
  f.render({ ...run, lastPollError: "temporary update" }); assert.equal(f.textarea().value, "修改颜色为蓝色");
  f.select("run-b"); f.render(completed("run-b")); assert.equal(f.textarea().value, "");
  f.textarea().value = "修改标题"; f.textarea().oninput!(); f.select(run.id); f.render(run); assert.equal(f.textarea().value, "修改颜色为蓝色");
  const reopened = dashboard(f.storage); reopened.render(run); assert.equal(reopened.textarea().value, "修改颜色为蓝色");
  reopened.render(completed(run.id, 2)); assert.equal(reopened.textarea().value, "");
});

test("a failed rework keeps its draft and visible error through refresh and task changes", async () => {
  const f = dashboard(); const run = completed(); f.render(run); f.textarea().value = "修复实际错误"; f.textarea().oninput!();
  f.handle(async () => response({ error: { message: "WorkBuddy 尚未结束当前执行" } }, false)); await f.button("提交返工").onclick!();
  f.render({ ...run, lastPollError: "update" });
  assert.equal(f.textarea().value, "修复实际错误"); assert.ok(f.nodes().some(node => node.className === "error" && node.textContent === "WorkBuddy 尚未结束当前执行"));
  f.select("run-b"); f.render(completed("run-b")); f.select(run.id); f.render(run);
  assert.equal(f.textarea().value, "修复实际错误"); assert.ok(f.nodes().some(node => node.textContent === "WorkBuddy 尚未结束当前执行"));
});

test("a failure immediately updates controls recreated by polling while the request was pending", async () => {
  const f = dashboard(); const run = completed(); f.render(run); f.textarea().value = "修复实际错误"; f.textarea().oninput!();
  const result = deferred<ReturnType<typeof response>>(); f.handle(() => result.promise); const pending = f.button("提交返工").onclick!();
  f.render({ ...run, lastPollError: "background update" }); const recreated = f.button("正在提交返工…"); assert.equal(recreated.disabled, true);
  result.resolve(response({ error: { message: "本轮已变化，请查看最新成果" } }, false)); await pending;
  assert.equal(f.button("提交返工"), recreated); assert.equal(recreated.disabled, false);
  assert.ok(f.nodes().some(node => node.className === "error" && node.textContent === "本轮已变化，请查看最新成果"));
  assert.equal(f.textarea().value, "修复实际错误");
});

test("successful rework displays the exact submitted feedback and clears only that round's draft", async () => {
  const f = dashboard(); const run = completed(); f.render(run); const feedback = "<script>不得执行</script>\n请只改第三项";
  f.textarea().value = feedback; f.textarea().oninput!(); f.textarea(1).value = "保留验收草稿"; f.textarea(1).oninput!();
  f.handle(async () => response({ ...run, round: 2, status: "queued", feedback, result: undefined })); await f.button("提交返工").onclick!();
  assert.ok(f.nodes().some(node => node.textContent === "本轮已提交的返工要求")); assert.ok(f.nodes().some(node => node.className === "result" && node.textContent === feedback));
  assert.ok(f.nodes().some(node => node.textContent === "返工要求已提交，等待 WorkBuddy 开始本轮执行。"));
  assert.equal(f.storage.has("agent-hub:draft:run-a:1:rework"), false); assert.equal(f.storage.get("agent-hub:draft:run-a:1:accept"), "保留验收草稿");
  f.render({ ...run, round: 2, status: "running", holdsCapacity: true, feedback }); assert.ok(f.nodes().some(node => node.textContent === "本轮返工执行中。"));
});

test("an old detail response cannot replace a newly selected task", async () => {
  const f = dashboard(); const a = completed("run-a"); const b = completed("run-b"); f.snapshots.set(a.id, a); f.snapshots.set(b.id, b);
  const oldDetail = deferred<ReturnType<typeof response>>(); let entered!: () => void; const requested = new Promise<void>(resolve => { entered = resolve; });
  f.handle(async request => {
    if (request.route === "/v1/runs") return response({ runs: [a, b] });
    if (request.route === "/v1/runs/run-a") { entered(); return oldDetail.promise; }
    return response(b);
  });
  const stale = f.refresh(); await requested; f.select(b.id); await f.refresh(); oldDetail.resolve(response(a)); await stale;
  assert.ok(f.nodes().some(node => node.textContent === b.input.task)); assert.ok(!f.nodes().some(node => node.textContent === a.input.task));
});

test("feedback focus protects its own draft without blocking a different selected task", () => {
  const f = dashboard(); const a = completed(); f.render(a); const input = f.textarea(); input.value = "正在输入"; input.oninput!(); f.document.activeElement = input;
  f.render({ ...a, lastPollError: "polling" }); assert.equal(f.textarea(), input);
  f.select("run-b"); f.render(completed("run-b")); assert.notEqual(f.textarea(), input); assert.equal(f.textarea().value, "");
});
