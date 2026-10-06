import { Alert } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";
import { useSyncExternalStore } from "react";

import { autoReadResponse, type SpokenResponse } from "./autoReadResponse";
import { speechBlocks, unsentSpeechBlocks } from "./markdownSpeechText";
import { nativeSpeech, type SpeechCue } from "./nativeSpeech";
import type { SpeechRequest } from "./speechSettings";

/** `block` indexes the response's top-level Markdown blocks; null until audio starts. */
export type SpeechSnapshot = {
  readonly response: SpokenResponse;
  readonly block: number | null;
  readonly paused: boolean;
};

type Reading = {
  readonly id: string;
  readonly response: SpokenResponse;
  markdown: string;
  streaming: boolean;
  sent: readonly string[];
};

let snapshot: SpeechSnapshot | null = null;
let reading: Reading | null = null;
let listening = false;
let readings = 0;
const listeners = new Set<() => void>();

function setSnapshot(next: SpeechSnapshot | null) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function isResponse(a: SpokenResponse, b: SpokenResponse) {
  return a.scope === b.scope && a.messageId === b.messageId;
}

function listen() {
  if (listening) return;
  listening = true;
  nativeSpeech().addListener("onSpeechState", ({ reading: id, block, paused }) => {
    if (snapshot && reading?.id === id) setSnapshot({ ...snapshot, block, paused });
  });
}

function blocksOf(markdown: string) {
  return speechBlocks(parseMarkdownWithOptions(markdown, { gfm: true, html: true, math: false }));
}

/** Sends the blocks that are ready, and ends the input once the text is final. */
function flush(current: Reading) {
  const unsent = unsentSpeechBlocks(current.sent, blocksOf(current.markdown), current.streaming);
  if (unsent) {
    current.sent = [...current.sent.slice(0, unsent.from), ...unsent.blocks];
    void nativeSpeech().append(unsent.blocks, unsent.from);
  }
  if (!current.streaming) void nativeSpeech().finish();
}

export function playCue(cue: SpeechCue) {
  void nativeSpeech()
    .playCue(cue)
    .catch((error: unknown) => console.error("Failed to play a cue", error));
}

/** Plays a tone and speaks the message in the system voice, which needs no network. */
export function announce(text: string, cue: "attention" | "error") {
  void nativeSpeech()
    .announce(text, cue)
    .catch((error: unknown) => console.error("Failed to announce", error));
}

export function reportResponseSpeechError(error: unknown) {
  console.error("Failed to read response aloud", error);
  const message = error instanceof Error ? error.message : "Please try again.";
  announce(`Could not read the response aloud. ${message}`, "error");
  Alert.alert("Could not read response aloud", message);
}

export const responseSpeech = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,

  /**
   * Reads a response aloud. While `streaming`, pass later text to `update`; each
   * block is read once the next one starts, and the rest once streaming ends.
   */
  async read(
    response: SpokenResponse,
    markdown: string,
    streaming: boolean,
    request: SpeechRequest,
    title: string,
  ) {
    listen();
    const current: Reading = { id: String(++readings), response, markdown, streaming, sent: [] };
    reading = current;
    setSnapshot({ response, block: null, paused: false });
    const finish = () => {
      if (reading !== current) return;
      reading = null;
      setSnapshot(null);
    };
    try {
      if (!streaming && blocksOf(markdown).every((block) => block === "")) {
        throw new Error("This response has no readable text.");
      }
      const done = nativeSpeech().start({ ...request, title }, current.id);
      flush(current);
      const completed = await done;
      if (!completed && reading === current) autoReadResponse.cancel(response.scope);
      finish();
    } catch (error) {
      if (reading !== current) return;
      autoReadResponse.cancel(response.scope);
      finish();
      reportResponseSpeechError(error);
    }
  },

  /** Passes newer text of a streaming response to its reading. */
  update(response: SpokenResponse, markdown: string, streaming: boolean) {
    const current = reading;
    if (!current || !isResponse(current.response, response) || !current.streaming) return;
    current.markdown = markdown;
    current.streaming = streaming;
    flush(current);
  },

  toggle(response: SpokenResponse, markdown: string, request: SpeechRequest, title: string) {
    if (snapshot && isResponse(snapshot.response, response)) return responseSpeech.stop();
    return responseSpeech.read(response, markdown, false, request, title);
  },

  stop() {
    reading = null;
    setSnapshot(null);
    return nativeSpeech().stop().catch(reportResponseSpeechError);
  },
  rewind: () => nativeSpeech().rewind().catch(reportResponseSpeechError),
  nextBlock: () => nativeSpeech().nextBlock().catch(reportResponseSpeechError),
  seekToBlock: (block: number) =>
    nativeSpeech().seekToBlock(block).catch(reportResponseSpeechError),
  pause: () => nativeSpeech().pause().catch(reportResponseSpeechError),
  resume: () => nativeSpeech().resume().catch(reportResponseSpeechError),
  setPace: (pace: number) => nativeSpeech().setPace(pace).catch(reportResponseSpeechError),
};

/** The block being read in this message: undefined when it is not being read, null before audio starts. */
export function useSpokenBlock(scope: string, messageId: string) {
  return useSyncExternalStore(responseSpeech.subscribe, () =>
    snapshot && snapshot.response.scope === scope && snapshot.response.messageId === messageId
      ? snapshot.block
      : undefined,
  );
}
