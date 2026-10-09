// Electron entry: runs the loopback UI/API server and the background review
// runner in the main process and shows the UI in one window.
//
// Data lives under Electron's userData folder. On first launch it is seeded
// from the retired Copilot canvas extension (~/.copilot/extensions/ado-pr-ops).

import { app, BrowserWindow, dialog, shell, type WebContents } from "electron";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const APP_ID = "AdoPrOps.Desktop";
const APP_NAME = "ADO PR Ops";
const SHUTDOWN_BUDGET_MS = 10_000;
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);

const appDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let shutdown: (() => Promise<void>) | null = null;

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

function startMenuShortcutPath(): string {
    return join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", `${APP_NAME}.lnk`);
}

/** The Start menu shortcut carries the AppUserModelID Windows needs for toasts. */
function installShortcut(): boolean {
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

function configureDataPaths(): { dbPath: string; configPath: string } {
    const userData = app.getPath("userData");
    const dbPath = (process.env.ADO_PR_OPS_DB_PATH ||= join(userData, "data", "reviews.db"));
    const configPath = (process.env.ADO_PR_OPS_CONFIG_PATH ||= join(userData, "config.json"));
    process.env.ADO_PR_OPS_WORK_DIR ||= join(userData, "sessions");
    return { dbPath, configPath };
}

/** Copy the extension's reviews and settings once, when this app has none yet. */
async function migrateExtensionData(dbPath: string, configPath: string): Promise<void> {
    const legacy = join(homedir(), ".copilot", "extensions", "ado-pr-ops");
    await mkdir(dirname(dbPath), { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });

    const legacyDb = join(legacy, "data", "reviews.db");
    if (!existsSync(dbPath) && existsSync(legacyDb)) {
        const staging = `${dbPath}.migrating`;
        await rm(staging, { force: true });
        try {
            // VACUUM INTO reads through the WAL, so it is consistent even while
            // the extension still has the database open.
            const source = new DatabaseSync(legacyDb);
            try {
                source.exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);
            } finally {
                source.close();
            }
            await rename(staging, dbPath);
        } catch (error) {
            await rm(staging, { force: true });
            console.error(`[migrate] reviews were not copied: ${(error as Error).message}`);
        }
    }

    const legacyConfig = join(legacy, "config.json");
    if (!existsSync(configPath) && existsSync(legacyConfig)) {
        await copyFile(legacyConfig, configPath).catch((error: Error) =>
            console.error(`[migrate] settings were not copied: ${error.message}`),
        );
    }
}

function isWebUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

/** Keep the window on the app's own origin; everything else opens in the browser. */
function confineToOrigin(contents: WebContents, origin: string): void {
    contents.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
        if (url === origin || url.startsWith(origin + "/")) return;
        event.preventDefault();
        if (isWebUrl(url)) void shell.openExternal(url);
    });
    contents.session.setPermissionRequestHandler((_contents, permission, callback) =>
        callback(ALLOWED_PERMISSIONS.has(permission)),
    );
    contents.session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
}

/** Mica needs Windows 11 22H2 (build 22621) or later. */
function supportsMica(): boolean {
    return process.platform === "win32" && Number(release().split(".")[2]) >= 22621;
}

function createWindow(url: string): BrowserWindow {
    const mica = supportsMica();
    const window = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 760,
        minHeight: 520,
        title: APP_NAME,
        backgroundColor: mica ? "#00000000" : "#202020",
        ...(mica ? { backgroundMaterial: "mica" as const } : {}),
        titleBarStyle: "hidden",
        titleBarOverlay: { color: mica ? "#00000000" : "#202020", symbolColor: "#f5f5f5", height: 40 },
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: true,
        },
    });
    confineToOrigin(window.webContents, new URL(url).origin);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
        if (mainWindow === window) mainWindow = null;
    });
    // The page draws its own title bar beside the caption buttons, and lets Mica show through.
    const target = new URL(url);
    target.searchParams.set("shell", mica ? "mica" : "solid");
    void window.loadURL(target.toString());
    return window;
}

async function start(): Promise<void> {
    const { dbPath, configPath } = configureDataPaths();
    await migrateExtensionData(dbPath, configPath);

    const { startServer } = await import("./server.mjs");
    const { startReviewRunner, stopReviewRunner } = await import("./review-runner.mjs");
    const { closeAllReviewerSessions } = await import("./reviewer-session.mjs");
    const { stopCopilotClient } = await import("./copilot-runtime.mjs");
    const { closeDb } = await import("./store.mjs");

    const running = await startServer(join(appDir, "web"));
    shutdown = async () => {
        running.server.close();
        await stopReviewRunner();
        await closeAllReviewerSessions();
        await stopCopilotClient();
        closeDb();
    };
    await startReviewRunner();
    console.log(`[ado-pr-ops] serving ${running.url}`);
    mainWindow = createWindow(running.url);
}

if (process.argv.includes("--install-shortcut")) {
    void app.whenReady().then(() => {
        const ok = installShortcut();
        app.exit(ok ? 0 : 1);
    });
} else if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    app.on("window-all-closed", () => app.quit());

    let phase: "running" | "stopping" | "stopped" = "running";
    app.on("before-quit", (event) => {
        if (phase === "stopped" || !shutdown) return;
        event.preventDefault();
        if (phase === "stopping") return;
        phase = "stopping";
        let timer: ReturnType<typeof setTimeout> | undefined;
        void Promise.race([
            shutdown().catch((error: Error) => console.error(`[shutdown] ${error.message}`)),
            new Promise((resolve) => (timer = setTimeout(resolve, SHUTDOWN_BUDGET_MS))),
        ]).finally(() => {
            clearTimeout(timer);
            phase = "stopped";
            app.quit();
        });
    });

    void app.whenReady().then(() =>
        start().catch((error: Error) => {
            dialog.showErrorBox(`${APP_NAME} could not start`, error.stack || error.message);
            app.exit(1);
        }),
    );
}
