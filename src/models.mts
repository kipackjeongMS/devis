// Live model discovery through the Copilot SDK catalog used by the CLI itself.

import type { ModelInfo } from "@github/copilot-sdk";
import { withCopilotClient } from "./copilot-runtime.mjs";

let inFlight: Promise<string[]> | null = null;

function modelIds(models: ModelInfo[]): string[] {
    return [
        ...new Set(
            models
                .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
                .filter((id) => id && id !== "auto"),
        ),
    ];
}

async function probe(): Promise<string[]> {
    const models = modelIds(await withCopilotClient((client) => client.listModels()));
    if (!models.length) throw new Error("Copilot returned no available models");
    return models;
}

export async function getAvailableModels(): Promise<string[]> {
    if (!inFlight) {
        inFlight = probe().finally(() => {
            inFlight = null;
        });
    }
    return inFlight;
}
