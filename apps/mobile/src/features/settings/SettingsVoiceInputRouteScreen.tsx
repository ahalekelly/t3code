import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { openAiApiKeyAtom, setOpenAiApiKeyAtom } from "../../state/voiceTranscription";
import {
  DEFAULT_VOICE_TRANSCRIPTION_SOURCE,
  VOICE_TRANSCRIPTION_SOURCE_LABELS,
  type VoiceTranscriptionSource,
} from "../voice-input/voiceTranscriptionSources";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsVoiceInputRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const storedResult = useAtomValue(openAiApiKeyAtom);
  const saveApiKey = useAtomSet(setOpenAiApiKeyAtom);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedKey = AsyncResult.isSuccess(storedResult) ? storedResult.value : null;
  const [draft, setDraft] = useState<string | null>(null);

  const selectedSource = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.voiceTranscriptionSource ?? DEFAULT_VOICE_TRANSCRIPTION_SOURCE)
    : DEFAULT_VOICE_TRANSCRIPTION_SOURCE;

  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const speechRate = preferences.responseSpeechRate ?? 1;

  const commitDraft = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() !== (storedKey ?? "")) saveApiKey(draft);
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice Input" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Transcription">
          <View className="flex-row items-center gap-4 p-4">
            <Text className="flex-1 text-lg text-foreground">Source</Text>
            <ControlPillMenu
              accessibilityLabel="Transcription source"
              accessibilityRole="button"
              actions={Object.entries(VOICE_TRANSCRIPTION_SOURCE_LABELS).map(([id, label]) => ({
                id,
                title: label,
                state: id === selectedSource ? ("on" as const) : undefined,
              }))}
              isAnchoredToRight
              onPressAction={({ nativeEvent }) =>
                savePreferences({
                  voiceTranscriptionSource: nativeEvent.event as VoiceTranscriptionSource,
                })
              }
            >
              <Pressable className="flex-row items-center gap-1.5 rounded-full bg-subtle px-3.5 py-2">
                <Text className="text-base text-foreground">
                  {VOICE_TRANSCRIPTION_SOURCE_LABELS[selectedSource]}
                </Text>
                <SymbolView
                  name="chevron.up.chevron.down"
                  size={12}
                  tintColorClassName={"accent-icon"}
                  type="monochrome"
                  weight="semibold"
                />
              </Pressable>
            </ControlPillMenu>
          </View>
        </SettingsSection>
        <SettingsSection title="OpenAI API key">
          <View className="p-4">
            <TextInput
              accessibilityLabel="OpenAI API key"
              autoCapitalize="none"
              autoCorrect={false}
              editable={AsyncResult.isSuccess(storedResult)}
              onBlur={commitDraft}
              onChangeText={setDraft}
              onSubmitEditing={commitDraft}
              placeholder="sk-..."
              returnKeyType="done"
              secureTextEntry
              value={draft ?? storedKey ?? ""}
            />
          </View>
        </SettingsSection>
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          On-device transcription needs iOS 26 on a supported iPhone. The OpenAI sources upload each
          recording with the API key above, which stays in this device's keychain.
        </Text>
        {Platform.OS === "ios" ? (
          <SettingsSection title="Read aloud">
            <View className="flex-row items-center gap-4 p-4">
              <Text className="flex-1 text-lg text-foreground">Playback speed</Text>
              <ControlPillMenu
                accessibilityLabel="Playback speed"
                accessibilityRole="button"
                actions={[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => ({
                  id: String(rate),
                  title: `${rate}×`,
                  state: rate === speechRate ? ("on" as const) : undefined,
                }))}
                isAnchoredToRight
                onPressAction={({ nativeEvent }) =>
                  savePreferences({ responseSpeechRate: Number(nativeEvent.event) })
                }
              >
                <Pressable className="flex-row items-center gap-1.5 rounded-full bg-subtle px-3.5 py-2">
                  <Text className="text-base text-foreground">{speechRate}×</Text>
                  <SymbolView
                    name="chevron.up.chevron.down"
                    size={12}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                    weight="semibold"
                  />
                </Pressable>
              </ControlPillMenu>
            </View>
            <SettingsSwitchRow
              icon="speaker.wave.2"
              label="Read voice replies aloud"
              subtitle="Read the completed response after using voice auto-send."
              value={preferences.readVoiceRepliesAloud ?? true}
              onValueChange={(readVoiceRepliesAloud) => savePreferences({ readVoiceRepliesAloud })}
            />
            <SettingsSwitchRow
              icon="text.bubble"
              label="Read thinking updates"
              subtitle="Include written progress messages during voice replies."
              disabled={!(preferences.readVoiceRepliesAloud ?? true)}
              value={preferences.readThinkingUpdatesAloud ?? false}
              onValueChange={(readThinkingUpdatesAloud) =>
                savePreferences({ readThinkingUpdatesAloud })
              }
            />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </View>
  );
}
