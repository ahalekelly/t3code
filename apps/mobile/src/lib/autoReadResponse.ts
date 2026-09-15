import type { OrchestrationLatestTurn, OrchestrationMessage } from "@t3tools/contracts";

import type { SpokenResponse } from "./responseSpeech";

type Message = Pick<
  OrchestrationMessage,
  "id" | "role" | "text" | "turnId" | "streaming" | "createdAt"
>;

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
  takeReply(
    scope: string,
    messages: readonly Message[],
    turn: OrchestrationLatestTurn | null,
    readUpdates: boolean,
  ) {
    const request = pending.get(scope);
    if (!request || !turn) return null;
    const promptId = request.messageId;
    const prompt = messages.find((message) => message.id === promptId && message.role === "user");
    if (!prompt) return null;
    // A later prompt replaces the hands-free exchange. An older running turn
    // must finish without being mistaken for the reply to a queued voice prompt.
    if (messages.findLast((message) => message.role === "user")?.id !== promptId) {
      autoReadResponse.cancel(scope);
      return null;
    }
    if (turn.startedAt === null || turn.startedAt < prompt.createdAt) return null;
    if (turn.state === "error" || turn.state === "interrupted") {
      autoReadResponse.cancel(scope);
      return null;
    }
    const replies = messages.filter(
      (message) => message.role === "assistant" && message.turnId === turn.turnId,
    );
    if (
      turn.state === "completed" &&
      turn.assistantMessageId !== null &&
      !replies.some((message) => message.id === turn.assistantMessageId)
    )
      return null;
    const reply = readUpdates
      ? replies.find((message) => !request.spoken.has(message.id) && message.text.trim())
      : turn.state === "completed"
        ? replies.at(-1)
        : undefined;
    if (reply?.streaming) return null;
    if (!reply || request.spoken.has(reply.id) || !reply.text.trim()) {
      if (turn.state === "completed") autoReadResponse.cancel(scope);
      return null;
    }
    pending.set(scope, { messageId: promptId, spoken: new Set([...request.spoken, reply.id]) });
    for (const listener of listeners) listener();
    return reply;
  },
};
