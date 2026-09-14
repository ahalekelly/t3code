import type { SpeechOptions } from "expo-speech";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  stop: vi.fn<() => Promise<void>>(),
  speak: vi.fn<(text: string, options: SpeechOptions) => void>(),
  parse: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("expo-speech", () => ({ stop: mocks.stop, speak: mocks.speak }));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("react-native-nitro-markdown/headless", () => ({ parseMarkdownWithOptions: mocks.parse }));

import { responseSpeech } from "./responseSpeech";

const first = { scope: "environment:thread", messageId: "first" };
const second = { scope: "environment:thread", messageId: "second" };

describe("responseSpeech", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stop.mockResolvedValue(undefined);
    mocks.parse.mockReturnValue({
      type: "paragraph",
      children: [{ type: "bold", children: [{ type: "text", content: "Hello" }] }],
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await responseSpeech.stop();
    vi.restoreAllMocks();
  });

  it("waits for previous audio to stop, then speaks plain text", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const reading = responseSpeech.toggle(first, "**Hello**");
    expect(responseSpeech.getSnapshot()).toEqual(first);
    expect(mocks.speak).not.toHaveBeenCalled();
    stopped.resolve();
    await reading;
    expect(mocks.speak).toHaveBeenCalledWith(
      "Hello",
      expect.objectContaining({
        useApplicationAudioSession: false,
      }),
    );
    mocks.speak.mock.calls[0]![1].onDone!();
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it("tapping the active response stops instead of starting it again", async () => {
    await responseSpeech.toggle(first, "Hello");
    await responseSpeech.toggle({ ...first }, "Hello");
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it("ignores late callbacks from a replaced response", async () => {
    await responseSpeech.toggle(first, "Hello");
    const oldSpeech = mocks.speak.mock.calls[0]![1];
    await responseSpeech.toggle(second, "World");
    oldSpeech.onStopped!();
    oldSpeech.onDone!();
    oldSpeech.onError!(new Error("stale error"));
    expect(responseSpeech.getSnapshot()).toEqual(second);
    expect(mocks.alert).not.toHaveBeenCalled();
    mocks.speak.mock.calls[1]![1].onStopped!();
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it("only starts the latest response when taps race with native stops", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const readingFirst = responseSpeech.toggle(first, "Hello");
    const readingSecond = responseSpeech.toggle(second, "World");
    stopped.resolve();
    await Promise.all([readingFirst, readingSecond]);
    expect(responseSpeech.getSnapshot()).toEqual(second);
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(mocks.parse).toHaveBeenCalledWith("World", expect.anything());
  });

  it("ignores completion from an earlier reading of the same response", async () => {
    await responseSpeech.toggle(first, "Hello");
    const oldSpeech = mocks.speak.mock.calls[0]![1];
    await responseSpeech.toggle(first, "Hello");
    await responseSpeech.toggle(first, "Hello");
    oldSpeech.onStopped!();
    expect(responseSpeech.getSnapshot()).toEqual(first);
  });

  it("a second tap cancels a response before native playback starts", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const reading = responseSpeech.toggle(first, "Hello");
    const cancelling = responseSpeech.toggle(first, "Hello");
    stopped.resolve();
    await Promise.all([reading, cancelling]);
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it("cancels pending playback when the thread closes or dictation starts", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const reading = responseSpeech.toggle(first, "Hello");
    const closing = responseSpeech.stop();
    stopped.resolve();
    await Promise.all([reading, closing]);
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it("distinguishes matching message IDs in different environments", async () => {
    await responseSpeech.toggle(first, "Hello");
    const remote = { ...first, scope: "remote:thread" };
    await responseSpeech.toggle(remote, "World");
    expect(responseSpeech.getSnapshot()).toEqual(remote);
    expect(mocks.speak).toHaveBeenCalledTimes(2);
  });

  it("clears the active response and reports native speech errors", async () => {
    await responseSpeech.toggle(first, "Hello");
    mocks.speak.mock.calls[0]![1].onError!(new Error("unavailable"));
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it("reports stop failures and allows another attempt", async () => {
    mocks.stop.mockRejectedValueOnce(new Error("stop failed"));
    await responseSpeech.toggle(first, "Hello");
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    await responseSpeech.toggle(first, "Hello");
    expect(mocks.speak).toHaveBeenCalledTimes(1);
  });

  it("reports unreadable responses without leaving the stop button active", async () => {
    mocks.parse.mockReturnValue({ type: "document", children: [] });
    await responseSpeech.toggle(first, "---");
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });
});
