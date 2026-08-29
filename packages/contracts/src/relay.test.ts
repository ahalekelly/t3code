import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import {
  RelayAgentActivityPublishProofPayload,
  RelayAgentActivityPublishRequest,
  RelayApi,
} from "./relay.ts";

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});

describe("RelayAgentActivityPublish", () => {
  it("alerts when a publisher omits notify", () => {
    const request = Schema.decodeUnknownSync(RelayAgentActivityPublishRequest)({
      state: null,
      proof: "proof",
    });
    const proof = Schema.decodeUnknownSync(RelayAgentActivityPublishProofPayload)({
      iss: "env_1",
      aud: "relay",
      sub: "env_1",
      jti: "jti_1",
      iat: 1,
      exp: 2,
      environmentId: "env_1",
      threadId: "thread_1",
      state: null,
    });

    expect(request.notify).toBe(true);
    expect(proof.notify).toBe(true);
  });
});
