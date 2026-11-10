import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError, type HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Schema.TaggedError<RemoteEnvironmentAuthFetchError>()(
  "RemoteEnvironmentAuthFetchError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

class RemoteEnvironmentAuthInvalidJsonError extends Schema.TaggedError<RemoteEnvironmentAuthInvalidJsonError>()(
  "RemoteEnvironmentAuthInvalidJsonError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Schema.TaggedError<RemoteEnvironmentAuthUndeclaredStatusError>()(
  "RemoteEnvironmentAuthUndeclaredStatusError",
  {
    status: Schema.Number,
    requestUrl: Schema.String,
  },
) {
  override get message(): string {
    return `Remote environment endpoint ${this.requestUrl} returned undeclared status ${this.status}.`;
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Schema.TaggedError<RemoteEnvironmentAuthTimeoutError>()(
  "RemoteEnvironmentAuthTimeoutError",
  {
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Remote environment endpoint ${this.requestUrl} timed out after ${this.timeoutMs}ms.`;
  }
}

const isRemoteEnvironmentAuthTimeoutError = Schema.is(RemoteEnvironmentAuthTimeoutError);

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    HttpObservability.layer,
  );

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient,
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Decodes a snapshot response fetched with `responseMode: "response-only"`. A non-200 response
 * goes through `decodeOther`, a typed client that replays it for its declared error decoding.
 */
export const decodeSnapshotResponse = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
  A,
  B,
  E,
  R,
>(input: {
  readonly response: HttpClientResponse.HttpClientResponse;
  readonly decode: (json: unknown) => Effect.Effect<A, Schema.SchemaError>;
  readonly counts: (value: A) => Record<string, number>;
  readonly group: Group;
  readonly decodeOther: (
    client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>,
  ) => Effect.Effect<B, E, R>;
}) =>
  input.response.status === 200
    ? Effect.gen(function* () {
        const text = yield* input.response.arrayBuffer.pipe(
          Effect.tap((body) => Effect.annotateCurrentSpan("snapshot.bytes", body.byteLength)),
          Effect.map((body) => new TextDecoder().decode(body)),
          Effect.withSpan("snapshot.body"),
        );
        const json = yield* decodeJsonText(text).pipe(Effect.withSpan("snapshot.parse"));
        // Schema decode effects parse eagerly when created, so suspend to time the parse.
        return yield* Effect.suspend(() => input.decode(json)).pipe(
          Effect.tap((value) => Effect.annotateCurrentSpan(input.counts(value))),
          Effect.withSpan("snapshot.decode"),
        );
      })
    : makeEnvironmentHttpApiGroupClient(input.response.request.url, input.group).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.makeWith<
            HttpClientError.HttpClientError,
            never,
            HttpClientError.HttpClientError,
            never
          >(Effect.as(input.response), Effect.succeed),
        ),
        Effect.flatMap(input.decodeOther),
      );

export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (isRemoteEnvironmentAuthTimeoutError(cause)) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError({ requestUrl, status: response.status }),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
};

const REMOTE_REQUEST_HEDGE_DELAY = Duration.seconds(2);

/**
 * Starts one identical attempt if an idempotent request has not settled after
 * `REMOTE_REQUEST_HEDGE_DELAY`: Tailscale can black-hole the first connection after a wake.
 */
export const hedgeIdempotentRequest = <A, E, R>(
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- A hedge, not a timeout: the first attempt keeps running.
  Effect.raceFirst(request, Effect.sleep(REMOTE_REQUEST_HEDGE_DELAY).pipe(Effect.andThen(request)));

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError({ requestUrl, timeoutMs })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
