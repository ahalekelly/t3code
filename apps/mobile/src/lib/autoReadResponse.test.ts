import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
} from "@t3tools/contracts";

import { autoReadResponse } from "./autoReadResponse";

const scope = "environment:thread";
const prompt: OrchestrationMessage = {
  id: MessageId.make("voice-prompt"),
  role: "user",
  text: "Hello",
  turnId: null,
  streaming: false,
  createdAt: "2026-09-15T11:00:00.000Z",
  updatedAt: "2026-09-15T11:00:00.000Z",
};
const reply: OrchestrationMessage = {
  id: MessageId.make("reply"),
  role: "assistant",
  text: "Hi",
  turnId: TurnId.make("turn"),
  streaming: false,
  createdAt: "2026-09-15T11:00:01.000Z",
  updatedAt: "2026-09-15T11:00:02.000Z",
};
const completed: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn"),
  state: "completed",
  requestedAt: prompt.createdAt,
  startedAt: prompt.createdAt,
  completedAt: reply.updatedAt,
  assistantMessageId: reply.id,
};
const request = () => autoReadResponse.request({ scope, messageId: prompt.id });

afterEach(() => autoReadResponse.cancelAll());

describe("automatic voice replies", () => {
  it("reads written updates in order, then the final response without repeating it", () => {
    request();
    const running = { ...completed, state: "running" as const, completedAt: null };
    const update = { ...reply, id: MessageId.make("update"), text: "Checking the files" };
    expect(
      autoReadResponse.takeReply(scope, [prompt, { ...update, streaming: true }], running, true),
    ).toBeNull();
    expect(autoReadResponse.takeReply(scope, [prompt, update], running, true)).toEqual(update);
    expect(autoReadResponse.takeReply(scope, [prompt, update], running, true)).toBeNull();
    expect(autoReadResponse.takeReply(scope, [prompt, update, reply], running, true)).toEqual(
      reply,
    );
    expect(autoReadResponse.takeReply(scope, [prompt, update, reply], completed, true)).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)).toBeNull();
  });

  it("drains updates received while another update was playing", () => {
    request();
    const update = { ...reply, id: MessageId.make("update"), text: "Checking the files" };
    const messages = [prompt, update, reply];
    expect(autoReadResponse.takeReply(scope, messages, completed, true)).toEqual(update);
    expect(autoReadResponse.takeReply(scope, messages, completed, true)).toEqual(reply);
    expect(autoReadResponse.takeReply(scope, messages, completed, true)).toBeNull();
  });

  it("waits for the final message when completion arrives before the feed", () => {
    request();
    const update = { ...reply, id: MessageId.make("update"), text: "Checking the files" };
    expect(autoReadResponse.takeReply(scope, [prompt, update], completed, false)).toBeNull();
    expect(autoReadResponse.takeReply(scope, [prompt, update, reply], completed, false)).toEqual(
      reply,
    );
  });

  it("reads a completed reply only once, including after opening a new task", () => {
    request();
    expect(autoReadResponse.takeReply(scope, [], null, false)).toBeNull();
    expect(autoReadResponse.takeReply(scope, [prompt, reply], completed, false)).toEqual(reply);
    expect(autoReadResponse.takeReply(scope, [prompt, reply], completed, false)).toBeNull();
  });

  it("ignores ordinary sends and other environments", () => {
    expect(autoReadResponse.takeReply(scope, [prompt, reply], completed, false)).toBeNull();
    request();
    expect(
      autoReadResponse.takeReply("remote:thread", [prompt, reply], completed, false),
    ).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)?.messageId).toBe(prompt.id);
  });

  it("waits for the full turn and the final response to finish streaming", () => {
    request();
    expect(
      autoReadResponse.takeReply(
        scope,
        [prompt, reply],
        {
          ...completed,
          state: "running",
          completedAt: null,
        },
        false,
      ),
    ).toBeNull();
    expect(
      autoReadResponse.takeReply(scope, [prompt, { ...reply, streaming: true }], completed, false),
    ).toBeNull();
    const final = { ...reply, id: MessageId.make("final"), text: "Finished" };
    expect(
      autoReadResponse.takeReply(
        scope,
        [prompt, reply, final],
        { ...completed, assistantMessageId: final.id },
        false,
      ),
    ).toEqual(final);
  });

  it("does not read an older turn while the voice message is queued", () => {
    request();
    expect(
      autoReadResponse.takeReply(
        scope,
        [prompt, reply],
        {
          ...completed,
          startedAt: "2026-09-15T10:59:00.000Z",
        },
        false,
      ),
    ).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)?.messageId).toBe(prompt.id);
  });

  it("cancels when a later prompt replaces the exchange", () => {
    request();
    const later = { ...prompt, id: MessageId.make("typed-prompt"), createdAt: reply.updatedAt };
    expect(autoReadResponse.takeReply(scope, [prompt, reply, later], completed, false)).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)).toBeNull();
  });

  it.each(["error", "interrupted"] as const)("does not read a %s turn", (state) => {
    request();
    expect(
      autoReadResponse.takeReply(scope, [prompt, reply], { ...completed, state }, false),
    ).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)).toBeNull();
  });

  it("cancels on leaving a thread or starting a new recording", () => {
    request();
    autoReadResponse.cancel(scope);
    expect(autoReadResponse.takeReply(scope, [prompt, reply], completed, false)).toBeNull();
    request();
    autoReadResponse.cancelAll();
    expect(autoReadResponse.takeReply(scope, [prompt, reply], completed, false)).toBeNull();
  });

  it("settles empty replies without reading them", () => {
    request();
    expect(
      autoReadResponse.takeReply(scope, [prompt, { ...reply, text: " " }], completed, false),
    ).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)).toBeNull();
  });
});
