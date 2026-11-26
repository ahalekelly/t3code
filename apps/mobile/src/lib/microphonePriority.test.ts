import { describe, expect, it } from "vite-plus/test";

import {
  type MicrophoneEntry,
  microphoneDevices,
  microphoneEntryKey,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "./microphonePriority";

const iPhone = { uid: "Built-In Microphone", name: "iPhone Microphone", type: "MicrophoneBuiltIn" };
const airPods = { uid: "airpods", name: "Julius’s AirPods Pro", type: "BluetoothHFP" };
const bose = { uid: "bose", name: "Julius’s Bose QC", type: "BluetoothHFP" };
const civic = { uid: "civic", name: "Honda Civic", type: "BluetoothHFP" };
const carPlay = { uid: "carplay", name: "CarPlay", type: "CarAudio" };
const usb = { uid: "usb", name: "Shure MV7", type: "USBAudio" };

const keys = (order: ReadonlyArray<MicrophoneEntry>) => order.map(microphoneEntryKey);

describe("microphoneOrder", () => {
  it("keeps a saved order and files missing kinds after their devices", () => {
    const saved: MicrophoneEntry[] = [
      { kind: "builtIn" },
      { kind: "bluetooth", uid: "airpods", name: "AirPods" },
      { kind: "builtIn" },
    ];
    expect(keys(microphoneOrder(saved))).toEqual([
      "kind:wired",
      "kind:builtIn",
      "airpods",
      "kind:bluetooth",
      "kind:carPlay",
    ]);
    expect(keys(microphoneOrder([{ kind: "carPlay" }, ...saved], "android"))).toEqual([
      "kind:wired",
      "kind:builtIn",
      "airpods",
      "kind:bluetooth",
    ]);
  });
});

describe("rememberMicrophones", () => {
  it("lists a new device just above its kind and leaves built-in and CarPlay as kinds", () => {
    const order = microphoneOrder();
    expect(keys(rememberMicrophones(order, microphoneDevices([iPhone, carPlay, airPods])))).toEqual(
      ["kind:wired", "airpods", "kind:bluetooth", "kind:builtIn", "kind:carPlay"],
    );
  });

  it("refreshes renamed devices and returns the same order when nothing changed", () => {
    const order = rememberMicrophones(microphoneOrder(), microphoneDevices([airPods]));
    expect(rememberMicrophones(order, microphoneDevices([airPods, iPhone]))).toBe(order);

    const renamed = rememberMicrophones(
      order,
      microphoneDevices([{ ...airPods, name: "AirPods Max" }]),
    );
    expect(renamed.find((entry) => microphoneEntryKey(entry) === "airpods")).toEqual({
      kind: "bluetooth",
      uid: "airpods",
      name: "AirPods Max",
    });
  });

  it("treats a Bluetooth device's speaker and microphone as one device", () => {
    const civicSpeaker = { kind: "bluetooth" as const, uid: "AA:BB:CC:DD:EE:FF", name: "Civic" };
    const order = rememberMicrophones(microphoneOrder(), [{ ...civicSpeaker, readAloud: true }]);
    const civicMic = { uid: "AA:BB:CC:DD:EE:FF-tsco", name: "Civic", type: "BluetoothHFP" };
    expect(rememberMicrophones(order, microphoneDevices([civicMic]))).toBe(order);
    expect(preferredMicrophoneInput([civicMic], order)).toBe(civicMic);

    const androidMic = { uid: "android:7:AA:BB:CC:DD:EE:FF", name: "Civic", type: "BluetoothSCO" };
    const renamed = rememberMicrophones(
      order,
      microphoneDevices([{ ...androidMic, name: "Honda" }]),
    );
    expect(renamed.find((entry) => microphoneEntryKey(entry) === "AA:BB:CC:DD:EE:FF")).toEqual({
      ...civicSpeaker,
      name: "Honda",
      readAloud: true,
    });
  });
});

describe("preferredMicrophoneInput", () => {
  const order: MicrophoneEntry[] = [
    { kind: "builtIn" },
    { kind: "bluetooth", uid: "bose", name: bose.name },
    { kind: "wired" },
    { kind: "bluetooth" },
    { kind: "bluetooth", uid: "airpods", name: airPods.name },
    { kind: "carPlay" },
  ];

  it("ranks unlisted devices of a kind at that kind, ahead of a device listed below it", () => {
    expect(preferredMicrophoneInput([airPods, civic], order)).toBe(civic);
    expect(preferredMicrophoneInput([airPods, bose], order)).toBe(bose);
    expect(preferredMicrophoneInput([airPods, usb], order)).toBe(usb);
    expect(preferredMicrophoneInput([airPods, carPlay], order)).toBe(airPods);
    expect(preferredMicrophoneInput([airPods, iPhone], order)).toBe(iPhone);
    const headset = { uid: "android:7:headset", name: "Headset", type: "BluetoothSCO" };
    expect(preferredMicrophoneInput([headset, iPhone], microphoneOrder([], "android"))).toBe(
      headset,
    );
  });
});
