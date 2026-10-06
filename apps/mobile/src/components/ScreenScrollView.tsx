import type { ComponentProps } from "react";
import { Platform } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { NativeScrollViewMarker } from "../native/NativeScrollViewMarker";

/**
 * Scroll view for forms and settings screens. Keeps the focused input above the keyboard,
 * and keeps content readable inside a wide pane while its surface fills the screen.
 */
export function ScreenScrollView(props: ComponentProps<typeof KeyboardAwareScrollView>) {
  const scrollView = (
    <KeyboardAwareScrollView
      bottomOffset={16}
      {...props}
      contentContainerStyle={[
        props.contentContainerStyle,
        Platform.OS === "android" && {
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        },
      ]}
    />
  );
  return Platform.OS === "ios" ? (
    <NativeScrollViewMarker style={{ flex: 1 }}>{scrollView}</NativeScrollViewMarker>
  ) : (
    scrollView
  );
}
