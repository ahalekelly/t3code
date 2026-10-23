import { getActionFromState } from "@react-navigation/native";

import type { NewTaskDraftRouteParams } from "../features/threads/thread-route-state";
import { uuidv4 } from "./uuid";

/** A link to a fresh composer opens a new draft, even when another draft is open. */
export function navigationLinkAction(...args: Parameters<typeof getActionFromState>) {
  const [state, options] = args;
  const index = state.index ?? state.routes.length - 1;
  const route = state.routes[index];
  const draft =
    route?.name === "Thread" && route.params && "draft" in route.params
      ? (route.params.draft as NewTaskDraftRouteParams)
      : undefined;
  if (
    draft?.environmentId !== undefined &&
    draft.projectId !== undefined &&
    draft.draftId === undefined &&
    draft.pendingTaskId === undefined &&
    draft.incomingShareId === undefined
  ) {
    const params = { draft: { ...draft, requestId: uuidv4() } };
    return getActionFromState(
      { ...state, routes: state.routes.with(index, { ...route, name: "Thread", params }) },
      options,
    );
  }
  return getActionFromState(...args);
}
