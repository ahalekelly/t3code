import { File, UploadType, type UploadResult } from "expo-file-system";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";
// The recorder writes MPEG-4 AAC, and the multipart filename comes from the file.
const RECORDING_MIME_TYPE = "audio/mp4";

/** Uploads the recording straight from the device; no T3 environment is involved. */
export function createOpenAiVoiceTranscriber(apiKey: string): VoiceTranscriber {
  return {
    prepare: async ({ signal }: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      return {
        locale,
        transcribe: (uri, options) => transcribeWithOpenAi(uri, locale, apiKey, options),
      };
    },
  };
}

async function transcribeWithOpenAi(
  uri: string,
  locale: string,
  apiKey: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  const response = await uploadRecording(uri, locale, apiKey, signal);
  throwIfVoiceTranscriptionAborted(signal);

  if (response.status < 200 || response.status >= 300) {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      `OpenAI transcription failed (${response.status}): ${readOpenAiErrorMessage(response.body)}`,
    );
  }

  const text = readJsonBody(response.body).text;
  if (typeof text !== "string") {
    throw new VoiceTranscriptionError(
      "transcription-failed",
      "OpenAI returned a transcription response without any text.",
    );
  }
  return text;
}

async function uploadRecording(
  uri: string,
  locale: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<UploadResult> {
  try {
    return await new File(uri).upload(OPENAI_TRANSCRIPTION_URL, {
      httpMethod: "POST",
      uploadType: UploadType.MULTIPART,
      fieldName: "file",
      mimeType: RECORDING_MIME_TYPE,
      headers: { Authorization: `Bearer ${apiKey}` },
      parameters: {
        model: OPENAI_TRANSCRIPTION_MODEL,
        language: locale.split(/[-_]/)[0] ?? locale,
        response_format: "json",
      },
      signal,
    });
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (error instanceof VoiceTranscriptionError) throw error;
    throw new VoiceTranscriptionError(
      "transcription-failed",
      "The recording could not be uploaded to OpenAI.",
      { cause: error },
    );
  }
}

/** OpenAI answers with JSON on success and on error; a proxy may not. */
function readJsonBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readOpenAiErrorMessage(body: string): string {
  const error = readJsonBody(body).error;
  const message =
    typeof error === "object" && error !== null ? Reflect.get(error, "message") : null;
  return typeof message === "string" ? message : body;
}
