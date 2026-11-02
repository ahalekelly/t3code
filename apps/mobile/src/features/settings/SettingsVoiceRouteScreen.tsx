import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { useState } from "react";
import { Linking, Platform, Pressable, useWindowDimensions, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useVoiceSettings } from "../../state/voiceSettings";
import { setVoiceApiKeyAtom, voiceApiKeyAtom } from "../../state/voiceApiKeys";
import {
  CLOUD_TRANSCRIPTION_SOURCES,
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
import { cn } from "../../lib/cn";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  isMicrophoneDevice,
  type MicrophoneEntry,
  type MicrophoneKind,
  microphoneEntryKey,
} from "../../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import {
  chooseVoiceDestination,
  cloudVoiceConnectionAtom,
  voiceConnectionAtom,
  voiceGrantAtom,
  hasEnvironmentVoiceCapture,
} from "../voice-input/voiceDestination";
import { LocalModelChoice } from "./VoiceModelSection";
import { CloudVoiceChoice } from "./CloudVoiceSection";
import type { VoiceGrant } from "../voice-input/voiceGrantStorage";
import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsDragHandle } from "./components/SettingsDragHandle";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  deviceMicrophoneOrder,
  localVoiceTranscriberAtom,
} from "../voice-input/VoiceInputProvider";

type MicrophonePermission = "checking" | "granted" | "ask" | "denied";

function toMicrophonePermission(response: {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}): MicrophonePermission {
  return response.granted ? "granted" : response.canAskAgain ? "ask" : "denied";
}

const readMicrophonePermission = () =>
  getRecordingPermissionsAsync().then(toMicrophonePermission, (): MicrophonePermission => "ask");

const microphonePermissionAtom = makePermissionStatusAtom<MicrophonePermission>({
  label: "mobile:microphone-permission",
  initial: "checking",
  read: readMicrophonePermission,
});

function useMicrophonePermission() {
  const permission = useAtomValue(microphonePermissionAtom);
  const setPermission = useAtomSet(microphonePermissionAtom);
  const request = () =>
    void requestRecordingPermissionsAsync()
      .then(toMicrophonePermission, readMicrophonePermission)
      .then(setPermission);
  return { permission, request };
}

const KINDS: Record<
  MicrophoneKind,
  {
    readonly label: string;
    readonly row: string;
    readonly rowDescription: string;
    readonly icon: AppSymbolName;
  }
> = {
  wired: {
    label: "Wired",
    row: "Other wired",
    rowDescription: "Headsets and USB microphones not listed here",
    icon: "cable.connector",
  },
  bluetooth: {
    label: "Bluetooth",
    row: "Other Bluetooth",
    rowDescription:
      Platform.OS === "android"
        ? "Earbuds, headsets, and cars, including Android Auto, not listed here"
        : "AirPods, headsets, and cars not listed here",
    icon: "headphones",
  },
  builtIn: {
    label: "Built-in",
    row: "Built-in microphone",
    rowDescription: "The microphone on this device",
    icon: "iphone",
  },
  carPlay: {
    label: "CarPlay",
    row: "CarPlay",
    rowDescription: "The car’s microphone",
    icon: "car",
  },
};

const UNAVAILABLE_EXPLANATION =
  Platform.OS === "android"
    ? "Dictation on this device needs Android 12 or later and Google speech services that support your language. Your keyboard’s voice typing is separate."
    : "Dictation on this device needs iOS 26 or later, a supported device, and a supported language. Your keyboard’s dictation is separate.";

function saveDestination(id: EnvironmentId | null) {
  try {
    chooseVoiceDestination(id);
  } catch {
    Dialog.alert(
      "Could not save transcription choice",
      "Dictation on an environment is off for this session. Save again before closing the app, or your previous choice may return when it restarts.",
    );
  }
}

function EnvironmentChoice({
  environment,
  selected,
  onCloudOnly,
}: {
  environment: EnvironmentPresentation;
  selected: boolean;
  /** Called instead of a local grant when the environment only offers cloud transcription. */
  onCloudOnly: () => void;
}) {
  const local = useAtomValue(voiceConnectionAtom(environment.environmentId)) !== null;
  const cloud = useAtomValue(cloudVoiceConnectionAtom(environment.environmentId)) !== null;
  const usable = local || cloud;
  return (
    <ListChoiceRow
      label={environment.label}
      selected={selected}
      disabled={!usable}
      description={
        environment.connection.phase !== "connected"
          ? "Not connected"
          : !usable
            ? "Transcription unavailable"
            : (environment.displayUrl ?? "Send finished recordings to this environment.")
      }
      separated
      onPress={() => {
        if (selected) return;
        if (!local) return onCloudOnly();
        Dialog.confirm({
          title: `Send microphone audio to ${environment.label}?`,
          message: `Finished recordings will be sent to ${environment.displayUrl ?? environment.label} for transcription. You can switch back to This device at any time.`,
          confirmText: "Use environment",
          onConfirm: () => saveDestination(environment.environmentId),
        });
      }}
    />
  );
}

/** How the selected environment transcribes: its own model or a cloud provider. */
function EnvironmentMethodSection({
  environment,
  grant,
  cloudOpen,
  onCloudOpenChange,
}: {
  environment: EnvironmentPresentation;
  grant: VoiceGrant | null;
  cloudOpen: boolean;
  onCloudOpenChange: (open: boolean) => void;
}) {
  const id = environment.environmentId;
  const destination = grant?.destination.environmentId === id ? grant.destination : null;
  const cloudCapable =
    environment.serverConfig?.environment.capabilities.cloudVoiceTranscription === true ||
    destination?.kind === "cloud";
  return (
    <SettingsSection title={`Method on ${environment.label}`}>
      <LocalModelChoice
        environmentId={id}
        label={environment.label}
        selected={destination?.kind === "environment"}
        // The user already agreed to send audio to this environment.
        onSelect={() => saveDestination(id)}
      />
      {cloudCapable ? (
        <CloudVoiceChoice
          environment={environment}
          active={destination?.kind === "cloud" ? destination : null}
          open={cloudOpen}
          onOpenChange={onCloudOpenChange}
        />
      ) : null}
    </SettingsSection>
  );
}

export function SettingsVoiceRouteScreen() {
  const transcriber = useAtomValue(localVoiceTranscriberAtom);
  const grant = useAtomValue(voiceGrantAtom);
  const { environments, isReady } = useEnvironments();
  const grantEnvironment = grant
    ? environments.find(
        (environment) => environment.environmentId === grant.destination.environmentId,
      )
    : undefined;
  // An environment whose cloud sheet is open; it may not hold the grant yet.
  const [cloudSheet, setCloudSheet] = useState<EnvironmentId | null>(null);
  // A sheet whose environment lost cloud transcription is gone, so its pending choice is too.
  const sheetEnvironment = environments.find(
    (environment) =>
      environment.environmentId === cloudSheet &&
      environment.serverConfig?.environment.capabilities.cloudVoiceTranscription === true,
  );
  const methodEnvironment = sheetEnvironment ?? grantEnvironment;
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const entries = deviceMicrophoneOrder(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value.microphones : undefined,
  );
  const { permission, request: requestPermission } = useMicrophonePermission();
  const [drag, setDrag] = useState<{ readonly key: string; readonly translation: number } | null>(
    null,
  );
  const [rowHeight, setRowHeight] = useState(0);
  // Each drop remounts the rows so the new order and the cleared offsets land in one frame.
  const [drops, setDrops] = useState(0);

  // Transforms apply to the stored order, so a device recorded meanwhile is kept.
  const move = (key: string, steps: number) =>
    savePreferences({
      transform: (current) => {
        const next = [...deviceMicrophoneOrder(current.microphones)];
        const from = next.findIndex((entry) => microphoneEntryKey(entry) === key);
        const to = Math.min(next.length - 1, Math.max(0, from + steps));
        if (from === -1 || from === to) return {};
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved!);
        return { microphones: next };
      },
    });
  const forget = (key: string) =>
    savePreferences({
      transform: (current) => ({
        microphones: deviceMicrophoneOrder(current.microphones).filter(
          (entry) => microphoneEntryKey(entry) !== key,
        ),
      }),
    });
  const dropSteps = (from: number, translation: number) =>
    rowHeight === 0
      ? 0
      : Math.min(entries.length - 1, Math.max(0, from + Math.round(translation / rowHeight))) -
        from;

  const dragFrom =
    drag === null ? -1 : entries.findIndex((entry) => microphoneEntryKey(entry) === drag.key);
  const dragTo = drag === null ? -1 : dragFrom + dropSteps(dragFrom, drag.translation);

  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  const voice = useVoiceSettings();
  const { preferences, speech } = voice;
  const source = grant ? null : voice.transcriptionSource;
  const chooseSource = (next: VoiceTranscriptionSource) => {
    if (grant) saveDestination(null);
    savePreferences({ voiceTranscriptionSource: next });
  };
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
    <SettingsScreen title="Voice">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Transcribe on">
          <ListChoiceRow
            label="This device"
            description="Audio stays on this device and is transcribed here."
            selected={source === "local" && !sheetEnvironment}
            onPress={() => {
              setCloudSheet(null);
              chooseSource("local");
            }}
          />
          {CLOUD_TRANSCRIPTION_SOURCES.map((cloud) => (
            <ListChoiceRow
              key={cloud}
              label={VOICE_TRANSCRIPTION_SOURCE_LABELS[cloud]}
              description={`Recordings upload to ${VOICE_API_PROVIDERS[cloud].label} with its API key below.`}
              selected={source === cloud && !sheetEnvironment}
              separated
              onPress={() => {
                setCloudSheet(null);
                chooseSource(cloud);
              }}
            />
          ))}
          {hasEnvironmentVoiceCapture &&
            environments.map((environment) => (
              <EnvironmentChoice
                key={environment.environmentId}
                environment={environment}
                selected={
                  sheetEnvironment
                    ? sheetEnvironment.environmentId === environment.environmentId
                    : grant?.destination.environmentId === environment.environmentId
                }
                onCloudOnly={() => setCloudSheet(environment.environmentId)}
              />
            ))}
          {isReady && grant && !grantEnvironment ? (
            <ListChoiceRow
              label="Previously selected environment"
              description="No longer paired"
              separated
              selected
              disabled
              onPress={() => {}}
            />
          ) : null}
        </SettingsSection>
        {hasEnvironmentVoiceCapture && methodEnvironment ? (
          <EnvironmentMethodSection
            environment={methodEnvironment}
            grant={grant}
            cloudOpen={cloudSheet === methodEnvironment.environmentId}
            onCloudOpenChange={(open) =>
              setCloudSheet(open ? methodEnvironment.environmentId : null)
            }
          />
        ) : null}
        {source === "local" && transcriber === null ? (
          <Text className="px-2 text-sm text-foreground-muted">{UNAVAILABLE_EXPLANATION}</Text>
        ) : null}
        {permission === "ask" || permission === "denied" ? (
          <>
            <SettingsSection title="Microphone access">
              <SettingsActionRow
                icon="mic"
                label={permission === "ask" ? "Allow microphone access" : "Open Settings"}
                onPress={
                  permission === "ask" ? requestPermission : () => void Linking.openSettings()
                }
              />
            </SettingsSection>
            <Text className="px-2 text-sm text-foreground-muted">
              {permission === "ask"
                ? "Allow microphone access to record and to see your microphones."
                : "Turn on microphone access for T3 Code in Settings to use voice input."}
            </Text>
          </>
        ) : null}
        <SettingsSection title="Preferred order">
          {entries.map((entry, index) => {
            const key = microphoneEntryKey(entry);
            const shift =
              dragFrom === -1 || index === dragFrom
                ? 0
                : dragFrom < dragTo && index > dragFrom && index <= dragTo
                  ? -rowHeight
                  : dragFrom > dragTo && index < dragFrom && index >= dragTo
                    ? rowHeight
                    : 0;
            return (
              <MicrophoneRow
                key={`${key}:${drops}`}
                entry={entry}
                position={index + 1}
                count={entries.length}
                reorderable={ready}
                offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
                lifted={index === dragFrom}
                onHeight={setRowHeight}
                onDragStart={() => setDrag({ key, translation: 0 })}
                onDragMove={(translation) => setDrag({ key, translation })}
                onDragEnd={(translation, cancelled) => {
                  setDrag(null);
                  setDrops((count) => count + 1);
                  if (!cancelled) move(key, dropSteps(index, translation));
                }}
                onStep={(direction) => move(key, direction === "up" ? -1 : 1)}
                onForget={isMicrophoneDevice(entry) ? () => forget(key) : undefined}
              />
            );
          })}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Voice input uses the first connected microphone in this list. A wired or Bluetooth
          microphone is added by name the first time you dictate with it connected; until then it
          falls under Other. Swipe left on a named microphone to forget it.
          {Platform.OS === "android"
            ? " Android may still use a different microphone if the preferred one can’t be routed."
            : null}
        </Text>
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
            onSelect={(pace) => savePreferences({ responseSpeechPace: Number(pace) as SpeechPace })}
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
        <SettingsSection title="API keys">
          {(Object.keys(VOICE_API_KEYS) as VoiceApiKey[]).map((key) => (
            <ApiKeyField key={key} slot={key} />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Keys stay in this device's secure storage. Azure keys come from Speech resources in West
          US 2; the free F0 key is used until its monthly quota runs out, then the S0 key until it
          refills.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}

function MicrophoneRow(props: {
  readonly entry: MicrophoneEntry;
  readonly position: number;
  readonly count: number;
  readonly reorderable: boolean;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
  readonly onForget: (() => void) | undefined;
}) {
  const { lifted, offset, entry, onForget } = props;
  const kind = KINDS[entry.kind];
  const title = isMicrophoneDevice(entry) ? entry.name : kind.row;
  const { width: windowWidth } = useWindowDimensions();
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  const row = (
    // Opaque so the swipe actions stay hidden until the row slides over them.
    <View className="flex-row items-center bg-grouped-card">
      <View
        accessible
        accessibilityLabel={`${title}, ${kind.label}, ${props.position} of ${props.count}`}
        accessibilityActions={onForget ? [{ name: "forget", label: "Forget" }] : undefined}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === "forget") onForget?.();
        }}
        className="min-w-0 flex-1"
      >
        <ListRowLayout
          icon={kind.icon}
          label={title}
          description={isMicrophoneDevice(entry) ? kind.label : kind.rowDescription}
        />
      </View>
      {props.reorderable ? (
        <SettingsDragHandle
          title={title}
          canMoveUp={props.position > 1}
          canMoveDown={props.position < props.count}
          onStart={props.onDragStart}
          onMove={props.onDragMove}
          onEnd={props.onDragEnd}
          onStep={props.onStep}
        />
      ) : null}
    </View>
  );
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn(
        props.position > 1 && !lifted && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
      )}
    >
      {onForget ? (
        <ThreadSwipeable
          backgroundColor="transparent"
          fullSwipeAction="primary"
          fullSwipeWidth={windowWidth - 40}
          onDelete={onForget}
          primaryAction={{
            accessibilityLabel: `Forget ${title}`,
            destructive: true,
            icon: "trash",
            label: "Forget",
            onPress: onForget,
          }}
          secondaryAction={null}
          threadKey={`microphone:${microphoneEntryKey(entry)}`}
          threadTitle={title}
        >
          {() => row}
        </ThreadSwipeable>
      ) : (
        row
      )}
    </Reanimated.View>
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
  Dialog.confirm({ title, message, confirmText: "Remove", destructive: true, onConfirm });
}

function maskApiKey(key: string): string {
  return key.length > 24 ? `${key.slice(0, 8)}...${key.slice(-8)}` : "...";
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
      <Menu
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
      </Menu>
    </View>
  );
}
