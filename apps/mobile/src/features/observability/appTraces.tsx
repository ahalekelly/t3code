import { Profiler, type ComponentType, type ProfilerOnRenderCallback } from "react";
import { AppState } from "react-native";

import { rootNavigationRef } from "../../lib/rootNavigation";
import { connectionTraceRecorder } from "./tracing";

const MIN_TRACED_COMMIT_MS = 4;

const toEpochNanos = (performanceMs: number) =>
  BigInt(Math.round((Date.now() - performance.now() + performanceMs) * 1_000_000));

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

export function withRenderTrace<Props extends object>(id: string, Screen: ComponentType<Props>) {
  return function RenderTracedScreen(props: Props) {
    return (
      <Profiler id={id} onRender={recordReactCommit}>
        <Screen {...props} />
      </Profiler>
    );
  };
}

function recordAppResume(launch: boolean) {
  const route = rootNavigationRef.getCurrentRoute();
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
