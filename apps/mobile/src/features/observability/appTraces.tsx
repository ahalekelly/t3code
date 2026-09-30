import { createNavigationContainerRef } from "@react-navigation/native";
import { Profiler, type ComponentType, type ProfilerOnRenderCallback } from "react";
import { AppState } from "react-native";

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
    { "profiler.id": id, phase, actualDuration, baseDuration },
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
    route?.name === "Thread" &&
    typeof route.params === "object" &&
    route.params !== null &&
    "environmentId" in route.params
      ? route.params.environmentId
      : undefined;
  const now = toEpochNanos(performance.now());
  connectionTraceRecorder.recordSpan("client.app.resume", now, now, {
    "app.launch": launch,
    screen: route?.name === "Home" ? "thread-list" : route?.name === "Thread" ? "thread" : "other",
    ...(typeof environmentId === "string" ? { "screen.environment.id": environmentId } : {}),
  });
}

/** Navigation `onReady`: traces the launch screen, then every return to the foreground. */
export function traceAppResumes() {
  recordAppResume(true);
  // iOS also reports `active` after brief `inactive` overlays (Control Center, Face ID), so
  // only a return from `background` counts as a resume.
  let previous = AppState.currentState;
  AppState.addEventListener("change", (state) => {
    if (state === "active" && previous === "background") {
      recordAppResume(false);
    }
    previous = state;
  });
}
