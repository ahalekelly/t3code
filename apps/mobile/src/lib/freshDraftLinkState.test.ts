import * as NodeModule from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";
import { getStateFromPath, StackRouter } from "@react-navigation/native";

vi.mock("@react-navigation/native", () => {
  const require = NodeModule.createRequire(import.meta.url);
  const requireFromNative = NodeModule.createRequire(
    require.resolve("@react-navigation/native/package.json"),
  );
  return requireFromNative("@react-navigation/core");
});

vi.mock("./uuid", () => ({ uuidv4: () => crypto.randomUUID() }));

import { restoreDraftLinkState } from "./appLinking";
import {
  workspaceDetailLinkAction,
  workspaceDetailRouter,
} from "../features/workspace/workspace-detail-selection";
import { freshDraftLinkState } from "./freshDraftLinkState";

const config = {
  initialRouteName: "Home",
  screens: {
    Home: "",
    Thread: { path: "threads/:environmentId?/:threadId?", alias: ["new/draft"] },
    NewTaskProject: "new",
  },
};

function parse(path: string) {
  const state = restoreDraftLinkState(getStateFromPath(path, config), path);
  if (!state) throw new Error(`Could not parse ${path}`);
  return state;
}

describe("project chat links", () => {
  it("cold-starts in the requested environment and project with a route home", () => {
    const state = parse("new/draft?environmentId=remote%20%26%20one&projectId=project%2Ftwo");
    expect(state.routes[0]?.name).toBe("Home");
    expect(state.routes.at(-1)).toMatchObject({
      name: "Thread",
      params: { draft: { environmentId: "remote & one", projectId: "project/two" } },
    });
  });

  it("opens a fresh draft on every tap", () => {
    const stack = StackRouter({ initialRouteName: "Home" });
    const router = { ...stack, ...workspaceDetailRouter(stack) };
    const options = {
      routeNames: ["Home", "Thread", "NewTaskProject"],
      routeParamList: {},
      routeGetIdList: {},
    };
    let state = router.getInitialState(options);
    const link = parse("new/draft?environmentId=env-1&projectId=project-1");
    const requestIds = new Set<unknown>();
    for (let tap = 0; tap < 3; tap++) {
      const action = workspaceDetailLinkAction(freshDraftLinkState(link));
      if (!action) throw new Error("Missing navigation action");
      const next = router.getStateForAction(state, action as never, options);
      if (!next) throw new Error("Navigation action was not handled");
      state = router.getRehydratedState(next, options);
      expect(state.routes.map((route) => route.name)).toEqual(["Home", "Thread"]);
      const params = state.routes.at(-1)?.params as { draft: Record<string, unknown> };
      expect(params.draft).toEqual({
        environmentId: "env-1",
        projectId: "project-1",
        requestId: expect.any(String),
      });
      requestIds.add(params.draft.requestId);
    }
    expect(requestIds.size).toBe(3);
  });

  it.each([
    "new",
    "threads/env-1/thread-1",
    "new/draft?environmentId=env-1&projectId=project-1&draftId=saved",
    "new/draft?environmentId=env-1&projectId=project-1&incomingShareId=share",
  ])("leaves %s unchanged", (path) => {
    const state = parse(path);
    expect(freshDraftLinkState(state)).toBe(state);
  });
});
