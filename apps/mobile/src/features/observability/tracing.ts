import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import {
  ConnectionTraceRecorder,
  makeConnectionTraceRecorder,
} from "@t3tools/client-runtime/observability/connection-traces";
import { makeRelayClientTracingLayer, RelayClientTracer } from "@t3tools/shared/relayTracing";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

export function resolveTracingConfig(): TracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

/**
 * Every span the app ends is buffered by the connection trace recorder, which
 * posts them to the environment after each connect. The relay tracer (hosted
 * OTLP export, when configured) is wrapped too so its spans are recorded as well.
 */
export function makeTracingLayer(config: TracingConfig | null, resource: TracingResource) {
  const recorder = makeConnectionTraceRecorder({
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    attributes: {
      "service.runtime": "react-native",
      "t3.client.surface": `mobile-${resource.appVariant}`,
    },
  });
  const relayTracerLayer = makeRelayClientTracingLayer(config, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
  });
  return Layer.mergeAll(
    Layer.succeed(ConnectionTraceRecorder, recorder),
    Layer.succeed(
      Tracer.Tracer,
      recorder.wrap(Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
    ),
    Layer.effect(
      RelayClientTracer,
      Effect.gen(function* () {
        return Option.map(yield* RelayClientTracer, recorder.wrap);
      }),
    ).pipe(Layer.provide(relayTracerLayer)),
  );
}

export const tracingLayer = makeTracingLayer(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
