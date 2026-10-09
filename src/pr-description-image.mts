import https from "node:https";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { getAzToken } from "./azauth.mjs";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class PrDescriptionImageError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export interface ValidatedPrDescriptionImageUrl {
    url: URL;
    expectedContentType: "image/png" | "image/jpeg";
}

export interface PrDescriptionImage {
    body: Buffer;
    contentType: "image/png" | "image/jpeg";
}

interface BinaryResponse {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

function normalizedOrg(org: string): string {
    const value = org.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
        throw new PrDescriptionImageError("A valid Azure DevOps organization is required", 400);
    }
    return value;
}

function pathOrganization(url: URL): string {
    const segment = url.pathname.split("/").filter(Boolean)[0] || "";
    try {
        return decodeURIComponent(segment).toLowerCase();
    } catch {
        return "";
    }
}

function isOrganizationAdoUrl(org: string, url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return (
        (host === "dev.azure.com" && pathOrganization(url) === org) ||
        host === `${org}.visualstudio.com`
    );
}

function expectedContentType(url: URL): "image/png" | "image/jpeg" | null {
    const candidates = [
        url.pathname,
        ...Array.from(url.searchParams.entries())
            .filter(([key]) => /^(?:file-?name|path)$/i.test(key))
            .map(([, value]) => value),
    ];
    for (const candidate of candidates) {
        if (/\.png$/i.test(candidate)) return "image/png";
        if (/\.jpe?g$/i.test(candidate)) return "image/jpeg";
    }
    return null;
}

export function validatePrDescriptionImageUrl(
    org: string,
    rawUrl: string,
): ValidatedPrDescriptionImageUrl {
    const expectedOrg = normalizedOrg(org);
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new PrDescriptionImageError("The PR image URL is invalid", 400);
    }
    if (url.protocol !== "https:") {
        throw new PrDescriptionImageError("PR images must use HTTPS", 400);
    }
    if (url.username || url.password) {
        throw new PrDescriptionImageError("PR image URLs cannot contain credentials", 400);
    }
    if (!isOrganizationAdoUrl(expectedOrg, url)) {
        throw new PrDescriptionImageError(
            "The PR image URL must belong to the selected Azure DevOps organization",
            400,
        );
    }
    const contentType = expectedContentType(url);
    if (!contentType) {
        throw new PrDescriptionImageError("Only PNG or JPEG PR images are supported", 400);
    }
    return { url, expectedContentType: contentType };
}

export function isAllowedPrImageRedirect(org: string, url: URL): boolean {
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const expectedOrg = normalizedOrg(org);
    const host = url.hostname.toLowerCase();
    return isOrganizationAdoUrl(expectedOrg, url) || host.endsWith(".vsassets.io");
}

export function normalizePrImageContentType(
    value: string | string[] | undefined,
): "image/png" | "image/jpeg" | null {
    const contentType = (Array.isArray(value) ? value[0] : value || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
    if (contentType === "image/png") return "image/png";
    if (contentType === "image/jpeg" || contentType === "image/jpg") return "image/jpeg";
    return null;
}

function requestBinary(url: URL, token: string | null): Promise<BinaryResponse> {
    return new Promise((resolve, reject) => {
        const headers: OutgoingHttpHeaders = {
            Accept: "image/png, image/jpeg",
        };
        if (token) headers.Authorization = `Bearer ${token}`;

        const req = https.request(url, { method: "GET", headers }, (res) => {
            const contentLength = Number(res.headers["content-length"]);
            if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
                res.resume();
                reject(new PrDescriptionImageError("The PR image is larger than 10 MB", 413));
                return;
            }

            const chunks: Buffer[] = [];
            let total = 0;
            let rejected = false;
            res.on("data", (chunk: Buffer) => {
                if (rejected) return;
                total += chunk.length;
                if (total > MAX_IMAGE_BYTES) {
                    rejected = true;
                    res.destroy();
                    reject(new PrDescriptionImageError("The PR image is larger than 10 MB", 413));
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => {
                if (rejected) return;
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
            res.on("error", (error) => {
                if (!rejected) reject(error);
            });
        });
        req.setTimeout(30_000, () => req.destroy(new Error("Timed out loading the PR image")));
        req.on("error", reject);
        req.end();
    });
}

export async function getPrDescriptionImage(
    org: string,
    rawUrl: string,
): Promise<PrDescriptionImage> {
    const validated = validatePrDescriptionImageUrl(org, rawUrl);
    const expectedOrg = normalizedOrg(org);
    const token = await getAzToken(ADO_RESOURCE);
    let current = validated.url;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        const response = await requestBinary(
            current,
            isOrganizationAdoUrl(expectedOrg, current) ? token : null,
        );
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.location;
            if (!location) {
                throw new PrDescriptionImageError("Azure DevOps returned an invalid image redirect", 502);
            }
            if (redirect === MAX_REDIRECTS) {
                throw new PrDescriptionImageError("The PR image redirected too many times", 502);
            }
            const next = new URL(location, current);
            if (!isAllowedPrImageRedirect(expectedOrg, next)) {
                throw new PrDescriptionImageError("Azure DevOps redirected the image to an unsupported host", 502);
            }
            current = next;
            continue;
        }
        if (response.status === 404) {
            throw new PrDescriptionImageError("The PR image was not found", 404);
        }
        if (response.status < 200 || response.status >= 300) {
            throw new PrDescriptionImageError(
                `Azure DevOps could not load the PR image (${response.status})`,
                502,
            );
        }
        const contentType = normalizePrImageContentType(response.headers["content-type"]);
        if (!contentType) {
            throw new PrDescriptionImageError("Azure DevOps returned an unsupported image type", 502);
        }
        return { body: response.body, contentType };
    }

    throw new PrDescriptionImageError("The PR image could not be loaded", 502);
}
