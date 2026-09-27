import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NativeSpeechState } from "./nativeSpeech";

const mocks = vi.hoisted(() => ({
  start: vi.fn<() => Promise<boolean>>(),
  append: vi.fn<(blocks: readonly string[]) => Promise<void>>(),
  finish: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  downloaded: vi.fn<() => boolean>(),
  playCue: vi.fn<() => Promise<void>>(),
  announce: vi.fn<() => Promise<void>>(),
  listener: null as ((state: NativeSpeechState) => void) | null,
  alert: vi.fn(),
}));
vi.mock("./nativeSpeech", () => ({
  nativeSpeech: () => ({
    start: mocks.start,
    append: mocks.append,
    finish: mocks.finish,
    stop: mocks.stop,
    isVoiceDownloaded: mocks.downloaded,
    playCue: mocks.playCue,
    announce: mocks.announce,
    addListener: (_event: string, listener: (state: NativeSpeechState) => void) => {
      mocks.listener = listener;
    },
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
// Paragraphs separated by blank lines stand in for the native Markdown parser.
vi.mock("react-native-nitro-markdown/headless", () => ({
  parseMarkdownWithOptions: (markdown: string) => ({
    type: "document",
    children: markdown
      .split("\n\n")
      .filter(Boolean)
      .map((content) => ({ type: "paragraph", children: [{ type: "text", content }] })),
  }),
}));

import { autoReadResponse } from "./autoReadResponse";
import { responseSpeech } from "./responseSpeech";
import type { SpeechRequest } from "../state/voiceSettings";

const first = { scope: "environment:thread", messageId: "first" };
const second = { scope: "environment:thread", messageId: "second" };
const request: SpeechRequest = {
  model: "openai",
  voice: "marin",
  pace: 1,
  quality: "balanced",
  instructions: "Read clearly.",
  apiKey: "sk-test",
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockImplementation(() => new Promise(() => {}));
  mocks.append.mockResolvedValue(undefined);
  mocks.finish.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.playCue.mockResolvedValue(undefined);
  mocks.announce.mockResolvedValue(undefined);
  mocks.downloaded.mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  autoReadResponse.cancelAll();
  await responseSpeech.stop();
  vi.restoreAllMocks();
});

describe("responseSpeech", () => {
  it("reads every block of a finished response and clears when playback ends", async () => {
    const played = Promise.withResolvers<boolean>();
    mocks.start.mockReturnValueOnce(played.promise);
    const reading = responseSpeech.toggle(first, "One.\n\nTwo.", request, "Thread");
    await flush();
    expect(mocks.start).toHaveBeenCalledWith({ ...request, title: "Thread" });
    expect(mocks.append).toHaveBeenCalledExactlyOnceWith(["One.", "Two."]);
    expect(mocks.finish).toHaveBeenCalledOnce();
    expect(responseSpeech.getSnapshot()).toEqual({ response: first, block: null, paused: false });
    played.resolve(true);
    await reading;
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it("reads a streaming response block by block as it grows", async () => {
    void responseSpeech.read(first, "One.\n\nTw", true, request, "Thread");
    await flush();
    expect(mocks.append).toHaveBeenLastCalledWith(["One."]);
    responseSpeech.update(first, "One.\n\nTwo.\n\nThr", true);
    expect(mocks.append).toHaveBeenLastCalledWith(["Two."]);
    responseSpeech.update(second, "Other.\n\nText.", true);
    expect(mocks.append).toHaveBeenCalledTimes(2);
    expect(mocks.finish).not.toHaveBeenCalled();
    responseSpeech.update(first, "One.\n\nTwo.\n\nThree.", false);
    expect(mocks.append).toHaveBeenLastCalledWith(["Three."]);
    expect(mocks.finish).toHaveBeenCalledOnce();
  });

  it("keeps text that streamed in while the download prompt was open", async () => {
    mocks.downloaded.mockReturnValue(false);
    const prompted = Promise.withResolvers<() => void>();
    mocks.alert.mockImplementationOnce((_title, _body, buttons) =>
      prompted.resolve(buttons[1].onPress),
    );
    void responseSpeech.read(
      first,
      "One.",
      true,
      { ...request, model: "pocket", voice: "Alba" },
      "Thread",
    );
    const accept = await prompted.promise;
    responseSpeech.update(first, "One.\n\nTwo.", false);
    accept();
    await flush();
    expect(mocks.append).toHaveBeenCalledExactlyOnceWith(["One.", "Two."]);
    expect(mocks.finish).toHaveBeenCalledOnce();
  });

  it("tracks the block and pause state reported by native playback", async () => {
    void responseSpeech.toggle(first, "One.\n\nTwo.", request, "Thread");
    await flush();
    mocks.listener?.({ block: 1, paused: true });
    expect(responseSpeech.getSnapshot()).toEqual({ response: first, block: 1, paused: true });
  });

  it("tapping the active response stops it", async () => {
    void responseSpeech.toggle(first, "Hello", request, "Thread");
    await flush();
    await responseSpeech.toggle({ ...first }, "Hello", request, "Thread");
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("cancels the hands-free exchange when playback is stopped from outside", async () => {
    autoReadResponse.request(first);
    mocks.start.mockResolvedValueOnce(false);
    await responseSpeech.toggle(first, "Hello", request, "Thread");
    expect(autoReadResponse.getSnapshot(first.scope)).toBeNull();
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it.each(["completion", "error"])(
    "ignores a late %s from a replaced response",
    async (outcome) => {
      const previous = Promise.withResolvers<boolean>();
      mocks.start.mockReturnValueOnce(previous.promise);
      void responseSpeech.toggle(first, "Hello", request, "Thread");
      await flush();
      void responseSpeech.toggle(second, "World", request, "Thread");
      await flush();
      if (outcome === "completion") previous.resolve(false);
      else previous.reject(new Error("Previous playback failed"));
      await flush();
      expect(responseSpeech.getSnapshot()?.response).toEqual(second);
      expect(mocks.alert).not.toHaveBeenCalled();
    },
  );

  it("reports playback errors aloud and on screen, and clears the reading", async () => {
    autoReadResponse.request(first);
    mocks.start.mockRejectedValueOnce(new Error("Add your OpenAI API key in Settings → Voice."));
    await responseSpeech.toggle(first, "Hello", request, "Thread");
    await flush();
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(autoReadResponse.getSnapshot(first.scope)).toBeNull();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not read response aloud",
      "Add your OpenAI API key in Settings → Voice.",
    );
    expect(mocks.playCue).toHaveBeenCalledWith("error");
    expect(mocks.announce).toHaveBeenCalledWith(
      "Could not read the response aloud. Add your OpenAI API key in Settings → Voice.",
    );
  });

  it("rejects responses without readable text", async () => {
    await responseSpeech.toggle(first, "", request, "Thread");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it.each([true, false])("only downloads an offline voice when accepted (%s)", async (accept) => {
    autoReadResponse.request(first);
    mocks.downloaded.mockReturnValue(false);
    mocks.alert.mockImplementationOnce((_title, body, buttons) => {
      expect(body).toContain("170 MB");
      buttons[accept ? 1 : 0].onPress();
    });
    void responseSpeech.toggle(
      first,
      "Hello",
      { ...request, model: "supertonic", voice: "F1" },
      "Thread",
    );
    await flush();
    expect(mocks.start).toHaveBeenCalledTimes(accept ? 1 : 0);
    expect(autoReadResponse.getSnapshot(first.scope) === null).toBe(!accept);
  });
});
