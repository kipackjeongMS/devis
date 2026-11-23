// The app's color theme, shell side. The pref is saved in the shell's data folder (the page's
// own storage is per service port, which changes when the service restarts) and passed to each
// page in its URL. The shell sets nativeTheme.themeSource to it, which also drives every page's
// prefers-color-scheme, the Windows backdrop's tint and the caption buttons. Kept free of Electron
// so it can be tested.

export type ThemePref = "dark" | "light" | "system";

export function isThemePref(value: unknown): value is ThemePref {
    return value === "dark" || value === "light" || value === "system";
}

/** A saved or requested pref; anything unknown is the default, dark. */
export function themePrefOf(value: unknown): ThemePref {
    return isThemePref(value) ? value : "dark";
}

export interface FrameColors {
    /** The window's own background, painted before the page; clear over the glass backdrop. */
    background: string;
    /** The strip behind the caption buttons. */
    overlay: string;
    /** The caption buttons' glyphs. */
    symbol: string;
}

/** The native frame for a resolved theme. The solid colors match the page's field (--ink). */
export function frameColors(dark: boolean, glass: boolean): FrameColors {
    const field = dark ? "#050505" : "#ebebeb";
    return {
        background: glass ? "#00000000" : field,
        overlay: glass ? "#00000000" : field,
        symbol: dark ? "#f2f2f2" : "#1b1b1b",
    };
}

/** The script that tells a page the pref changed. */
export function themeScript(pref: ThemePref): string {
    return `window.dispatchEvent(new CustomEvent("devis:theme", { detail: ${JSON.stringify(pref)} }))`;
}
