import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ThreadRunSummary } from "@t3tools/client-runtime/state/models";
import { MessageId, RunId } from "@t3tools/contracts";

import { autoReadResponse } from "./autoReadResponse";

type Message = Parameters<typeof autoReadResponse.takeReply>[1][number];

const scope = "environment:thread";
const prompt: Message = {
  id: MessageId.make("voice-prompt"),
  role: "user",
  text: "Hello",
  runId: null,
  streaming: false,
  createdAt: "2026-09-15T11:00:00.000Z",
};
const reply: Message = {
  id: MessageId.make("reply"),
  role: "assistant",
  text: "Hi",
  runId: RunId.make("run"),
  streaming: false,
  createdAt: "2026-09-15T11:00:01.000Z",
};
const replyFinishedAt = "2026-09-15T11:00:02.000Z";
const completed: ThreadRunSummary = {
  runId: RunId.make("run"),
  status: "completed",
  requestedAt: prompt.createdAt,
  startedAt: prompt.createdAt,
  completedAt: replyFinishedAt,
  assistantMessageId: reply.id,
};
const request = () => autoReadResponse.request({ scope, messageId: prompt.id });

afterEach(() => autoReadResponse.cancelAll());

describe("automatic voice replies", () => {
  it("reads written updates in order, then the final response without repeating it", () => {
    request();
    const running = { ...completed, status: "running" as const, completedAt: null };
    const update = { ...reply, id: MessageId.make("update"), text: "Checking the files" };
    const streaming = { ...update, streaming: true };
    expect(autoReadResponse.takeReply(scope, [prompt, streaming], running, true)).toEqual(
      streaming,
    );
    expect(autoReadResponse.takeReply(scope, [prompt, update], running, true)).toBeNull();
    expect(autoReadResponse.takeReply(scope, [prompt, update, reply], running, true)).toEqual(
      reply,
    );
    expect(autoReadResponse.takeReply(scope, [prompt, update, reply], completed, true)).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)).toBeNull();
  });

  it("announces each pending approval once per exchange", () => {
    expect(autoReadResponse.takeAnnouncement(scope, "approval")).toBe(false);
    request();
    expect(autoReadResponse.takeAnnouncement(scope, "approval")).toBe(true);
    expect(autoReadResponse.takeAnnouncement(scope, "approval")).toBe(false);
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

  it("waits for the full run, reading a final response that is still streaming live", () => {
    request();
    expect(
      autoReadResponse.takeReply(
        scope,
        [prompt, reply],
        {
          ...completed,
          status: "running",
          completedAt: null,
        },
        false,
      ),
    ).toBeNull();
    const streaming = { ...reply, streaming: true };
    expect(autoReadResponse.takeReply(scope, [prompt, streaming], completed, false)).toEqual(
      streaming,
    );
    request();
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

  it("does not read an older run while the voice message is queued", () => {
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
    const later = { ...prompt, id: MessageId.make("typed-prompt"), createdAt: replyFinishedAt };
    expect(autoReadResponse.takeReply(scope, [prompt, reply, later], completed, false)).toBeNull();
    expect(autoReadResponse.getSnapshot(scope)).toBeNull();
  });

  it.each(["failed", "interrupted", "cancelled"] as const)("does not read a %s run", (status) => {
    request();
    expect(
      autoReadResponse.takeReply(scope, [prompt, reply], { ...completed, status }, false),
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
