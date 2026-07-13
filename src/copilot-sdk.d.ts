// Ambient declaration for the Copilot CLI extension SDK.
// The `@github/copilot-sdk/extension` module is provided by the Copilot runtime
// when it loads the compiled `extension.mjs`; it is NOT installed from npm, so we
// describe just the surface this extension uses.
declare module "@github/copilot-sdk/extension" {
    /** Context handed to a canvas action handler. */
    export interface CanvasActionContext {
        instanceId: string;
        [key: string]: unknown;
    }

    /** A named action the agent can invoke on a registered canvas. */
    export interface CanvasAction {
        name: string;
        description?: string;
        handler: (ctx: CanvasActionContext) => Promise<unknown> | unknown;
    }

    /** What a canvas `open` handler returns: the panel title and the URL to load. */
    export interface CanvasOpenResult {
        title: string;
        url: string;
    }

    /** Definition passed to `createCanvas`. */
    export interface CanvasDefinition {
        id: string;
        displayName: string;
        description?: string;
        actions?: CanvasAction[];
        open: () => Promise<CanvasOpenResult> | CanvasOpenResult;
        onClose?: () => Promise<void> | void;
    }

    /** Opaque canvas handle returned by `createCanvas`. */
    export interface Canvas {
        id: string;
    }

    export function createCanvas(def: CanvasDefinition): Canvas;

    /** The live session; `send` pushes a prompt into the Copilot CLI conversation. */
    export interface SessionRef {
        send: (msg: { prompt: string }) => Promise<void>;
    }

    export interface JoinSessionOptions {
        canvases: Canvas[];
    }

    export function joinSession(opts: JoinSessionOptions): Promise<SessionRef>;
}
