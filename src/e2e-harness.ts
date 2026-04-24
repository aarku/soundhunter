// End-to-end test harness. Activates only when `?e2e=1` is present in the URL.
// Installs a requestAnimationFrame loop that records inter-frame gaps > 100 ms.
// The CDP driver reads `window.__e2e` to inspect results and calls
// `window.__e2e.invoke(cmd, args)` to run Tauri commands without relying on
// `withGlobalTauri` (which is off by default in Tauri 2).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface FreezeEvent {
  /** performance.now() timestamp at which the gap ended. */
  at: number;
  /** Duration of the gap in milliseconds. */
  gapMs: number;
  /** Most recent action tag pushed via window.__e2e.mark(). */
  lastMark: string | null;
}

interface ProgressEvent {
  done: number;
  total: number;
  at: number; // performance.now() when received
}

interface E2EApi {
  enabled: boolean;
  startedAt: number;
  freezes: FreezeEvent[];
  frameCount: number;
  lastFrameAt: number;
  maxGapMs: number;
  /** Push a label so the next freeze (if any) captures what was happening. */
  mark: (label: string) => void;
  /** Reset collected data. */
  reset: () => void;
  lastMark: string | null;
  /** Invoke a Tauri command without needing the global `__TAURI__` object. */
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** All embedding-progress events received since install (or last reset). */
  progressEvents: ProgressEvent[];
  /** `true` after an embedding-complete event has fired. */
  embeddingComplete: boolean;
}

declare global {
  interface Window {
    __e2e: E2EApi;
  }
}

export function installE2EHarness() {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (params.get("e2e") !== "1") return;

  const api: E2EApi = {
    enabled: true,
    startedAt: performance.now(),
    freezes: [],
    frameCount: 0,
    lastFrameAt: performance.now(),
    maxGapMs: 0,
    lastMark: null,
    progressEvents: [],
    embeddingComplete: false,
    mark(label: string) {
      this.lastMark = label;
    },
    reset() {
      this.freezes = [];
      this.frameCount = 0;
      this.maxGapMs = 0;
      this.lastFrameAt = performance.now();
      this.startedAt = performance.now();
      this.lastMark = null;
      this.progressEvents = [];
      this.embeddingComplete = false;
    },
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      return invoke<T>(cmd, args);
    },
  };

  // Listen for embedding events directly, independent of the React UI — that
  // way the driver can observe progress even if the indicator hasn't mounted.
  listen<{ done: number; total: number }>("embedding-progress", (event) => {
    api.progressEvents.push({
      done: event.payload.done,
      total: event.payload.total,
      at: performance.now(),
    });
  });
  listen<{ total: number }>("embedding-complete", () => {
    api.embeddingComplete = true;
  });
  window.__e2e = api;

  // rAF loop. On a healthy 60 Hz tab the gap is ~16.7 ms; anything over
  // ~100 ms means the renderer thread was blocked long enough a user would
  // notice (missed animation frames, unresponsive clicks).
  const FREEZE_THRESHOLD_MS = 100;
  const tick = () => {
    const now = performance.now();
    const gap = now - api.lastFrameAt;
    api.frameCount += 1;
    if (gap > api.maxGapMs) api.maxGapMs = gap;
    if (gap > FREEZE_THRESHOLD_MS) {
      api.freezes.push({ at: now, gapMs: Math.round(gap), lastMark: api.lastMark });
    }
    api.lastFrameAt = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Signal readiness to the driver via the document title (easy to poll).
  const originalTitle = document.title;
  document.title = `${originalTitle} [e2e:ready]`;

  // eslint-disable-next-line no-console
  console.log("[e2e] harness installed");
}
