import { requireNativeModule, type NativeModule } from "expo";
import type { SpeechModel, SpeechOptions } from "./speechModels";

export type NativeSpeechOptions = SpeechOptions & {
  readonly instructions: string;
  readonly apiKey: string;
  /** Shown on the Lock Screen and car display while reading. */
  readonly title: string;
};

/** `reading` is the id passed to `start`. */
export type NativeSpeechState = {
  readonly reading: string;
  readonly block: number | null;
  readonly paused: boolean;
};

export type SpeechCue = "sent" | "attention" | "error";

declare class SpeechModule extends NativeModule<{
  onSpeechState(state: NativeSpeechState): void;
}> {
  isVoiceDownloaded(options: NativeSpeechOptions): boolean;
  downloadedBytes(model: SpeechModel): number;
  /** Resolves `true` when the reading played to the end, `false` when stopped. */
  start(options: NativeSpeechOptions, reading: string): Promise<boolean>;
  /** Replaces the blocks from index `from`. */
  append(blocks: readonly string[], from: number): Promise<void>;
  finish(): Promise<void>;
  rewind(): Promise<void>;
  nextBlock(): Promise<void>;
  seekToBlock(block: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setPace(pace: number): Promise<void>;
  stop(): Promise<void>;
  deleteVoice(model: SpeechModel): Promise<void>;
  playCue(cue: SpeechCue): Promise<void>;
  /** Plays the cue, then speaks the text in the system voice. */
  announce(text: string, cue: SpeechCue): Promise<void>;
}

// Resolve on use: other platforms can import thread and voice-input controls.
export const nativeSpeech = () => requireNativeModule<SpeechModule>("T3Speech");
