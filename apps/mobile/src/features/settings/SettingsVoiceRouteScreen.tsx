import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { useVoiceSettings } from "../../state/voiceSettings";
import { setVoiceApiKeyAtom, voiceApiKeyAtom } from "../../state/voiceApiKeys";
import {
  VOICE_TRANSCRIPTION_SOURCE_LABELS,
  type VoiceTranscriptionSource,
} from "../../lib/voiceTranscriptionSources";
import {
  SPEECH_MODELS,
  SPEECH_PACES,
  VOICE_API_KEYS,
  VOICE_API_PROVIDERS,
  type SpeechModel,
  type SpeechPace,
  type VoiceApiKey,
} from "../../lib/speechSettings";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsVoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);

  const voice = useVoiceSettings();
  const { preferences, speech } = voice;
  const selectedSource = voice.transcriptionSource;
  const model = SPEECH_MODELS[speech.model];
  const speechProvider = VOICE_API_PROVIDERS[model.provider];

  const commitInstructions = () => {
    if (instructionsDraft === null) return;
    setInstructionsDraft(null);
    if (instructionsDraft !== speech.instructions) {
      savePreferences({ responseSpeechInstructions: instructionsDraft.trim() });
    }
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
        {Platform.OS === "ios" ? (
          <SettingsSection title="Read aloud">
            <VoiceChoice
              label="Model"
              value={speech.model}
              options={Object.entries(SPEECH_MODELS).map(([id, { label }]) => ({
                id,
                title: label,
              }))}
              onSelect={(id) => savePreferences({ responseSpeechModel: id as SpeechModel })}
            />
            <VoiceChoice
              label="Voice"
              value={speech.voice}
              options={voice.voices.map(({ id, name }) => ({ id, title: name }))}
              onSelect={(voice) => savePreferences({ responseSpeechVoice: voice })}
            />
            <VoiceChoice
              label="Pace"
              value={String(speech.pace)}
              options={SPEECH_PACES.map((pace) => ({ id: String(pace), title: `${pace}×` }))}
              onSelect={(pace) =>
                savePreferences({ responseSpeechPace: Number(pace) as SpeechPace })
              }
            />
            {model.instructions ? (
              <View className="gap-2 p-4">
                <Text className="text-lg text-foreground">Delivery</Text>
                <TextInput
                  accessibilityLabel="Reading instructions"
                  multiline
                  onBlur={commitInstructions}
                  onChangeText={setInstructionsDraft}
                  value={instructionsDraft ?? speech.instructions}
                />
              </View>
            ) : null}
            {voice.voicesError ? (
              <Text className="px-4 text-sm text-foreground-muted">{voice.voicesError}</Text>
            ) : null}
            <Text className="px-4 pb-4 text-sm text-foreground-muted">
              {model.instructions ? "Describe how the voice should sound. " : ""}
              {model.voices === "account" ? "Voices come from your ElevenLabs account. " : ""}
              Reading with {model.label} uses the {speechProvider.label} API key and costs about{" "}
              {model.centsPerMinute} cents per minute of audio.
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
        <SettingsSection title="API keys">
          {(Object.keys(VOICE_API_KEYS) as VoiceApiKey[])
            // Android only transcribes; reading aloud is iOS-only.
            .filter(
              (key) =>
                Platform.OS === "ios" || VOICE_API_KEYS[key].provider in VOICE_TRANSCRIPTION_SOURCE_LABELS,
            )
            .map((key) => (
              <ApiKeyField key={key} slot={key} />
            ))}
        </SettingsSection>
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Keys stay in this device's keychain. Azure keys come from Speech resources in West US 2;
          the free F0 key is used until its monthly quota runs out, then the S0 key until it refills.
        </Text>
      </ScrollView>
    </View>
  );
}

function ApiKeyField({ slot }: { slot: VoiceApiKey }) {
  const { label, placeholder } = VOICE_API_KEYS[slot];
  const storedResult = useAtomValue(voiceApiKeyAtom(slot));
  const saveApiKey = useAtomSet(setVoiceApiKeyAtom(slot));
  const storedKey = AsyncResult.isSuccess(storedResult) ? storedResult.value : null;
  // A new key typed or pasted from scratch; the stored key is never edited in place.
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    if (draft.trim() !== "" && draft.trim() !== storedKey) saveApiKey(draft);
    setDraft("");
  };

  return (
    <View className="gap-2 p-4">
      <Text className="text-lg text-foreground">{label}</Text>
      <View className="flex-row items-center gap-3">
        <TextInput
          accessibilityLabel={`${label} API key`}
          autoCapitalize="none"
          autoCorrect={false}
          className="flex-1"
          editable={AsyncResult.isSuccess(storedResult)}
          onBlur={commitDraft}
          onChangeText={setDraft}
          onSubmitEditing={commitDraft}
          placeholder={storedKey ? maskApiKey(storedKey) : placeholder}
          // The masked stored key reads as the field's value; typing replaces it.
          placeholderTextColorClassName={storedKey ? "accent-foreground" : "accent-placeholder"}
          returnKeyType="done"
          value={draft}
        />
        {storedKey ? (
          <>
            <Pressable
              accessibilityLabel={`Copy ${label} API key`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => copyTextWithHaptic(storedKey, { target: `${label} API key` })}
            >
              <SymbolView
                name="doc.on.doc"
                size={18}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </Pressable>
            <Pressable
              accessibilityLabel={`Remove ${label} API key`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => confirmRemoveApiKey(label, () => saveApiKey(""))}
            >
              <SymbolView
                name="xmark.circle.fill"
                size={18}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

function confirmRemoveApiKey(label: string, onConfirm: () => void) {
  const title = `Remove ${label} API key?`;
  const message = "Copy it first if you don't have it saved elsewhere.";
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Remove", destructive: true, onConfirm });
}

/** Shows enough of a stored key to tell keys apart without revealing it. */
function maskApiKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "...";
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
