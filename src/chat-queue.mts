// Messages typed while a Copilot chat (the Lead or a worker) is mid-turn. The app,
// not the runtime, keeps them, so the chat can show each one with Send now and Remove.
// They run one at a time, in order, as turns end. A turn that was stopped or failed holds
// the rest until the user sends something themselves.

import { randomUUID } from "node:crypto";
import type { CopilotSession, MessageOptions } from "@github/copilot-sdk";
import type { ChatImage } from "./chat-transcript.mjs";
import { JarvisError } from "./jarvis-store.mjs";

export interface QueuedMessage {
    id: string;
    /** What the user typed; empty when the message is only images. */
    text: string;
    at: string;
    /** Images sent with it; absent when none. */
    images?: ChatImage[];
}

export const QUEUE_MAX = 20;

/** How a message is sent while a turn runs: after it ("queue"), or into it ("now"). */
export type SendMode = "queue" | "now";

export function sendMode(value: unknown): SendMode | null {
    return value === "queue" || value === "now" ? value : null;
}

export class MessageQueue {
    private items: QueuedMessage[] = [];
    /** Set after a stop or a failure: nothing starts on its own until the user sends again. */
    held = false;

    get size(): number {
        return this.items.length;
    }

    add(text: string, images: readonly ChatImage[] = []): QueuedMessage {
        if (this.items.length >= QUEUE_MAX) throw new JarvisError(`The queue holds ${QUEUE_MAX} messages. Wait for some to run, or remove one.`, 409);
        const item: QueuedMessage = { id: randomUUID(), text, at: new Date().toISOString(), ...(images.length ? { images: [...images] } : {}) };
        this.items.push(item);
        return item;
    }

    find(id: unknown): QueuedMessage | null {
        return typeof id === "string" ? (this.items.find((m) => m.id === id) ?? null) : null;
    }

    /** Take one message out, wherever it is. */
    take(id: unknown): QueuedMessage | null {
        const item = this.find(id);
        if (item) this.items = this.items.filter((m) => m !== item);
        return item;
    }

    /** Put a message back at the front, as when sending it now failed. */
    restore(item: QueuedMessage): void {
        if (!this.items.some((m) => m.id === item.id)) this.items.unshift(item);
    }

    /** The next message to run when a turn ends normally, or null (none, or held). */
    next(): QueuedMessage | null {
        if (this.held) return null;
        return this.items.shift() ?? null;
    }

    /** The turn stopped or failed: keep what's queued, but don't start it on its own. */
    hold(): void {
        this.held = this.items.length > 0;
    }

    /** A turn the user started: what's queued runs after it. */
    resume(): void {
        this.held = false;
    }

    clear(): void {
        this.items = [];
        this.held = false;
    }

    view(): { queue: QueuedMessage[]; queueHeld: boolean } {
        return {
            queue: this.items.map((m) => ({ ...m, ...(m.images ? { images: m.images.map((i) => ({ ...i })) } : {}) })),
            queueHeld: this.held && this.items.length > 0,
        };
    }
}

/** Put a message into the turn that's running now, as the CLI does when you steer it. */
export async function steer(session: Pick<CopilotSession, "send">, prompt: string, attachments?: MessageOptions["attachments"]): Promise<void> {
    await session.send({ prompt, mode: "immediate", ...(attachments?.length ? { attachments } : {}) });
}
