// Electron entry: the window. The backend (the loopback UI/API server, the review
// and pipeline runners, the Workspace and its Copilot sessions) runs in the background
// service (service.mts), a process of its own. The window finds or starts it,
// shows its URL, and holds a connection open so the service knows a window is
// up. Closing the window leaves work in flight running; the service exits on its
// own once it's idle.
//
// Data lives under the userData folder (%APPDATA%\ADO PR Ops, see brand.mts); the service reads and writes it.

import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, shell, type BrowserWindowConstructorOptions, type WebContents } from "electron";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endService, ensureService, serviceFiles, serviceStatus, stopService, watchService, type ServiceStatus } from "./service-files.mjs";
import { APP_NAME, DATA_FOLDER, FORMER_APP_NAME } from "./brand.mjs";
import { CODE_WINDOW_MIN, codeWindowUrl, codeWindowWorker, isFocusMainUrl, parsePlacement, placeCodeWindow, type SavedPlacement } from "./code-window.mjs";
import { nextZoom, titleBarHeight, zoomCommand, zoomLevelOf } from "./ui-zoom.mjs";

// Kept from the app's first name: Windows ties toast settings to it.
const APP_ID = "AdoPrOps.Desktop";
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);
/** More losses than this within a minute and the window gives up instead of restarting the service again. */
const MAX_RECOVERIES = 3;

const appDir = dirname(fileURLToPath(import.meta.url));
const APP_ICON = join(appDir, "assets", "icon.png");
let mainWindow: BrowserWindow | null = null;
/** One code window per worker, keyed by its session id. */
const codeWindows = new Map<string, BrowserWindow>();
let origin = "";
let attachment: { close(): void } | null = null;
let quitting = false;
const recoveries: number[] = [];

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
// The data stays in the folder named for the app's first name (the name now would pick a new, empty one).
// Another data folder (a second copy, a test run) gets its own window lock and its own service.
app.setPath("userData", process.env.ADO_PR_OPS_USER_DATA || join(app.getPath("appData"), DATA_FOLDER));

function startMenuShortcutPath(name = APP_NAME): string {
    return join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", `${name}.lnk`);
}

/** The Start menu shortcut carries the AppUserModelID Windows needs for toasts. The one under the app's first name goes. */
function installShortcut(): boolean {
    rmSync(startMenuShortcutPath(FORMER_APP_NAME), { force: true });
    // "create" also overwrites; "replace" fails when the shortcut does not exist yet.
    return shell.writeShortcutLink(startMenuShortcutPath(), "create", {
        target: process.execPath,
        cwd: dirname(process.execPath),
        description: "Azure DevOps pull request review console",
        appUserModelId: APP_ID,
        icon: process.execPath,
        iconIndex: 0,
    });
}

function isWebUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

const TEAMS_LINK = /^https:\/\/teams\.microsoft\.com\/l\//i;

/** Open a link in the browser; a Teams link opens in the Teams app when it's installed. */
function openOutside(url: string): void {
    const inTeams = TEAMS_LINK.test(url) && !!app.getApplicationNameForProtocol("msteams://") ? url.replace(/^https:\/\/teams\.microsoft\.com/i, "msteams:") : url;
    shell.openExternal(inTeams).catch(() => {
        if (inTeams !== url) void shell.openExternal(url).catch(() => undefined);
    });
}

/**
 * Keep the window on the service's origin (it can change when the service restarts); everything else opens in the browser.
 * The page's own window.opens are a worker's code window (the shell builds it, not the page) and a code window's
 * "back to the main window" (`/?focus=main`), which only brings that window forward.
 */
function confineToOrigin(contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
        const worker = codeWindowWorker(url, origin);
        if (worker) openCodeWindow(worker);
        else if (isFocusMainUrl(url, origin)) focusMainWindow();
        else if (isWebUrl(url)) openOutside(url);
        return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
        if (url === origin || url.startsWith(origin + "/")) return;
        event.preventDefault();
        if (isWebUrl(url)) openOutside(url);
    });
    contents.session.setPermissionRequestHandler((_contents, permission, callback) =>
        callback(ALLOWED_PERMISSIONS.has(permission)),
    );
    contents.session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/**
 * Native window backdrop. Mica samples the wallpaper once, so it costs nothing per frame;
 * acrylic re-blurs whatever sits behind the window live. Both need Windows 11 22H2
 * (build 22621). ADO_PR_OPS_BACKDROP=acrylic|none overrides the default.
 */
type Backdrop = "mica" | "acrylic" | "none";
function windowBackdrop(): Backdrop {
    if (process.platform !== "win32" || Number(release().split(".")[2]) < 22621) return "none";
    const pick = process.env.ADO_PR_OPS_BACKDROP?.trim().toLowerCase();
    return pick === "acrylic" || pick === "none" ? pick : "mica";
}

const glass = windowBackdrop() !== "none";

/**
 * Without GPU compositing (a virtual machine, a remote session), Chromium draws every frame
 * on the CPU; the page then drops effects that cost per frame (html.lean in style.css).
 * The GPU's feature status only means something once the GPU process has reported it, so
 * this waits for that (briefly), then holds the answer for the life of the process.
 * ADO_PR_OPS_RENDER=lean|full overrides it.
 */
let renderDecision: Promise<"lean" | "full"> | null = null;
function renderMode(): Promise<"lean" | "full"> {
    renderDecision ??= (async () => {
        const pick = process.env.ADO_PR_OPS_RENDER?.trim().toLowerCase();
        if (pick === "lean" || pick === "full") return pick;
        await Promise.race([app.getGPUInfo("basic").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3000))]);
        const status = app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>;
        return (status.gpu_compositing || "").startsWith("enabled") ? "full" : "lean";
    })();
    return renderDecision;
}

/** Load a page of the service, telling it which shell it's in. The page draws its own title bar and lets the backdrop tint through its glass. */
async function load(window: BrowserWindow, url: string): Promise<void> {
    const target = new URL(url);
    target.searchParams.set("shell", glass ? "glass" : "solid");
    target.searchParams.set("render", await renderMode());
    if (!window.isDestroyed()) await window.loadURL(target.toString()).catch(() => undefined);
}

/** Point the main window at the service. */
async function show(window: BrowserWindow, url: string): Promise<void> {
    origin = new URL(url).origin;
    await load(window, url);
}

/** The frame every window shares: hidden title bar with caption buttons over the page, the native backdrop, a sandboxed page. */
function chromeOptions(): BrowserWindowConstructorOptions {
    const backdrop = windowBackdrop();
    // The UI is dark-only, so pin the native frame (and the backdrop tint) to dark too.
    nativeTheme.themeSource = "dark";
    return {
        title: APP_NAME,
        icon: APP_ICON,
        backgroundColor: glass ? "#00000000" : "#050505",
        ...(glass ? { backgroundMaterial: backdrop } : {}),
        titleBarStyle: "hidden",
        titleBarOverlay: { color: glass ? "#00000000" : "#050505", symbolColor: "#f2f2f2", height: titleBarHeight(uiZoom) },
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: true,
            zoomFactor: uiZoom,
        },
    };
}

// ---- interface size -----------------------------------------------------------------

function zoomFile(): string {
    return join(app.getPath("userData"), "ui-zoom.json");
}

function savedZoom(): number {
    try {
        return zoomLevelOf((JSON.parse(readFileSync(zoomFile(), "utf8")) as { level?: unknown }).level);
    } catch {
        return 1;
    }
}

/** The whole interface's size, in every window (1 is 100%). */
let uiZoom = savedZoom();

function sizeWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    window.webContents.setZoomFactor(uiZoom);
    // The caption buttons' strip grows with the page's title bar. Windows and Linux only.
    if (process.platform !== "darwin") {
        try {
            window.setTitleBarOverlay({ height: titleBarHeight(uiZoom) });
        } catch {
            // A window without the overlay keeps its frame.
        }
    }
}

/** Size every window at `level`, save it, and tell the page the keys came from, so it can say so. */
function setUiZoom(level: number, from: WebContents): void {
    if (level !== uiZoom) {
        uiZoom = level;
        try {
            writeFileSync(zoomFile(), JSON.stringify({ level }));
        } catch {
            // Not saved: the app opens at the last saved size.
        }
    }
    for (const window of BrowserWindow.getAllWindows()) sizeWindow(window);
    if (!from.isDestroyed()) void from.executeJavaScript(`window.dispatchEvent(new CustomEvent("devis:ui-zoom", { detail: ${level} }))`).catch(() => undefined);
}

/**
 * Ctrl +/−/0 size the whole interface, in every window, before the page sees the keys.
 * A page that loads, or reloads onto a new port, takes the current size.
 */
function followUiZoom(window: BrowserWindow): void {
    const contents = window.webContents;
    contents.on("before-input-event", (event, input) => {
        const command = zoomCommand(input);
        if (!command) return;
        event.preventDefault();
        setUiZoom(nextZoom(uiZoom, command), contents);
    });
    contents.on("did-navigate", () => sizeWindow(window));
}

function createWindow(url: string): BrowserWindow {
    const window = new BrowserWindow({ ...chromeOptions(), width: 1440, height: 920, minWidth: 760, minHeight: 520 });
    confineToOrigin(window.webContents);
    followUiZoom(window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
        if (mainWindow === window) mainWindow = null;
        // The code windows belong to the main one: closing it closes the app.
        for (const code of codeWindows.values()) if (!code.isDestroyed()) code.close();
    });
    void show(window, url);
    return window;
}

// ---- code windows --------------------------------------------------------------------

function placementFile(): string {
    return join(app.getPath("userData"), "code-window.json");
}

function savedPlacement(): SavedPlacement | null {
    try {
        return parsePlacement(JSON.parse(readFileSync(placementFile(), "utf8")));
    } catch {
        return null;
    }
}

/** The last code window closed sets where the next one opens. */
function savePlacement(window: BrowserWindow): void {
    try {
        const placement: SavedPlacement = { ...window.getNormalBounds(), maximized: window.isMaximized() };
        writeFileSync(placementFile(), JSON.stringify(placement));
    } catch {
        // Placement is a convenience; the next window falls back to the main window's display.
    }
}

/** Bring the main window forward (a code window's "Open in chat", a second launch). */
function focusMainWindow(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
}

/** A worker's changes, full width in a window of its own. Opening one that's already up brings it forward. */
function openCodeWindow(worker: string): void {
    const existing = codeWindows.get(worker);
    if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return;
    }
    const saved = savedPlacement();
    const mainArea = (mainWindow && !mainWindow.isDestroyed() ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay()).workArea;
    const open = [...codeWindows.values()].filter((w) => !w.isDestroyed()).map((w) => w.getNormalBounds());
    const placement = placeCodeWindow(saved, saved ? screen.getDisplayMatching(saved).workArea : null, mainArea, open);
    const window = new BrowserWindow({
        ...chromeOptions(),
        ...placement.bounds,
        minWidth: CODE_WINDOW_MIN.width,
        minHeight: CODE_WINDOW_MIN.height,
    });
    codeWindows.set(worker, window);
    confineToOrigin(window.webContents);
    followUiZoom(window);
    window.once("ready-to-show", () => {
        if (placement.maximized) window.maximize();
        window.show();
    });
    window.on("close", () => savePlacement(window));
    window.on("closed", () => {
        if (codeWindows.get(worker) === window) codeWindows.delete(worker);
    });
    void load(window, codeWindowUrl(origin, worker));
}

/** The service came back on another port: move the code windows with it, keeping each one's open file (the page keeps it in the hash). */
function moveCodeWindows(to: string): void {
    for (const [worker, window] of codeWindows) {
        if (window.isDestroyed()) continue;
        let hash = "";
        try {
            hash = new URL(window.webContents.getURL()).hash;
        } catch {
            // Not loaded yet; open it fresh.
        }
        void load(window, codeWindowUrl(to, worker, hash));
    }
}

// ---- the background service ---------------------------------------------------------

/** What ending the service means for work in flight. */
const RESTART_DETAIL = "Reviews in progress start again, and workers continue from your next message.";

/** The service for this build, started if needed. An earlier build that's still working, or a hung one, is the user's call. */
async function connect(): Promise<ServiceStatus> {
    const userData = app.getPath("userData");
    const options = { userData, appDir, execPath: process.execPath };
    for (let attempt = 0; attempt < 3; attempt++) {
        const result = await ensureService(options);
        if (result.kind === "ready") return result.status;
        if (result.kind === "unresponsive") {
            const choice = await dialog.showMessageBox({
                type: "warning",
                title: APP_NAME,
                message: "Devis's background service isn't responding.",
                detail: `End it to start a fresh one. ${RESTART_DETAIL} Its log is in ${serviceFiles(userData).logs}.`,
                buttons: ["End it and start fresh", "Quit"],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            });
            if (choice.response !== 0) throw new QuitRequested();
            await endService(result.info, userData);
            continue;
        }
        const work = result.status.work.map((w) => `• ${w.label}`).join("\n");
        const choice = await dialog.showMessageBox({
            type: "warning",
            title: APP_NAME,
            message: result.unanswered
                ? "An earlier version of Devis is running in the background and didn't answer when asked to stop."
                : "An earlier version of Devis is still working in the background.",
            detail: `${work ? `${work}\n\n` : ""}Stop it to open this version. ${RESTART_DETAIL} Or quit, and open the app again once it finishes.`,
            buttons: ["Stop it and open", "Quit"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        });
        if (choice.response !== 0) throw new QuitRequested();
        await stopService(result.status);
    }
    throw new Error("The background service couldn't be replaced. Try again in a moment.");
}

class QuitRequested extends Error {}

let askingAboutHang = false;
/** The service the window shows and watches. */
let servicePid = 0;

function watch(status: ServiceStatus): void {
    attachment?.close();
    servicePid = status.pid;
    attachment = watchService(status, {
        onLost: () => void recover(),
        onUnresponsive: () => void hung(status),
    });
}

/** The window's service is still there but stopped answering: offer to restart it. */
async function hung(status: ServiceStatus): Promise<void> {
    if (askingAboutHang || quitting) return;
    askingAboutHang = true;
    try {
        const choice = await dialog.showMessageBox({
            type: "warning",
            title: APP_NAME,
            message: "Devis's background service stopped responding.",
            detail: `Restart it, or keep waiting if it's in the middle of something long. ${RESTART_DETAIL}`,
            buttons: ["Restart it", "Keep waiting"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        });
        if (choice.response !== 0) return;
        // The dialog may have sat open a while: the window may be on a newer service by now, or this one may have come back.
        if (servicePid !== status.pid || (await serviceStatus(status))) return;
        // Ending it drops the window's connection, which starts a fresh service and reloads onto it.
        await endService(status, app.getPath("userData"));
    } finally {
        askingAboutHang = false;
    }
}

/** The service went away (it crashed, or something stopped it): start it again and reload the window onto it. */
async function recover(): Promise<void> {
    if (quitting) return;
    const now = Date.now();
    recoveries.push(now);
    while (recoveries.length && now - recoveries[0] > 60_000) recoveries.shift();
    if (recoveries.length > MAX_RECOVERIES) {
        dialog.showErrorBox(
            `${APP_NAME} lost its background service`,
            `It stopped ${recoveries.length} times in a minute. Its log is in ${serviceFiles(app.getPath("userData")).logs}.`,
        );
        app.exit(1);
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (quitting) return;
    try {
        const previous = servicePid;
        const status = await connect();
        watch(status);
        // The new service usually takes the same port, so the origin alone doesn't say it's a new one.
        const next = new URL(status.url).origin;
        const moved = next !== origin;
        if (mainWindow && (moved || status.pid !== previous)) void show(mainWindow, status.url);
        // On the same port the code windows just reconnect on their next poll.
        if (moved) {
            origin = next;
            moveCodeWindows(next);
        }
        console.log(`[ado-pr-ops] reconnected to the service at ${status.url}`);
    } catch (error) {
        if (error instanceof QuitRequested) return void app.exit(0);
        dialog.showErrorBox(`${APP_NAME} lost its background service`, (error as Error).message);
        app.exit(1);
    }
}

async function start(): Promise<void> {
    const status = await connect();
    watch(status);
    console.log(`[ado-pr-ops] showing the service at ${status.url} (pid ${status.pid})`);
    // Electron's default menu binds Ctrl +/−/0 to the focused window's zoom; the shell
    // sizes every window together with those keys (followUiZoom), so keep the default menu minus zoom.
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { role: "fileMenu" },
            { role: "editMenu" },
            {
                label: "View",
                submenu: [
                    { role: "reload" },
                    { role: "forceReload" },
                    { role: "toggleDevTools" },
                    { type: "separator" },
                    { role: "togglefullscreen" },
                ],
            },
            { role: "windowMenu" },
        ]),
    );
    mainWindow = createWindow(status.url);
}

if (process.argv.includes("--install-shortcut")) {
    void app.whenReady().then(() => {
        const ok = installShortcut();
        app.exit(ok ? 0 : 1);
    });
} else if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => focusMainWindow());
    app.on("window-all-closed", () => app.quit());
    // The service keeps running while it has work; only the window's connection goes.
    app.on("before-quit", () => {
        quitting = true;
        attachment?.close();
        attachment = null;
    });

    void app.whenReady().then(() =>
        start().catch((error: Error) => {
            if (error instanceof QuitRequested) return void app.exit(0);
            dialog.showErrorBox(`${APP_NAME} could not start`, error.stack || error.message);
            app.exit(1);
        }),
    );
}