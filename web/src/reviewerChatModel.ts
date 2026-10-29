// Pure view model for the reviewer chat (no DOM), so it can be tested headless.

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ReviewerChat {
  messages: ChatMessage[];
  pending: boolean;
  partial: string;
  error: string | null;
  /** Inline plus PR-level findings on the review; grows when the reviewer adds some. */
  findingCount?: number;
}

export type ChatItem =
  | { kind: "task"; text: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "thinking"; text: "" };

/** Must match REVIEW_TASK_LABEL in src/reviewer-session.mts. */
export const REVIEW_TASK_LABEL = "Review task (PR data and review instructions)";

/**
 * Render items for a chat snapshot. `sentText` is the message sent this turn:
 * it is shown until the session history contains it.
 */
export function chatItems(chat: ReviewerChat, sentText = ""): ChatItem[] {
  const items: ChatItem[] = chat.messages.map((message, index) =>
    message.role === "assistant"
      ? { kind: "assistant", text: message.content }
      : index === 0 && message.content === REVIEW_TASK_LABEL
        ? { kind: "task", text: message.content }
        : { kind: "user", text: message.content }
  );
  if (!chat.pending) return items;
  const lastUser = [...chat.messages].reverse().find((message) => message.role === "user");
  if (sentText && lastUser?.content !== sentText) items.push({ kind: "user", text: sentText });
  items.push(chat.partial ? { kind: "assistant", text: chat.partial, streaming: true } : { kind: "thinking", text: "" });
  return items;
}

/** Cheap change detector so polling re-renders only when something changed. */
export function chatFingerprint(chat: ReviewerChat, sentText = ""): string {
  return JSON.stringify([chat.messages.length, chat.messages[chat.messages.length - 1]?.content.length ?? 0, chat.pending, chat.partial, chat.error, sentText]);
}
