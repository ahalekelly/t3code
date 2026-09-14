import * as Speech from "expo-speech";
import { Alert } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import { markdownSpeechText } from "./markdownSpeechText";
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
  Alert.alert("Could not read response aloud", "Please try again.");
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
    return queue.run(() => Speech.stop());
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

      // Native completion/cancellation events can arrive after another response starts.
      const finish = () => {
        if (activeResponse === response) setActiveResponse(null);
      };
      Speech.speak(text, {
        useApplicationAudioSession: false,
        onDone: finish,
        onStopped: finish,
        onError: (error) => {
          if (activeResponse !== response) return;
          finish();
          reportResponseSpeechError(error);
        },
      });
    } catch (error) {
      if (activeResponse === response) setActiveResponse(null);
      reportResponseSpeechError(error);
    }
  },
};
