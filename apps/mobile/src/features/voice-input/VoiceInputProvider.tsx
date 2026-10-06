import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type RecorderState,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { autoReadResponse } from "../../lib/autoReadResponse";
import { nativeSpeech } from "../../lib/nativeSpeech";
import { announce, playCue, responseSpeech } from "../../lib/responseSpeech";
import { VOICE_API_PROVIDERS } from "../../lib/speechSettings";
import type { CloudTranscriptionSource } from "../../lib/voiceTranscriptionSources";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { useVoiceSettings } from "../../state/voiceSettings";
import { toEpochNanos } from "../observability/appTraces";
import { connectionTraceRecorder } from "../observability/tracing";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VoiceTranscriptionError,
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createCloudVoiceTranscriber } from "./cloudVoiceTranscriber";
import { withDictationDisclaimer } from "./dictationDisclaimer";
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from "./lazyVoiceRecorder";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor takes platform-flattened options, as `useAudioRecorder`
// builds them with expo-audio's internal `createRecordingOptions`.
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

type PreparationTimer = <T>(step: string, run: () => Promise<T>) => Promise<T>;

type PreparationTrace = {
  readonly start: number;
  end: number | null;
  outcome: VoiceInputState["phase"] | null;
  pending: number;
  readonly steps: Record<string, number>;
};

/**
 * Records a `client.voice.prepare` span per dictation start, from the tap until
 * recording starts or fails, with each step's duration. The span waits for steps
 * still running when the start ends early, such as a cancelled transcriber.
 */
function createPreparationTracer() {
  let current: PreparationTrace | null = null;
  const record = (trace: PreparationTrace) => {
    if (trace.end === null || trace.pending > 0) return;
    connectionTraceRecorder.recordSpan(
      "client.voice.prepare",
      toEpochNanos(trace.start),
      toEpochNanos(trace.end),
      { ...trace.steps, "voice.outcome": trace.outcome },
    );
  };
  const timed: PreparationTimer = async (step, run) => {
    const trace = current;
    if (trace === null) return run();
    const start = performance.now();
    trace.pending += 1;
    try {
      return await run();
    } finally {
      trace.steps[`voice.${step}_ms`] = Math.round(performance.now() - start);
      trace.pending -= 1;
      record(trace);
    }
  };
  const phaseChanged = (phase: VoiceInputState["phase"]) => {
    if (phase === "preparing") {
      current = { start: performance.now(), end: null, outcome: null, pending: 0, steps: {} };
      return;
    }
    const trace = current;
    if (trace === null) return;
    current = null;
    trace.end = performance.now();
    trace.outcome = phase;
    record(trace);
  };
  return { timed, phaseChanged };
}

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(timed: PreparationTimer): Promise<void> {
  autoReadResponse.cancelAll();
  if (Platform.OS === "ios") await responseSpeech.stop();
  try {
    await timed("audio_mode", () =>
      setAudioModeAsync({
        allowsRecording: true,
        interruptionMode: "doNotMix",
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        // Keeps recording when the phone locks. Android cannot record.
        allowsBackgroundRecording: Platform.OS === "ios",
      }),
    );
    await timed("activate", () => setIsAudioActiveAsync(true));
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const recorderRef = useRef<LazyVoiceRecorder<RecorderState> | null>(null);
  const sendRequestedRef = useRef(false);
  const voice = useVoiceSettings();
  const readRepliesAloud = Platform.OS === "ios" && (!voice.loaded || voice.readRepliesAloud);
  const readRepliesAloudRef = useRef(readRepliesAloud);
  readRepliesAloudRef.current = readRepliesAloud;
  const transcriptionConfig = {
    source: voice.transcriptionSource,
    apiKeys: voice.transcriptionKeys,
  };
  const transcriptionConfigRef = useRef(transcriptionConfig);
  transcriptionConfigRef.current = transcriptionConfig;

  if (!sessionRef.current || !recorderRef.current) {
    const { timed, phaseChanged } = createPreparationTracer();
    // The native recorder is created when dictation starts, not on app launch.
    const recorder = createLazyVoiceRecorder({
      create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        void sessionRef.current?.controller.handleRecorderStatus({
          isFinished: status.isFinished,
          hasError: status.hasError || status.mediaServicesDidReset === true,
          error: status.error,
          url: status.url,
          interrupted: status.interrupted === true,
        });
      },
    });
    recorderRef.current = recorder;
    sessionRef.current = new VoiceInputSession({
      recorder: {
        get uri() {
          return recorder.uri;
        },
        prepareToRecordAsync: () => timed("recorder", () => recorder.prepareToRecordAsync()),
        record: (options) => recorder.record(options),
        stop: () => recorder.stop(),
      },
      getTranscriber: () => {
        const { source, apiKeys } = transcriptionConfigRef.current;
        const transcriber =
          source === "local"
            ? getLocalVoiceTranscriber()
            : apiKeys.length === 0
              ? missingKeyTranscriber(source)
              : createCloudVoiceTranscriber(source, apiKeys);
        return (
          transcriber && {
            prepare: (options) => timed("transcriber", () => transcriber.prepare(options)),
          }
        );
      },
      requestPermission: async () => {
        const permission = await timed("permission", requestRecordingPermissionsAsync);
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: () => configureVoiceRecordingAudio(timed),
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      onStateChange: (nextState) => {
        phaseChanged(nextState.phase);
        // Settling without a commit (cancel, empty transcript, failed
        // transcription) must not leave a later manual finish armed.
        if (nextState.phase === "error" || nextState.phase === "idle") {
          if (
            nextState.phase === "error" &&
            sendRequestedRef.current &&
            readRepliesAloudRef.current
          ) {
            announce(`The voice message was not sent. ${nextState.error ?? ""}`, "error");
          }
          sendRequestedRef.current = false;
        }
        setState({
          state: nextState,
          ownerKey: sessionRef.current?.ownerKey ?? null,
          label: sessionRef.current?.label ?? null,
        });
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

  const session = sessionRef.current;
  const controller = session.controller;
  const recorder = recorderRef.current;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      // Dispose first so an active recording is stopped before the recorder is released.
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

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
      const status = recorder.getStatus();
      if (!status?.isRecording) return;

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
  }, [audioLevels, controller, recorder, state.phase]);

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
  /** Applies a transcript about to land; `send` reports whether it was finished with Send. */
  const prepareCommit = useCallback((text: string) => {
    const send = sendRequestedRef.current;
    sendRequestedRef.current = false;
    return { text: withDictationDisclaimer(text, send && readRepliesAloudRef.current), send };
  }, []);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      (voice.transcriptionSource === "local"
        ? getLocalVoiceTranscriber() !== null
        : voice.transcriptionKeys.length > 0) || getNativeShowcaseScene() !== null,
    readRepliesAloud,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    stopAndSend,
    transcribeAgain,
    prepareCommit,
    cancel,
  };
}
