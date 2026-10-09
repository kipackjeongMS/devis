function imageTypeFromUrl(url: URL): "png" | "jpeg" | null {
  const candidates = [
    url.pathname,
    ...Array.from(url.searchParams.entries())
      .filter(([key]) => /^(?:file-?name|path)$/i.test(key))
      .map(([, value]) => value),
  ];
  for (const candidate of candidates) {
    if (/\.png$/i.test(candidate)) return "png";
    if (/\.jpe?g$/i.test(candidate)) return "jpeg";
  }
  return null;
}

function isOrganizationAdoImage(org: string, rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || !imageTypeFromUrl(url)) {
    return false;
  }

  const expectedOrg = org.trim().toLowerCase();
  const host = url.hostname.toLowerCase();
  if (host === `${expectedOrg}.visualstudio.com`) return true;
  if (host !== "dev.azure.com") return false;

  const pathOrg = url.pathname.split("/").filter(Boolean)[0] || "";
  try {
    return decodeURIComponent(pathOrg).toLowerCase() === expectedOrg;
  } catch {
    return false;
  }
}

function showImageFallback(image: HTMLImageElement, originalUrl: string): void {
  const fallback = document.createElement("a");
  fallback.className = "pr-desc-image-fallback";
  fallback.href = originalUrl;
  fallback.target = "_blank";
  fallback.rel = "noopener noreferrer";
  fallback.textContent = image.alt.trim()
    ? `Open image in Azure DevOps: ${image.alt.trim()}`
    : "Open image in Azure DevOps";
  image.replaceWith(fallback);
}

export function hydratePrDescriptionImages(root: HTMLElement, org: string): void {
  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    const originalUrl = image.getAttribute("src") || "";
    if (!isOrganizationAdoImage(org, originalUrl)) continue;

    root.classList.add("has-images");
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => showImageFallback(image, originalUrl), { once: true });
    image.src =
      `/api/pr-description-image?org=${encodeURIComponent(org)}` +
      `&url=${encodeURIComponent(originalUrl)}`;
  }
}
