import { requireNativeModule } from "expo";
import type { SpeechOptions } from "./speechModels";

interface SpeechModule {
  isVoiceDownloaded(options: SpeechOptions): boolean;
  speak(text: string, options: SpeechOptions): Promise<boolean>;
  rewind(): Promise<void>;
  stop(): Promise<void>;
}

// Resolve on use: other platforms can import thread and voice-input controls.
const native = () => requireNativeModule<SpeechModule>("T3Speech");

export const nativeSpeech = {
  isVoiceDownloaded: (options: SpeechOptions) => native().isVoiceDownloaded(options),
  speak: (text: string, options: SpeechOptions) => native().speak(text, options),
  rewind: () => native().rewind(),
  stop: () => native().stop(),
};
