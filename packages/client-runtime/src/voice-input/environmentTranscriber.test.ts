import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { createEnvironmentVoiceTranscriber } from "./environmentTranscriber.ts";

const environmentId = EnvironmentId.make("environment-1");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
const registry = {} as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["registry"];

function transcriber(input: {
  readonly services?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly connected?: boolean;
  readonly createUrl?: Parameters<
    typeof createEnvironmentVoiceTranscriber
  >[0]["environment"]["createUrl"];
  readonly fetch?: typeof fetch;
}) {
  return createEnvironmentVoiceTranscriber({
    environmentId,
    serviceId: "openai",
    locale: "en-US",
    registry,
    environment: {
      createUrl:
        input.createUrl ??
        ({
          label: "test:transcription:create-url",
          run: async () =>
            AsyncResult.success({
              relativeUrl: "/api/transcription/token",
              expiresAt: 1,
            }),
        } as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["environment"]["createUrl"]),
    },
    getServices: () => input.services ?? [{ id: "openai", label: "OpenAI" }],
    isConnected: () => input.connected ?? true,
    resolveUrl: (relativeUrl) => `https://environment.test${relativeUrl}`,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
}

describe("createEnvironmentVoiceTranscriber", () => {
  it("mints a URL, uploads the recording, and returns the transcript", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (request) => {
      const url = String(request);
      return url.startsWith("file:")
        ? new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }))
        : Response.json({ text: "hello from OpenAI" });
    });
    const abort = new AbortController();
    const prepared = await transcriber({ fetch: fetchImpl }).prepare({ signal: abort.signal });

    await expect(prepared.transcribe("file:///voice.m4a", { signal: abort.signal })).resolves.toBe(
      "hello from OpenAI",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://environment.test/api/transcription/token");
  });

  it("cancels while minting the upload URL", async () => {
    const createUrl = {
      label: "test:transcription:create-url",
      run: async (_registry: unknown, _input: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("mint aborted")), {
            once: true,
          });
        }),
    } as Parameters<typeof createEnvironmentVoiceTranscriber>[0]["environment"]["createUrl"];
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(new Blob([new Uint8Array([1])], { type: "audio/mp4" })),
    );
    const abort = new AbortController();
    const prepared = await transcriber({ createUrl, fetch: fetchImpl }).prepare({
      signal: abort.signal,
    });
    const pending = prepared.transcribe("file:///voice.m4a", { signal: abort.signal });
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancels the transcription upload", async () => {
    const uploadStarted = deferred<void>();
    const fetchImpl = vi.fn<typeof fetch>(async (request, options) => {
      if (String(request).startsWith("file:")) {
        return new Response(new Blob([new Uint8Array([1])], { type: "audio/mp4" }));
      }
      uploadStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("upload aborted")), {
          once: true,
        });
      });
    });
    const abort = new AbortController();
    const prepared = await transcriber({ fetch: fetchImpl }).prepare({ signal: abort.signal });
    const pending = prepared.transcribe("file:///voice.m4a", { signal: abort.signal });
    await uploadStarted.promise;
    abort.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports unavailable when the selected service is no longer advertised", async () => {
    await expect(
      transcriber({ services: [] }).prepare({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
