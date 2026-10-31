import { useAtomValue } from "@effect/atom-react";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { autoReadResponse } from "../../lib/autoReadResponse";
import { nativeSpeech } from "../../lib/nativeSpeech";
import { announce, playCue, responseSpeech } from "../../lib/responseSpeech";
import { VOICE_API_PROVIDERS } from "../../lib/speechSettings";
import type { CloudTranscriptionSource } from "../../lib/voiceTranscriptionSources";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { voiceInputSettingsAtom, type VoiceInputSettings } from "../../state/voiceSettings";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VoiceTranscriptionError,
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createCloudVoiceTranscriber } from "./cloudVoiceTranscriber";
import { withDictationDisclaimer } from "./dictationDisclaimer";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  // Mono AAC at 64 kbps keeps speech clear at under 10 MB for the full recording limit.
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

/** Selecting a cloud source without its key is a setup mistake, not a reason to fall back. */
function missingKeyTranscriber(source: CloudTranscriptionSource): VoiceTranscriber {
  return {
    prepare: async () => {
      throw new VoiceTranscriptionError(
        "unavailable",
        `Add your ${VOICE_API_PROVIDERS[source].label} API key in Settings → Voice.`,
      );
    },
  };
}

function readsRepliesAloud(settings: VoiceInputSettings): boolean {
  return Platform.OS === "ios" && (!settings.loaded || settings.readRepliesAloud);
}

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  get.mount(voiceInputSettingsAtom);
  let sendRequested = false;
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const recorder = createLazyVoiceRecorder({
    create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      void session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
        interrupted: status.interrupted === true,
      });
    },
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = microphoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: () => {
      const { transcriptionSource, transcriptionKeys } = registry.get(voiceInputSettingsAtom);
      if (transcriptionSource === "local") return getLocalVoiceTranscriber();
      if (transcriptionKeys.length === 0) return missingKeyTranscriber(transcriptionSource);
      return createCloudVoiceTranscriber(transcriptionSource, transcriptionKeys);
    },
    requestPermission: async () => {
      const permission = await requestRecordingPermissionsAsync();
      return { granted: permission.granted, canAskAgain: permission.canAskAgain };
    },
    configureRecording: async () => {
      autoReadResponse.cancelAll();
      if (Platform.OS === "ios") await responseSpeech.stop();
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      if (AppState.currentState !== "active") return null;
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
    onRecordingInterrupted: () => {
      // What was captured lands in the draft for review instead of being sent.
      sendRequested = false;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      playCue("error");
    },
    holdBackgroundTime: async () => {
      const task = await nativeSpeech().beginBackgroundTask("Voice transcription");
      return () => void nativeSpeech().endBackgroundTask(task);
    },
  });
  // Settling without a commit (cancel, empty transcript, failed transcription)
  // must not leave a later manual finish armed.
  const unsubscribeSettled = session.subscribe(() => {
    const { phase, error } = session.getSnapshot().state;
    if (phase !== "error" && phase !== "idle") return;
    if (
      phase === "error" &&
      sendRequested &&
      readsRepliesAloud(registry.get(voiceInputSettingsAtom))
    ) {
      announce(`The voice message was not sent. ${error ?? ""}`, "error");
    }
    sendRequested = false;
  });
  const stopAndSend = () => {
    if (session.controller.currentState.phase !== "recording") return;
    sendRequested = true;
    return session.controller.stop();
  };
  const prepareCommit = (text: string) => {
    const send = sendRequested;
    sendRequested = false;
    const readAloud = send && readsRepliesAloud(registry.get(voiceInputSettingsAtom));
    return { text: withDictationDisclaimer(text, readAloud), send };
  };
  // iOS reports `inactive` while its permission dialog is open. Only the real
  // background state cancels preparation; recorder status handles calls and
  // route interruptions during capture.
  const appStateSubscription = AppState.addEventListener("change", (nextState) => {
    if (nextState === "background") void session.controller.appMovedToBackground();
  });
  get.addFinalizer(() => {
    appStateSubscription.remove();
    unsubscribeSettled();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels, stopAndSend, prepareCommit };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels, stopAndSend, prepareCommit } = useAtomValue(voiceInputAtom);
  const settings = useAtomValue(voiceInputSettingsAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const transcriberAvailable =
    settings.transcriptionSource === "local"
      ? getLocalVoiceTranscriber() !== null
      : settings.transcriptionKeys.length > 0;
  return {
    ...snapshot,
    isAvailable: transcriberAvailable || getNativeShowcaseScene() !== null,
    readRepliesAloud: readsRepliesAloud(settings),
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    stopAndSend,
    transcribeAgain: () => void session.controller.transcribeAgain(),
    prepareCommit,
    cancel: () => session.controller.cancel(),
  };
}
