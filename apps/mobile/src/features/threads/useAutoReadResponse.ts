import { useIsFocused } from "@react-navigation/native";
import type { PendingApproval, PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import type { OrchestrationLatestTurn } from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { autoReadResponse } from "../../lib/autoReadResponse";
import { announce, responseSpeech } from "../../lib/responseSpeech";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { useVoiceSettings } from "../../state/voiceSettings";

const KEEP_AWAKE_TAG = "voice-reply";

function truncate(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/**
 * Reads the replies to a voice auto-send while this thread is open, and announces
 * approvals and questions that would otherwise stall the exchange. The screen stays
 * awake meanwhile, so a locked phone does not drop the connection mid-turn.
 */
export function useAutoReadResponse(
  scope: string,
  title: string,
  feed: readonly ThreadFeedEntry[],
  turn: OrchestrationLatestTurn | null,
  approval: PendingApproval | null,
  userInput: PendingUserInput | null,
) {
  const focused = useIsFocused();
  const voice = useVoiceSettings();
  const pending = useSyncExternalStore(autoReadResponse.subscribe, () =>
    autoReadResponse.getSnapshot(scope),
  );
  const speaking = useSyncExternalStore(
    responseSpeech.subscribe,
    () => responseSpeech.getSnapshot()?.response ?? null,
  );

  const handsFree = Platform.OS === "ios" && focused && (pending !== null || speaking !== null);
  useEffect(() => {
    if (!handsFree) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [handsFree]);

  useEffect(() => {
    if (Platform.OS !== "ios" || !focused || !voice.loaded) return;
    const messages = feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    if (speaking) {
      if (speaking.scope !== scope) return;
      const message = messages.find((candidate) => candidate.id === speaking.messageId);
      if (message) {
        responseSpeech.update(
          speaking,
          renderAssistantCitationsAsText(message.text),
          message.streaming,
        );
      }
      return;
    }
    if (!pending) return;
    if (!voice.readRepliesAloud) {
      autoReadResponse.cancel(scope);
      return;
    }
    if (approval && autoReadResponse.takeAnnouncement(scope, approval.requestId)) {
      const subject = approval.appName ?? approval.requestKind;
      const detail = approval.detail ? `: ${truncate(approval.detail, 160)}` : "";
      announce(`Approval needed for ${subject}${detail}`, "attention");
      return;
    }
    if (userInput && autoReadResponse.takeAnnouncement(scope, userInput.requestId)) {
      const question = userInput.questions[0]?.question ?? "";
      announce(`The agent has a question. ${truncate(question, 200)}`, "attention");
      return;
    }
    const reply = autoReadResponse.takeReply(scope, messages, turn, voice.readThinkingUpdates);
    if (reply) {
      void responseSpeech.read(
        { scope, messageId: reply.id },
        renderAssistantCitationsAsText(reply.text),
        reply.streaming,
        voice.speech,
        title,
      );
    }
  }, [approval, feed, focused, pending, scope, speaking, title, turn, userInput, voice]);
}
