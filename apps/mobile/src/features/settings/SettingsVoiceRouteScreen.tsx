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
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useVoiceSettings } from "../../state/voiceSettings";
import { openAiApiKeyAtom, setOpenAiApiKeyAtom } from "../../state/voiceTranscription";
import {
  VOICE_TRANSCRIPTION_SOURCE_LABELS,
  type VoiceTranscriptionSource,
} from "../../lib/voiceTranscriptionSources";
import {
  DEFAULT_SPEECH_INSTRUCTIONS,
  SPEECH_PACES,
  SPEECH_VOICES,
  type SpeechPace,
  type SpeechVoice,
} from "../../lib/speechSettings";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsVoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const storedResult = useAtomValue(openAiApiKeyAtom);
  const saveApiKey = useAtomSet(setOpenAiApiKeyAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedKey = AsyncResult.isSuccess(storedResult) ? storedResult.value : null;
  const [draft, setDraft] = useState<string | null>(null);
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);

  const voice = useVoiceSettings();
  const { preferences, speech } = voice;
  const selectedSource = voice.transcriptionSource;

  const commitInstructions = () => {
    if (instructionsDraft === null) return;
    setInstructionsDraft(null);
    if (instructionsDraft !== speech.instructions) {
      // Clearing the field restores the default delivery.
      savePreferences({ responseSpeechInstructions: instructionsDraft.trim() || undefined });
    }
  };

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
          <AndroidScreenHeader title="Voice" onBack={() => navigation.goBack()} />
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
          On-device transcription needs iOS 26 on a supported iPhone. OpenAI transcription uploads
          each recording with the API key above, which stays in this device's keychain. With a key,
          transcription defaults to OpenAI.
        </Text>
        {Platform.OS === "ios" ? (
          <SettingsSection title="Read aloud">
            <VoiceChoice
              label="Voice"
              value={speech.voice}
              options={SPEECH_VOICES.map((voice) => ({
                id: voice,
                title: voice.charAt(0).toUpperCase() + voice.slice(1),
              }))}
              onSelect={(voice) => savePreferences({ responseSpeechVoice: voice as SpeechVoice })}
            />
            <VoiceChoice
              label="Pace"
              value={String(speech.pace)}
              options={SPEECH_PACES.map((pace) => ({ id: String(pace), title: `${pace}×` }))}
              onSelect={(pace) =>
                savePreferences({ responseSpeechPace: Number(pace) as SpeechPace })
              }
            />
            <View className="gap-2 p-4">
              <Text className="text-lg text-foreground">Delivery</Text>
              <TextInput
                accessibilityLabel="Reading instructions"
                multiline
                onBlur={commitInstructions}
                onChangeText={setInstructionsDraft}
                placeholder={DEFAULT_SPEECH_INSTRUCTIONS}
                value={instructionsDraft ?? speech.instructions}
              />
            </View>
            <Text className="px-4 pb-4 text-sm text-foreground-muted">
              Describe how the voice should sound. Reading uses OpenAI with the API key above and
              costs about 1.5 cents per minute of audio.
            </Text>
            <SettingsSwitchRow
              icon="speaker.wave.2"
              label="Read voice replies aloud"
              subtitle="Read the reply after using voice auto-send, and announce approvals and questions."
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

function VoiceChoice({
  label,
  value,
  options,
  onSelect,
}: {
  label: string;
  value: string;
  options: { id: string; title: string }[];
  onSelect: (value: string) => void;
}) {
  return (
    <View className="flex-row items-center gap-4 p-4">
      <Text className="flex-1 text-lg text-foreground">{label}</Text>
      <ControlPillMenu
        accessibilityLabel={label}
        accessibilityRole="button"
        isAnchoredToRight
        actions={options.map((option) => ({
          ...option,
          state: option.id === value ? ("on" as const) : undefined,
        }))}
        onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}
      >
        <Pressable className="flex-row items-center gap-1.5 rounded-full bg-subtle px-3.5 py-2">
          <Text className="text-base text-foreground">
            {options.find((option) => option.id === value)?.title}
          </Text>
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
  );
}
