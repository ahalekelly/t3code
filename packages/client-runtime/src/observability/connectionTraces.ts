import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";
import { HttpClient } from "effect/http";
import { OtlpResource, type OtlpTracer } from "effect/observability";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
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
    readonly wrap: (delegate: Tracer.Tracer) => Tracer.Tracer;
    readonly pending: () => Option.Option<{
      readonly data: TraceData;
      readonly through: number;
    }>;
    readonly acknowledge: (through: number) => void;
    /** Times are epoch nanoseconds, like Effect's clock. */
    readonly recordSpan: (
      name: string,
      startTime: bigint,
      endTime: bigint,
      attributes: Record<string, unknown>,
    ) => void;
    /** Concurrent callers share one stall timer; runs until interrupted. */
    readonly monitorStalls: Effect.Effect<never>;
  }
>()("@t3tools/client-runtime/observability/connectionTraces/ConnectionTraceRecorder") {}

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

function rootSpan(
  name: string,
  startTime: bigint,
  endTime: bigint,
  attributes: Record<string, unknown>,
): OtlpSpan {
  return {
    traceId: Hex.random(32),
    spanId: Hex.random(16),
    name,
    kind: OTLP_SPAN_KIND.internal,
    startTimeUnixNano: String(startTime),
    endTimeUnixNano: String(endTime),
    attributes: OtlpResource.entriesToAttributes(Object.entries(attributes)),
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
        push(
          rootSpan("client.jsThread.stall", expected, now, {
            "client.stall_ms": Number(late) / 1_000_000,
          }),
        );
      }
      expected = now + STALL_INTERVAL_NANOS;
      // @effect-diagnostics-next-line globalTimers:off - a late plain timer is the stall being measured
      stallTimer = setTimeout(tick, STALL_INTERVAL_MS);
    };
    // @effect-diagnostics-next-line globalTimers:off - a late plain timer is the stall being measured
    stallTimer = setTimeout(tick, STALL_INTERVAL_MS);
  };

  return ConnectionTraceRecorder.of({
    wrap: (delegate) =>
      Tracer.make({
        span: (options) => new RecordedSpan(options, delegate.span(options), push),
        ...(delegate.context ? { context: delegate.context } : {}),
      }),
    recordSpan: (name, startTime, endTime, attributes) =>
      push(rootSpan(name, startTime, endTime, attributes)),
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

// Untraced: the export must not record spans of its own into the buffer it drains.
export const exportConnectionTraces = Effect.fnUntraced(
  function* (input: {
    readonly recorder: ConnectionTraceRecorder["Service"];
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  }) {
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
      url: (urls) => urls.traces(),
      timeoutMs: EXPORT_TIMEOUT_MS,
      request: ({ client, headers }) => client.traces({ payload: pending.value.data, headers }),
    });
    input.recorder.acknowledge(pending.value.through);
  },
  Effect.catchCause((cause) =>
    Effect.logDebug("Could not export connection traces").pipe(
      Effect.annotateLogs({ cause: Cause.pretty(cause) }),
    ),
  ),
  Effect.withTracerEnabled(false),
);

/** The buffer is shared, so each export also carries other environments' spans. */
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
