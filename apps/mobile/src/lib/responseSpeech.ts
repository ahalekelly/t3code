import { Alert } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import { markdownSpeechText } from "./markdownSpeechText";
import { pocketSpeech } from "./pocketSpeech";
import { SerializedAsyncQueue } from "./serialized-async-queue";

type SpokenResponse = { readonly scope: string; readonly messageId: string };

let activeResponse: SpokenResponse | null = null;
const listeners = new Set<() => void>();
const queue = new SerializedAsyncQueue();

function setActiveResponse(response: SpokenResponse | null) {
  activeResponse = response;
  for (const listener of listeners) listener();
}

export function reportResponseSpeechError(error: unknown) {
  console.error("Failed to read response aloud", error);
  Alert.alert(
    "Could not read response aloud",
    error instanceof Error ? error.message : "Please try again.",
  );
}

export const responseSpeech = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => activeResponse,
  stop() {
    setActiveResponse(null);
    return queue.run(() => pocketSpeech.stop());
  },
  async toggle({ scope, messageId }: SpokenResponse, markdown: string) {
    const response = { scope, messageId };
    const previous = activeResponse;
    const stopping = responseSpeech.stop();
    const stoppingCurrent =
      previous?.scope === response.scope && previous.messageId === response.messageId;
    if (!stoppingCurrent) setActiveResponse(response);

    try {
      await stopping;
      if (stoppingCurrent || activeResponse !== response) return;

      const text = markdownSpeechText(
        parseMarkdownWithOptions(markdown, { gfm: true, html: true, math: false }),
      ).trim();
      if (!text) throw new Error("This response has no readable text.");

      if (!pocketSpeech.isVoiceDownloaded()) {
        const download = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Download offline voice?",
            "The English voice needs a one-time 236 MB download. Keep the app open while it downloads. Your responses stay on this device.\n\nPocket TTS by Kyutai. Voice license: creativecommons.org/licenses/by/4.0",
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: "Download", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
        if (activeResponse !== response) return;
        if (!download) {
          setActiveResponse(null);
          return;
        }
      }

      // A previous reading can finish after another response starts.
      const finish = () => {
        if (activeResponse === response) setActiveResponse(null);
      };
      void pocketSpeech.speak(text).then(finish, (error: unknown) => {
        if (activeResponse !== response) return;
        finish();
        reportResponseSpeechError(error);
      });
    } catch (error) {
      if (activeResponse !== response) return;
      setActiveResponse(null);
      reportResponseSpeechError(error);
    }
  },
};
