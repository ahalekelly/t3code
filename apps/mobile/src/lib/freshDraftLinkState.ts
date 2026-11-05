import type { getActionFromState } from "@react-navigation/native";

import type { NewTaskDraftRouteParams } from "../features/threads/thread-route-state";
import { uuidv4 } from "./uuid";

type LinkState = Parameters<typeof getActionFromState>[0];

/** A link to a fresh composer opens a new draft, even when another draft is open. */
export function freshDraftLinkState(state: LinkState): LinkState {
  const index = state.index ?? state.routes.length - 1;
  const route = state.routes[index];
  const draft =
    route?.name === "Thread" && route.params && "draft" in route.params
      ? (route.params.draft as NewTaskDraftRouteParams)
      : undefined;
  if (
    draft?.environmentId === undefined ||
    draft.projectId === undefined ||
    draft.draftId !== undefined ||
    draft.incomingShareId !== undefined
  ) {
    return state;
  }
  const params = { draft: { ...draft, requestId: uuidv4() } };
  return { ...state, routes: state.routes.with(index, { ...route, name: "Thread", params }) };
}
