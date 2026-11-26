import { createContext, forwardRef, use, type ComponentProps } from "react";
import { Platform } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Reanimated from "react-native-reanimated";
import { cn } from "../../lib/cn";
import { NativeScrollViewMarker } from "../../native/NativeScrollViewMarker";

export const ScreenScrollViewBottomInset = createContext(0);
/**
 * The screen's surface class. UIKit's scroll-edge material under the header takes the scroll
 * view's own color; a clear scroll view gets the system's near-white bar over the screen's surface.
 */
export const ScreenScrollViewSurface = createContext<string | undefined>(undefined);

// The marker must be the scroll view's direct parent, inside keyboard-controller's clipping wrapper.
const MarkedScrollView: NonNullable<
  ComponentProps<typeof KeyboardAwareScrollView>["ScrollViewComponent"]
> = forwardRef((props, ref) => (
  <NativeScrollViewMarker style={{ flex: 1 }}>
    <Reanimated.ScrollView ref={ref} {...props} />
  </NativeScrollViewMarker>
));

export function ScreenScrollView(props: ComponentProps<typeof KeyboardAwareScrollView>) {
  const bottomInset = use(ScreenScrollViewBottomInset);
  const surface = use(ScreenScrollViewSurface);
  return (
    <KeyboardAwareScrollView
      bottomOffset={16}
      {...(Platform.OS === "ios" && { ScrollViewComponent: MarkedScrollView })}
      {...props}
      className={Platform.OS === "ios" && surface ? cn(surface, props.className) : props.className}
      contentInset={
        Platform.OS === "ios" && bottomInset > 0
          ? { ...props.contentInset, bottom: (props.contentInset?.bottom ?? 0) + bottomInset }
          : props.contentInset
      }
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
}
