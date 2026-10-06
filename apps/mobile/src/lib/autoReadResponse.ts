import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";

import type { ThreadFeedMessage } from "./threadActivity";

type Message = Pick<
  ThreadFeedMessage,
  "id" | "role" | "text" | "runId" | "streaming" | "createdAt"
>;

/** A response being read, or the voice prompt whose replies should be read. */
export type SpokenResponse = { readonly scope: string; readonly messageId: string };

const pending = new Map<
  string,
  { readonly messageId: string; readonly spoken: ReadonlySet<string> }
>();
const listeners = new Set<() => void>();

export const autoReadResponse = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (scope: string) => pending.get(scope) ?? null,
  request({ scope, messageId }: SpokenResponse) {
    pending.set(scope, { messageId, spoken: new Set() });
    for (const listener of listeners) listener();
  },
  cancelAll() {
    pending.clear();
    for (const listener of listeners) listener();
  },
  cancel(scope: string) {
    if (!pending.delete(scope)) return;
    for (const listener of listeners) listener();
  },
  /** True the first time a hands-free exchange sees this approval or question. */
  takeAnnouncement(scope: string, requestId: string) {
    const request = pending.get(scope);
    if (!request || request.spoken.has(requestId)) return false;
    pending.set(scope, { ...request, spoken: new Set([...request.spoken, requestId]) });
    for (const listener of listeners) listener();
    return true;
  },
  /** The next reply to read; a streaming reply is read live as it grows. */
  takeReply(
    scope: string,
    messages: readonly Message[],
    run: ThreadRunSummary | null,
    readUpdates: boolean,
  ) {
    const request = pending.get(scope);
    if (!request || !run) return null;
    const promptId = request.messageId;
    const prompt = messages.find((message) => message.id === promptId && message.role === "user");
    if (!prompt) return null;
    // A later prompt replaces the hands-free exchange. An older running run
    // must finish without being mistaken for the reply to a queued voice prompt.
    if (messages.findLast((message) => message.role === "user")?.id !== promptId) {
      autoReadResponse.cancel(scope);
      return null;
    }
    if (run.startedAt === null || run.startedAt < prompt.createdAt) return null;
    if (
      run.status === "failed" ||
      run.status === "interrupted" ||
      run.status === "cancelled" ||
      run.status === "rolled_back"
    ) {
      autoReadResponse.cancel(scope);
      return null;
    }
    const replies = messages.filter(
      (message) => message.role === "assistant" && message.runId === run.runId,
    );
    if (
      run.status === "completed" &&
      run.assistantMessageId !== null &&
      !replies.some((message) => message.id === run.assistantMessageId)
    )
      return null;
    const reply = readUpdates
      ? replies.find((message) => !request.spoken.has(message.id) && message.text.trim())
      : run.status === "completed"
        ? replies.at(-1)
        : undefined;
    if (!reply || request.spoken.has(reply.id) || !reply.text.trim()) {
      if (run.status === "completed") autoReadResponse.cancel(scope);
      return null;
    }
    pending.set(scope, { messageId: promptId, spoken: new Set([...request.spoken, reply.id]) });
    for (const listener of listeners) listener();
    return reply;
  },
};
