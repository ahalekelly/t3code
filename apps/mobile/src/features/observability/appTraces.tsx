import { createNavigationContainerRef } from "@react-navigation/native";
import { Profiler, type ComponentType, type ProfilerOnRenderCallback } from "react";
import { AppState } from "react-native";
import { setMarkdownTextCutoffReporter } from "@t3tools/mobile-markdown-text/primitive";

import { connectionTraceRecorder } from "./tracing";

// Commits under 4 ms are routine updates. Skipping them keeps the trace buffer
// for the renders that can stall the JS thread.
const MIN_TRACED_COMMIT_MS = 4;

// Profiler times are performance.now() milliseconds; spans use epoch nanoseconds.
const toEpochNanos = (performanceMs: number) =>
  BigInt(Math.round((Date.now() - performance.now() + performanceMs) * 1_000_000));

/**
 * Records a `react.commit` span per Profiler commit. React calls this only with
 * the profiling renderer, which metro.config.js selects for every build.
 *
 * Durations are wall-clock time. iOS throttles a backgrounded app and then
 * suspends it, so a commit that runs or resumes outside `active` can report
 * seconds of time the JS thread spent descheduled; only `app.state: "active"`
 * commits measure render cost. AppState events reach JS only after the current
 * task, so the first commit after leaving the app can still read `active`; the
 * `client.app.background` span marks that boundary.
 */
export const recordReactCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  if (actualDuration < MIN_TRACED_COMMIT_MS) {
    return;
  }
  connectionTraceRecorder.recordSpan(
    "react.commit",
    toEpochNanos(startTime),
    toEpochNanos(commitTime),
    { "profiler.id": id, phase, actualDuration, baseDuration, "app.state": AppState.currentState },
  );
};

/** Wraps a navigation screen in a Profiler whose commits are traced under `id`. */
export function withRenderTrace<Props extends object>(id: string, Screen: ComponentType<Props>) {
  return function RenderTracedScreen(props: Props) {
    return (
      <Profiler id={id} onRender={recordReactCommit}>
        <Screen {...props} />
      </Profiler>
    );
  };
}

export const navigationRef = createNavigationContainerRef();

/** Records a `client.app.resume` span naming the screen the app opened on. */
function recordAppResume(launch: boolean) {
  const route = navigationRef.getCurrentRoute();
  const environmentId =
    typeof route?.params === "object" && route.params !== null && "environmentId" in route.params
      ? route.params.environmentId
      : undefined;
  const now = toEpochNanos(performance.now());
  connectionTraceRecorder.recordSpan("client.app.resume", now, now, {
    "app.launch": launch,
    screen: route?.name ?? "none",
    ...(typeof environmentId === "string" ? { "screen.environment.id": environmentId } : {}),
  });
}

const SUSPEND_TICK_MS = 250;
const MIN_SUSPENDED_MS = 1_000;

/**
 * Ticks while the app is in the background and records a `client.app.suspended`
 * span for each tick at least MIN_SUSPENDED_MS late. iOS freezes the JS thread
 * with the timer, so the span ends when JS runs again. That is more exact than
 * `client.app.resume`, which waits behind the work queued during the freeze.
 * Date.now() keeps advancing while the device sleeps, unlike performance.now().
 */
function traceSuspensions() {
  let expected = Date.now() + SUSPEND_TICK_MS;
  const tick = () => {
    const now = Date.now();
    if (now - expected >= MIN_SUSPENDED_MS) {
      connectionTraceRecorder.recordSpan(
        "client.app.suspended",
        BigInt(expected) * 1_000_000n,
        BigInt(now) * 1_000_000n,
        {},
      );
    }
    expected = now + SUSPEND_TICK_MS;
    timer = setTimeout(tick, SUSPEND_TICK_MS);
  };
  let timer = setTimeout(tick, SUSPEND_TICK_MS);
  return () => clearTimeout(timer);
}

/**
 * Navigation `onReady`: traces the launch screen, every move to the background, every
 * return, and every markdown text view that draws less text than it holds.
 */
export function traceAppLifecycle() {
  recordAppResume(true);
  setMarkdownTextCutoffReporter(({ textLength, shownLength, frameHeight, neededHeight }) => {
    const now = toEpochNanos(performance.now());
    connectionTraceRecorder.recordSpan("client.markdown.text_cutoff", now, now, {
      textLength,
      shownLength,
      frameHeight,
      neededHeight,
    });
  });
  // iOS also reports `active` after brief `inactive` overlays (Control Center, Face ID), so
  // only a return from `background` counts as a resume.
  let previous = AppState.currentState;
  let stopSuspensionTrace: (() => void) | undefined;
  AppState.addEventListener("change", (state) => {
    if (state === "background") {
      const now = toEpochNanos(performance.now());
      connectionTraceRecorder.recordSpan("client.app.background", now, now, {});
      stopSuspensionTrace ??= traceSuspensions();
    }
    if (state === "active") {
      // The last tick, run as JS resumed, recorded the freeze before this event arrived.
      stopSuspensionTrace?.();
      stopSuspensionTrace = undefined;
      if (previous === "background") {
        recordAppResume(false);
      }
    }
    previous = state;
  });
}
