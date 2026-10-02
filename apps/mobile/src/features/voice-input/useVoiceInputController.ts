import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { autoReadResponse } from "../../lib/autoReadResponse";
import type { SpokenResponse } from "../../lib/autoReadResponse";
import { nativeSpeech } from "../../lib/nativeSpeech";
import { announce, playCue, responseSpeech } from "../../lib/responseSpeech";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { VOICE_API_PROVIDERS } from "../../lib/speechSettings";
import type { CloudTranscriptionSource } from "../../lib/voiceTranscriptionSources";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import { useVoiceSettings } from "../../state/voiceSettings";
import { withDictationDisclaimer } from "./dictationDisclaimer";
import { createCloudVoiceTranscriber } from "./cloudVoiceTranscriber";
import {
  VoiceInputController,
  VoiceTranscriptionError,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
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
const VOICE_METERING_INTERVAL_MS = 80;
// The native recorder takes the platform's options flattened, as useAudioRecorder passes them.
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  // Mono AAC at 64 kbps keeps speech clear at under 10 MB for the full recording limit.
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios"
    ? RecordingPresets.HIGH_QUALITY.ios
    : RecordingPresets.HIGH_QUALITY.android),
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  autoReadResponse.cancelAll();
  if (Platform.OS === "ios") await responseSpeech.stop();
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      // Keeps recording when the phone locks. Android cannot record.
      allowsBackgroundRecording: Platform.OS === "ios",
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly draftMessage: string;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
  readonly onSubmit: () => Promise<SpokenResponse | undefined>;
}) {
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const sendRequestedRef = useRef(false);
  const pendingSendTextRef = useRef<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const voice = useVoiceSettings();
  const readRepliesAloud = Platform.OS === "ios" && (!voice.loaded || voice.readRepliesAloud);
  const readRepliesAloudRef = useRef(readRepliesAloud);
  readRepliesAloudRef.current = readRepliesAloud;
  const transcriptionSource = voice.transcriptionSource;
  const transcriptionConfig = { source: transcriptionSource, apiKeys: voice.transcriptionKeys };
  const transcriptionConfigRef = useRef(transcriptionConfig);
  transcriptionConfigRef.current = transcriptionConfig;

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
      interrupted: status.interrupted === true,
    });
  }, []);
  // Creating the app's first native recorder blocks the JS thread for about
  // 100 ms, so it waits for the first dictation instead of the composer mount.
  const recorderRef = useRef<AudioRecorder | null>(null);
  useEffect(() => () => recorderRef.current?.release(), []);
  const preparedRecorder = useCallback(() => {
    if (recorderRef.current === null) throw new Error("The voice recorder is not prepared.");
    return recorderRef.current;
  }, []);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder: {
        get uri() {
          return recorderRef.current?.uri ?? null;
        },
        prepareToRecordAsync: () => {
          if (recorderRef.current === null) {
            recorderRef.current = new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS);
            recorderRef.current.addListener("recordingStatusUpdate", handleRecorderStatus);
          }
          return recorderRef.current.prepareToRecordAsync();
        },
        record: (options) => preparedRecorder().record(options),
        stop: async () => {
          await recorderRef.current?.stop();
        },
      },
      getTranscriber: () => {
        const { source, apiKeys } = transcriptionConfigRef.current;
        if (source === "local") return getLocalVoiceTranscriber();
        if (apiKeys.length === 0) return missingKeyTranscriber(source);
        return createCloudVoiceTranscriber(source, apiKeys);
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftMessage,
          selection: current.selection,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        const committed = withDictationDisclaimer(
          text,
          sendRequestedRef.current && readRepliesAloudRef.current,
        );
        // The disclaimer lands after the caret, so the controller's selection holds.
        current.onChangeSelection(selection);
        current.onChangeDraftMessage(committed);
        if (sendRequestedRef.current) {
          sendRequestedRef.current = false;
          pendingSendTextRef.current = committed;
        }
      },
      onStateChange: (next) => {
        // Settling without a commit (cancel, empty transcript, stale draft,
        // failed transcription) must not leave a later manual finish armed.
        if (next.phase === "error" && sendRequestedRef.current && readRepliesAloudRef.current) {
          announce(`The voice message was not sent. ${next.error ?? ""}`, "error");
        }
        if (next.phase === "error" || (next.phase === "idle" && !pendingSendTextRef.current)) {
          sendRequestedRef.current = false;
        }
        setState(next);
      },
      onRecordingInterrupted: () => {
        // What was captured lands in the draft for review instead of being sent.
        sendRequestedRef.current = false;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        playCue("error");
      },
      holdBackgroundTime: async () => {
        const task = await nativeSpeech().beginBackgroundTask("Voice transcription");
        return () => void nativeSpeech().endBackgroundTask(task);
      },
    });
  }

  const controller = controllerRef.current;
  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useFocusEffect(
    useCallback(
      () => () => {
        controller.dispose();
      },
      [controller],
    ),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recording continues.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = preparedRecorder().getStatus();
      if (!status.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    // Nobody sees the meter while the phone is locked, so sampling pauses until the app is active.
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const resume = () => {
      if (intervalId !== null) return;
      sampleRecording();
      intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    };
    const pause = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    if (AppState.currentState === "active") resume();
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") resume();
      else pause();
    });
    return () => {
      subscription.remove();
      pause();
    };
  }, [audioLevels, controller, preparedRecorder, state.phase]);

  // The controller commits the draft and goes idle in the same render, so the
  // send waits for the composer to report the committed text back rather than
  // firing against a stale submit closure.
  useEffect(() => {
    if (pendingSendTextRef.current === null) return;
    if (state.phase !== "idle" || input.draftMessage !== pendingSendTextRef.current) return;
    pendingSendTextRef.current = null;
    void latestInputRef.current
      .onSubmit()
      .then((prompt) => {
        if (!readRepliesAloud) return;
        if (!prompt) {
          announce("The voice message was not sent.", "error");
          return;
        }
        playCue("sent");
        autoReadResponse.request(prompt);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Please try again.";
        if (readRepliesAloud) announce(`The voice message was not sent. ${message}`, "error");
        Alert.alert("Could not send voice message", message);
      });
  }, [input.draftMessage, latestInputRef, pendingSendTextRef, readRepliesAloud, state.phase]);

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const stopAndSend = useCallback(() => {
    if (controller.currentState.phase !== "recording") return;
    sendRequestedRef.current = true;
    return controller.stop();
  }, [controller]);
  const transcribeAgain = useCallback(() => {
    void controller.transcribeAgain();
  }, [controller]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      (transcriptionSource === "local"
        ? getLocalVoiceTranscriber() !== null
        : voice.transcriptionKeys.length > 0) || getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    stopAndSend,
    transcribeAgain,
    cancel,
  };
}
