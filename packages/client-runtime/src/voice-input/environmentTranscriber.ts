import {
  type EnvironmentId,
  TranscriptionResponse,
  type TranscriptionService,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/unstable/reactivity";

import type { TranscriptionEnvironmentAtoms } from "../state/transcription.ts";
import { runAtomCommand, squashAtomCommandFailure } from "../state/runtime.ts";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "./transcription.ts";

const decodeResponse = Schema.decodeUnknownSync(TranscriptionResponse);

function transcriptionError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  return cause instanceof VoiceTranscriptionError
    ? cause
    : new VoiceTranscriptionError(code, message, { cause });
}

export function createEnvironmentVoiceTranscriber(input: {
  readonly environmentId: EnvironmentId;
  readonly serviceId: string;
  readonly locale: string;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environment: TranscriptionEnvironmentAtoms;
  readonly getServices: () => ReadonlyArray<TranscriptionService>;
  readonly isConnected: () => boolean;
  readonly resolveUrl: (relativeUrl: string) => string | null;
  readonly fetch?: typeof fetch;
}): VoiceTranscriber {
  const fetchImpl = input.fetch ?? fetch;

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      if (!input.isConnected()) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "The selected transcription environment is disconnected.",
        );
      }
      if (!input.getServices().some((service) => service.id === input.serviceId)) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "The selected transcription service is unavailable.",
        );
      }

      return {
        locale: input.locale,
        transcribe: async (uri, options) => {
          const { signal: transcriptionSignal } = options;
          try {
            throwIfVoiceTranscriptionAborted(transcriptionSignal);
            const recordingResponse = await fetchImpl(uri, { signal: transcriptionSignal });
            if (!recordingResponse.ok) throw new Error("Could not read the voice recording.");
            const audio = await recordingResponse.blob();
            throwIfVoiceTranscriptionAborted(transcriptionSignal);

            const minted = await runAtomCommand(
              input.registry,
              input.environment.createUrl,
              {
                environmentId: input.environmentId,
                input: {
                  mimeType: audio.type || "audio/mp4",
                  sizeBytes: audio.size,
                  locale: input.locale,
                },
              },
              {
                reportFailure: false,
                reportDefect: false,
                signal: transcriptionSignal,
              },
            );
            throwIfVoiceTranscriptionAborted(transcriptionSignal);
            if (minted._tag !== "Success") {
              if (!input.isConnected()) {
                throw new VoiceTranscriptionError(
                  "unavailable",
                  "The selected transcription environment is disconnected.",
                );
              }
              throw squashAtomCommandFailure(minted);
            }

            const url = input.resolveUrl(minted.value.relativeUrl);
            if (!url) {
              throw new VoiceTranscriptionError(
                "unavailable",
                "The selected transcription environment is disconnected.",
              );
            }
            const response = await fetchImpl(url, {
              method: "POST",
              headers: { "Content-Type": audio.type || "audio/mp4" },
              body: audio,
              signal: transcriptionSignal,
            });
            throwIfVoiceTranscriptionAborted(transcriptionSignal);
            if (!response.ok) {
              throw new Error(
                (await response.text()) || `Transcription failed (${response.status}).`,
              );
            }
            return decodeResponse(await response.json()).text;
          } catch (cause) {
            if (transcriptionSignal.aborted) {
              throw new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.", {
                cause,
              });
            }
            throw transcriptionError(
              "transcription-failed",
              "The environment could not transcribe the recording.",
              cause,
            );
          }
        },
      };
    },
  };
}
