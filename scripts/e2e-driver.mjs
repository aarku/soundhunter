#!/usr/bin/env node
// SoundHunter end-to-end driver.
//
// Launches `pnpm tauri dev` with WebView2 remote debugging enabled, connects
// to the DevTools Protocol via WebSocket, drives the app through scripted
// scenarios, and reports UI responsiveness.
//
// Usage:
//   node scripts/e2e-driver.mjs [scenario]
//
// Scenarios:
//   embedding-responsiveness  (default) — rescan while searching, assert no freezes
//
// Requirements:
//   * pnpm available on PATH
//   * On Windows, WebView2 (ships with Edge / Windows 11)

import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT ?? 9222);
const SOURCE_LIBRARY = process.env.E2E_SOURCE ?? "C:\\Users\\JMC\\src\\unity\\Assets\\audio";
const FIXTURE_FILES = Number(process.env.E2E_FIXTURES ?? 400);
const SCENARIO = process.argv[2] ?? "embedding-responsiveness";
const APP_DATA_DIR = `${process.env.APPDATA}\\com.soundhunter.app`;

// ---------- Fixture builder ----------

function walkFiles(root, limit) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (out.length >= limit) break;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && extname(name).toLowerCase() === ".wav") out.push(p);
    }
  }
  return out;
}

function buildFixtureFolder(source, count) {
  const fixtureDir = join(tmpdir(), `soundhunter-e2e-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
  const files = walkFiles(source, count);
  if (files.length === 0) throw new Error(`no .wav files found under ${source}`);
  for (const src of files) {
    copyFileSync(src, join(fixtureDir, basename(src)));
  }
  console.log(`[driver] fixture folder: ${fixtureDir} (${files.length} files)`);
  return fixtureDir;
}

function buildE2EDataDir() {
  // Fresh per-run data dir so each test starts clean without touching the
  // user's real production data. Copy over the cached CLAP ONNX models so
  // we don't re-download them (200MB, slow).
  const dataDir = join(tmpdir(), `soundhunter-e2e-data-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });

  const realModelDir = join(APP_DATA_DIR, "clap_model");
  const testModelDir = join(dataDir, "clap_model");
  if (existsSync(realModelDir)) {
    mkdirSync(testModelDir, { recursive: true });
    for (const name of readdirSync(realModelDir)) {
      copyFileSync(join(realModelDir, name), join(testModelDir, name));
    }
    console.log(`[driver] reusing cached CLAP models from ${realModelDir}`);
  } else {
    console.log(`[driver] no cached CLAP models — first run will download`);
  }

  return dataDir;
}

// ---------- CDP client ----------

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map(); // method -> [handlers]
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method && this.events.has(msg.method)) {
        for (const h of this.events.get(msg.method)) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(handler);
  }
  /** Evaluate JS in the page, awaiting promises, and unwrap the value. */
  async evalInPage(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`Page JS threw: ${ex}`);
    }
    return r.result?.value;
  }
}

// ---------- Harness helpers, evaluated in the page ----------

const PAGE_HELPERS = `
(() => {
  const byTestId = (id) => document.querySelector('[data-testid="' + id + '"]');
  window.__e2eHelpers = {
    byTestId,
    click(id) {
      const el = byTestId(id);
      if (!el) throw new Error('no element [data-testid="' + id + '"]');
      el.click();
      return true;
    },
    text(id) {
      const el = byTestId(id);
      return el ? el.textContent : null;
    },
    exists(id) {
      return !!byTestId(id);
    },
  };
  return true;
})()
`;

// ---------- Launch + connect ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function waitForWebviewTarget(port, child, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  // Phase 1: wait for the app binary to actually launch. Before this the only
  // port-9222 target would be a stale zombie from a prior run.
  while (Date.now() < deadline) {
    if (child._e2eState?.appStarted) break;
    await sleep(250);
  }
  if (!child._e2eState?.appStarted) {
    throw new Error("tauri never reached 'Running soundhunter.exe' stage");
  }
  // Phase 2: now the app is launching, poll for its CDP target.
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const page = targets.find(
        (t) => t.type === "page" && (t.url.startsWith("http://localhost:1420") || t.url.startsWith("tauri://")),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for webview on :${port}`);
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return new CdpClient(ws);
}

function killStaleAppInstances() {
  // Dev iterations sometimes leave soundhunter.exe and its webview2 children
  // alive when the driver is killed mid-run. They hold port 9222 open and the
  // next launch ends up connecting to the stale window.
  if (process.platform !== "win32") return;
  try {
    spawn("taskkill", ["/IM", "soundhunter.exe", "/F", "/T"], {
      stdio: "ignore",
      shell: false,
    });
  } catch { /* ignore */ }
}

function launchTauri(dataDir) {
  // pnpm tauri dev — build + launch. stdout/stderr piped so we can detect
  // "app is actually launching now" vs "still compiling / still booting Vite".
  const child = spawn("pnpm", ["tauri", "dev"], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}`,
      SOUNDHUNTER_E2E_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  // Track when cargo has actually launched the app binary. Before this,
  // any port-9222 target we see is a zombie from a prior run.
  const state = { appStarted: false };
  const onChunk = (prefix) => (chunk) => {
    const text = chunk.toString();
    process.stderr.write(`${prefix} ${text}`);
    if (text.includes("soundhunter.exe") && text.includes("Running")) {
      state.appStarted = true;
    }
  };
  child.stdout.on("data", onChunk("[tauri]"));
  child.stderr.on("data", onChunk("[tauri:err]"));
  child.on("exit", (code, signal) => {
    process.stderr.write(`[tauri] exited code=${code} signal=${signal}\n`);
  });
  child._e2eState = state;
  return child;
}

// ---------- Scenarios ----------

async function scenarioEmbeddingResponsiveness(cdp, fixtureFolder) {
  // 1) Install helpers + reset freeze detector.
  await cdp.evalInPage(PAGE_HELPERS);
  await cdp.evalInPage(`window.__e2e && window.__e2e.reset(); true`);

  // 2) Add the fixture folder.
  console.log(`[driver] add_folder: ${fixtureFolder}`);
  await cdp.evalInPage(
    `window.__e2e.invoke("add_folder", { path: ${JSON.stringify(fixtureFolder)} })`,
  );
  await cdp.evalInPage(`window.__e2e.mark("add_folder-done"); true`);

  // 3) Scan + start embedding.
  await cdp.evalInPage(`window.__e2e.invoke("scan_folders")`);
  await cdp.evalInPage(`window.__e2e.mark("scan-done"); true`);
  await cdp.evalInPage(`window.__e2e.invoke("start_embedding")`);
  await cdp.evalInPage(`window.__e2e.mark("start_embedding-called"); true`);

  // 4) Wait for the first progress event (not the DOM indicator — events are
  //    captured by the harness's event listener even if React hasn't mounted
  //    the progress row yet).
  const started = Date.now();
  let firstProgress = null;
  while (Date.now() - started < 120_000) {
    const count = await cdp.evalInPage(`window.__e2e.progressEvents.length`);
    const done = await cdp.evalInPage(`window.__e2e.embeddingComplete`);
    if (count > 0) {
      firstProgress = await cdp.evalInPage(
        `JSON.stringify(window.__e2e.progressEvents[0])`,
      );
      break;
    }
    if (done) {
      // Edge case: embedding finished so fast we never caught a progress event.
      // Still a successful run, just no responsiveness window to test.
      console.log(`[driver] embedding completed before first progress event`);
      return 0;
    }
    await sleep(100);
  }
  if (!firstProgress) throw new Error("no embedding-progress events within 2 min");
  console.log(`[driver] first progress event: ${firstProgress}`);

  // 5) Drive search 10 times over 10 seconds while embedding runs. Each search
  //    goes through the real search flow (via setQuery -> debounced search).
  //    We measure round-trip latency of the underlying Tauri command directly
  //    to separate "UI latency" from "embedding contention latency".
  const searchQueries = ["ocean", "explosion", "footstep", "door", "bird", "thunder", "gun", "crowd", "wind", "water"];
  const searchLatencies = [];
  for (const q of searchQueries) {
    await cdp.evalInPage(`window.__e2e.mark(${JSON.stringify("search:" + q)}); true`);
    const t0 = Date.now();
    await cdp.evalInPage(
      `window.__e2e.invoke("search", { query: ${JSON.stringify(q)}, limit: 50 })`,
    );
    const ms = Date.now() - t0;
    searchLatencies.push({ q, ms });
    console.log(`[driver] search(${q}) -> ${ms}ms`);
    await sleep(1000);
  }

  // 6) Collect freeze events and progress events.
  const freezesRaw = await cdp.evalInPage(`JSON.stringify(window.__e2e.freezes)`);
  const frameCount = await cdp.evalInPage(`window.__e2e.frameCount`);
  const maxGapMs = await cdp.evalInPage(`window.__e2e.maxGapMs`);
  const elapsedMs = await cdp.evalInPage(`performance.now() - window.__e2e.startedAt`);
  const progressRaw = await cdp.evalInPage(`JSON.stringify(window.__e2e.progressEvents)`);
  const completed = await cdp.evalInPage(`window.__e2e.embeddingComplete`);
  const freezes = JSON.parse(freezesRaw);
  const progress = JSON.parse(progressRaw);

  // 7) Progress monotonicity + single-total check. The original bug the user
  //    reported was "7...9...11...7" progress with varying totals because two
  //    embedding runs were racing. Catch that here.
  let progressOk = true;
  let progressFailReason = null;
  if (progress.length > 1) {
    const totals = new Set(progress.map((p) => p.total));
    if (totals.size > 1) {
      progressOk = false;
      progressFailReason = `multiple distinct totals seen: [${[...totals].join(", ")}]`;
    } else {
      for (let i = 1; i < progress.length; i++) {
        if (progress[i].done < progress[i - 1].done) {
          progressOk = false;
          progressFailReason = `progress went backwards: ${progress[i - 1].done} -> ${progress[i].done} at event ${i}`;
          break;
        }
      }
    }
  }

  // 8) Report.
  console.log("");
  console.log("=".repeat(60));
  console.log("REPORT: embedding-responsiveness");
  console.log("=".repeat(60));
  console.log(`elapsed: ${Math.round(elapsedMs)}ms`);
  console.log(`frames rendered: ${frameCount}`);
  console.log(`max inter-frame gap: ${Math.round(maxGapMs)}ms`);
  console.log(`freeze events (> 100ms): ${freezes.length}`);
  for (const f of freezes.slice(0, 10)) {
    console.log(`  gap=${f.gapMs}ms mark=${f.lastMark ?? "(none)"}`);
  }
  if (freezes.length > 10) console.log(`  ... ${freezes.length - 10} more`);

  console.log("");
  console.log(`progress events: ${progress.length}`);
  console.log(`embedding complete: ${completed}`);
  console.log(`progress monotonic: ${progressOk}${progressFailReason ? " — " + progressFailReason : ""}`);

  console.log("");
  console.log("search latencies (ms):");
  for (const { q, ms } of searchLatencies) console.log(`  ${q.padEnd(10)} ${ms}`);
  const avg = searchLatencies.reduce((a, x) => a + x.ms, 0) / searchLatencies.length;
  const max = Math.max(...searchLatencies.map((x) => x.ms));
  console.log(`  avg=${Math.round(avg)}ms  max=${max}ms`);

  // 9) Pass/fail.
  const FREEZE_BUDGET_MS = 500;
  const SEARCH_P95_BUDGET_MS = 800;
  const sortedLat = [...searchLatencies].map((x) => x.ms).sort((a, b) => a - b);
  const p95 = sortedLat[Math.floor(sortedLat.length * 0.95)] ?? sortedLat[sortedLat.length - 1];

  const failures = [];
  if (!progressOk) failures.push(`progress broken: ${progressFailReason}`);
  if (maxGapMs > FREEZE_BUDGET_MS) failures.push(`max UI freeze ${Math.round(maxGapMs)}ms > ${FREEZE_BUDGET_MS}ms`);
  if (p95 > SEARCH_P95_BUDGET_MS) failures.push(`search p95 ${p95}ms > ${SEARCH_P95_BUDGET_MS}ms`);

  console.log("");
  if (failures.length === 0) {
    console.log("PASS");
    return 0;
  } else {
    console.log("FAIL");
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
}

// ---------- Main ----------

async function main() {
  console.log(`[driver] starting scenario: ${SCENARIO}`);
  console.log(`[driver] debug port: ${DEBUG_PORT}`);
  console.log(`[driver] source library: ${SOURCE_LIBRARY}`);

  killStaleAppInstances();
  await sleep(1000); // let the OS finish cleanup

  const dataDir = buildE2EDataDir();
  console.log(`[driver] e2e data dir: ${dataDir}`);
  const fixtureFolder = buildFixtureFolder(SOURCE_LIBRARY, FIXTURE_FILES);

  const child = launchTauri(dataDir);

  let exitCode = 2;
  try {
    const target = await waitForWebviewTarget(DEBUG_PORT, child);
    console.log(`[driver] webview ready: ${target.url}`);

    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // Re-navigate with ?e2e=1 so the harness installs.
    const targetUrl = new URL(target.url);
    targetUrl.searchParams.set("e2e", "1");
    await cdp.send("Page.navigate", { url: targetUrl.toString() });

    // Wait for harness installation (title suffix set by harness).
    const navDeadline = Date.now() + 30_000;
    while (Date.now() < navDeadline) {
      const ready = await cdp.evalInPage(`typeof window.__e2e === "object" && !!window.__e2e`);
      if (ready) break;
      await sleep(200);
    }
    const ready = await cdp.evalInPage(`typeof window.__e2e === "object" && !!window.__e2e`);
    if (!ready) throw new Error("e2e harness did not install");
    console.log("[driver] e2e harness installed");

    if (SCENARIO === "embedding-responsiveness") {
      exitCode = await scenarioEmbeddingResponsiveness(cdp, fixtureFolder);
    } else {
      throw new Error(`unknown scenario: ${SCENARIO}`);
    }
  } catch (err) {
    console.error("[driver] ERROR:", err.message);
    exitCode = 2;
  } finally {
    // On Windows, `pnpm tauri dev` spawns a tree (pnpm -> node -> cargo -> app).
    // SIGINT on the direct child doesn't always reach the grandchildren, so we
    // use taskkill /T to terminate the whole tree.
    if (process.platform === "win32" && child.pid) {
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          shell: false,
        });
      } catch { /* ignore */ }
    } else {
      child.kill("SIGINT");
    }
    await sleep(2000);
    // Clean up temp dirs. Best-effort; swallowed errors are fine.
    try { rmSync(fixtureFolder, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
