import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";
import { HttpClient } from "effect/unstable/http";
import { OtlpResource, type OtlpTracer } from "effect/unstable/observability";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

const MAX_BUFFERED_SPANS = 1_000;
const STALL_INTERVAL_MS = 50;
const STALL_INTERVAL_NANOS = BigInt(STALL_INTERVAL_MS) * 1_000_000n;
// A timer suspended while the app is in the background fires minutes late.
// That gap is suspension, not a blocked JS thread, so longer gaps are skipped.
const MAX_STALL_NANOS = 5_000_000_000n;
const EXPORT_TIMEOUT_MS = 15_000;
const OTLP_SPAN_KIND = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
} satisfies Record<Tracer.SpanKind, number>;

// Root spans omit parentSpanId instead of setting it to undefined, which is not
// a JSON value and fails the traces endpoint's payload encoding.
type OtlpSpan = Omit<OtlpTracer.ScopeSpan["spans"][number], "parentSpanId"> & {
  readonly parentSpanId?: string;
};

/** OTLP/JSON request body. */
interface TraceData {
  readonly resourceSpans: ReadonlyArray<{
    readonly resource: OtlpResource.Resource;
    readonly scopeSpans: ReadonlyArray<{
      readonly scope: { readonly name: string };
      readonly spans: ReadonlyArray<OtlpSpan>;
    }>;
  }>;
}
type SpanEvent = readonly [name: string, startTime: bigint, attributes: Record<string, unknown>];

export interface ConnectionTraceResource {
  readonly serviceName: string;
  readonly serviceVersion?: string | undefined;
  readonly attributes: Record<string, string>;
}

export class ConnectionTraceRecorder extends Context.Service<
  ConnectionTraceRecorder,
  {
    /** Wraps a tracer so every sampled span it ends is buffered for the next export. */
    readonly wrap: (delegate: Tracer.Tracer) => Tracer.Tracer;
    /**
     * Every buffered span as one OTLP payload, plus the position to pass to
     * `acknowledge` once it is delivered; None when nothing is buffered.
     */
    readonly pending: () => Option.Option<{
      readonly data: TraceData;
      readonly through: number;
    }>;
    /** Drops the spans of a delivered `pending` payload. */
    readonly acknowledge: (through: number) => void;
    /**
     * Records a `client.jsThread.stall` span whenever a 50 ms timer fires ≥ 50 ms
     * late; runs until interrupted. Concurrent callers share one timer.
     */
    readonly monitorStalls: Effect.Effect<never>;
  }
>()("@t3tools/client-runtime/observability/ConnectionTraceRecorder") {}

/** Mirrors the delegate span and buffers an OTLP copy of itself when it ends sampled. */
class RecordedSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly attributes = new Map<string, unknown>();
  readonly events: Array<SpanEvent> = [];
  status: Tracer.SpanStatus;
  private readonly delegate: Tracer.Span;
  private readonly push: (span: OtlpSpan) => void;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (span: OtlpSpan) => void,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = { _tag: "Started", startTime: options.startTime };
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const startTime = this.status.startTime;
    this.status = { _tag: "Ended", startTime, endTime, exit };
    this.delegate.end(endTime, exit);
    if (this.sampled) {
      this.push(this.toOtlp(startTime, endTime, exit));
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const eventAttributes = attributes ?? {};
    this.events.push([name, startTime, eventAttributes]);
    this.delegate.event(name, startTime, eventAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }

  /** Copies only what the export needs, so the buffer never holds exits or span trees. */
  private toOtlp(startTime: bigint, endTime: bigint, exit: Exit.Exit<unknown, unknown>): OtlpSpan {
    const attributes = OtlpResource.entriesToAttributes(this.attributes);
    let status: OtlpSpan["status"];
    if (Exit.isSuccess(exit)) {
      status = { code: 1 };
    } else if (Cause.hasInterruptsOnly(exit.cause)) {
      status = { code: 1, message: "Interrupted" };
      attributes.push({ key: "status.interrupted", value: { boolValue: true } });
    } else {
      const [error] = Cause.prettyErrors(exit.cause);
      status = error === undefined ? { code: 2 } : { code: 2, message: error.message };
    }
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(Option.isSome(this.parent) ? { parentSpanId: this.parent.value.spanId } : {}),
      name: this.name,
      kind: OTLP_SPAN_KIND[this.kind],
      startTimeUnixNano: String(startTime),
      endTimeUnixNano: String(endTime),
      attributes,
      droppedAttributesCount: 0,
      events: this.events.map(([name, eventTime, eventAttributes]) => ({
        name,
        timeUnixNano: String(eventTime),
        attributes: OtlpResource.entriesToAttributes(Object.entries(eventAttributes)),
        droppedAttributesCount: 0,
      })),
      droppedEventsCount: 0,
      status,
      links: this.links.map((link) => ({
        traceId: link.span.traceId,
        spanId: link.span.spanId,
        attributes: OtlpResource.entriesToAttributes(Object.entries(link.attributes)),
        droppedAttributesCount: 0,
      })),
      droppedLinksCount: 0,
    };
  }
}

function stallSpan(startTime: bigint, endTime: bigint): OtlpSpan {
  return {
    traceId: Encoding.randomHex(32),
    spanId: Encoding.randomHex(16),
    name: "client.jsThread.stall",
    kind: OTLP_SPAN_KIND.internal,
    startTimeUnixNano: String(startTime),
    endTimeUnixNano: String(endTime),
    attributes: OtlpResource.entriesToAttributes([
      ["client.stall_ms", Number(endTime - startTime) / 1_000_000],
    ]),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: 1 },
    links: [],
    droppedLinksCount: 0,
  };
}

export function makeConnectionTraceRecorder(
  resource: ConnectionTraceResource,
): ConnectionTraceRecorder["Service"] {
  const otlpResource = OtlpResource.make({
    serviceName: resource.serviceName,
    serviceVersion: resource.serviceVersion,
    attributes: { "service.namespace": "t3code", ...resource.attributes },
  });
  // Ring buffer: span number n lives at ring[n % MAX_BUFFERED_SPANS]. Spans
  // [max(acknowledged, recorded - MAX_BUFFERED_SPANS), recorded) are pending.
  const ring: Array<OtlpSpan | undefined> = [];
  let recorded = 0;
  let acknowledged = 0;
  const firstPending = () => Math.max(acknowledged, recorded - MAX_BUFFERED_SPANS);
  const push = (span: OtlpSpan) => {
    ring[recorded % MAX_BUFFERED_SPANS] = span;
    recorded++;
  };

  let stallMonitors = 0;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const startStallTimer = (clock: { readonly currentTimeNanosUnsafe: () => bigint }) => {
    let expected = clock.currentTimeNanosUnsafe() + STALL_INTERVAL_NANOS;
    const tick = () => {
      const now = clock.currentTimeNanosUnsafe();
      const late = now - expected;
      if (late >= STALL_INTERVAL_NANOS && late <= MAX_STALL_NANOS) {
        push(stallSpan(expected, now));
      }
      expected = now + STALL_INTERVAL_NANOS;
      stallTimer = setTimeout(tick, STALL_INTERVAL_MS);
    };
    stallTimer = setTimeout(tick, STALL_INTERVAL_MS);
  };

  return ConnectionTraceRecorder.of({
    wrap: (delegate) =>
      Tracer.make({
        span: (options) => new RecordedSpan(options, delegate.span(options), push),
        ...(delegate.context ? { context: delegate.context } : {}),
      }),
    pending: () => {
      const first = firstPending();
      if (first === recorded) {
        return Option.none();
      }
      const spans: Array<OtlpSpan> = [];
      for (let index = first; index < recorded; index++) {
        spans.push(ring[index % MAX_BUFFERED_SPANS]!);
      }
      return Option.some({
        data: {
          resourceSpans: [
            {
              resource: otlpResource,
              scopeSpans: [{ scope: { name: "@t3tools/client-runtime" }, spans }],
            },
          ],
        },
        through: recorded,
      });
    },
    acknowledge: (through) => {
      for (let index = firstPending(); index < through; index++) {
        ring[index % MAX_BUFFERED_SPANS] = undefined;
      }
      acknowledged = Math.max(acknowledged, through);
    },
    monitorStalls: Effect.clockWith((clock) =>
      Effect.callback<never>(() => {
        if (stallMonitors++ === 0) {
          startStallTimer(clock);
        }
        return Effect.sync(() => {
          if (--stallMonitors === 0) {
            clearTimeout(stallTimer);
          }
        });
      }),
    ),
  });
}

/**
 * Posts every buffered span to the environment. A failed or interrupted post
 * keeps the spans for the next export.
 */
export const exportConnectionTraces = (input: {
  readonly recorder: ConnectionTraceRecorder["Service"];
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pending = input.recorder.pending();
    if (Option.isNone(pending)) {
      return;
    }
    yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer: input.signer,
      remoteAuthorization: input.remoteAuthorization,
      group: "observability",
      method: "POST",
      url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).observability.traces(),
      timeoutMs: EXPORT_TIMEOUT_MS,
      request: ({ client, headers }) => client.traces({ payload: pending.value.data, headers }),
    });
    input.recorder.acknowledge(pending.value.through);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("Could not export connection traces").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      ),
    ),
    Effect.withTracerEnabled(false),
  );

/**
 * Follows every registered environment; 5 s after each one becomes ready, posts
 * the recorder's buffer to that environment. The buffer is shared, so with
 * several environments each export also carries the others' spans.
 */
export const connectionTraceExportLayer: Layer.Layer<
  never,
  never,
  EnvironmentRegistry | ConnectionTraceRecorder | HttpClient.HttpClient
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const recorder = yield* ConnectionTraceRecorder;
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);

    const environmentTraces = Stream.unwrap(
      EnvironmentSupervisor.pipe(
        Effect.map((supervisor) =>
          SubscriptionRef.changes(supervisor.state).pipe(
            Stream.map(connectionProjectionPhase),
            Stream.changes,
            Stream.switchMap((phase) => {
              switch (phase) {
                case "disconnected":
                  return Stream.empty;
                case "synchronizing":
                  return Stream.fromEffect(recorder.monitorStalls);
                case "ready":
                  // Shell subscribe and the first thread loads land in the seconds after ready.
                  return Stream.fromEffect(
                    recorder.monitorStalls.pipe(
                      Effect.timeoutOption("5 seconds"),
                      Effect.andThen(SubscriptionRef.get(supervisor.prepared)),
                      Effect.flatMap(
                        Option.match({
                          onNone: () => Effect.void,
                          onSome: (prepared) =>
                            exportConnectionTraces({
                              recorder,
                              prepared,
                              signer,
                              remoteAuthorization,
                            }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
                        }),
                      ),
                    ),
                  );
              }
            }),
          ),
        ),
      ),
    );

    // followStream idles while an environment is removed and re-attaches when it returns.
    const followed = new Set<EnvironmentId>();
    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((entries) =>
        Effect.forEach(
          [...entries.keys()].filter((environmentId) => !followed.has(environmentId)),
          (environmentId) => {
            followed.add(environmentId);
            return registry
              .followStream(environmentId, environmentTraces)
              .pipe(Stream.runDrain, Effect.forkScoped);
          },
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
