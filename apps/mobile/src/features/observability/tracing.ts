import Constants from "expo-constants";
import { type ReleaseChannel, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import {
  ConnectionTraceRecorder,
  makeConnectionTraceRecorder,
} from "@t3tools/client-runtime/observability/connection-traces";
import * as RelayTracing from "@t3tools/shared/relayTracing";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

const RELEASE_CHANNEL_BY_VARIANT: Readonly<Record<string, ReleaseChannel | undefined>> = {
  development: "dev",
  preview: "preview",
  production: "stable",
};

export function resolveTracingConfig(): TracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export function makeTracing(config: TracingConfig | null, resource: TracingResource) {
  const channel =
    typeof __DEV__ !== "undefined" && __DEV__
      ? "dev"
      : RELEASE_CHANNEL_BY_VARIANT[resource.appVariant];
  const recorder = makeConnectionTraceRecorder({
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    attributes: {
      "service.runtime": "react-native",
      "t3.client.surface": `mobile-${resource.appVariant}`,
    },
  });
  const layerRelayTracer = RelayTracing.layer(config, {
    serviceName: "t3code-mobile",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    serviceInstanceId: resource.serviceInstanceId,
    client: `mobile-${resource.appVariant}`,
    attributes: channel && releaseResourceAttributes(channel),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(ConnectionTraceRecorder, recorder),
    Layer.succeed(
      Tracer.Tracer,
      recorder.wrap(Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
    ),
    Layer.effect(
      RelayTracing.RelayClientTracer,
      Effect.gen(function* () {
        return Option.map(yield* RelayTracing.RelayClientTracer, recorder.wrap);
      }),
    ).pipe(Layer.provide(layerRelayTracer)),
  );
  return { recorder, layer };
}

export const { recorder: connectionTraceRecorder, layer } = makeTracing(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  serviceInstanceId: Constants.sessionId,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
});
