import { requireNativeModule } from "expo";
import type { SpeechModel } from "./speechModels";

interface SpeechModule {
  isVoiceDownloaded(model: SpeechModel): boolean;
  speak(text: string, rate: number, model: SpeechModel): Promise<boolean>;
  rewind(): Promise<void>;
  stop(): Promise<void>;
}

// Resolve on use: other platforms can import thread and voice-input controls.
const native = () => requireNativeModule<SpeechModule>("T3Speech");

export const nativeSpeech = {
  isVoiceDownloaded: (model: SpeechModel) => native().isVoiceDownloaded(model),
  speak: (text: string, rate: number, model: SpeechModel) => native().speak(text, rate, model),
  rewind: () => native().rewind(),
  stop: () => native().stop(),
};
