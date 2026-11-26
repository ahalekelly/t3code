const MICROPHONE_KINDS = ["wired", "bluetooth", "builtIn", "carPlay"] as const;

export type MicrophoneKind = (typeof MICROPHONE_KINDS)[number];

export interface MicrophoneDevice {
  readonly kind: MicrophoneKind;
  readonly uid: string;
  readonly name: string;
  readonly readAloud?: boolean;
}

export type MicrophoneEntry =
  | { readonly kind: MicrophoneKind; readonly readAloud?: boolean }
  | MicrophoneDevice;

interface MicrophoneInput {
  readonly uid: string;
  readonly name: string;
  readonly type: string;
}

// A car without CarPlay, and Android Auto, routes its microphone over Bluetooth, so it is a Bluetooth device.
const KIND_BY_PORT_TYPE: Readonly<Record<string, MicrophoneKind>> = {
  MicrophoneWired: "wired",
  USBAudio: "wired",
  LineIn: "wired",
  BluetoothHFP: "bluetooth",
  BluetoothSCO: "bluetooth",
  BluetoothLE: "bluetooth",
  MicrophoneBuiltIn: "builtIn",
  CarAudio: "carPlay",
};

const DEVICE_KINDS: ReadonlySet<MicrophoneKind> = new Set(["wired", "bluetooth"]);

const rank = (kind: MicrophoneKind) => MICROPHONE_KINDS.indexOf(kind);

// iOS suffixes a Bluetooth port UID with its profile (-tsco, -tacl) and Android prefixes its
// device type, so one device's microphone and speaker share the address between.
const deviceKey = (kind: MicrophoneKind | undefined, uid: string) =>
  kind === "bluetooth" ? uid.replace(/^android:\d+:/, "").replace(/-[^-:]*$/, "") : uid;

const inputKey = (input: MicrophoneInput) => deviceKey(KIND_BY_PORT_TYPE[input.type], input.uid);

export function isMicrophoneKind(value: unknown): value is MicrophoneKind {
  return (MICROPHONE_KINDS as ReadonlyArray<unknown>).includes(value);
}

export function isMicrophoneDevice(entry: MicrophoneEntry): entry is MicrophoneDevice {
  return "uid" in entry;
}

export function microphoneEntryKey(entry: MicrophoneEntry): string {
  return isMicrophoneDevice(entry) ? deviceKey(entry.kind, entry.uid) : `kind:${entry.kind}`;
}

export function microphoneOrder(
  saved: ReadonlyArray<MicrophoneEntry> = [],
  platform: "ios" | "android" = "ios",
): ReadonlyArray<MicrophoneEntry> {
  const kinds = MICROPHONE_KINDS.filter((kind) => platform === "ios" || kind !== "carPlay");
  const order: MicrophoneEntry[] = [];
  const keys = new Set<string>();
  for (const entry of saved) {
    if (!kinds.includes(entry.kind)) continue;
    const row =
      isMicrophoneDevice(entry) && DEVICE_KINDS.has(entry.kind)
        ? entry
        : { kind: entry.kind, readAloud: entry.readAloud };
    const key = microphoneEntryKey(row);
    if (keys.has(key)) continue;
    keys.add(key);
    order.push(row);
  }
  for (const kind of kinds) {
    if (keys.has(`kind:${kind}`)) continue;
    const lastDevice = order.map((entry) => entry.kind).lastIndexOf(kind);
    const below = order.findIndex(
      (entry) => !isMicrophoneDevice(entry) && rank(entry.kind) > rank(kind),
    );
    order.splice(lastDevice !== -1 ? lastDevice + 1 : below !== -1 ? below : order.length, 0, {
      kind,
    });
  }
  return order;
}

export function microphoneDevices(
  inputs: ReadonlyArray<MicrophoneInput>,
): ReadonlyArray<MicrophoneDevice> {
  return inputs.flatMap((input) => {
    const kind = KIND_BY_PORT_TYPE[input.type];
    return kind && DEVICE_KINDS.has(kind) ? [{ kind, uid: input.uid, name: input.name }] : [];
  });
}

export function rememberMicrophones(
  order: ReadonlyArray<MicrophoneEntry>,
  devices: ReadonlyArray<MicrophoneDevice>,
): ReadonlyArray<MicrophoneEntry> {
  let next: MicrophoneEntry[] | null = null;
  for (const device of devices) {
    const current = next ?? order;
    const key = microphoneEntryKey(device);
    const index = current.findIndex((entry) => microphoneEntryKey(entry) === key);
    const existing = current[index];
    if (existing && isMicrophoneDevice(existing) && existing.name === device.name) continue;
    next ??= [...order];
    if (existing) {
      next[index] = { ...existing, name: device.name };
      continue;
    }
    const kindRow = next.findIndex((entry) => microphoneEntryKey(entry) === `kind:${device.kind}`);
    next.splice(kindRow === -1 ? next.length : kindRow, 0, device);
  }
  return next ?? order;
}

/** The connected input of the first entry that has one, or null for the system default. */
export function preferredMicrophoneInput<Input extends MicrophoneInput>(
  inputs: ReadonlyArray<Input>,
  order: ReadonlyArray<MicrophoneEntry>,
): Input | null {
  const listed = new Set(order.filter(isMicrophoneDevice).map(microphoneEntryKey));
  for (const entry of order) {
    const input = inputs.find((candidate) =>
      isMicrophoneDevice(entry)
        ? inputKey(candidate) === microphoneEntryKey(entry)
        : KIND_BY_PORT_TYPE[candidate.type] === entry.kind && !listed.has(inputKey(candidate)),
    );
    if (input) return input;
  }
  return null;
}
