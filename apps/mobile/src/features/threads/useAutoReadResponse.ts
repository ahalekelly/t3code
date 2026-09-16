import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import type { OrchestrationLatestTurn } from "@t3tools/contracts";
import { renderAssistantCitationsAsText } from "@t3tools/shared/assistantCitations";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { autoReadResponse } from "../../lib/autoReadResponse";
import { getSpeechOptions } from "../../lib/speechModels";
import { responseSpeech } from "../../lib/responseSpeech";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { mobilePreferencesAtom } from "../../state/preferences";

export function useAutoReadResponse(
  scope: string,
  feed: readonly ThreadFeedEntry[],
  turn: OrchestrationLatestTurn | null,
) {
  const focused = useIsFocused();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const pending = useSyncExternalStore(autoReadResponse.subscribe, () =>
    autoReadResponse.getSnapshot(scope),
  );
  const active = useSyncExternalStore(responseSpeech.subscribe, responseSpeech.getSnapshot);
  useEffect(() => {
    if (Platform.OS !== "ios" || !focused || !pending || !AsyncResult.isSuccess(preferences))
      return;
    if (!(preferences.value.readVoiceRepliesAloud ?? true)) {
      autoReadResponse.cancel(scope);
      return;
    }
    if (active) return;
    const messages = feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    const reply = autoReadResponse.takeReply(
      scope,
      messages,
      turn,
      preferences.value.readThinkingUpdatesAloud ?? false,
    );
    if (reply)
      void responseSpeech.toggle(
        { scope, messageId: reply.id },
        renderAssistantCitationsAsText(reply.text),
        getSpeechOptions(preferences.value),
      );
  }, [active, feed, focused, pending, preferences, scope, turn]);
}
