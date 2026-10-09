export function canonicalReviewFilePath(value: string | null | undefined): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
  return normalized ? `/${normalized}` : "";
}
