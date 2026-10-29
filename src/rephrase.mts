// Optionally rephrase a staged review comment before it is posted to ADO.
// Generation runs in a throwaway headless SDK session that is deleted
// afterwards, so it leaves nothing behind in the session list.
//
// When the review recorded which session produced it, api.mts instead runs
// buildRephrasePrompt inside that session (see reviewer-session.mts) and falls
// back to this throwaway path.
import { runOneShot } from "./copilot-runtime.mjs";

export interface RephraseInput {
    comment: string;
    title?: string;
    model?: string;
    /** What the user asked to change this time ("shorter", "softer", "mention the rollout"). */
    instructions?: string;
    /** The user's writing voice (their in-my-language skill), when they have it. */
    voice?: string | null;
}

export const REPHRASE_INSTRUCTIONS_MAX = 1000;

export function buildRephrasePrompt(input: RephraseInput): string {
    const original = (input.title ? `Title: ${input.title}\n` : "") + input.comment;
    const asked = (input.instructions || "").trim().slice(0, REPHRASE_INSTRUCTIONS_MAX);
    return [
        "Rewrite the following code-review comment so it reads like a natural, concise note a human reviewer would leave on a pull request.",
        input.voice
            ? "The user posts it under their own name, so write it in their own language: follow their in-my-language skill below. Keep the technical substance and any suggested fix."
            : "Use plain, direct English. Keep the technical substance and any suggested fix, but strip robotic phrasing, hedging, filler, and AI tells so it does not sound AI-generated at all.",
        "Keep it short — one to three sentences. No greetings, no sign-offs.",
        ...(asked
            ? [
                  "",
                  "The user asked for this change:",
                  asked,
                  "Follow it. It takes priority over the length and tone rules above, but keep the technical facts accurate and don't add claims the comment doesn't support.",
              ]
            : []),
        "Output ONLY the rewritten comment text: no preamble, no surrounding quotes, no markdown headers.",
        ...(input.voice ? ["", input.voice] : []),
        "",
        "Comment to rewrite:",
        original,
    ].join("\n");
}

// Strip a single pair of wrapping quotes the model may have added despite the
// instruction, plus surrounding whitespace.
export function cleanRephrase(out: string): string {
    let text = (out || "").trim();
    if (
        text.length >= 2 &&
        ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    ) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

export async function rephraseComment(input: RephraseInput): Promise<string> {
    const text = cleanRephrase(
        await runOneShot(buildRephrasePrompt(input), { model: input.model, timeoutMs: 90_000 }),
    );
    if (!text) throw new Error("empty rephrase");
    return text;
}
