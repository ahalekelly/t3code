import { PermissionUpdateNotice } from "./features/connection/PermissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { Profiler, useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, getStateFromPath } from "@react-navigation/native";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import {
  navigationRef,
  recordReactCommit,
  traceAppLifecycle,
} from "./features/observability/appTraces";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells } from "./state/threads";
import { environmentShell, homeLaunchPaintedAtom } from "./state/shell";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { navigationLinkAction } from "./lib/navigationLinkAction";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});

const appLinking = {
  // Scene and App Intent launches can arrive before JavaScript subscribes.
  getInitialURL: async () => Linking.getLinkingURL(),
  getActionFromState: navigationLinkAction,
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
  getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) =>
    restoreDraftLinkState(getStateFromPath(path, options), path),
};

const Navigation = createStaticNavigation(RootStack);

const MAX_LAUNCH_SCREEN_MS = 2_000;

/** Keeps the launch screen up until appearance is ready and the home list has painted, so neither pops in. */
function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();
  const homePainted = useAtomValue(homeLaunchPaintedAtom);

  useEffect(() => {
    if (!isReady) return;
    if (homePainted) {
      void SplashScreen.hide();
      return;
    }
    // A home list that never paints must not hold the launch screen.
    const timer = setTimeout(() => void SplashScreen.hide(), MAX_LAUNCH_SCREEN_MS);
    return () => clearTimeout(timer);
  }, [isReady, homePainted]);

  return null;
}

export default function App() {
  useUiRuntimeMemoryWarningGc();
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <Profiler id="app" onRender={recordReactCommit}>
            <AppContent />
          </Profiler>
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <PermissionUpdateNotice />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
              <GlobalVoiceInputControl>
                <NativeLayoutMetricsProvider>
                  <IncomingShareProvider>
                    <Navigation
                      ref={navigationRef}
                      linking={appLinking}
                      theme={navigationTheme}
                      onReady={traceAppLifecycle}
                    />
                  </IncomingShareProvider>
                  <Dialog.Host />
                  <ThreadArrangementHost />
                </NativeLayoutMetricsProvider>
              </GlobalVoiceInputControl>
              {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
