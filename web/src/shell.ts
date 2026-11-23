// Page classes the desktop shell asks for in the URL. Shared by every window's entry script.
import { pickRenderMode, probeSoftwareRendering } from "./renderMode.js";
import { followTheme } from "./theme.js";

export function applyShellClasses(params: URLSearchParams): void {
  const root = document.documentElement;
  // The desktop shell overlays the caption buttons (wco) and may paint a Mica backdrop behind the glass field.
  const shellKind = params.get("shell");
  if (shellKind) root.classList.add("wco");
  if (shellKind === "glass") root.classList.add("glass");
  // Drawn without a GPU, effects that cost per frame are dropped (html.lean).
  if (pickRenderMode(params.get("render"), probeSoftwareRendering) === "lean") root.classList.add("lean");
  // themeBoot.js already set the theme; from here it follows Settings, Windows and the other windows.
  followTheme();
}
