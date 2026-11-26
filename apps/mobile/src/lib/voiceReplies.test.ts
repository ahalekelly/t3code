import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./nativeSpeech", () => ({}));

import type { MicrophoneEntry } from "./microphonePriority";
import { readsVoiceReplies } from "./voiceReplies";

const civic = { id: "AA:BB:CC:DD:EE:FF", name: "Civic" };
const airPods = { id: "11:22:33:44:55:66", name: "AirPods" };

describe("readsVoiceReplies", () => {
  const microphones: MicrophoneEntry[] = [
    { kind: "bluetooth", uid: "AA:BB:CC:DD:EE:FF-tsco", name: "Civic", readAloud: true },
    { kind: "bluetooth", uid: "11:22:33:44:55:66-tsco", name: "AirPods" },
    { kind: "carPlay", readAloud: true },
  ];
  const reads = (audio: { carPlay: boolean; devices: (typeof civic)[] }) =>
    readsVoiceReplies("selectedDevices", microphones, audio);

  it("reads on selected devices only while one is connected", () => {
    expect(reads({ carPlay: false, devices: [airPods, civic] })).toBe(true);
    expect(reads({ carPlay: true, devices: [] })).toBe(true);
    expect(reads({ carPlay: false, devices: [airPods] })).toBe(false);
    expect(readsVoiceReplies("always", [], { carPlay: false, devices: [] })).toBe(true);
    expect(readsVoiceReplies("never", microphones, { carPlay: true, devices: [civic] })).toBe(
      false,
    );
  });
});
