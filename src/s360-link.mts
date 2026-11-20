// Links an S360 item shows: any https link for its guidance or work item, and only links into the
// S360 portal for where the item is (what a to-do made from it keeps). Anything else is "", so a
// link the page shows can't run script.

/** An https link, whole; "" for anything else. */
export function webLink(value: unknown): string {
    if (typeof value !== "string" || value.length > 2000) return "";
    try {
        const u = new URL(value.trim());
        return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
    } catch {
        return "";
    }
}

/** A link into the S360 portal (*.s360.msftcloudes.com); "" for anything else. */
export function s360Link(value: unknown): string {
    const link = webLink(value);
    if (!link) return "";
    const host = new URL(link).hostname.toLowerCase();
    return host === "s360.msftcloudes.com" || host.endsWith(".s360.msftcloudes.com") ? link : "";
}
