import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import plist from "@expo/plist";
import { describe, expect, it } from "vitest";
import withIosSideloadSigning from "./withIosSideloadSigning.cjs";

async function apply(config, name, modResults, root) {
  return config.mods.ios[name]({
    ...config,
    modRequest: { platform: "ios", modName: name, introspect: false, platformProjectRoot: root },
    modResults,
  });
}

const config = () => ({ name: "Test", slug: "test", ios: { bundleIdentifier: "com.example.t3" } });
const entitlements = {
  "aps-environment": "production",
  "com.apple.developer.applesignin": ["Default"],
  "com.apple.security.application-groups": ["group.com.example.t3"],
};

describe("iOS sideload signing", () => {
  it("omits capabilities that Xcode cannot provision for a Personal Team", async () => {
    const result = await apply(withIosSideloadSigning(config(), {}), "entitlements", {
      ...entitlements,
    });
    expect(result.modResults).toEqual({});
  });

  it("retains unsigned groups for SideStore and points both processes at the signed group", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sidestore-test-"));
    const target = NodePath.join(root, "ExpoWidgetsTarget");
    NodeFS.mkdirSync(target);
    const file = NodePath.join(target, "Info.plist");
    NodeFS.writeFileSync(
      file,
      plist.build({ ExpoWidgetsAppGroupIdentifier: "group.com.example.t3" }),
    );
    const generated = withIosSideloadSigning(config(), { sideStoreTeam: "0123456789" });
    const result = await apply(generated, "entitlements", { ...entitlements });
    expect(result.modResults).toEqual({
      "com.apple.security.application-groups": ["group.com.example.t3"],
    });
    const info = await apply(generated, "infoPlist", {});
    await apply(generated, "dangerous", {}, root);
    const widget = plist.parse(NodeFS.readFileSync(file, "utf8"));
    expect(info.modResults.ExpoWidgetsAppGroupIdentifier).toBe("group.com.example.t3.0123456789");
    expect(widget.ExpoWidgetsAppGroupIdentifier).toBe(
      info.modResults.ExpoWidgetsAppGroupIdentifier,
    );
  });
});
