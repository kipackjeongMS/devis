export interface PrCanvasTarget {
    org: string;
    project: string;
    repoId: string;
    prId: string;
}

function requiredString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/** Validate and normalize the target accepted by canvas.open and /api/pr-summary. */
export function parsePrCanvasTarget(input: unknown): PrCanvasTarget | null {
    if (input == null) return null;
    if (typeof input !== "object" || Array.isArray(input)) {
        throw new Error("PR canvas input must be an object");
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length === 0) return null;
    const org = requiredString(record.org);
    const project = requiredString(record.project);
    const repoId = requiredString(record.repoId);
    const rawPrId = record.prId;
    const prId =
        typeof rawPrId === "number" && Number.isSafeInteger(rawPrId) && rawPrId > 0
            ? String(rawPrId)
            : typeof rawPrId === "string" && /^[1-9]\d*$/.test(rawPrId.trim())
              ? rawPrId.trim()
              : null;
    if (!org || !project || !repoId || !prId) {
        throw new Error("PR canvas input requires org, project, repoId, and a positive prId");
    }
    return { org, project, repoId, prId };
}

export function targetUrl(baseUrl: string, target: PrCanvasTarget): string {
    const url = new URL(baseUrl);
    url.searchParams.set("org", target.org);
    url.searchParams.set("project", target.project);
    url.searchParams.set("repoId", target.repoId);
    url.searchParams.set("prId", target.prId);
    return url.toString();
}
