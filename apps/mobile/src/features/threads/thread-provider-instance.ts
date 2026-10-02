import * as Equal from "effect/Equal";
import { useMemo, useState } from "react";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId, ProviderDriverKind, ServerConfig } from "@t3tools/contracts";

/** What a thread row needs to draw the provider glyph and its account badge. */
export interface ThreadRowProviderInstance {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly showBadge: boolean;
}

/**
 * Resolve the provider instance a thread runs on, scoped to the thread's own
 * environment: default instance ids are the driver slug, so the same id
 * names a different account on every server.
 */
export function resolveThreadProviderInstance(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  thread: EnvironmentThreadShell,
): ThreadRowProviderInstance | null {
  const providers = serverConfigs.get(thread.environmentId)?.providers ?? [];
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot) return null;
  const entry = {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
  };
  return {
    ...entry,
    showBadge: shouldShowInstanceBadge(
      entry,
      providers.map((provider) => ({ driverKind: provider.driver })),
    ),
  };
}

/**
 * Builds the list-scoped source of reference-stable `ThreadRowProviderInstance`
 * objects, which memoized rows compare by reference. Each server-config
 * generation gets its own resolver, and a generation reuses the previous
 * generation's object for an (environment, instance id) whose resolved value is
 * unchanged, so a reconnect that resends the same config re-renders no rows.
 */
export function createThreadRowProviderInstanceResolver(): (
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
) => (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const latest = new Map<string, ThreadRowProviderInstance | null>();
  return (serverConfigs) => {
    const generation = new Map<string, ThreadRowProviderInstance | null>();
    return (thread) => {
      const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
      const cacheKey = `${thread.environmentId}|${instanceId ?? ""}`;
      const cached = generation.get(cacheKey);
      if (cached !== undefined) return cached;
      const resolved = resolveThreadProviderInstance(serverConfigs, thread);
      const previous = latest.get(cacheKey);
      const value =
        previous !== undefined && Equal.equals(previous, resolved) ? previous : resolved;
      latest.set(cacheKey, value);
      generation.set(cacheKey, value);
      return value;
    };
  };
}

/** List-scoped wrapper: one resolver per server-config generation. */
export function useThreadRowProviderInstanceResolver(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): (thread: EnvironmentThreadShell) => ThreadRowProviderInstance | null {
  const [resolverForGeneration] = useState(createThreadRowProviderInstanceResolver);
  return useMemo(
    () => resolverForGeneration(serverConfigs),
    [resolverForGeneration, serverConfigs],
  );
}
