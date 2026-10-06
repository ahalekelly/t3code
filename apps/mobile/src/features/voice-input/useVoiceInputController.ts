import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { autoReadResponse, type SpokenResponse } from "../../lib/autoReadResponse";
import { announce, playCue } from "../../lib/responseSpeech";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  /** Shown by the global dictation pill when this composer is off screen. */
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
  /** Sends the draft after a dictation finished with Send. */
  readonly onSubmit?: () => Promise<SpokenResponse | undefined>;
}) {
  const global = useGlobalVoiceInput();
  const { setOwnerFocused, session, prepareCommit, readRepliesAloud } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  // The committed text of a dictation finished with Send, until the draft shows it.
  const [pendingSendText, setPendingSendText] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (transcript, selection) => {
          const { text, send } = prepareCommit(transcript);
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
            if (send) setPendingSendText(text);
          }
        },
        captured.selection,
      ),
      label: captured.label,
    });
  }, [prepareCommit, session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;

  // The transcript lands and the controller goes idle in one update, so the send
  // waits for the composer to render the committed text instead of submitting a
  // stale draft.
  const draftShowsPendingSend =
    pendingSendText !== null && input.readDraftMessage() === pendingSendText;
  useEffect(() => {
    if (!draftShowsPendingSend || state.phase !== "idle") return;
    setPendingSendText(null);
    const submit = latestInput.current.onSubmit;
    if (!submit) return;
    void submit()
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
  }, [draftShowsPendingSend, readRepliesAloud, state.phase]);

  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    stopAndSend: global.stopAndSend,
    transcribeAgain: global.transcribeAgain,
    cancel: global.cancel,
  };
}
