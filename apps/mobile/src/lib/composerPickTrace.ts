import * as Effect from "effect/Effect";

import { uuidv4 } from "./uuid";

const DISMISS_POLL_MS = 250;

type PickAttributes = Record<string, string | number | boolean>;

export type ComposerPickTrace = (step: string, attributes?: PickAttributes) => void;

// Lazy: modules importing the composer helpers must not build the app runtime.
function recordPickStep(step: string, attributes: PickAttributes) {
  void import("./runtime").then(({ runtime }) =>
    runtime.runFork(Effect.withSpan(Effect.void, `composer.media.pick.${step}`, { attributes })),
  );
}

/**
 * Records each step of one media pick as a `composer.media.pick.<step>` span sharing a pick id,
 * to diagnose picks that silently never reach the composer.
 */
export function startComposerPickTrace(source: string): ComposerPickTrace {
  const pickId = uuidv4();
  const launchedAt = Date.now();
  return (step, attributes = {}) =>
    recordPickStep(step, { pickId, source, msSinceLaunch: Date.now() - launchedAt, ...attributes });
}

/** The draft can still drop processed attachments: a removed placeholder, an abort, a duplicate, or the cap. */
export function traceComposerPickLanded(
  attachmentIds: ReadonlyArray<string>,
  landedIds: ReadonlyArray<string>,
) {
  recordPickStep("landed", {
    attachmentIds: attachmentIds.join(","),
    landed: landedIds.length,
    dropped: attachmentIds.filter((id) => !landedIds.includes(id)).join(","),
  });
}

/**
 * expo-image-picker resolves only after it loads the picked files, so JS cannot otherwise see the
 * picker close. Polls the iOS presentation stack for it to shrink back to its depth before launch;
 * a `dismissed` step with no `resolved` after it means the picker never returned.
 */
export async function traceNativePicker<T>(
  trace: ComposerPickTrace,
  launch: () => Promise<T>,
): Promise<T> {
  const { requireOptionalNativeModule } = await import("expo");
  const presentationDepth = requireOptionalNativeModule<{
    presentationDepth?(): Promise<number>;
  }>("T3NativeControls")?.presentationDepth;
  const baseline = presentationDepth === undefined ? null : await presentationDepth();
  let settled = false;
  const picked = launch();
  if (presentationDepth !== undefined && baseline !== null) {
    void (async () => {
      let opened = false;
      while (!settled) {
        await new Promise((resolve) => setTimeout(resolve, DISMISS_POLL_MS));
        const depth = await presentationDepth();
        if (depth > baseline) opened = true;
        else if (opened) {
          if (!settled) trace("dismissed");
          return;
        }
      }
    })();
  }
  try {
    const result = await picked;
    trace("resolved");
    return result;
  } catch (error) {
    trace("rejected", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    settled = true;
  }
}
