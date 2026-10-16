import * as NodeModule from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  getActionFromState,
  getStateFromPath,
  getFocusedRouteNameFromRoute,
  StackRouter,
} from "@react-navigation/native";

vi.mock("@react-navigation/native", () => {
  const require = NodeModule.createRequire(import.meta.url);
  const requireFromNative = NodeModule.createRequire(
    require.resolve("@react-navigation/native/package.json"),
  );
  return requireFromNative("@react-navigation/core");
});

vi.mock("./uuid", () => ({ uuidv4: () => crypto.randomUUID() }));

import { navigationLinkAction, navigationLinkState } from "./navigationLinkAction";

const config = {
  initialRouteName: "Home",
  screens: {
    Home: "",
    Thread: "threads/:environmentId/:threadId",
    NewTaskSheet: {
      path: "new",
      initialRouteName: "NewTask",
      screens: { NewTask: "", NewTaskDraft: "draft" },
    },
  },
};

function parse(path: string) {
  const state = navigationLinkState(path, config);
  if (!state) throw new Error(`Could not parse ${path}`);
  return state;
}

describe("project chat links", () => {
  it("cold-starts in the requested environment and project with a route home", () => {
    const state = parse("new/draft?environmentId=remote%20%26%20one&projectId=project%2Ftwo");
    expect(state.routes[0]?.name).toBe("Home");
    const sheet = state.routes.at(-1);
    expect(sheet?.name).toBe("NewTaskSheet");
    expect(sheet?.params).toEqual({
      screen: "NewTaskDraft",
      params: { environmentId: "remote & one", projectId: "project/two" },
    });
    if (!sheet) throw new Error("Missing new-task sheet");
    expect(getFocusedRouteNameFromRoute(sheet)).toBe("NewTaskDraft");
    expect(sheet?.state?.routes.at(-1)).toMatchObject({
      name: "NewTaskDraft",
      params: { environmentId: "remote & one", projectId: "project/two" },
    });
  });

  it.each(["new", "threads/env-1/thread-1"])("preserves initial state for %s", (path) => {
    expect(navigationLinkState(path, config)).toEqual(getStateFromPath(path, config));
  });

  it("opens fresh drafts on repeated taps without stacking sheets", () => {
    const router = StackRouter({ initialRouteName: "Home" });
    const options = {
      routeNames: ["Home", "NewTaskSheet", "Thread"],
      routeParamList: {},
      routeGetIdList: {},
    };
    let state = router.getInitialState(options);
    const link = parse("new/draft?environmentId=env-1&projectId=project-1");
    const launches = new Set<string>();
    for (let tap = 0; tap < 3; tap++) {
      const action = navigationLinkAction(link, config);
      if (!action) throw new Error("Missing navigation action");
      const next = router.getStateForAction(state, action, options);
      if (!next) throw new Error("Navigation action was not handled");
      state = router.getRehydratedState(next, options);
      expect(state.routes.map((route) => route.name)).toEqual(["Home", "NewTaskSheet"]);
      expect(state.routes.at(-1)?.params).toEqual({
        screen: "NewTaskDraft",
        params: { environmentId: "env-1", projectId: "project-1", launchId: expect.any(String) },
      });
      const params = state.routes.at(-1)?.params as { params: { launchId: string } };
      launches.add(params.params.launchId);
    }
    expect(state.routes).toHaveLength(2);
    expect(launches.size).toBe(3);
  });

  it.each([
    "new",
    "threads/env-1/thread-1",
    "new/draft?environmentId=env-1&projectId=project-1&draftId=saved",
    "new/draft?environmentId=env-1&projectId=project-1&pendingTaskId=pending",
    "new/draft?environmentId=env-1&projectId=project-1&incomingShareId=share",
  ])("preserves normal navigation for %s", (path) => {
    const state = parse(path);
    expect(navigationLinkAction(state, config)).toEqual(getActionFromState(state, config));
  });
});
