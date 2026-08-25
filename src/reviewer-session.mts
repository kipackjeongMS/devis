// Run a follow-up subtask inside the exact Copilot session that produced a PR
// review. Elaborate and rephrase-before-post are conversational continuations of
// the review, so resuming the reviewer session gives them the diffs, findings and
// reasoning that session already holds — instead of re-deriving them from a bare
// prompt in a throwaway process.
//
// Transport is `copilot --resume <sessionId> -p <prompt>`: a print-mode
// subprocess that works whether or not the session is currently loaded in the
// app, creates no new visible session, and appends the follow-up to that
// session's history so it is still there on a later revisit.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

// Strict UUID. Session ids reach us over the loopback API from the webview, and
// `--resume` also accepts names and id prefixes — anything looser could resolve
// to a different session than the one that did the review.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrow an untrusted value to a session id safe to hand to `--resume`. */
export function asReviewerSessionId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const id = value.trim();
    return SESSION_ID_RE.test(id) ? id : null;
}

// One `copilot --resume` at a time per session: concurrent resumes of the same
// session would interleave writes into a single event log. Different sessions
// still run in parallel.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    // `previous` is always a settled-or-pending chain that never rejects.
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const started = previous.then(task);
    const tail = started.catch(() => undefined);
    queues.set(sessionId, tail);
    void tail.then(() => {
        if (queues.get(sessionId) === tail) queues.delete(sessionId);
    });
    return started;
}

export interface ReviewerSessionRun {
    sessionId: string;
    prompt: string;
    timeoutMs?: number;
}

/**
 * Send `prompt` to an existing session and resolve with its reply text.
 *
 * The model is deliberately not overridden: the reviewer session keeps whatever
 * model it reviewed with. Custom instructions are disabled so the reply is the
 * requested text and nothing else.
 */
export function runInReviewerSession(run: ReviewerSessionRun): Promise<string> {
    const sessionId = asReviewerSessionId(run.sessionId);
    if (!sessionId) return Promise.reject(new Error("invalid reviewer session id"));
    const prompt = run.prompt;
    const timeout = run.timeoutMs ?? 180_000;

    return enqueue(sessionId, () =>
        new Promise<string>((resolve, reject) => {
            execFile(
                "copilot",
                [
                    "--resume", sessionId,
                    "-p", prompt,
                    "-s",
                    "--no-color",
                    "--no-custom-instructions",
                ],
                { timeout, maxBuffer: 8 << 20, cwd: tmpdir(), windowsHide: true },
                (err, stdout, stderr) => {
                    if (err) {
                        const detail = String(stderr || "").trim().split("\n").slice(-3).join(" ").trim();
                        return reject(
                            new Error(
                                `reviewer session ${sessionId} failed: ${err.message || "unknown error"}` +
                                    (detail ? ` — ${detail}` : ""),
                            ),
                        );
                    }
                    const text = String(stdout || "").trim();
                    if (!text) return reject(new Error("reviewer session returned an empty reply"));
                    resolve(text);
                },
            );
        }),
    );
}
