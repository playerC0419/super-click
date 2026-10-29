import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { Config } from "../src/config.js";
import { NativeDesktopRpcTrigger } from "../src/native-desktop-trigger.js";

function startupFixture(t: test.TestContext, pages: unknown[][], signal?: AbortSignal) {
  let clock = 0, reads = 0;
  const exe = path.resolve("renderer-startup-fixture", "WorkBuddy.exe");
  const appAsar = path.join(path.dirname(exe), "resources", "app.asar").replaceAll("\\", "/");
  const target = { type: "page", url: `file:///${appAsar}/renderer/index.html`, webSocketDebuggerUrl: "ws://127.0.0.1:18491/devtools/page/main" };
  const trigger = new NativeDesktopRpcTrigger({ cliElectronPath: exe } as Config, 18491, false, {
    run() { throw new Error("Discovery must not run a process in this fixture"); },
    launch() { throw new Error("Discovery must not launch or replay a task"); },
    async pause(ms) { clock += ms; },
  },signal);
  const internals = trigger as unknown as { portStateWindows(): string; ownerIsNative(): boolean; discoverWindows(): Promise<string> };
  t.mock.method(internals, "portStateWindows", () => "native");
  t.mock.method(internals, "ownerIsNative", () => true);
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async () => {
    const response = pages[Math.min(reads++, pages.length - 1)]!;
    return new Response(JSON.stringify(response), { status: 200 });
  });
  return { internals, target, reads: () => reads, elapsed: () => clock };
}

test("a native debugger with only splash/empty pages waits for the Windows main renderer", async t => {
  const pages: unknown[][] = [[], []];
  const f = startupFixture(t, pages);
  pages[0] = [{ ...f.target, url: f.target.url.replace("index.html", "splash.html") }];
  pages.push([f.target]);
  assert.equal(await f.internals.discoverWindows(), f.target.webSocketDebuggerUrl);
  assert.equal(f.reads(), 3);
  assert.equal(f.elapsed(), 1000);
});

test("a missing Windows main renderer stops after a bounded wait without launching or dispatching", async t => {
  const f = startupFixture(t, [[]]);
  await assert.rejects(f.internals.discoverWindows(), /not ready after 45 seconds; no task was sent/);
  assert.equal(f.elapsed(), 45_000);
});

test("renderer readiness never bypasses loopback identity or changed port ownership", async t => {
  const pages: unknown[][] = [[]];
  const f = startupFixture(t, pages);
  pages[0] = [{ ...f.target, webSocketDebuggerUrl: "ws://foreign.example:18491/devtools/page/main" }];
  await assert.rejects(f.internals.discoverWindows(), /not the registered loopback endpoint/);
  pages[0] = [f.target];
  t.mock.method(f.internals, "ownerIsNative", () => false);
  await assert.rejects(f.internals.discoverWindows(), /local port changed/);
});

test("cancelling startup interrupts an in-flight renderer query without waiting for readiness timeout",async t=>{
  const controller=new AbortController(),f=startupFixture(t,[[]],controller.signal);
  t.mock.method(globalThis,"fetch",async (_url:unknown,init:RequestInit)=>new Promise((_resolve,reject)=>{
    init.signal!.addEventListener("abort",()=>reject(init.signal!.reason),{once:true});
    queueMicrotask(()=>controller.abort(Error("Startup cancelled")));
  }));
  await assert.rejects(f.internals.discoverWindows(),/Startup cancelled/);
  assert.equal(f.elapsed(),0);
});
