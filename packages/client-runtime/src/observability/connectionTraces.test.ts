import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { exportConnectionTraces, makeConnectionTraceRecorder } from "./connectionTraces.ts";

const RESOURCE = {
  serviceName: "t3code-mobile",
  serviceVersion: "1.2.3",
  attributes: { "t3.client.surface": "mobile-test" },
};

const nativeTracer = Tracer.make({ span: (options) => new Tracer.NativeSpan(options) });

function makeRecorder() {
  const recorder = makeConnectionTraceRecorder(RESOURCE);
  return { recorder, tracer: recorder.wrap(nativeTracer) };
}

function drainedSpans(recorder: ReturnType<typeof makeConnectionTraceRecorder>) {
  return Option.match(recorder.pending(), {
    onNone: () => [],
    onSome: ({ data, through }) => {
      recorder.acknowledge(through);
      return data.resourceSpans[0]!.scopeSpans[0]!.spans;
    },
  });
}

describe("ConnectionTraceRecorder", () => {
  it.effect("buffers ended spans as one OTLP payload until acknowledged", () =>
    Effect.gen(function* () {
      const { recorder, tracer } = makeRecorder();
      yield* Effect.annotateCurrentSpan("connection.attempt", 2).pipe(
        Effect.withSpan("child"),
        Effect.withSpan("root"),
        Effect.provideService(Tracer.Tracer, tracer),
      );

      const { data: payload, through } = Option.getOrThrow(recorder.pending());
      expect(payload.resourceSpans[0]!.resource.attributes).toEqual(
        expect.arrayContaining([
          { key: "service.name", value: { stringValue: "t3code-mobile" } },
          { key: "service.version", value: { stringValue: "1.2.3" } },
          { key: "t3.client.surface", value: { stringValue: "mobile-test" } },
        ]),
      );
      const [child, root] = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
      expect(root!.name).toBe("root");
      expect(root!.parentSpanId).toBeUndefined();
      expect(child!.name).toBe("child");
      expect(child!.parentSpanId).toBe(root!.spanId);
      expect(child!.traceId).toBe(root!.traceId);
      expect(child!.kind).toBe(1);
      expect(child!.status).toEqual({ code: 1 });
      expect(child!.attributes).toEqual([{ key: "connection.attempt", value: { intValue: 2 } }]);
      expect(BigInt(child!.endTimeUnixNano) >= BigInt(child!.startTimeUnixNano)).toBe(true);
      expect(Option.getOrThrow(recorder.pending()).data).toEqual(payload);
      recorder.acknowledge(through);
      expect(recorder.pending()).toEqual(Option.none());
    }),
  );

  it.effect("reports failures and interruptions in the span status", () =>
    Effect.gen(function* () {
      const { recorder, tracer } = makeRecorder();
      yield* Effect.fail(new Error("boom")).pipe(
        Effect.withSpan("failing"),
        Effect.ignore,
        Effect.provideService(Tracer.Tracer, tracer),
      );
      const fiber = yield* Effect.never.pipe(
        Effect.withSpan("interrupted"),
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      const [failing, interrupted] = drainedSpans(recorder);
      expect(failing!.status).toEqual({ code: 2, message: "boom" });
      expect(interrupted!.status).toEqual({ code: 1, message: "Interrupted" });
      expect(interrupted!.attributes).toEqual([
        { key: "status.interrupted", value: { boolValue: true } },
      ]);
    }),
  );

  it.effect("skips unsampled spans and drops the oldest past the buffer cap", () =>
    Effect.gen(function* () {
      const { recorder, tracer } = makeRecorder();
      const traced = <A>(effect: Effect.Effect<A>) =>
        effect.pipe(Effect.provideService(Tracer.Tracer, tracer));
      yield* traced(Effect.void.pipe(Effect.withSpan("unsampled", { sampled: false })));
      expect(recorder.pending()).toEqual(Option.none());

      for (let index = 0; index < 1_001; index++) {
        yield* traced(Effect.void.pipe(Effect.withSpan(`span-${index}`)));
      }
      const spans = drainedSpans(recorder);
      expect(spans).toHaveLength(1_000);
      expect(spans[0]!.name).toBe("span-1");
      expect(spans.at(-1)!.name).toBe("span-1000");

      // Spans recorded after a payload was taken survive its acknowledgement.
      yield* traced(Effect.void.pipe(Effect.withSpan("sent")));
      const pending = Option.getOrThrow(recorder.pending());
      yield* traced(Effect.void.pipe(Effect.withSpan("recorded-during-send")));
      recorder.acknowledge(pending.through);
      expect(drainedSpans(recorder).map((span) => span.name)).toEqual(["recorded-during-send"]);
    }),
  );

  it.live("records one JS-thread stall however many callers monitor", () =>
    Effect.gen(function* () {
      const { recorder } = makeRecorder();
      const monitor = yield* Effect.forkChild(
        Effect.all([recorder.monitorStalls, recorder.monitorStalls], { concurrency: 2 }),
      );
      yield* Effect.sleep("60 millis");
      const busyUntil = Date.now() + 150;
      while (Date.now() < busyUntil) {
        // Block the event loop so the 50 ms timer fires late.
      }
      yield* Effect.sleep("60 millis");
      yield* Fiber.interrupt(monitor);

      const stalls = drainedSpans(recorder).filter((span) => span.name === "client.jsThread.stall");
      expect(stalls).toHaveLength(1);
      const stallMs =
        Number(BigInt(stalls[0]!.endTimeUnixNano) - BigInt(stalls[0]!.startTimeUnixNano)) / 1e6;
      expect(stallMs).toBeGreaterThanOrEqual(90);
    }),
  );
});

describe("exportConnectionTraces", () => {
  const TARGET = new RelayConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Remote environment",
  });
  const PREPARED: PreparedConnection = {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    httpBaseUrl: "https://environment.example.test/some/path?x=1",
    socketUrl: "wss://environment.example.test/ws",
    httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
    target: TARGET,
  };

  function makeHarness(statuses: ReadonlyArray<number>) {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetchFn: typeof fetch = async (request, init) => {
      calls.push({ url: String(request), init: init ?? {} });
      return new Response(null, { status: statuses[calls.length - 1]! });
    };
    const { recorder, tracer } = makeRecorder();
    return { calls, recorder, tracer, httpLayer: remoteHttpClientLayer(fetchFn) };
  }

  const exportWith = (harness: ReturnType<typeof makeHarness>) =>
    exportConnectionTraces({
      recorder: harness.recorder,
      prepared: PREPARED,
      signer: Option.none<ManagedRelayDpopSigner["Service"]>(),
      remoteAuthorization: Option.none(),
    }).pipe(Effect.provide(harness.httpLayer));

  it.effect("posts the buffered spans as JSON to the environment's traces route", () =>
    Effect.gen(function* () {
      const harness = makeHarness([204]);
      yield* Effect.void.pipe(
        Effect.withSpan("relay.connection.attempt"),
        Effect.provideService(Tracer.Tracer, harness.tracer),
      );

      yield* exportWith(harness);

      expect(harness.calls).toHaveLength(1);
      const [call] = harness.calls;
      expect(call!.url).toBe("https://environment.example.test/api/observability/v1/traces");
      expect(call!.init.method).toBe("POST");
      const headers = new Headers(call!.init.headers);
      expect(headers.get("authorization")).toBe("Bearer bearer-token");
      expect(headers.get("content-type")).toBe("application/json");
      const body = JSON.parse(new TextDecoder().decode(call!.init.body as Uint8Array));
      expect(
        body.resourceSpans[0].scopeSpans[0].spans.map((span: { name: string }) => span.name),
      ).toEqual(["relay.connection.attempt"]);
      // The export request itself is not traced, so nothing is left for the next batch.
      expect(harness.recorder.pending()).toEqual(Option.none());
    }),
  );

  it.effect("sends nothing when the buffer is empty and keeps spans after a failed post", () =>
    Effect.gen(function* () {
      const harness = makeHarness([502, 204]);
      yield* exportWith(harness);
      expect(harness.calls).toHaveLength(0);

      yield* Effect.void.pipe(
        Effect.withSpan("span"),
        Effect.provideService(Tracer.Tracer, harness.tracer),
      );
      yield* exportWith(harness);
      expect(harness.calls).toHaveLength(1);
      expect(Option.isSome(harness.recorder.pending())).toBe(true);

      yield* exportWith(harness);
      expect(harness.calls).toHaveLength(2);
      expect(harness.calls[1]!.init.body).toEqual(harness.calls[0]!.init.body);
      expect(harness.recorder.pending()).toEqual(Option.none());
    }),
  );
});
