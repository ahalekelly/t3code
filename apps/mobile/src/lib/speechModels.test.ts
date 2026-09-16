import { describe, expect, it } from "vite-plus/test";
import { getSpeechOptions, validateSpeechSettings, type SpeechPreferences } from "./speechModels";

describe("speech settings", () => {
  it("retains each model's voice, pace, and quality when switching models", () => {
    const preferences: SpeechPreferences = {
      responseSpeechSettings: {
        pocket: { voice: "Marius", pace: 0.75, quality: "high" },
        supertonic: { voice: "M3", pace: 1.5, quality: "fast" },
      },
    };
    expect(getSpeechOptions(preferences)).toEqual({
      model: "pocket",
      voice: "Marius",
      pace: 0.75,
      quality: "high",
    });
    expect(getSpeechOptions({ ...preferences, responseSpeechModel: "supertonic" })).toEqual({
      model: "supertonic",
      voice: "M3",
      pace: 1.5,
      quality: "fast",
    });
    expect(getSpeechOptions({ responseSpeechModel: "supertonic" })).toEqual({
      model: "supertonic",
      voice: "F1",
      pace: 1,
      quality: "balanced",
    });
  });

  it("rejects a voice from the wrong model and invalid generation controls", () => {
    const valid = { voice: "F5", pace: 1.25, quality: "high" };
    expect(validateSpeechSettings("supertonic", valid)).toEqual(valid);
    for (const value of [
      null,
      {},
      { ...valid, voice: "Alba" },
      { ...valid, pace: NaN },
      { ...valid, pace: 0 },
      { ...valid, pace: 3 },
      { ...valid, quality: "ultra" },
    ]) {
      expect(() => validateSpeechSettings("supertonic", value)).toThrow("Invalid voice settings");
    }
  });
});
