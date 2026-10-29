// The chat a Copilot session's events describe: its top-level user and assistant messages,
// without tool or sub-agent chatter. The transcript read after a turn and a worker's live
// view of the turn in flight both build it here, so they agree message for message (same
// ids, same content) and a chat can swap one for the other without a visible change.

/** An image the user pasted into a chat: its file name in the app's images folder, and what to call it. */
export interface ChatImage {
    id: string;
    name: string;
}

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: string;
    /** Images the user sent with the message (user messages only; absent when none). */
    images?: ChatImage[];
}

/** An image's id: a content hash plus its type, the name of its file in the app's images folder. */
export const IMAGE_ID = /^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/;

/** The prompt for a message that is only images: the runtime needs some text, the chat shows none. */
export function imageOnlyPrompt(count: number): string {
    return count === 1 ? "Take a look at the attached image." : "Take a look at the attached images.";
}

const IMAGE_ONLY = new Set([imageOnlyPrompt(1), imageOnlyPrompt(2)]);

/** What the session gets for a message: the text, or for images alone a line pointing at them. */
export function promptFor(text: string, images: readonly ChatImage[]): string {
    return text.trim() || (images.length ? imageOnlyPrompt(images.length) : "");
}

/**
 * The app's images a message carried, from its attachments. Each is a file in the images folder
 * named by its id; anything else attached (a path elsewhere, a blob) isn't one of the user's images.
 */
export function imagesFromAttachments(value: unknown): ChatImage[] {
    if (!Array.isArray(value)) return [];
    const images: ChatImage[] = [];
    for (const a of value as Array<Record<string, unknown>>) {
        if (!a || a.type !== "file" || typeof a.path !== "string") continue;
        const id = a.path.split(/[\\/]/).pop() || "";
        if (!IMAGE_ID.test(id)) continue;
        images.push({ id, name: typeof a.displayName === "string" && a.displayName.trim() ? a.displayName.trim() : id });
    }
    return images;
}

/** Whether two image lists are the same images in the same order. */
export function sameImages(a: readonly ChatImage[] | undefined, b: readonly ChatImage[] | undefined): boolean {
    const x = a || [];
    const y = b || [];
    return x.length === y.length && x.every((image, i) => image.id === y[i].id);
}

export interface EventLike {
    id?: string;
    type: string;
    timestamp?: string;
    agentId?: string;
    data?: Record<string, unknown>;
}

const REVIEW_TASK_MARKER = "===REVIEW TASK START===";
export const REVIEW_TASK_LABEL = "Review task (PR data and review instructions)";

/** Builds the chat one event at a time. */
export class ChatTranscript {
    private list: ChatMessage[] = [];
    private readonly assistantById = new Map<string, ChatMessage>();

    /** Take in one event. Returns the message it added or grew, or null for anything else. */
    add(event: EventLike): ChatMessage | null {
        const data = event.data || {};
        if (event.agentId || data.parentToolCallId) return null;
        const content = typeof data.content === "string" ? data.content : "";
        if (event.type === "user.message") {
            if (data.source && data.source !== "user") return null;
            const images = imagesFromAttachments(data.attachments);
            const shown = images.length && IMAGE_ONLY.has(content.trim()) ? "" : content;
            const message: ChatMessage = {
                id: String(event.id ?? `user-${this.list.length}`),
                role: "user",
                content: shown.trimStart().startsWith(REVIEW_TASK_MARKER) ? REVIEW_TASK_LABEL : shown,
                timestamp: event.timestamp || "",
                ...(images.length ? { images } : {}),
            };
            this.list.push(message);
            return message;
        }
        if (event.type !== "assistant.message") return null;
        const messageId = String(data.messageId ?? event.id ?? `assistant-${this.list.length}`);
        const existing = this.assistantById.get(messageId);
        if (existing) {
            existing.content += content;
            return existing;
        }
        const message: ChatMessage = { id: messageId, role: "assistant", content, timestamp: event.timestamp || "" };
        this.assistantById.set(messageId, message);
        this.list.push(message);
        return message;
    }

    /** The messages so far, in order, each a copy; empty ones (a tool call's carrier) are left out. */
    messages(): ChatMessage[] {
        return this.list
            .filter((message) => message.content.trim() || message.images?.length)
            .map((message) => ({ ...message, ...(message.images ? { images: message.images.map((i) => ({ ...i })) } : {}) }));
    }
}

/** Top-level user and assistant messages; tool and sub-agent chatter is omitted. */
export function chatMessagesFromEvents(events: readonly EventLike[]): ChatMessage[] {
    const transcript = new ChatTranscript();
    for (const event of events) transcript.add(event);
    return transcript.messages();
}
