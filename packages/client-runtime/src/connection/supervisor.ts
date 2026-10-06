import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const MOBILE_CONNECTION_PROBE_TIMEOUT = "3 seconds";
const BACKOFF_RESET_AFTER_MS = 30_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

// A lease owns its own scope so a replacement can be established while the
// current lease stays live, then either adopted or released on its own.
interface ActiveLease {
  readonly lease: ConnectionDriver.EnvironmentConnectionLease;
  readonly scope: Scope.Closeable;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

// `generation` is the latest established generation; `resetRetry` restarts the
// backoff ladder because the user returned to the app; `skipBackoff` retries
// at once because a foreground probe found the transport dead.
type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly generation: number;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly generation: number;
      readonly stable: boolean;
      readonly resetRetry: boolean;
      readonly skipBackoff: boolean;
      readonly failure: TracedAttemptFailure;
    };

// Ends a connected attempt; `skipBackoff` retries at once because the user is
// present on a dead transport.
interface ConnectedFailure {
  readonly failure: TracedAttemptFailure;
  readonly skipBackoff: boolean;
}

type ConnectedEvent =
  | { readonly _tag: "SignalReady" }
  | { readonly _tag: "Closed"; readonly error: ConnectionAttemptError }
  | { readonly _tag: "Checked"; readonly exit: Exit.Exit<ActiveLease | null, ConnectedFailure> };

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
  /**
   * Awaited before every connection attempt the user did not request, so the
   * registry can let the environment on screen connect first.
   */
  readonly awaitTurn?: Effect.Effect<FocusWaitArm>;
}

/** Fork-only A/B arm of the focused-environment wait; remove after measuring. */
export type FocusWaitArm = "wait" | "skip";

function retryDelayMs(failureCount: number): number {
  return RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)] ?? 16_000;
}

function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function unexpectedFailure(target: ConnectionTarget): TracedAttemptFailure {
  return {
    error: new ConnectionTransientError({
      reason: "transport",
      detail: `${target.label} connection failed unexpectedly.`,
    }),
    attemptSpan: Option.none(),
  };
}

function tracedFailure(
  target: ConnectionTarget,
  cause: Cause.Cause<TracedAttemptFailure>,
): TracedAttemptFailure {
  return Result.getOrElse(Cause.findError(cause), () => unexpectedFailure(target));
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

/** The supervisor plus the controls only its owning registry uses. */
export type ManagedEnvironmentSupervisor = EnvironmentSupervisor["Service"] & {
  /**
   * True from a foreground wakeup until the connected session proves alive or
   * is replaced; the phase stays "connected" meanwhile.
   */
  readonly verifying: SubscriptionRef.SubscriptionRef<boolean>;
  readonly wake: (reason: ConnectionWakeups.ConnectionWakeup) => Effect.Effect<void>;
};

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  ManagedEnvironmentSupervisor,
  never,
  Connectivity.Connectivity | ConnectionDriver.ConnectionDriver | Scope.Scope
> {
  const target = entry.target;
  const setupTimeoutDetail = `${target.label} did not respond during connection setup.${
    target._tag === "RelayConnectionTarget" ? ` ${NETWORK_BLOCKING_HINT}` : ""
  }`;
  yield* annotateTarget(target);

  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const awaitTurn = options?.awaitTurn ?? Effect.succeed<FocusWaitArm>("wait");
  // Fork-only: records the A/B arm and the wait on the attempt's spans.
  const afterTurn = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.timed(awaitTurn).pipe(
      Effect.flatMap(([waited, arm]) =>
        Effect.annotateSpans(effect, {
          "connection.focus_wait.arm": arm,
          "connection.focus_wait.ms": Duration.toMillis(waited),
        }),
      ),
    );
  const supervisorScope = yield* Effect.scope;
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
  };
  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const resetRetryState = yield* Ref.make(false);
  // Set by `connect` and `retryNow` until an attempt settles. It outlives an
  // interrupted attempt because the request's own signal may restart the
  // attempt it already started.
  const userRequested = yield* Ref.make(false);
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const verifying = yield* SubscriptionRef.make(false);
  const activeLease = yield* Ref.make(Option.none<ActiveLease>());

  const releaseLease = (lease: ActiveLease) => Scope.close(lease.scope, Exit.void);

  const clearLease = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(activeLease, Option.none());
    yield* SubscriptionRef.set(session, Option.none());
    yield* SubscriptionRef.set(prepared, Option.none());
    yield* SubscriptionRef.set(verifying, false);
    if (Option.isSome(current)) {
      yield* releaseLease(current.value);
    }
  });

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* SubscriptionRef.set(state, next);
  });

  // Publishes `next` as the connected lease. Consumers keyed on session
  // identity move to the new session before the previous socket closes, so a
  // replacement never surfaces as a transport failure.
  const adoptLease = Effect.fnUntraced(function* (
    next: ActiveLease,
    attempt: number,
    generation: number,
  ) {
    const previous = yield* Ref.getAndSet(activeLease, Option.some(next));
    yield* SubscriptionRef.set(prepared, Option.some(next.lease.prepared));
    yield* SubscriptionRef.set(session, Option.some(next.lease.session));
    yield* SubscriptionRef.set(verifying, false);
    if (Option.isSome(previous)) {
      yield* releaseLease(previous.value);
    }
    yield* setState({
      desired: true,
      network: (yield* Ref.get(intent)).network,
      phase: "connected",
      stage: null,
      attempt,
      generation,
      lastFailure: null,
      retryAt: null,
    });
  });

  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (next: SupervisorSignal) {
    yield* Queue.offer(signals, next);
  });

  const logManagedRelayAccountChange = Effect.logInfo(
    "Managed relay account changed; restarting the environment connection.",
  ).pipe(
    Effect.annotateLogs({
      "environment.id": target.environmentId,
      "environment.label": target.label,
    }),
  );

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if ("prepared" in progress) {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    yield* setState(
      connectingState(yield* Ref.get(intent), generation, attempt, lastFailure, progress.stage),
    );
  });

  const traceRelayEstablishment = (
    effect: Effect.Effect<
      ConnectionDriver.EnvironmentConnectionLease,
      ConnectionAttemptError,
      Scope.Scope
    >,
    attempt: number,
    generation: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
    resumeHedge: boolean,
  ) => {
    const traced = Effect.gen(function* () {
      const attemptSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      yield* annotateTarget(target);
      yield* Effect.annotateCurrentSpan({
        "connection.attempt": attempt,
        "connection.generation": generation,
        "connection.resume_hedge": resumeHedge,
        "connection.retry.failure_count": Option.match(pendingRetry, {
          onNone: () => 0,
          onSome: (retry) => retry.failureCount,
        }),
      });
      const lease = yield* effect.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: Option.some(attemptSpan),
        })),
      );
      return { attemptSpan: Option.some(attemptSpan), lease };
    }).pipe(Effect.withSpan("relay.connection.attempt", { root: true }));

    return Option.match(pendingRetry, {
      onNone: () => traced,
      onSome: (retry) =>
        traced.pipe(
          Effect.linkSpans(retry.previousAttempt, {
            "connection.retry.delay_ms": retry.delayMs,
            "connection.retry.reason": retry.reason,
          }),
        ),
    }).pipe(withRelayClientTracing);
  };

  // Establishes a lease in its own scope, forked from the supervisor's so a
  // lease that is open but not yet adopted still closes with the supervisor.
  // The scope closes with the attempt on failure, interruption, or setup
  // timeout, and otherwise belongs to the returned lease.
  const openLease = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
    resumeHedge: boolean,
    report: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const connect = driver.connect(entry, report);
    const traced =
      target._tag === "RelayConnectionTarget"
        ? traceRelayEstablishment(connect, attempt, generation, pendingRetry, resumeHedge)
        : connect.pipe(
            Effect.map((lease) => ({ attemptSpan: Option.none<Tracer.Span>(), lease })),
            Effect.mapError((error): TracedAttemptFailure => ({
              error,
              attemptSpan: Option.none(),
            })),
          );
    const scope = yield* Scope.fork(supervisorScope);
    const established = yield* traced.pipe(
      Scope.provide(scope),
      Effect.timeoutOrElse({
        duration: CONNECTION_ESTABLISHMENT_TIMEOUT,
        orElse: () =>
          Effect.fail<TracedAttemptFailure>({
            error: new ConnectionTransientError({ reason: "timeout", detail: setupTimeoutDetail }),
            attemptSpan: Option.none(),
          }),
      }),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit))),
    );
    return { ...established, scope } satisfies ActiveLease;
  });

  // Interrupts an establishment fiber and releases its lease if it had already
  // succeeded, so an unadopted lease never outlives the decision to drop it.
  const abandonLease = <E>(fiber: Fiber.Fiber<ActiveLease | null, E>) =>
    Fiber.interrupt(fiber).pipe(
      Effect.andThen(Fiber.await(fiber)),
      Effect.flatMap((exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? releaseLease(exit.value) : Effect.void,
      ),
    );

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return false;
        case "NetworkChanged":
          if (next.network === "offline") {
            return false;
          }
          break;
        case "ConnectRequested":
          break;
        case "Wakeup":
          if (next.reason === "application-active-reconnect") {
            return true;
          }
          if (next.reason === "credentials-changed" && target._tag === "RelayConnectionTarget") {
            yield* logManagedRelayAccountChange;
            return false;
          }
          break;
      }
    }
  });

  // Checks the connected session after a foreground wakeup. Succeeds with the
  // lease to continue on, `null` keeping the current one. A long mobile resume
  // races the probe against a fresh lease: the OS commonly kills a suspended
  // socket without reporting closure, and a probe alone would wait out its
  // timeout on it. Once the probe shows the session dead, the fresh lease's
  // progress becomes the visible connection state.
  const checkSession = Effect.fnUntraced(function* (
    active: ActiveLease,
    generation: number,
    reason: ConnectionWakeups.ConnectionWakeup,
  ) {
    const probe = active.lease.session.probe.pipe(
      Effect.timeoutOrElse({
        duration:
          reason === "application-active"
            ? CONNECTION_PROBE_TIMEOUT
            : MOBILE_CONNECTION_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "timeout",
              detail: `${target.label} did not respond to a connection health check.`,
            }),
          ),
      }),
      Effect.raceFirst(active.lease.session.closed),
      Effect.catchDefect(() => Effect.fail(unexpectedFailure(target).error)),
    );
    if (reason !== "application-active-reconnect") {
      return yield* probe.pipe(
        Effect.as(null),
        Effect.mapError((error): ConnectedFailure => ({
          failure: { error, attemptSpan: active.attemptSpan },
          // The user is present, so retry the dead transport without a backoff sleep.
          skipBackoff: true,
        })),
      );
    }

    let progress: ConnectionDriver.ConnectionDriverProgress = { stage: "preparing" };
    let deadSessionError: ConnectionAttemptError | null = null;
    const fresh = yield* afterTurn(
      openLease(1, generation + 1, Option.none(), true, (next) =>
        Effect.suspend(() => {
          progress = next;
          return deadSessionError === null
            ? Effect.void
            : reportProgress(1, generation + 1, deadSessionError, next);
        }),
      ),
    ).pipe(Effect.forkChild);
    // Uninterruptible so a fresh lease winning meanwhile cannot cut the
    // release of the dead session short.
    const sessionDied = (error: ConnectionAttemptError) =>
      Effect.suspend(() => {
        deadSessionError = error;
        return clearLease.pipe(Effect.andThen(reportProgress(1, generation + 1, error, progress)));
      }).pipe(Effect.uninterruptible);
    return yield* Effect.race(
      probe.pipe(Effect.tapError(sessionDied), Effect.as(null)),
      Fiber.join(fresh),
    ).pipe(
      // Both failed; the fresh lease's failure is the one to report.
      Effect.catch(() => Fiber.join(fresh)),
      Effect.mapError((failure): ConnectedFailure => ({ failure, skipBackoff: false })),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? Effect.void : abandonLease(fresh),
      ),
    );
  });

  // Supervises a connected lease until the attempt ends, checking the session
  // after foreground wakeups. The phase stays "connected" while a check runs.
  const runConnected = Effect.fnUntraced(function* (
    initial: ActiveLease,
    attempt: number,
    generation: number,
  ) {
    let active = initial;
    let resetRetry = false;
    let connectedAt = yield* Clock.currentTimeMillis;
    let check = Option.none<Fiber.Fiber<ActiveLease | null, ConnectedFailure>>();

    const finish = Effect.fnUntraced(function* (
      outcome: { readonly _tag: "Interrupted" } | ({ readonly _tag: "Failure" } & ConnectedFailure),
    ) {
      const stable = (yield* Clock.currentTimeMillis) - connectedAt >= BACKOFF_RESET_AFTER_MS;
      return { ...outcome, generation, stable, resetRetry } satisfies AttemptOutcome;
    });

    yield* adoptLease(active, attempt, generation);
    return yield* Effect.gen(function* () {
      for (;;) {
        // Peek rather than take: a signal that arrives in the same tick another
        // branch settles stays queued for the next iteration instead of being
        // consumed by a losing branch.
        const event = yield* Effect.raceFirst(
          Queue.peek(signals).pipe(Effect.as<ConnectedEvent>({ _tag: "SignalReady" })),
          Option.match(check, {
            onNone: () =>
              active.lease.session.closed.pipe(
                Effect.flip,
                Effect.map((error): ConnectedEvent => ({ _tag: "Closed", error })),
              ),
            onSome: (fiber) =>
              Fiber.await(fiber).pipe(
                Effect.map((exit): ConnectedEvent => ({ _tag: "Checked", exit })),
              ),
          }),
        );
        switch (event._tag) {
          case "Closed":
            return yield* finish({
              _tag: "Failure",
              failure: { error: event.error, attemptSpan: active.attemptSpan },
              skipBackoff: false,
            });
          case "Checked": {
            check = Option.none();
            if (Exit.isFailure(event.exit)) {
              resetRetry = true;
              return yield* finish({
                _tag: "Failure",
                ...Result.getOrElse(Cause.findError(event.exit.cause), () => ({
                  failure: unexpectedFailure(target),
                  skipBackoff: false,
                })),
              });
            }
            if (event.exit.value === null) {
              // The session answered: keep it.
              yield* SubscriptionRef.set(verifying, false);
              resetRetry = false;
              break;
            }
            active = event.exit.value;
            attempt = 1;
            generation += 1;
            resetRetry = true;
            connectedAt = yield* Clock.currentTimeMillis;
            yield* adoptLease(active, attempt, generation);
            break;
          }
          case "SignalReady": {
            const signal = yield* Queue.take(signals);
            switch (signal._tag) {
              case "DisconnectRequested":
              case "RetryRequested":
                return yield* finish({ _tag: "Interrupted" });
              case "NetworkChanged":
                if (signal.network === "offline") {
                  return yield* finish({ _tag: "Interrupted" });
                }
                break;
              case "ConnectRequested":
                break;
              case "Wakeup": {
                const reason = signal.reason;
                if (reason === "credentials-changed") {
                  if (target._tag === "RelayConnectionTarget") {
                    yield* logManagedRelayAccountChange;
                    return yield* finish({ _tag: "Interrupted" });
                  }
                  break;
                }
                // A long resume always starts a new race: a check already in
                // flight was suspended along with the app.
                const longResume = reason === "application-active-reconnect";
                if (Option.isSome(check) && !longResume) {
                  break;
                }
                if (Option.isSome(check)) {
                  yield* abandonLease(check.value);
                }
                if (longResume) {
                  // A later failure starts from the bottom of the retry ladder.
                  resetRetry = true;
                }
                check = Option.some(
                  yield* checkSession(active, generation, reason).pipe(Effect.forkChild),
                );
                break;
              }
            }
            break;
          }
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Option.match(check, {
            onNone: () => Effect.void,
            onSome: abandonLease,
          }),
        ),
      ),
    );
  });

  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) {
    yield* SubscriptionRef.set(prepared, Option.none());
    const nextGeneration = generation + 1;
    const open = openLease(attempt, nextGeneration, pendingRetry, false, (progress) =>
      reportProgress(attempt, nextGeneration, lastFailure, progress),
    );
    const opening = yield* ((yield* Ref.get(userRequested)) ? open : afterTurn(open)).pipe(
      Effect.forkChild,
    );
    const establishment = yield* Effect.raceFirst(
      Fiber.await(opening).pipe(Effect.map((exit) => ({ _tag: "Completed" as const, exit }))),
      waitForEstablishmentInterrupt().pipe(
        Effect.map((resetRetry) => ({ _tag: "Interrupted" as const, resetRetry })),
      ),
    );
    if (establishment._tag === "Completed") {
      yield* Ref.set(userRequested, false);
    }

    if (establishment._tag === "Interrupted") {
      yield* abandonLease(opening);
      return {
        _tag: "Interrupted",
        generation,
        stable: false,
        resetRetry: establishment.resetRetry,
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      const cause = establishment.exit.cause;
      if (Cause.hasInterruptsOnly(cause)) {
        return {
          _tag: "Interrupted",
          generation,
          stable: false,
          resetRetry: false,
        } satisfies AttemptOutcome;
      }
      if (!cause.reasons.some(Cause.isFailReason)) {
        const defect = cause.reasons.find(Cause.isDieReason)?.defect;
        yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "cause.reason_count": cause.reasons.length,
            ...safeErrorLogAttributes(defect),
          }),
        );
      }
      return {
        _tag: "Failure",
        generation,
        stable: false,
        resetRetry: false,
        skipBackoff: false,
        failure: tracedFailure(target, cause),
      } satisfies AttemptOutcome;
    }

    const active = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired || currentIntent.network === "offline") {
      yield* releaseLease(active);
      return {
        _tag: "Interrupted",
        generation,
        stable: false,
        resetRetry: false,
      } satisfies AttemptOutcome;
    }
    return yield* runConnected(active, attempt, nextGeneration);
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - the sleep is the retry delay (false), not a timeout around the signal loop
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(false)),
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);
          switch (next._tag) {
            case "Wakeup":
              return ConnectionWakeups.isApplicationActiveWakeup(next.reason);
            case "ConnectRequested":
            case "DisconnectRequested":
            case "RetryRequested":
            case "NetworkChanged":
              return false;
          }
        }
      }),
    );
  });

  const waitForSignal = Queue.take(signals).pipe(
    Effect.map(
      (next) => next._tag === "Wakeup" && ConnectionWakeups.isApplicationActiveWakeup(next.reason),
    ),
  );

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let generation = 0;
    let latestFailure: ConnectionAttemptError | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    const resetRetryLadder = () => {
      failureCount = 0;
      pendingRetry = Option.none();
    };

    for (;;) {
      if (yield* Ref.getAndSet(resetRetryState, false)) {
        failureCount = 0;
        latestFailure = null;
        pendingRetry = Option.none();
      }
      const currentIntent = yield* Ref.get(intent);
      if (!currentIntent.desired) {
        resetRetryLadder();
        latestFailure = null;
        yield* clearLease;
        yield* setState(availableState(currentIntent, generation));
        yield* waitForSignal;
        continue;
      }
      if (currentIntent.network === "offline") {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        const applicationActivated = yield* waitForSignal;
        if (applicationActivated) {
          resetRetryLadder();
        }
        continue;
      }

      const attempt = failureCount + 1;
      const outcome: AttemptOutcome = yield* runAttempt(
        attempt,
        generation,
        latestFailure,
        pendingRetry,
      );
      generation = outcome.generation;
      if (outcome.stable) {
        resetRetryLadder();
        latestFailure = null;
      }
      if (outcome.resetRetry) {
        resetRetryLadder();
      }
      if (outcome._tag === "Interrupted") {
        continue;
      }

      const attemptSpan: Option.Option<Tracer.Span> = outcome.failure.attemptSpan;
      const error: ConnectionAttemptError = outcome.failure.error;
      latestFailure = error;
      if (error._tag === "ConnectionBlockedError") {
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt,
          generation,
          lastFailure: error,
          retryAt: null,
        });
        const applicationActivated = yield* waitForSignal;
        if (applicationActivated) {
          resetRetryLadder();
        }
        continue;
      }

      if (outcome.skipBackoff) {
        // Only this first attempt skips the ladder; if it fails too, normal
        // backoff resumes.
        yield* setState(connectingState(yield* Ref.get(intent), generation, 1, error));
        continue;
      }

      failureCount += 1;
      const delayMs = retryDelayMs(failureCount - 1);
      pendingRetry = Option.map(attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt,
        generation,
        lastFailure: error,
        retryAt: (yield* Clock.currentTimeMillis) + delayMs,
      });
      const applicationActivated = yield* waitForRetrySignal(delayMs);
      if (applicationActivated) {
        resetRetryLadder();
      }
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed ? signal({ _tag: "NetworkChanged", network }) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(Ref.set(userRequested, true)),
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = Ref.set(resetRetryState, true).pipe(
    Effect.andThen(Ref.set(userRequested, true)),
    Effect.andThen(signal({ _tag: "RetryRequested" })),
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  // Marks the supervisor as verifying before queueing the wakeup, so a caller
  // that wakes several supervisors in order sees each one's health check or
  // cut-short backoff start before waking the next. The flag clears when the
  // lease is adopted, proven healthy, or its attempt ends.
  const wake = Effect.fnUntraced(function* (reason: ConnectionWakeups.ConnectionWakeup) {
    const phase = (yield* SubscriptionRef.get(state)).phase;
    if (
      ConnectionWakeups.isApplicationActiveWakeup(reason) &&
      (phase === "connected" || phase === "backoff")
    ) {
      yield* SubscriptionRef.set(verifying, true);
    }
    yield* signal({ _tag: "Wakeup", reason });
  });

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return {
    target,
    state,
    session,
    prepared,
    verifying,
    connect,
    disconnect,
    retryNow,
    wake,
  } satisfies ManagedEnvironmentSupervisor;
});
