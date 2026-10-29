// Live model discovery through the Copilot SDK catalog used by the CLI itself.

import type { CopilotSession, ModelInfo } from "@github/copilot-sdk";
import { withCopilotClient } from "./copilot-runtime.mjs";

/** A model the user's Copilot can run, with the reasoning efforts it takes (none when it takes none). */
export interface ModelChoice {
    id: string;
    name: string;
    efforts: string[];
}

/** An effort as the runtime spells it ("none", "low" … "max"); BYOK providers may add their own. */
export const EFFORT_ID = /^[a-z][a-z0-9-]{0,19}$/;

let inFlight: Promise<ModelChoice[]> | null = null;

export function modelChoices(models: ModelInfo[]): ModelChoice[] {
    const seen = new Set<string>();
    const out: ModelChoice[] = [];
    for (const model of models) {
        const id = typeof model.id === "string" ? model.id.trim() : "";
        if (!id || id === "auto" || seen.has(id)) continue;
        seen.add(id);
        const efforts = Array.isArray(model.supportedReasoningEfforts)
            ? [...new Set((model.supportedReasoningEfforts as unknown[]).filter((e): e is string => typeof e === "string" && EFFORT_ID.test(e)))]
            : [];
        out.push({ id, name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id, efforts });
    }
    return out;
}

async function probe(): Promise<ModelChoice[]> {
    const models = modelChoices(await withCopilotClient((client) => client.listModels()));
    if (!models.length) throw new Error("Copilot returned no available models");
    return models;
}

/** Every model the user's Copilot can run, with its efforts. Concurrent calls share one read. */
export function getModelCatalog(): Promise<ModelChoice[]> {
    if (!inFlight) {
        inFlight = probe().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}

export async function getAvailableModels(): Promise<string[]> {
    return (await getModelCatalog()).map((m) => m.id);
}

/**
 * Why `effort` can't go with `model`, or null. An effort needs a chosen model ("" leaves the
 * model to Copilot, so its efforts aren't known), and must be one that model lists. Without
 * a catalog only its spelling is checked; the runtime refuses what the model doesn't take.
 */
export function effortProblem(model: string, effort: string, catalog: ModelChoice[] | null): string | null {
    if (!effort) return null;
    if (!EFFORT_ID.test(effort)) return "Unknown reasoning effort.";
    if (!model) return "Choose a model before its reasoning effort; the Copilot default picks its own.";
    const entry = catalog?.find((m) => m.id === model);
    if (!entry) return null;
    if (!entry.efforts.length) return `${model} doesn't take a reasoning effort.`;
    if (!entry.efforts.includes(effort)) return `${model} takes ${entry.efforts.join(", ")}, not ${effort}.`;
    return null;
}

/** The effort to keep when the model changes: the same one when the new model takes it, else none. */
export function carriedEffort(model: string, effort: string, catalog: ModelChoice[] | null): string {
    if (!effort || !model) return "";
    const entry = catalog?.find((m) => m.id === model);
    return entry && entry.efforts.includes(effort) ? effort : "";
}

/** What a session is running: its model and, when one is set, its reasoning effort. */
export interface ModelState {
    model: string | null;
    effort: string | null;
}

type ModelRpc = { rpc: { model: Pick<CopilotSession["rpc"]["model"], "getCurrent" | "switchTo"> } };

export async function sessionModelState(session: ModelRpc): Promise<ModelState> {
    try {
        const current = await session.rpc.model.getCurrent();
        return { model: current.modelId || null, effort: current.reasoningEffort || null };
    } catch {
        return { model: null, effort: null };
    }
}

/**
 * Switch a session's model and effort ("" for the model's own default) and keep its
 * conversation. During a turn the runtime defers the switch until the turn ends.
 */
export async function switchSessionModel(session: ModelRpc, model: string, effort: string): Promise<{ deferred: boolean }> {
    const result = await session.rpc.model.switchTo({ modelId: model, reasoningEffort: effort || null, deferIfModelChangeQueued: true });
    return { deferred: !!result?.deferred };
}
