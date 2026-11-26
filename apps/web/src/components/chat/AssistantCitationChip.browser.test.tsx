import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import "~/index.css";
import { render } from "../../../test/render";
import { chooseAudioDestination, chooseTranscriptCleanup } from "../../speech/voiceConsent";

const mocks = vi.hoisted(() => ({
  transcribeCalls: 0,
  transcript: null as Promise<string> | null,
}));
const environment = vi.hoisted(() => ({
  environmentId: "environment",
  serverConfig: {
    environment: { capabilities: { voiceTranscription: true, cloudVoiceTranscription: false } },
  },
}));
const preparedConnection = vi.hoisted(() => ({
  environmentId: "environment",
  label: "environment",
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  usePreparedConnection: ((environmentId: string | null) =>
    environmentId === preparedConnection.environmentId
      ? Option.some(preparedConnection)
      : Option.none()) as never,
}));
vi.mock(import("../../state/environments"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironment: ((environmentId: string | null) =>
    environmentId === environment.environmentId ? environment : null) as never,
}));
vi.mock(import("../../speech/runEnvironmentSpeech"), () => ({
  runEnvironmentSpeech: Effect.runPromise as never,
}));
vi.mock(import("@t3tools/client-runtime/voice-input"), async (importOriginal) => ({
  ...(await importOriginal()),
  getEnvironmentSpeechStatus: (() =>
    Effect.succeed({
      supported: true,
      state: "ready",
      modelId: "test-model",
      model: "Test",
      size: 1,
      supportsStreaming: false,
      supportsTranslation: false,
      acceleration: "auto",
      benchmarkTier: "accelerated",
      modelUnloadTimeout: "min_15",
      gpuDevices: [],
    })) as never,
}));
vi.mock(import("../../speech/browserVoiceInput"), () => ({
  createAppleSpeechVoiceInputPlatform: vi.fn() as never,
  createBrowserVoiceInputPlatform: (() => ({
    recorder: {
      uri: "blob:recording",
      prepareToRecordAsync: async () => {},
      record() {},
      stop: async () => {},
    },
    transcriber: {
      prepare: async () => ({
        locale: "en",
        transcribe: async () => {
          mocks.transcribeCalls += 1;
          return mocks.transcript ?? "dictated comment";
        },
      }),
    },
    cancelRecording() {},
    deleteRecording() {},
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

function useDictation() {
  chooseAudioDestination({ kind: "environment", environmentId: citation.environmentId });
  chooseTranscriptCleanup(false);
  mocks.transcribeCalls = 0;
  mocks.transcript = null;
}

function Composer({
  chipCitation,
  onSave = () => true,
}: {
  chipCitation: AssistantCitation;
  onSave?: () => boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AssistantCitationChip
      citation={chipCitation}
      commentEditor={{ open, onOpenChange: setOpen, onSave }}
    />
  );
}

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

describe("citation comment caret", () => {
  it("opens a saved comment with the caret after its end, scrolled into view", async () => {
    const comment = `${"line\n".repeat(40)}end`;
    await using _screen = await render(<Composer chipCitation={{ ...citation, comment }} />);
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));
    const input = textarea()!;

    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(input.scrollTop).toBe(input.scrollHeight - input.clientHeight);
    await userEvent.keyboard("!");
    expect(input.value).toBe(`${comment}!`);
  });

  it("saves with Tab then Enter after typing a comment", async () => {
    const onSave = vi.fn(() => true);
    await using _screen = await render(<Composer chipCitation={citation} onSave={onSave} />);
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));

    await userEvent.keyboard("agreed");
    await userEvent.keyboard("{Tab}");
    await userEvent.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("agreed");
  });
});

describe("citation comment popup position", () => {
  it("opens at its anchor instead of sliding in from the window corner", async () => {
    await using _screen = await render(<Composer chipCitation={citation} />);
    const positioner = () =>
      document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
    await vi.waitFor(() => expect(positioner()?.style.opacity).not.toBe("0"));

    const moves = positioner()!
      .getAnimations()
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          ["transform", "top", "left"].includes(animation.transitionProperty),
      );
    expect(moves).toEqual([]);
  });
});

describe("citation comment dictation", () => {
  async function startDictation(onSave: () => boolean) {
    useDictation();
    const screen = await render(
      <>
        <Composer chipCitation={citation} onSave={onSave} />
        <button type="button">Outside</button>
      </>,
    );
    await page.getByRole("button", { name: "Start voice input" }).click();
    await expect.element(page.getByRole("button", { name: "Finish voice input" })).toBeVisible();
    return screen;
  }

  it("keeps the dictation when the box is clicked away while recording", async () => {
    const onSave = vi.fn(() => true);
    await using _screen = await startDictation(onSave);

    await page.getByRole("button", { name: "Outside" }).click();

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("dictated comment"));
  });

  it("keeps the dictation when the box is clicked away while transcribing", async () => {
    const onSave = vi.fn(() => true);
    await using _screen = await startDictation(onSave);
    let finish!: (text: string) => void;
    mocks.transcript = new Promise((resolve) => (finish = resolve));
    await page.getByRole("button", { name: "Finish voice input" }).click();
    await vi.waitFor(() => expect(mocks.transcribeCalls).toBe(1));

    await page.getByRole("button", { name: "Outside" }).click();
    finish("dictated comment");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("dictated comment"));
  });
});
