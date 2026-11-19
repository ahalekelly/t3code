import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { ComposerMediaSource } from "../../lib/composerImages";

const MEDIA_ACTIONS: MenuAction[] = [
  { id: "camera", title: "Take Photo", image: "camera" },
  { id: "library", title: "Photo Library", image: "photo" },
];
const FILES_ACTION: MenuAction = { id: "files", title: "Choose Files", image: "folder" };

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: (source: ComposerMediaSource) => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const { scale } = useAndroidControlSizing();
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={props.supportsFiles ? [...MEDIA_ACTIONS, FILES_ACTION] : MEDIA_ACTIONS}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "camera" || nativeEvent.event === "library") {
          void props.onPickMedia(nativeEvent.event);
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}
