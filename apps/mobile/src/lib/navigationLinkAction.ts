import { CommonActions, getActionFromState, getStateFromPath } from "@react-navigation/native";
import { uuidv4 } from "./uuid";

/** Fresh chat links reset the draft inside a single new-task sheet. */
export function navigationLinkAction(...args: Parameters<typeof getActionFromState>) {
  const [state] = args;
  const route = state.routes[state.index ?? state.routes.length - 1];
  const nested = route?.state;
  const draft = nested?.routes[nested.index ?? nested.routes.length - 1];
  if (
    route?.name === "NewTaskSheet" &&
    draft?.name === "NewTaskDraft" &&
    draft.params &&
    "environmentId" in draft.params &&
    "projectId" in draft.params &&
    !("draftId" in draft.params) &&
    !("pendingTaskId" in draft.params) &&
    !("incomingShareId" in draft.params)
  ) {
    return CommonActions.navigate(
      "NewTaskSheet",
      {
        screen: "NewTaskDraft",
        params: { ...draft.params, launchId: uuidv4() },
      },
      { pop: true },
    );
  }
  return getActionFromState(...args);
}

/** Give cold launches the same initial project parameters as warm navigation. */
export function navigationLinkState(...args: Parameters<typeof getStateFromPath>) {
  const state = getStateFromPath(...args);
  if (!state) return state;
  const sheet = state.routes.at(-1);
  const draft = sheet?.state?.routes.at(-1);
  if (sheet?.name === "NewTaskSheet" && draft?.name === "NewTaskDraft") {
    return {
      ...state,
      routes: state.routes.map((route) =>
        route === sheet
          ? { ...route, params: { screen: "NewTaskDraft", params: draft.params } }
          : route,
      ),
    };
  }
  return state;
}
