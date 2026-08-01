// Thin fetch wrapper: parses JSON, surfaces API error messages as thrown Errors.
//
// Also detects a stale connection: the loopback server binds a fresh
// ephemeral port on every extension (re)start, but this page caches the URL
// from whenever the canvas panel was opened. If the extension process gets
// reloaded, this page is left talking to a dead/mismatched server. bindIdentity()
// captures who we're bound to at boot; any later failure re-pings to tell a
// genuine app error apart from "the extension moved on without me".
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
  const r = await fetch("/api/ping");
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

const STALE_MSG = "Extension was reloaded — close and reopen this panel to reconnect.";

export async function api(path: string, opts?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(path, opts);
  } catch (e) {
    if (await checkStale()) throw new Error(STALE_MSG);
    throw e;
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  if (!r.ok) {
    if (await checkStale()) throw new Error(STALE_MSG);
    throw new Error((data && data.error) || text || r.statusText);
  }
  return data;
}

export const getJSON = (p: string): Promise<any> => api(p);

export const postJSON = (p: string, body: unknown): Promise<any> =>
  api(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
