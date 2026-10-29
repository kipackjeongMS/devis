// Page classes the desktop shell asks for in the URL. Shared by the main window and the code window.
import { pickRenderMode, probeSoftwareRendering } from "./renderMode.js";

export function applyShellClasses(params: URLSearchParams): void {
  const root = document.documentElement;
  // The desktop shell overlays the caption buttons (wco) and may paint a Mica backdrop behind the glass field.
  const shellKind = params.get("shell");
  if (shellKind) root.classList.add("wco");
  if (shellKind === "glass") root.classList.add("glass");
  // Drawn without a GPU, effects that cost per frame are dropped (html.lean).
  if (pickRenderMode(params.get("render"), probeSoftwareRendering) === "lean") root.classList.add("lean");
}
