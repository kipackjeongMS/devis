// Humanize a staged AI review comment into a natural, plain-English note before
// it is posted to ADO. Generation runs headlessly via `copilot -p` (print mode)
// as a throwaway subprocess — it produces NO visible session in the app, and the
// arbitrary comment text is passed as a single argv element (execFile, no shell)
// so quotes/newlines/special chars can't break out. Mirrors the subprocess
// pattern already used by models.mts.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

export interface RephraseInput {
    comment: string;
    title?: string;
    model?: string;
}

function buildPrompt(input: RephraseInput): string {
    const original = (input.title ? `Title: ${input.title}\n` : "") + input.comment;
    return [
        "Rewrite the following code-review comment so it reads like a natural, concise note a human reviewer would leave on a pull request.",
        "Use plain, direct English. Keep the technical substance and any suggested fix, but strip robotic phrasing, hedging, filler, and AI tells so it does not sound AI-generated at all.",
        "Keep it short — one to three sentences. No greetings, no sign-offs.",
        "Output ONLY the rewritten comment text: no preamble, no surrounding quotes, no markdown headers.",
        "",
        "Comment to rewrite:",
        original,
    ].join("\n");
}

// Strip a single pair of wrapping quotes the model may have added despite the
// instruction, plus surrounding whitespace.
function clean(out: string): string {
    let text = (out || "").trim();
    if (
        text.length >= 2 &&
        ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    ) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

export function rephraseComment(input: RephraseInput): Promise<string> {
    const model = (input.model && input.model.trim()) || "auto";
    const args = [
        "-p", buildPrompt(input),
        "--model", model,
        "-s",
        "--no-color",
        "--no-custom-instructions",
        "--allow-all-tools",
    ];
    return new Promise((resolve, reject) => {
        execFile(
            "copilot",
            args,
            { timeout: 90_000, maxBuffer: 4 << 20, cwd: tmpdir(), windowsHide: true },
            (err, stdout) => {
                if (err) return reject(new Error(err.message || "rephrase failed"));
                const text = clean(stdout);
                if (!text) return reject(new Error("empty rephrase"));
                resolve(text);
            },
        );
    });
}
