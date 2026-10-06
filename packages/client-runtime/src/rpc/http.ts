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
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError, type HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
}> {
  constructor(requestUrl: string, status: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} returned undeclared status ${status}.`,
      requestUrl,
      status,
    });
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl,
      timeoutMs,
    });
  }
}

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

export const remoteHttpClientLayer = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    httpHeaderRedactionLayer,
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
 * Decodes a snapshot endpoint's response fetched with `responseMode: "response-only"`.
 * A 200 body is read, parsed, and schema-decoded in the `snapshot.body`,
 * `snapshot.parse`, and `snapshot.decode` spans, with the same validation and
 * errors as the typed client. Any other status goes through `decodeOther`, a
 * typed client that replays the received response for its declared error decoding.
 */
export const decodeSnapshotResponse = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
  A,
  B,
  E,
  R,
>(input: {
  readonly response: HttpClientResponse.HttpClientResponse;
  /** `Schema.decodeUnknownEffect` of the endpoint's success schema. */
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
        return yield* input.decode(json).pipe(
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

/** Contract-derived request URLs for authentication proofs, tracing, and structured errors. */
export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (cause instanceof RemoteEnvironmentAuthTimeoutError) {
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
        new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
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

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
