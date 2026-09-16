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
import {
  getSpeechOptions,
  SPEECH_MODELS,
  SPEECH_PACES,
  SPEECH_QUALITIES,
  type SpeechModel,
  type SpeechQuality,
  type SpeechSettings,
} from "../../lib/speechModels";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsVoiceRouteScreen() {
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
  const speech = getSpeechOptions(preferences);
  const saveSpeech = (patch: Partial<SpeechSettings>) => {
    const { model, ...settings } = speech;
    savePreferences({
      responseSpeechSettings: {
        ...preferences.responseSpeechSettings,
        [model]: { ...settings, ...patch },
      },
    });
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
          On-device transcription needs iOS 26 on a supported iPhone. The OpenAI sources upload each
          recording with the API key above, which stays in this device's keychain.
        </Text>
        {Platform.OS === "ios" ? (
          <SettingsSection title="Read aloud">
            <VoiceChoice
              label="Voice model"
              value={speech.model}
              options={Object.entries(SPEECH_MODELS).map(([id, model]) => ({
                id,
                title: model.label,
              }))}
              onSelect={(model) => savePreferences({ responseSpeechModel: model as SpeechModel })}
            />
            <VoiceChoice
              label="Voice"
              value={speech.voice}
              options={SPEECH_MODELS[speech.model].voices.map((voice) => ({
                id: voice,
                title: voice,
              }))}
              onSelect={(voice) => saveSpeech({ voice })}
            />
            <VoiceChoice
              label="Pace"
              value={String(speech.pace)}
              options={SPEECH_PACES.map((pace) => ({ id: String(pace), title: `${pace}×` }))}
              onSelect={(pace) => saveSpeech({ pace: Number(pace) })}
            />
            <VoiceChoice
              label="Quality"
              value={speech.quality}
              options={Object.entries(SPEECH_QUALITIES).map(([id, title]) => ({ id, title }))}
              onSelect={(quality) => saveSpeech({ quality: quality as SpeechQuality })}
            />
            <Text className="px-4 pb-4 text-sm text-foreground-muted">
              Higher quality takes longer to generate. Voice, pace, and quality are saved for each
              model.
            </Text>
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
