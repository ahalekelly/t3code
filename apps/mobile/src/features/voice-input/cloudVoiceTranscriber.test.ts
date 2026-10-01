import type { UploadOptions, UploadResult } from "expo-file-system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  upload: vi.fn<(url: string, options: UploadOptions) => Promise<UploadResult>>(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    upload = mocks.upload;
  },
  UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

import { createCloudVoiceTranscriber } from "./cloudVoiceTranscriber";

function response(status: number, body: unknown): UploadResult {
  return { status, body: JSON.stringify(body), headers: {} };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function transcribe(signal: AbortSignal, source: "openai" | "azure" = "openai") {
  const transcriber = createCloudVoiceTranscriber(source, ["sk-test"]);
  const prepared = await transcriber.prepare({ signal });
  return prepared.transcribe("file:///voice.m4a", { signal });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...Intl.DateTimeFormat().resolvedOptions(),
    locale: "sv-FI",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCloudVoiceTranscriber", () => {
  it("uploads the recording with the key, GPT Transcribe, and device language", async () => {
    mocks.upload.mockResolvedValue(response(200, { text: "Hej världen." }));

    await expect(transcribe(new AbortController().signal)).resolves.toBe("Hej världen.");
    expect(mocks.upload).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        httpMethod: "POST",
        uploadType: 1,
        fieldName: "file",
        mimeType: "audio/mp4",
        headers: { Authorization: "Bearer sk-test" },
        parameters: { model: "gpt-transcribe", language: "sv", response_format: "json" },
      }),
    );
  });

  it("uploads to Azure with MAI-Transcribe-2 and reads the combined transcript", async () => {
    mocks.upload.mockResolvedValue(
      response(200, { combinedPhrases: [{ text: "Hej världen." }], phrases: [] }),
    );

    await expect(transcribe(new AbortController().signal, "azure")).resolves.toBe("Hej världen.");
    const [url, options] = mocks.upload.mock.calls[0]!;
    expect(url).toBe(
      "https://westus2.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    );
    expect(options).toMatchObject({
      fieldName: "audio",
      headers: { "Ocp-Apim-Subscription-Key": "sk-test" },
    });
    expect(JSON.parse(options.parameters!.definition!)).toEqual({
      enhancedMode: {
        enabled: true,
        model: "MAI-Transcribe-2",
        modelOptions: { transcribeStyle: "clean" },
      },
    });
  });

  it("retries with the next key when Azure's free key answers 403", async () => {
    mocks.upload
      .mockResolvedValueOnce(response(403, { error: { message: "Out of call volume quota." } }))
      .mockResolvedValueOnce(response(200, { combinedPhrases: [{ text: "Hej." }] }));
    const transcriber = createCloudVoiceTranscriber("azure", ["free", "paid"]);
    const { signal } = new AbortController();
    const prepared = await transcriber.prepare({ signal });

    await expect(prepared.transcribe("file:///voice.m4a", { signal })).resolves.toBe("Hej.");
    expect(mocks.upload.mock.calls.map(([, options]) => options.headers)).toEqual([
      { "Ocp-Apim-Subscription-Key": "free" },
      { "Ocp-Apim-Subscription-Key": "paid" },
    ]);
  });

  it("reads silence from Azure as an empty transcript", async () => {
    mocks.upload.mockResolvedValue(response(200, { combinedPhrases: [], phrases: [] }));

    await expect(transcribe(new AbortController().signal, "azure")).resolves.toBe("");
  });

  it("reports OpenAI's own error message when the request is rejected", async () => {
    mocks.upload.mockResolvedValue(response(401, { error: { message: "Incorrect API key." } }));

    const error = await transcribe(new AbortController().signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "transcription-failed" });
    expect((error as VoiceTranscriptionError).message).toContain("401");
    expect((error as VoiceTranscriptionError).message).toContain("Incorrect API key.");
  });

  it("discards a transcript produced after cancellation", async () => {
    const enteredUpload = deferred<void>();
    const uploadResult = deferred<UploadResult>();
    mocks.upload.mockImplementation(() => {
      enteredUpload.resolve();
      return uploadResult.promise;
    });
    const controller = new AbortController();
    const result = transcribe(controller.signal).catch((error: unknown) => error);

    await enteredUpload.promise;
    controller.abort();
    uploadResult.resolve(response(200, { text: "Hej världen." }));

    expect(await result).toMatchObject({ code: "cancelled" });
  });

  it("fails when a successful response carries no transcript", async () => {
    mocks.upload.mockResolvedValue(response(200, { duration: 2 }));

    const error = await transcribe(new AbortController().signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "transcription-failed" });
  });
});
