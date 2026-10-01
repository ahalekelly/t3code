import { File, UploadType, type UploadResult } from "expo-file-system";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import { VOICE_API_PROVIDERS } from "../../lib/speechSettings";
import type { CloudTranscriptionSource } from "../../lib/voiceTranscriptionSources";

// The recorder writes MPEG-4 AAC, and the multipart filename comes from the file.
const RECORDING_MIME_TYPE = "audio/mp4";

/** How each provider takes a multipart recording upload and returns its transcript. */
const PROVIDERS = {
  openai: {
    url: "https://api.openai.com/v1/audio/transcriptions",
    fieldName: "file",
    headers: (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` }),
    parameters: (locale: string) => ({
      model: "gpt-transcribe",
      language: locale.split(/[-_]/)[0] ?? locale,
      response_format: "json",
    }),
    readText: (body: Record<string, unknown>) => body.text,
  },
  // Azure Speech fast transcription; MAI-Transcribe-2 detects the language itself.
  // West US 2 serves MAI-Transcribe and the MAI voices, so one key covers both.
  azure: {
    url: "https://westus2.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15",
    fieldName: "audio",
    headers: (apiKey: string) => ({ "Ocp-Apim-Subscription-Key": apiKey }),
    parameters: () => ({
      definition: JSON.stringify({
        enhancedMode: {
          enabled: true,
          model: "MAI-Transcribe-2",
          // Drops fillers and false starts, as dictation wants.
          modelOptions: { transcribeStyle: "clean" },
        },
      }),
    }),
    readText: (body: Record<string, unknown>) => {
      const phrases = body.combinedPhrases;
      return Array.isArray(phrases) ? (phrases[0]?.text ?? "") : undefined;
    },
  },
} satisfies Record<CloudTranscriptionSource, unknown>;

/**
 * Keys whose quota ran out, mapped to when it refills; skipped until then. Azure's free
 * tier answers 403 once its monthly quota is spent and 429 while over its rate limit.
 */
const spentKeys = new Map<string, number>();

/** Azure's 403 says when the quota refills in `Retry-After` seconds; without it, assume the next month in UTC. */
function quotaRefill(headers: Record<string, string>, now: Date): number {
  const retryAfter = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  const seconds = Number(retryAfter?.[1]);
  if (retryAfter && Number.isFinite(seconds)) return now.getTime() + seconds * 1000;
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Uploads the recording straight from the device; no T3 environment is involved.
 * A refused key retries with the next one, so Azure's free key serves until its quota runs out.
 */
export function createCloudVoiceTranscriber(
  source: CloudTranscriptionSource,
  apiKeys: readonly string[],
): VoiceTranscriber {
  return {
    prepare: async ({ signal }: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      return {
        locale,
        transcribe: (uri, options) => transcribe(source, uri, locale, apiKeys, options),
      };
    },
  };
}

async function transcribe(
  source: CloudTranscriptionSource,
  uri: string,
  locale: string,
  apiKeys: readonly string[],
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  const provider = PROVIDERS[source];
  const label = VOICE_API_PROVIDERS[source].label;
  const now = new Date();
  const keys = apiKeys.filter(
    (key, index) => index === apiKeys.length - 1 || (spentKeys.get(key) ?? 0) <= now.getTime(),
  );
  let response: UploadResult | undefined;
  for (const [position, apiKey] of keys.entries()) {
    throwIfVoiceTranscriptionAborted(signal);
    try {
      response = await new File(uri).upload(provider.url, {
        httpMethod: "POST",
        uploadType: UploadType.MULTIPART,
        fieldName: provider.fieldName,
        mimeType: RECORDING_MIME_TYPE,
        headers: provider.headers(apiKey),
        parameters: provider.parameters(locale),
        signal,
      });
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      if (error instanceof VoiceTranscriptionError) throw error;
      throw new VoiceTranscriptionError(
        "transcription-failed",
        `The recording could not be uploaded to ${label}.`,
        { cause: error },
      );
    }
    throwIfVoiceTranscriptionAborted(signal);
    if (![403, 429].includes(response.status) || position === keys.length - 1) break;
    if (response.status === 403) spentKeys.set(apiKey, quotaRefill(response.headers, now));
  }
  if (response === undefined) throw new Error("Cloud transcription needs at least one API key.");

  const body = readJsonBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      `${label} transcription failed (${response.status}): ${readErrorMessage(body) ?? response.body}`,
    );
  }
  const text = provider.readText(body);
  if (typeof text !== "string") {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      `${label} returned a transcription response without any text.`,
    );
  }
  return text;
}

/** Both providers answer with JSON on success and on error; a proxy may not. */
function readJsonBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI and Azure both send `error.message`. */
function readErrorMessage(body: Record<string, unknown>): string | null {
  const error = body.error;
  const message =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : null;
  return typeof message === "string" ? message : null;
}
