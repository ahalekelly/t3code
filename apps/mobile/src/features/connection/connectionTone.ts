import type { StatusTone } from "../../components/StatusPill";
import type { RemoteClientConnectionState } from "../../lib/connection";

// One shared tone per state, so tones passed as props keep their identity.
const CONNECTION_TONES: Record<RemoteClientConnectionState, StatusTone> = {
  connected: {
    label: "Connected",
    pillClassName: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
  },
  reconnecting: {
    label: "Reconnecting",
    pillClassName: "bg-warning",
    textClassName: "text-warning-foreground",
  },
  connecting: {
    label: "Connecting",
    pillClassName: "bg-update",
    textClassName: "text-update-foreground",
  },
  unsupported: {
    label: "Client not supported",
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-secondary",
  },
  error: {
    label: "Connection failed",
    pillClassName: "bg-danger",
    textClassName: "text-danger-foreground",
  },
  offline: {
    label: "Offline",
    pillClassName: "bg-danger",
    textClassName: "text-danger-foreground",
  },
  available: {
    label: "Available",
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-secondary",
  },
};

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  return CONNECTION_TONES[state];
}
