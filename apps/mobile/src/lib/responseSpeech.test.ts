import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  stop: vi.fn<() => Promise<void>>(),
  rewind: vi.fn<() => Promise<void>>(),
  speak: vi.fn<(text: string, rate: number, model: string) => Promise<boolean>>(),
  downloaded: vi.fn<() => boolean>(),
  parse: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("./nativeSpeech", () => ({
  nativeSpeech: {
    stop: mocks.stop,
    rewind: mocks.rewind,
    speak: mocks.speak,
    isVoiceDownloaded: mocks.downloaded,
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("react-native-nitro-markdown/headless", () => ({ parseMarkdownWithOptions: mocks.parse }));

import { autoReadResponse } from "./autoReadResponse";
import { responseSpeech } from "./responseSpeech";

const first = { scope: "environment:thread", messageId: "first" };
const second = { scope: "environment:thread", messageId: "second" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alert.mockReset();
  mocks.stop.mockResolvedValue(undefined);
  mocks.speak.mockImplementation(() => new Promise(() => {}));
  mocks.downloaded.mockReturnValue(true);
  mocks.parse.mockReturnValue({
    type: "paragraph",
    children: [{ type: "text", content: "Hello" }],
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  autoReadResponse.cancelAll();
  await responseSpeech.stop();
  vi.restoreAllMocks();
});

describe("responseSpeech", () => {
  it("cancels queued updates when audio is interrupted", async () => {
    autoReadResponse.request(first);
    mocks.speak.mockResolvedValueOnce(false);
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    expect(autoReadResponse.getSnapshot(first.scope)).toBeNull();
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it("cancels queued updates when the voice download is declined", async () => {
    autoReadResponse.request(first);
    mocks.downloaded.mockReturnValue(false);
    mocks.alert.mockImplementationOnce((_title, _body, buttons) => buttons[0].onPress());
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    expect(autoReadResponse.getSnapshot(first.scope)).toBeNull();
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it("uses the selected speed and rewinds without regenerating speech", async () => {
    await responseSpeech.toggle(first, "Hello", 1.5, "pocket");
    await responseSpeech.rewind();
    expect(mocks.speak).toHaveBeenCalledExactlyOnceWith("Hello", 1.5, "pocket");
    expect(mocks.rewind).toHaveBeenCalledOnce();
    expect(responseSpeech.getSnapshot()).toEqual(first);
  });

  it("downloads the selected model and can switch back to Pocket", async () => {
    mocks.downloaded.mockReturnValue(false);
    mocks.alert.mockImplementation((_title, _body, buttons) => buttons[1].onPress());
    await responseSpeech.toggle(first, "Hello", 1, "supertonic");
    expect(mocks.alert.mock.calls[0]?.[1]).toContain("Supertonic 3");
    expect(mocks.alert.mock.calls[0]?.[1]).toContain("170 MB");
    expect(mocks.downloaded).toHaveBeenCalledWith("supertonic");
    expect(mocks.speak).toHaveBeenLastCalledWith("Hello", 1, "supertonic");
    await responseSpeech.toggle(second, "Hello", 1, "pocket");
    expect(mocks.speak).toHaveBeenLastCalledWith("Hello", 1, "pocket");
  });

  it("waits for previous playback to stop and reads plain text until playback completes", async () => {
    const stopped = Promise.withResolvers<void>();
    const played = Promise.withResolvers<boolean>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    mocks.speak.mockReturnValueOnce(played.promise);
    const reading = responseSpeech.toggle(first, "**Hello**", 1, "pocket");
    expect(responseSpeech.getSnapshot()).toEqual(first);
    expect(mocks.speak).not.toHaveBeenCalled();
    stopped.resolve();
    await reading;
    expect(mocks.speak).toHaveBeenCalledWith("Hello", 1, "pocket");
    expect(responseSpeech.getSnapshot()).toEqual(first);
    played.resolve(true);
    await played.promise;
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it("tapping the active response stops it", async () => {
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    await responseSpeech.toggle({ ...first }, "Hello", 1, "pocket");
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.speak).toHaveBeenCalledTimes(1);
  });

  it.each(["completion", "error"])(
    "ignores a late %s from a replaced response",
    async (outcome) => {
      const previous = Promise.withResolvers<boolean>();
      mocks.speak.mockReturnValueOnce(previous.promise);
      await responseSpeech.toggle(first, "Hello", 1, "pocket");
      await responseSpeech.toggle(second, "World", 1, "pocket");
      if (outcome === "completion") previous.resolve(true);
      else previous.reject(new Error("Previous playback failed"));
      await previous.promise.catch(() => {});
      expect(responseSpeech.getSnapshot()).toEqual(second);
      expect(mocks.alert).not.toHaveBeenCalled();
    },
  );

  it("starts only the latest response when taps race with stopping", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const a = responseSpeech.toggle(first, "Hello", 1, "pocket");
    const b = responseSpeech.toggle(second, "World", 1, "pocket");
    stopped.resolve();
    await Promise.all([a, b]);
    expect(mocks.speak).toHaveBeenCalledTimes(1);
    expect(mocks.parse).toHaveBeenCalledWith("World", expect.anything());
    expect(responseSpeech.getSnapshot()).toEqual(second);
  });

  it("does not start after the thread closes or voice recording starts", async () => {
    const stopped = Promise.withResolvers<void>();
    mocks.stop.mockReturnValueOnce(stopped.promise);
    const reading = responseSpeech.toggle(first, "Hello", 1, "pocket");
    const closing = responseSpeech.stop();
    stopped.resolve();
    await Promise.all([reading, closing]);
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(responseSpeech.getSnapshot()).toBeNull();
  });

  it("distinguishes matching message IDs in different environments", async () => {
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    const remote = { ...first, scope: "remote:thread" };
    await responseSpeech.toggle(remote, "Hello", 1, "pocket");
    expect(responseSpeech.getSnapshot()).toEqual(remote);
    expect(mocks.speak).toHaveBeenCalledTimes(2);
  });

  it("reports playback errors and clears the active response", async () => {
    const played = Promise.withResolvers<boolean>();
    mocks.speak.mockReturnValueOnce(played.promise);
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    played.reject(new Error("Voice download failed"));
    await played.promise.catch(() => {});
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not read response aloud",
      "Voice download failed",
    );
  });

  it("reports stop failures and permits another attempt", async () => {
    mocks.stop.mockRejectedValueOnce(new Error("Stop failed"));
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    expect(mocks.speak).toHaveBeenCalledTimes(1);
  });

  it("rejects responses without readable text", async () => {
    mocks.parse.mockReturnValue({ type: "document", children: [] });
    await responseSpeech.toggle(first, "---", 1, "pocket");
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(responseSpeech.getSnapshot()).toBeNull();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("only downloads the voice when the user accepts (%s)", async (accept) => {
    mocks.downloaded.mockReturnValue(false);
    mocks.alert.mockImplementationOnce((_title, _body, buttons) =>
      buttons[accept ? 1 : 0].onPress(),
    );
    await responseSpeech.toggle(first, "Hello", 1, "pocket");
    expect(mocks.speak).toHaveBeenCalledTimes(accept ? 1 : 0);
    expect(responseSpeech.getSnapshot()).toEqual(accept ? first : null);
  });

  it("ignores download confirmation after leaving the response", async () => {
    mocks.downloaded.mockReturnValue(false);
    const prompted = Promise.withResolvers<() => void>();
    mocks.alert.mockImplementationOnce((_title, _body, buttons) =>
      prompted.resolve(buttons[1].onPress),
    );
    const reading = responseSpeech.toggle(first, "Hello", 1, "pocket");
    const accept = await prompted.promise;
    await responseSpeech.stop();
    accept();
    await reading;
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(responseSpeech.getSnapshot()).toBeNull();
  });
});
