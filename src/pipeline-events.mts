// What happens to pipeline chain runs, for anything that follows them (a Jarvis task's
// validation). The store and the runner say what happened; listeners never block them.

export type PipelineEvent =
    | { type: "runStarted"; chainId: string; runId: string }
    | { type: "runFinished"; chainId: string; runId: string; status: string };

type Listener = (event: PipelineEvent) => void | Promise<void>;

const listeners = new Set<Listener>();

export function onPipelineEvent(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emitPipelineEvent(event: PipelineEvent): void {
    for (const listener of [...listeners]) {
        try {
            const result = listener(event);
            if (result && typeof (result as Promise<void>).catch === "function") {
                (result as Promise<void>).catch((error: Error) => console.error(`[pipelines] ${event.type} listener: ${error.message}`));
            }
        } catch (error) {
            console.error(`[pipelines] ${event.type} listener: ${(error as Error).message}`);
        }
    }
}
