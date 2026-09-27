import { useAtomSet } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { responseSpeech } from "../../lib/responseSpeech";
import { SPEECH_PACES } from "../../lib/speechModels";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useVoiceSettings } from "../../state/voiceSettings";

function PlaybackButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      className="size-12 items-center justify-center rounded-full"
      style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={24} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}

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
      className="mx-4 mb-2 flex-row items-center justify-between rounded-full border border-border bg-card-alt px-2 py-1"
      entering={FadeInDown.duration(200)}
      exiting={FadeOut.duration(140)}
    >
      <PlaybackButton
        icon="gobackward.10"
        label="Rewind 10 seconds"
        onPress={() => void responseSpeech.rewind()}
      />
      <PlaybackButton
        icon={paused ? "play.fill" : "pause.fill"}
        label={paused ? "Resume reading" : "Pause reading"}
        onPress={() => void (paused ? responseSpeech.resume() : responseSpeech.pause())}
      />
      <PlaybackButton
        icon="forward.end.fill"
        label="Next paragraph"
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
        <View className="h-12 min-w-14 items-center justify-center rounded-full px-2">
          <Text className="font-t3-bold text-lg tabular-nums text-foreground">
            {settings.pace}×
          </Text>
        </View>
      </ControlPillMenu>
      <PlaybackButton
        icon="stop.fill"
        label="Stop reading"
        onPress={() => void responseSpeech.stop()}
      />
    </Animated.View>
  );
}
