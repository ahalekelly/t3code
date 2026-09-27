import { useAtomSet } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import { responseSpeech } from "../../lib/responseSpeech";
import { SPEECH_PACES } from "../../lib/speechModels";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useVoiceSettings } from "../../state/voiceSettings";
import { ComposerSurface } from "./ThreadComposer";

const SURFACE_STYLE = {
  borderRadius: 28,
  padding: 6,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
} as const;

/** Controls for the response being read in this thread, above the composer. */
export function SpeechPlaybackBar(props: { readonly scope: string }) {
  const paused = useSyncExternalStore(responseSpeech.subscribe, () => {
    const snapshot = responseSpeech.getSnapshot();
    return snapshot?.response.scope === props.scope ? snapshot.paused : null;
  });
  const voice = useVoiceSettings();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  if (paused === null) return null;

  const { model, instructions: _instructions, apiKey: _apiKey, ...settings } = voice.speech;
  return (
    <Animated.View
      className="mx-4 mb-2"
      entering={FadeInDown.duration(200)}
      exiting={FadeOut.duration(140)}
    >
      <ComposerSurface animateLayout={false} style={SURFACE_STYLE}>
        <ComposerToolbarButton
          accessibilityLabel="Rewind 10 seconds"
          icon="gobackward.10"
          showChevron={false}
          onPress={() => void responseSpeech.rewind()}
        />
        <ComposerToolbarButton
          accessibilityLabel={paused ? "Resume reading" : "Pause reading"}
          icon={paused ? "play.fill" : "pause.fill"}
          showChevron={false}
          variant="primary"
          onPress={() => void (paused ? responseSpeech.resume() : responseSpeech.pause())}
        />
        <ComposerToolbarButton
          accessibilityLabel="Next paragraph"
          icon="forward.end.fill"
          showChevron={false}
          onPress={() => void responseSpeech.nextBlock()}
        />
        <ControlPillMenu
          accessibilityLabel="Reading pace"
          accessibilityRole="button"
          actions={SPEECH_PACES.map((pace) => ({
            id: String(pace),
            title: `${pace}×`,
            state: pace === settings.pace ? ("on" as const) : undefined,
          }))}
          onPressAction={({ nativeEvent }) => {
            const pace = Number(nativeEvent.event);
            void responseSpeech.setPace(pace);
            savePreferences({
              responseSpeechSettings: {
                ...voice.preferences.responseSpeechSettings,
                [model]: { ...settings, pace },
              },
            });
          }}
        >
          <ComposerToolbarButton accessibilityLabel="Reading pace" label={`${settings.pace}×`} />
        </ControlPillMenu>
        <ComposerToolbarButton
          accessibilityLabel="Stop reading"
          icon="stop.fill"
          showChevron={false}
          onPress={() => void responseSpeech.stop()}
        />
      </ComposerSurface>
    </Animated.View>
  );
}
