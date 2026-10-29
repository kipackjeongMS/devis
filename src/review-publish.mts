// Validation and persistence for the `publish_review` tool a reviewer session
// calls when its review is complete.

import {
    appendReviewFindings,
    ensureDb,
    publishReviewJobRun,
    type Finding,
    type SemanticFinding,
} from "./store.mjs";

/** The PR a reviewer session was started for; publishes must match it exactly. */
export interface ReviewPublishTarget {
    prId: string;
    org: string;
    project: string;
    repoId: string;
    /** The run the session was started for, when known. */
    runId?: string;
}

export const PUBLISH_REVIEW_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["prId", "runId", "org", "project", "repoId", "status"],
    properties: {
        prId: {
            oneOf: [
                { type: "integer", minimum: 1 },
                { type: "string", pattern: "^[1-9][0-9]*$" },
            ],
        },
        runId: { type: "string", minLength: 1 },
        org: { type: "string" },
        project: { type: "string" },
        repoId: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: ["done", "error"] },
        summary: { type: "string" },
        story: { type: "string" },
        error: { type: "string" },
        findings: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: [
                    "file",
                    "line",
                    "side",
                    "severity",
                    "comment",
                    "technicalExplanation",
                ],
                properties: {
                    file: { type: "string", minLength: 1 },
                    line: { type: "integer", minimum: 1 },
                    endLine: { type: ["integer", "null"], minimum: 1 },
                    side: { type: "string", enum: ["left", "right"] },
                    severity: {
                        type: "string",
                        enum: ["critical", "high", "medium", "low", "nit"],
                    },
                    title: { type: ["string", "null"] },
                    comment: { type: "string", minLength: 1 },
                    technicalExplanation: { type: "string", minLength: 1 },
                },
            },
        },
        semanticFindings: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["category", "severity", "title", "comment"],
                properties: {
                    category: {
                        type: "string",
                        enum: [
                            "intent",
                            "architecture",
                            "behavior",
                            "contract",
                            "compatibility",
                            "operability",
                            "testing",
                        ],
                    },
                    severity: {
                        type: "string",
                        enum: ["critical", "high", "medium", "low"],
                    },
                    title: { type: "string", minLength: 1 },
                    comment: { type: "string", minLength: 1 },
                    files: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                    },
                },
            },
        },
    },
} as const;

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

/** Validate a reviewer session's `publish_review` call and persist its review. */
export async function publishReview(
    input: unknown,
    target: ReviewPublishTarget,
    reviewerSessionId: string | null,
): Promise<{
    ok: true;
    prId: string;
    status: "done" | "error";
}> {
    const record = asRecord(input, "publish_review input");
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
        repoId !== target.repoId ||
        (target.runId !== undefined && runId !== target.runId)
    ) {
        throw new Error("publish_review input does not match this review's PR");
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
        // Taken from the tool invocation, not from `input`: the reviewing
        // agent cannot forge or omit it.
        reviewerSessionId,
    });
    return { ok: true, prId, status };
}

/**
 * Input of the reviewer chat's `add_review_findings` tool. The target review is
 * never part of the input: it is the review this session produced.
 */
export const ADD_REVIEW_FINDINGS_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        findings: PUBLISH_REVIEW_SCHEMA.properties.findings,
        semanticFindings: PUBLISH_REVIEW_SCHEMA.properties.semanticFindings,
    },
} as const;

const MAX_ADDED_FINDINGS = 50;

/** Validate an `add_review_findings` call and stage its findings on this session's review. */
export async function addReviewFindings(
    input: unknown,
    reviewerSessionId: string,
): Promise<{ prId: string; findings: number; semanticFindings: number; duplicates: number; message: string }> {
    const record = asRecord(input, "add_review_findings input");
    for (const key of Object.keys(record)) {
        if (key !== "findings" && key !== "semanticFindings") throw new Error(`unexpected field ${key}`);
    }
    if (record.findings != null && !Array.isArray(record.findings)) throw new Error("findings must be an array");
    if (record.semanticFindings != null && !Array.isArray(record.semanticFindings)) {
        throw new Error("semanticFindings must be an array");
    }
    const findings = ((record.findings as unknown[] | undefined) || []).map(parseFinding);
    const semanticFindings = ((record.semanticFindings as unknown[] | undefined) || []).map(parseSemanticFinding);
    if (!findings.length && !semanticFindings.length) {
        throw new Error("Provide at least one entry in findings or semanticFindings");
    }
    if (findings.length + semanticFindings.length > MAX_ADDED_FINDINGS) {
        throw new Error(`Add at most ${MAX_ADDED_FINDINGS} findings per call`);
    }

    await ensureDb();
    const result = appendReviewFindings(reviewerSessionId, findings, semanticFindings);
    const prId = result.review.pr_id;
    const parts: string[] = [];
    if (result.findings.length) parts.push(`${result.findings.length} inline finding(s)`);
    if (result.semanticFindings.length) parts.push(`${result.semanticFindings.length} PR-level finding(s)`);
    const skipped = result.duplicates ? ` Skipped ${result.duplicates} already staged.` : "";
    const message = parts.length
        ? `Added ${parts.join(" and ")} to the Devis review of PR #${prId}. They are staged in the PR detail view for the user to post; nothing was posted to Azure DevOps.${skipped}`
        : `Nothing new was added to the review of PR #${prId}: every finding is already staged.`;
    return {
        prId,
        findings: result.findings.length,
        semanticFindings: result.semanticFindings.length,
        duplicates: result.duplicates,
        message,
    };
}
