import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

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

function Composer() {
  const [open, setOpen] = useState(true);
  return (
    <AssistantCitationChip
      citation={citation}
      composer
      commentEditor={{ open, onOpenChange: setOpen, onSave: () => true }}
    />
  );
}

describe("citation comment popup position", () => {
  it("opens at its anchor instead of sliding in from the window corner", async () => {
    await using _screen = await render(<Composer />);
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
