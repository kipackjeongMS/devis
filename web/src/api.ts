// Thin fetch wrapper: parses JSON, surfaces API error messages as thrown Errors.
//
// Also detects a stale connection: the page keeps the URL it loaded from, and
// the service behind it can restart (usually on the same port, sometimes not).
// bindIdentity() captures who we're bound to at boot; any later failure
// re-pings to tell a genuine app error apart from a lost or replaced server.
import { showStaleBanner } from "./staleBanner.js";

interface PingResult {
  pid: number;
  startedAt: number;
}

let boundIdentity: PingResult | null = null;
let staleShown = false;

function markStale(): void {
  if (staleShown) return;
  staleShown = true;
  showStaleBanner();
}

async function rawPing(): Promise<PingResult> {
  const r = await fetch("/api/ping", { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error("ping failed");
  return r.json();
}

/** Call once at boot, before any other request, to record the identity of the
 *  server this page is currently talking to. */
export async function bindIdentity(): Promise<void> {
  try {
    boundIdentity = await rawPing();
  } catch {
    // Can't even reach our own server at boot — definitely stale/dead.
    markStale();
  }
}

/** Returns true (and shows the banner) if the given failure looks like a
 *  stale connection rather than a genuine app-level error. */
async function checkStale(): Promise<boolean> {
  if (staleShown) return true;
  if (!boundIdentity) return false; // never bound; let the normal error surface
  try {
    const current = await rawPing();
    if (current.pid !== boundIdentity.pid || current.startedAt !== boundIdentity.startedAt) {
      markStale();
      return true;
    }
    return false;
  } catch {
    markStale();
    return true;
  }
}

const STALE_MSG = "Lost the connection to the local server — restart the app to reconnect.";

/**
 * Every request gives up after this, so a stalled call never holds its polling
 * chain forever. Calls that legitimately wait on Copilot for longer (queueing a
 * batch of reviews, a rephrase queued behind a reviewer chat) pass their own
 * `timeoutMs`; 0 means no limit.
 */
export const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** setTimeout fires at once for delays past 2³¹−1 ms, so longer limits mean none. */
const MAX_TIMER_MS = 2_147_483_647;

/** The caller's signal, if any, plus a timeout. */
function withTimeout(signal: AbortSignal | null | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = ms > 0 && ms <= MAX_TIMER_MS
    ? window.setTimeout(() => controller.abort(new DOMException(`The request took longer than ${ms / 1000}s.`, "TimeoutError")), ms)
    : undefined;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function api(path: string, opts?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...init } = opts || {};
  const limit = withTimeout(init.signal, timeoutMs);
  let r: Response;
  let text: string;
  try {
    try {
      r = await fetch(path, { ...init, signal: limit.signal });
    } catch (e) {
      if ((e as Error)?.name === "TimeoutError" || limit.signal.reason?.name === "TimeoutError") {
        throw new Error(`The app didn't answer within ${timeoutMs / 1000}s. Try again.`);
      }
      if ((e as Error)?.name === "AbortError") throw e;
      if (await checkStale()) throw new Error(STALE_MSG);
      throw e;
    }
    text = await r.text();
  } finally {
    limit.done();
  }
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  if (!r.ok) {
    if (await checkStale()) throw new Error(STALE_MSG);
    // The status and body ride along, for callers that act on a 409's current state.
    throw Object.assign(new Error((data && data.error) || text || r.statusText), { status: r.status, data });
  }
  return data;
}

/** An error thrown by `api`, with the response's status and parsed body. */
export type ApiError = Error & { status?: number; data?: any };

export const getJSON = (p: string): Promise<any> => api(p);

export const postJSON = (p: string, body: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<any> =>
  api(p, {
    ...opts,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
