import { useEffect, useState } from "react";

import { nativeSpeech, type AudioDevice, type AudioDevices } from "./nativeSpeech";

export type VoiceReplyMode = "always" | "inCar" | "never";

export function isVoiceReplyMode(value: unknown): value is VoiceReplyMode {
  return value === "always" || value === "inCar" || value === "never";
}

/** "In the car" means CarPlay, Android Auto, or a connected Bluetooth device the user picked. */
export function readsVoiceReplies(
  mode: VoiceReplyMode,
  carAudioDevices: readonly AudioDevice[],
  audio: AudioDevices,
): boolean {
  if (mode !== "inCar") return mode === "always";
  return (
    audio.car || audio.devices.some(({ id }) => carAudioDevices.some((saved) => saved.id === id))
  );
}

export function useAudioDevices(): AudioDevices {
  const [devices, setDevices] = useState(() => nativeSpeech().audioDevices());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows native audio route and Android Auto changes
  useEffect(() => {
    const subscription = nativeSpeech().addListener("onAudioDevicesChange", () =>
      setDevices(nativeSpeech().audioDevices()),
    );
    return () => subscription.remove();
  }, []);
  return devices;
}
