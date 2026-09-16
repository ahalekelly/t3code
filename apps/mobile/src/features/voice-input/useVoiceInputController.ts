import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { autoReadResponse } from "../../lib/autoReadResponse";
import { responseSpeech, type SpokenResponse } from "../../lib/responseSpeech";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import { mobilePreferencesAtom } from "../../state/preferences";
import { openAiApiKeyAtom } from "../../state/voiceTranscription";
import { withDictationDisclaimer } from "./dictationDisclaimer";
import { createOpenAiVoiceTranscriber } from "./openAiVoiceTranscriber";
import { DEFAULT_VOICE_TRANSCRIPTION_SOURCE } from "./voiceTranscriptionSources";
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
/** Selecting an OpenAI source without a key is a setup mistake, not a reason to fall back. */
const MISSING_OPENAI_KEY_TRANSCRIBER: VoiceTranscriber = {
  prepare: async () => {
    throw new VoiceTranscriptionError("unavailable", "Add an OpenAI API key in Settings → Voice.");
  },
};
const VOICE_METERING_INTERVAL_MS = 80;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
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
  readonly onSubmit: () => Promise<SpokenResponse | null>;
}) {
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const sendRequestedRef = useRef(false);
  const pendingSendTextRef = useRef<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftMessage });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftMessage
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftMessage };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const openAiApiKeyResult = useAtomValue(openAiApiKeyAtom);
  const openAiApiKey = AsyncResult.isSuccess(openAiApiKeyResult) ? openAiApiKeyResult.value : null;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const readRepliesAloud =
    Platform.OS === "ios" &&
    (!AsyncResult.isSuccess(preferencesResult) ||
      (preferencesResult.value.readVoiceRepliesAloud ?? true));
  const transcriptionSource = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.voiceTranscriptionSource ?? DEFAULT_VOICE_TRANSCRIPTION_SOURCE)
    : DEFAULT_VOICE_TRANSCRIPTION_SOURCE;
  const transcriptionConfig = { source: transcriptionSource, apiKey: openAiApiKey };
  const transcriptionConfigRef = useRef(transcriptionConfig);
  transcriptionConfigRef.current = transcriptionConfig;

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleRecorderStatus);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: () => {
        const { source, apiKey } = transcriptionConfigRef.current;
        if (source === "local") return getLocalVoiceTranscriber();
        if (apiKey === null) return MISSING_OPENAI_KEY_TRANSCRIBER;
        return createOpenAiVoiceTranscriber({ apiKey, model: source });
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
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        const committed = withDictationDisclaimer(text);
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
        if (next.phase === "error" || (next.phase === "idle" && !pendingSendTextRef.current)) {
          sendRequestedRef.current = false;
        }
        setState(next);
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
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

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

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

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
        if (prompt && readRepliesAloud) autoReadResponse.request(prompt);
      })
      .catch((error: unknown) => {
        Alert.alert(
          "Could not send voice message",
          error instanceof Error ? error.message : "Please try again.",
        );
      });
  }, [input.draftMessage, latestInputRef, pendingSendTextRef, readRepliesAloud, state.phase]);

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const stopAndSend = useCallback(() => {
    sendRequestedRef.current = true;
    return controller.stop();
  }, [controller]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      (transcriptionSource === "local"
        ? getLocalVoiceTranscriber() !== null
        : openAiApiKey !== null) || getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    stopAndSend,
    cancel,
  };
}
