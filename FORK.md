# Adrian's T3 Code fork

`ahalekelly/t3code` is T3 Code plus a stack of branches, released to Adrian's machines by CI. Agents do all development; everything below runs headlessly on akelly-desktop or in GitHub Actions.

## How `main` is built

Never commit to `main`; it is generated.

- The manifest, `~/.agents/linux/t3-main.txt`, names an upstream tag and the origin branches merged onto it in order. `fork/*` branches are fork-only; the rest can become upstream PRs. `AGENTS.md` has the rules for branches and worktrees.
- `~/.agents/linux/t3-fork-main.py`, run every 10 minutes by `t3-fork-main.timer` on akelly-desktop, rebuilds `main` when a branch or the manifest changes, checks it with a frozen-lockfile install and the mobile typecheck, and force-pushes it. Its docstring covers conflicts and the commands:
  - `ship [<branch> <parent>...]` rebuilds `main` now, adding a new branch to the manifest when given one.
  - `rebase <upstream tag>` moves every branch onto a new upstream release.
- Work in your own worktree (`git -C ~/Git/t3code worktree add ...`), never in `~/Git/t3code`, which the timer owns.
- Install with `pnpm_config_minimum_release_age=1440 npx corepack pnpm install`. akelly-desktop has no global `vp`, so put the worktree's `node_modules/.bin` on `PATH`.

## Releases

Each push to `main` runs `.github/workflows/fork-release.yml`: tests, then the Linux CLI archive, macOS and Windows apps, and a GitHub release versioned `<next upstream patch>-fork.<run number>`. This run is the fork's test gate. `ship` and `rebase` wait for it and print its failed jobs and tests; the timer opens a T3 thread for runs no command waited on. `fork-branch-checks.yml` also lints and typechecks each non-`fork/*` branch tip `main` merges, so a branch shows whether it is ready to open upstream.

The macOS app is signed and notarized with Adrian's Developer ID certificate, which expires 2027-02-01. It lacks passkeys, which need an Associated Domains provisioning profile for upstream's bundle ID.

Roll a machine back with `t3 update <version> --allow-downgrade`. For an upstream version, set `T3CODE_RELEASE_BASE_URL=https://github.com/pingdotgg/t3code/releases/download`.

## Dev workflow

Iterate against dev builds on akelly-desktop; releases are for using the fork. Never touch the production service on port 3773 or `~/.t3/userdata`. Stop what you start by the PID or unit you started.

### Server and web

`vp run dev` in your worktree (see `AGENTS.md` and `docs/operations/development.md`). State lives in the worktree's `.t3`, and the `[dev-runner]` line prints the ports. Drive the web client with browser-swarm or Playwright.

### Desktop app

Electron runs under Xvfb and exposes Chrome DevTools Protocol for Playwright. Seed a scratch home with the launch-check fixture, or copy real data as `AGENTS.md` describes:

```sh
home=$(mktemp -d) && mkdir -p "$home/userdata"
cp scripts/fixtures/desktop-launch/statev2.sqlite "$home/userdata/"
T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=9333 setsid xvfb-run -a -s "-screen 0 1440x900x24" \
  vp run dev:desktop --home-dir "$home" > desktop.log 2>&1 & echo $! > desktop.pid
```

Then, from `apps/desktop` (which depends on `playwright-core`):

```sh
node --input-type=module -e '
import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith("t3code-dev:"));
await page.locator("li[data-thread-item]").first().click();
await page.screenshot({ path: "/tmp/desktop.png" });
await browser.close();'
```

Main-process and renderer edits reload in place. Stop it with `kill -- -$(cat desktop.pid)`, which ends its whole process group.

### Android emulator

`~/.agents/linux/android-emulator.sh start` boots a headless emulator (AVD `t3-dev`, API 36, KVM) in about 30 seconds. It holds about 3 GB that agents share, so run `stop` when done. Then install the development client and open it on Metro:

```sh
vp run mobile:install android   # rebuilds (~8 min) only when native code changed
cd apps/mobile
APP_VARIANT=development setsid vp exec expo start --dev-client --localhost --port 8090 > metro.log 2>&1 & echo $! > metro.pid
adb reverse tcp:8090 tcp:8090
adb shell am start -a android.intent.action.VIEW -d "t3code-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8090"
```

Metro's default port, 8081, is taken on akelly-desktop. Stop Metro with `kill -- -$(cat metro.pid)`. The first launch opens Expo's developer menu; close it with `adb shell input keyevent KEYCODE_BACK`. Capture the screen with `adb exec-out screencap -p > shot.png`, read the UI tree with `adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml`, tap with `adb shell input tap <x> <y>`, and read logs with `adb logcat`. The app reaches a dev server on the host at `10.0.2.2:<port>`. After a build, `./gradlew --stop` in `apps/mobile/android` frees the Gradle daemon's 4 GB.

### Apple-only behavior

Widgets, Live Activities, the share extension, and push need iOS. `fork-ios-check.yml` builds any ref's development client for the iOS simulator on GitHub's `macos-26` runner, opens it on Metro, runs an optional flow, and uploads screenshots, UI trees, and Metro and device logs. A run takes about 11 minutes, or 40 when native code changed since the last cached client, so use it as a final check.

```sh
gh workflow run fork-ios-check.yml -R ahalekelly/t3code -f ref=<branch> -f flow='
axe tap --label "Add environment" --udid "$UDID"
xcrun simctl io "$UDID" screenshot "$ARTIFACTS/add-environment.png"'
gh run watch -R ahalekelly/t3code <run id>
gh run download -R ahalekelly/t3code <run id> -D /tmp/ios-check
```

The flow is Bash that starts on the app's home screen, with `$UDID`, `$ARTIFACTS`, `xcrun simctl`, and [AXe](https://github.com/cameroncooke/AXe) available. `axe describe-ui --udid "$UDID"` prints the UI tree with each element's label. Expo builds with Xcode 27, which GitHub's runners lack; their Xcode 26.6 still compiles the app, but suspect that gap first when a native build fails there.
