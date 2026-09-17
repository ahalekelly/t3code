import { CommonActions, getActionFromState } from "@react-navigation/native";
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
