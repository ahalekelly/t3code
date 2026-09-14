import { requireNativeModule } from "expo";

interface PocketSpeechModule {
  isVoiceDownloaded(): boolean;
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}

// Resolve on use: other platforms can import thread and voice-input controls.
const native = () => requireNativeModule<PocketSpeechModule>("T3PocketSpeech");

export const pocketSpeech = {
  isVoiceDownloaded: () => native().isVoiceDownloaded(),
  speak: (text: string) => native().speak(text),
  stop: () => native().stop(),
};
