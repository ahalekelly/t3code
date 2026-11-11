# Adrian's T3 Code fork

`ahalekelly/t3code` is T3 Code plus a stack of branches, released to Adrian's machines by CI. Agents do all development; everything below runs headlessly on akelly-desktop or in GitHub Actions.

## How `main` is built

Never commit to `main`; it is generated.

- The manifest, `~/.agents/linux/t3-main.txt` on akelly-desktop, names an upstream release tag and the origin branches merged onto it in order. Other machines' copies update only when their `~/.agents` syncs. `fork/*` branches are fork-only; the rest can become upstream PRs. `AGENTS.md` has the rules for branches and worktrees.
- `~/.agents/linux/t3-fork-main.py`, run every 10 minutes by `t3-fork-main.timer` on akelly-desktop, rebuilds `main` when a branch or the manifest changes, and moves the manifest onto each new upstream release when `main` rebuilds on it cleanly. It checks each rebuild with a frozen-lockfile install and the mobile typecheck, and force-pushes it after the manifest's upstream tag, which the workflows read from this repository. Its docstring covers conflicts and the commands:
  - `ship [<branch> <parent>...]` rebuilds `main` now, adding a new branch to the manifest when given one.
  - `rebase <upstream tag>` restacks every branch onto an upstream tag and drops the ones upstream merged.
- Work in your own worktree, never in `~/Git/t3code`, which the timer owns. Create it with `git -C ~/Git/t3code worktree add ../t3code-<name> ...` and run commands that write there with the sandbox disabled, since the Bash sandbox writes only your session's directory. Join `cd` and later commands with `&&`, not `;`, so a failed step can't run the rest in the timer's checkout.
- Install with `pnpm_config_minimum_release_age=1440 npx corepack pnpm install`. akelly-desktop has no global `vp`, so put the worktree's `node_modules/.bin` on `PATH`.

## Releases

Each push to `main` runs `.github/workflows/fork-release.yml`, versioned `<next upstream patch>-akelly-<run number>`. It always runs the tests, then publishes only the builds whose code changed since their last release: the Linux CLI archive and Linux and Windows apps as the Latest release `v<version>`, and an Android APK (`fork-android-apk.yml`) as `android-<version>`. A build counts as changed when a file differs from its last release's tree in its packages or their dependencies; changes outside any package count for all of them, and Markdown counts for none. This run is the fork's test gate. `ship` and `rebase` wait until its "Tests passed" job passes and print any failed jobs and tests; the timer opens a T3 thread when a build of the newest `main` fails after that, or for a run no command waited on. A newer `main` replaces a run still waiting to start, never a running one.

When a whole release run succeeds, `fork-mac-release.yml` builds that revision's macOS app as `mac-<version>`, from the gate's version and JS bundle, and `fork-ios-release.yml` builds its ad hoc iPhone IPA (`fork-ios-ipa.yml`) as `ios-<version>`. GitHub's macOS runners are scarce, often for hours, so nothing waits for these builds. Each app has its own queue, where a newer `main` never cancels a running build; it replaces only a waiting one. The timer keeps rerunning the newest run's jobs that got no runner, and opens a T3 thread when that run fails or has gone 12 hours without one. `fork-branch-checks.yml` also lints and typechecks each non-`fork/*` branch tip `main` merges, so a branch shows whether it is ready to open upstream.

The macOS app is signed and notarized with Adrian's Developer ID certificate, which expires 2027-02-01. It lacks passkeys, which need an Associated Domains provisioning profile for upstream's bundle ID. It updates from `latest-mac.yml` on the `mac-update-feed` branch, which the Mac workflow points at the newest `mac-` release, since the Latest release carries no Mac build.

The iPhone IPA is built for Adrian's iPhone alone, as `com.akelly.t3code` under his team T3TBGN4UX7, with the run number as its build number. Xcode archives it with the `IOS_DEVELOPMENT_P12` identity and exports it with `IOS_DISTRIBUTION_P12`, fetching profiles with the App Store Connect API key. A launchd job on the Mac (`~/.agents/macos/t3-phone-install.py`) installs each iPhone release on the phone, and `t3-fork-main.py` publishes it at https://akelly-desktop.troodon-bigeye.ts.net:8444 for over-the-air installs on the tailnet.

The Android APK is built for Adrian's Pixel as `com.akelly.t3code`, arm64 only, with the run number as its version code, and signed with the `ANDROID_KEYSTORE` key, whose only other copy is `~/.android-signing` on akelly-desktop; a different key cannot update the installed app. Obtainium on the Pixel installs each Android release, picking them out by the title "T3 Code Android". The build takes about 7 minutes from its Gradle and ccache caches and 20 without them; only a passing build of `main` saves them.

Roll a machine back with `t3 update <version> --allow-downgrade`, only to an older fork release. Fork builds can carry database migrations that an upstream release lacks.

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
