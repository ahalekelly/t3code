import { CommonActions, getActionFromState } from "@react-navigation/native";
import { uuidv4 } from "./uuid";

/** A link to a fresh composer owns a new flow, even when another draft is open. */
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
    return CommonActions.navigate({
      name: "NewTaskSheet",
      params: {
        screen: "NewTaskDraft",
        params: { ...draft.params, launchId: uuidv4() },
      },
    });
  }
  return getActionFromState(...args);
}
