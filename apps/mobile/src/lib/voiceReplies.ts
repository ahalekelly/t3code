import { useEffect, useState } from "react";

import { isMicrophoneDevice, microphoneEntryKey, type MicrophoneEntry } from "./microphonePriority";
import { nativeSpeech, type AudioDevices } from "./nativeSpeech";
import type { VoiceReplyMode } from "./speechSettings";

export const bluetoothDevices = (audio: AudioDevices) =>
  audio.devices.map(({ id, name }) => ({ kind: "bluetooth" as const, uid: id, name }));

/** Selected devices are the CarPlay row and named Bluetooth rows with Read aloud on. */
export function readsVoiceReplies(
  mode: VoiceReplyMode,
  microphones: ReadonlyArray<MicrophoneEntry>,
  audio: AudioDevices,
): boolean {
  if (mode !== "selectedDevices") return mode === "always";
  const connected = new Set(bluetoothDevices(audio).map(microphoneEntryKey));
  return microphones.some(
    (entry) =>
      entry.readAloud === true &&
      (isMicrophoneDevice(entry)
        ? connected.has(microphoneEntryKey(entry))
        : entry.kind === "carPlay" && audio.carPlay),
  );
}

export function useAudioDevices(): AudioDevices {
  const [devices, setDevices] = useState(() => nativeSpeech().audioDevices());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows native audio route changes
  useEffect(() => {
    const subscription = nativeSpeech().addListener("onAudioDevicesChange", () =>
      setDevices(nativeSpeech().audioDevices()),
    );
    return () => subscription.remove();
  }, []);
  return devices;
}
