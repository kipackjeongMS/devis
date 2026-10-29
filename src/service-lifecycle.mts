// When the background service may exit: no window attached and nothing in
// flight (worker turns, recaps, the Lead, reviews, pipeline runs) for a grace
// period. Features report their work through sources registered here.

import type { WorkItem } from "./service-files.mjs";

export type WorkSource = () => WorkItem[] | Promise<WorkItem[]>;

export interface LifecycleOptions {
    /** No window and no work for this long, and the service exits. */
    idleExitMs: number;
    checkMs: number;
    onIdle: () => void;
    now?: () => number;
    /** A source that takes longer than this is skipped for that check. */
    sourceTimeoutMs?: number;
}

export class ServiceLifecycle {
    private readonly sources = new Map<string, WorkSource>();
    private attachedCount = 0;
    private idleSince: number | null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private checking = false;
    private done = false;
    private readonly now: () => number;

    constructor(private readonly options: LifecycleOptions) {
        this.now = options.now || Date.now;
        // A fresh service waits the grace period for its first window.
        this.idleSince = this.now();
    }

    register(name: string, source: WorkSource): void {
        this.sources.set(name, source);
    }

    get attached(): number {
        return this.attachedCount;
    }

    /** A window is showing the service; call the returned function when it's gone. */
    attach(): () => void {
        this.attachedCount++;
        this.idleSince = null;
        let detached = false;
        return () => {
            if (detached) return;
            detached = true;
            this.attachedCount--;
        };
    }

    /**
     * Everything in flight. A source that throws is logged and skipped, so a broken feature can't
     * pin the service forever; one that doesn't answer in time counts as busy, since it may be
     * slow because it's working, and exiting under it could cut a turn short.
     */
    async work(): Promise<WorkItem[]> {
        const limit = this.options.sourceTimeoutMs ?? 10_000;
        const timedOut = Symbol("timed out");
        const results = await Promise.all(
            [...this.sources].map(async ([name, source]): Promise<WorkItem[]> => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const result = await Promise.race([
                        Promise.resolve().then(source),
                        new Promise<typeof timedOut>((resolve) => {
                            timer = setTimeout(() => resolve(timedOut), limit);
                        }),
                    ]);
                    if (result !== timedOut) return result;
                    console.warn(`[service] ${name} activity didn't answer within ${limit} ms; counting it as busy`);
                    return [{ kind: "other", label: `${name} (not answering)` }];
                } catch (error) {
                    console.warn(`[service] couldn't read ${name} activity: ${(error as Error).message}`);
                    return [];
                } finally {
                    clearTimeout(timer);
                }
            }),
        );
        return results.flat();
    }

    /** One look: returns true when the service should exit now. */
    async check(): Promise<boolean> {
        if (this.done) return false;
        if (this.attachedCount > 0 || (await this.work()).length) {
            this.idleSince = null;
            return false;
        }
        // Read the clock after the sources: they can take a while.
        const now = this.now();
        if (this.attachedCount > 0) return false;
        if (this.idleSince === null) this.idleSince = now;
        return now - this.idleSince >= this.options.idleExitMs;
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (this.checking) return;
            this.checking = true;
            void this.check()
                .then((exit) => {
                    if (exit && !this.done) {
                        this.done = true;
                        this.stop();
                        this.options.onIdle();
                    }
                })
                .catch((error: Error) => console.warn(`[service] idle check failed: ${error.message}`))
                .finally(() => (this.checking = false));
        }, this.options.checkMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
