import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { Profiler, useEffect } from "react";
import { StatusBar, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation } from "@react-navigation/native";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
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
import { homeLaunchPaintedAtom } from "./state/shell";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { shouldHandleAppLink } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { navigationLinkAction, navigationLinkState } from "./lib/navigationLinkAction";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  // Scene and App Intent launches can arrive before JavaScript subscribes.
  getInitialURL: async () => Linking.getLinkingURL(),
  getActionFromState: navigationLinkAction,
  getStateFromPath: navigationLinkState,
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  // Keep the compact thread list available beneath a directly opened thread.
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
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
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
            {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
            <View style={{ flex: 1 }}>
              <IncomingShareProvider>
                <Navigation
                  ref={navigationRef}
                  linking={appLinking}
                  theme={navigationTheme}
                  onReady={traceAppLifecycle}
                />
              </IncomingShareProvider>
              <ConfirmDialogHost />
              <ThreadArrangementHost />
            </View>
            {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
