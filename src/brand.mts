// The app's names. The app and its lead agent are both Devis; until October 2026 they were
// ADO PR Ops and Jarvis. Internal names (ADO_PR_OPS_* settings, /api/jarvis routes,
// jarvis_* tables, the data folder's jarvis folder) stayed as they were.

export const APP_NAME = "Devis";

/** The Workspace's lead agent: one persistent Copilot session. What it posts is signed with this. */
export const LEAD_NAME = "Devis";

/** The lead's name before, which older status lines, to-dos and proposals were signed with. */
export const FORMER_LEAD_NAME = "Jarvis";

/** The app's name before, which its old Start menu shortcut and install folder carry. */
export const FORMER_APP_NAME = "ADO PR Ops";

/**
 * The data folder under %APPDATA%. It keeps the app's first name: it holds the database and
 * settings, and the folders worker sessions run in, so moving it would strand them.
 */
export const DATA_FOLDER = "ADO PR Ops";
