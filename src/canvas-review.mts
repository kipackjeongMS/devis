import {
    ensureDb,
    publishReviewJobRun,
    type Finding,
    type SemanticFinding,
} from "./store.mjs";
import type { PrCanvasTarget } from "./canvas-target.mjs";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${key} is required`);
    }
    return value.trim();
}

function optionalString(record: JsonRecord, key: string): string | undefined {
    const value = record[key];
    if (value == null) return undefined;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
}

function optionalInteger(record: JsonRecord, key: string): number | null {
    const value = record[key];
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${key} must be a positive integer`);
    }
    return value;
}

function parseFinding(value: unknown, index: number): Finding {
    const record = asRecord(value, `findings[${index}]`);
    const side = requiredString(record, "side");
    if (side !== "left" && side !== "right") {
        throw new Error(`findings[${index}].side must be left or right`);
    }
    const severity = requiredString(record, "severity");
    if (!["critical", "high", "medium", "low", "nit"].includes(severity)) {
        throw new Error(`findings[${index}].severity is invalid`);
    }
    const line = optionalInteger(record, "line");
    if (line == null) throw new Error(`findings[${index}].line is required`);
    const endLine = optionalInteger(record, "endLine");
    if (endLine != null && endLine < line) {
        throw new Error(`findings[${index}].endLine must be greater than or equal to line`);
    }
    const technicalExplanation = record.technicalExplanation;
    if (typeof technicalExplanation !== "string" || !technicalExplanation.trim()) {
        throw new Error(`findings[${index}].technicalExplanation is required`);
    }
    return {
        file: requiredString(record, "file"),
        line,
        endLine,
        side,
        severity,
        title: optionalString(record, "title") ?? null,
        comment: requiredString(record, "comment"),
        technicalExplanation: technicalExplanation.trim(),
    };
}

function parseSemanticFinding(value: unknown, index: number): SemanticFinding {
    const record = asRecord(value, `semanticFindings[${index}]`);
    const category = requiredString(record, "category");
    if (
        ![
            "intent",
            "architecture",
            "behavior",
            "contract",
            "compatibility",
            "operability",
            "testing",
        ].includes(category)
    ) {
        throw new Error(`semanticFindings[${index}].category is invalid`);
    }
    const severity = requiredString(record, "severity");
    if (!["critical", "high", "medium", "low"].includes(severity)) {
        throw new Error(`semanticFindings[${index}].severity is invalid`);
    }
    const rawFiles = record.files;
    if (rawFiles != null && !Array.isArray(rawFiles)) {
        throw new Error(`semanticFindings[${index}].files must be an array`);
    }
    const files = (rawFiles || []).map((file, fileIndex) => {
        if (typeof file !== "string" || !file.trim()) {
            throw new Error(`semanticFindings[${index}].files[${fileIndex}] must be a string`);
        }
        return file.trim();
    });
    return {
        category,
        severity,
        title: requiredString(record, "title"),
        comment: requiredString(record, "comment"),
        files: [...new Set(files)],
    };
}

/** Validate a child-session canvas action and persist its completed review. */
export async function publishCanvasReview(
    input: unknown,
    target: PrCanvasTarget,
    reviewerSessionId: string | null,
): Promise<{
    ok: true;
    prId: string;
    status: "done" | "error";
}> {
    const record = asRecord(input, "publishReview input");
    const rawPrId = record.prId;
    const prId =
        typeof rawPrId === "number" && Number.isSafeInteger(rawPrId) && rawPrId > 0
            ? String(rawPrId)
            : typeof rawPrId === "string" && /^[1-9]\d*$/.test(rawPrId.trim())
              ? rawPrId.trim()
              : "";
    if (!prId) throw new Error("prId must be a positive integer");
    const runId = requiredString(record, "runId");
    const org = requiredString(record, "org");
    const project = requiredString(record, "project");
    const repoId = requiredString(record, "repoId");
    if (
        prId !== target.prId ||
        org !== target.org ||
        project !== target.project ||
        repoId !== target.repoId
    ) {
        throw new Error("publishReview input does not match this canvas target");
    }

    const status = requiredString(record, "status");
    if (status !== "done" && status !== "error") {
        throw new Error("status must be done or error");
    }

    let findings: Finding[] | undefined;
    let semanticFindings: SemanticFinding[] | undefined;
    let summary: string | undefined;
    let story: string | undefined;
    let error: string | undefined;
    if (status === "done") {
        summary = requiredString(record, "summary");
        story = requiredString(record, "story");
        if (!Array.isArray(record.findings)) throw new Error("findings must be an array");
        findings = record.findings.map(parseFinding);
        if (!Array.isArray(record.semanticFindings)) {
            throw new Error("semanticFindings must be an array");
        }
        semanticFindings = record.semanticFindings.map(parseSemanticFinding);
    } else {
        error = requiredString(record, "error");
    }

    await ensureDb();
    publishReviewJobRun({
        prId,
        runId,
        org,
        project,
        repo: optionalString(record, "repo"),
        repoId,
        title: optionalString(record, "title"),
        status,
        summary,
        story,
        findings,
        semanticFindings,
        error,
        // Taken from the publishing extension process, not from `input`: the
        // reviewing agent cannot forge or omit it.
        reviewerSessionId,
    });
    return { ok: true, prId, status };
}
