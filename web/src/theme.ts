// The color theme, page side. themeBoot.js sets it before first paint; this keeps it current: the
// user's pick in Settings, Windows' own setting (for "system"), and picks made in other windows.
// In the desktop shell the pref lives with the shell (it survives the service moving ports) and
// comes in the URL; in a plain browser it lives in this origin's storage.

export type ThemePref = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export const THEME_PREFS: ReadonlyArray<{ value: ThemePref; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Use Windows setting" },
];

const STORAGE_KEY = "devis.theme";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function themePrefOf(value: unknown): ThemePref {
  return value === "light" || value === "system" ? value : "dark";
}

export function resolveTheme(pref: ThemePref, prefersLight: boolean): Theme {
  return pref === "light" || (pref === "system" && prefersLight) ? "light" : "dark";
}

// The shell puts ?shell= on every page it loads (see main.mts load()).
const inShell = (): boolean => new URLSearchParams(location.search).has("shell");

export function themePref(): ThemePref {
  return themePrefOf(document.documentElement.dataset.themePref);
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function apply(pref: ThemePref): void {
  const root = document.documentElement;
  const theme = resolveTheme(pref, matchMedia(LIGHT_QUERY).matches);
  const changed = root.dataset.theme !== theme || root.dataset.themePref !== pref;
  root.dataset.themePref = pref;
  root.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
  if (changed) window.dispatchEvent(new CustomEvent("devis:theme-applied", { detail: { pref, theme } }));
}

// So a reload (View > Reload, or a sign-in restart) opens in the pref the shell now holds.
function rememberInUrl(pref: ThemePref): void {
  const url = new URL(location.href);
  if (url.searchParams.get("theme") === pref) return;
  url.searchParams.set("theme", pref);
  history.replaceState(history.state, "", url);
}

/** The user's pick: applies here at once, then every other window follows. */
export function setThemePref(pref: ThemePref): void {
  apply(pref);
  if (inShell()) {
    rememberInUrl(pref);
    window.open(`/?shell-request=theme&value=${pref}`, "_blank");
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Not saved: this page keeps it until it reloads.
    }
  }
}

let following = false;
/** Start following theme changes. Every page calls this once, through applyShellClasses. */
export function followTheme(): void {
  if (following) return;
  following = true;
  apply(themePref());
  matchMedia(LIGHT_QUERY).addEventListener("change", () => apply(themePref()));
  window.addEventListener("devis:theme", (event) => {
    const pref = themePrefOf((event as CustomEvent).detail);
    rememberInUrl(pref);
    apply(pref);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && !inShell()) apply(themePrefOf(event.newValue));
  });
}
