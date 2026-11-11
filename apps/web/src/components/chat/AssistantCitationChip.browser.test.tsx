import { type AssistantCitation, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

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

function Composer({ chipCitation }: { chipCitation: AssistantCitation }) {
  const [open, setOpen] = useState(true);
  return (
    <AssistantCitationChip
      citation={chipCitation}
      composer
      commentEditor={{ open, onOpenChange: setOpen, onSave: () => true }}
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
