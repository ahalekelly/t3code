// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerSpawnCommand } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderProcesses from "./providerProcesses.ts";
import { make, ownedAgentSlice } from "./agentScope.ts";

const GiB = 1024 ** 3;
const memory = vi.hoisted(() => ({ total: 16 * 1024 ** 3, swapKb: 2 * 1024 ** 2 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  totalmem: () => memory.total,
}));

interface FakeUnit {
  activeState: string;
  controlGroup?: string;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly failingVerbs: Set<string>;
    readonly stateDir: string;
    readonly cgroupRoot: string;
  }) => Effect.Effect<A, E>,
  // A user manager older than systemd 253 rejects OOMPolicy on scopes.
  {
    oomPolicy = true,
    stopFails = false,
    leftovers = false,
    liveOwner = false,
    noBinSh = false,
    noScopes = false,
  }: {
    readonly oomPolicy?: boolean;
    readonly stopFails?: boolean;
    readonly leftovers?: boolean;
    readonly liveOwner?: boolean;
    readonly noBinSh?: boolean;
    readonly noScopes?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent", "sh"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const cgroupRoot = NodePath.join(bin, "cgroup");
    const units = new Map<string, FakeUnit>();
    const calls: Array<ReadonlyArray<string>> = [];
    const failingVerbs = new Set<string>();
    const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(code),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          calls.push(args);
          if (!oomPolicy && args.some((arg) => arg.startsWith("--property=OOMPolicy="))) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (failingVerbs.has(verb!)) return output("", 1);
          if (stopFails && verb === "stop") {
            return {
              ...output(""),
              stderr: `Failed to stop ${args.at(-1)}: Unit not loaded.`,
              code: ChildProcessSpawner.ExitCode(5),
            };
          }
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "ActiveState=inactive\n"
              : `ActiveState=${state.activeState}\nControlGroup=${state.controlGroup ?? ""}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    if (leftovers) {
      units.set(ownedAgentSlice(stateDir), { activeState: "active" });
    }
    const scope = yield* make.pipe(
      Effect.provideService(ProviderProcesses.ProviderProcesses, { hasOtherLiveOwner: liveOwner }),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(
        HostProcess.Environment,
        noScopes ? { PATH: bin } : { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" },
      ),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        exists: (path) =>
          noBinSh && path === "/bin/sh" ? Effect.succeed(false) : fileSystem.exists(path),
        readFileString: (path, encoding) =>
          path === "/proc/meminfo"
            ? Effect.sync(() => `MemTotal:       16384 kB\nSwapTotal:      ${memory.swapKb} kB\n`)
            : fileSystem.readFileString(path.replace("/sys/fs/cgroup", cgroupRoot), encoding),
        writeFileString: (path, data, options) =>
          fileSystem.writeFileString(path.replace("/sys/fs/cgroup", cgroupRoot), data, options),
      }),
    );
    return yield* body({ scope, units, calls, failingVerbs, stateDir, cgroupRoot }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: Pick<ChildProcess.StandardCommand, "args">) =>
  launch.args
    .map(String)
    .find((arg) => arg.startsWith("--unit="))
    ?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

/** An active scope as systemd and the kernel report it. */
const activeScope = (
  units: Map<string, FakeUnit>,
  cgroupRoot: string,
  unit: string,
  { populated, oomKills }: { readonly populated: boolean; readonly oomKills: number | undefined },
) => {
  const controlGroup = `/${unit}`;
  NodeFS.mkdirSync(NodePath.join(cgroupRoot, controlGroup), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(cgroupRoot, controlGroup, "cgroup.events"),
    `populated ${populated ? 1 : 0}\nfrozen 0\n`,
  );
  // An undefined count leaves memory.events unreadable.
  const memoryEvents = NodePath.join(cgroupRoot, controlGroup, "memory.events");
  if (oomKills === undefined) NodeFS.rmSync(memoryEvents, { force: true });
  else {
    NodeFS.writeFileSync(
      memoryEvents,
      `low 0\nhigh 0\nmax 0\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
    );
  }
  units.set(unit, { activeState: "active", controlGroup });
};

const stopsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(([, verb]) => verb === "stop");
const launchCodex = (
  scope: Effect.Success<typeof make>,
  threadId: string,
  env?: NodeJS.ProcessEnv,
) =>
  makeCodexAppServerSpawnCommand({ command: "agent", args: ["app-server"], threadId, env }).pipe(
    Effect.provideService(AgentScope, scope),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.map((command) => {
      assert(ChildProcess.isStandardCommand(command));
      return command;
    }),
  );

describe("AgentScope service", () => {
  it.effect("launches through sh from PATH when the host has no /bin/sh", () =>
    Effect.gen(function* () {
      const withScopes = yield* withFakeSystemd(({ scope }) =>
        scope.wrap({ command: "agent", args: [], name: "t" }),
      );
      expect(withScopes.command).toBe("/bin/sh");
      const scoped = yield* withFakeSystemd(
        ({ scope }) => scope.wrap({ command: "agent", args: [], name: "t" }),
        { noBinSh: true },
      );
      const unscoped = yield* withFakeSystemd(
        ({ scope }) => scope.wrap({ command: "agent", args: [], name: "t" }),
        { noBinSh: true, noScopes: true },
      );
      for (const launch of [scoped, unscoped]) {
        expect(NodePath.basename(launch.command)).toBe("sh");
        expect(launch.command).not.toBe("/bin/sh");
        expect(NodePath.basename(String(launch.args.at(-1)))).toBe("agent");
      }
      expect(unscoped.args).not.toContain("--scope");
    }),
  );

  it.effect("tells an agent once about each OOM kill in its own scope, never in a shared one", () =>
    withFakeSystemd(({ scope, units, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(agent.args).toContain("--property=OOMPolicy=continue");
        expect(agent.args).toContain("--collect");
        const unit = unitOf(agent);
        activeScope(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        expect(yield* scope.takeOomKills(unit)).toBe(0);
        activeScope(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
        expect(yield* scope.takeOomKills(unit)).toBe(1);
        expect(yield* scope.takeOomKills(unit)).toBe(0);
        activeScope(units, cgroupRoot, unit, { populated: true, oomKills: undefined });
        expect(yield* scope.takeOomKills(unit)).toBe(0);
        activeScope(units, cgroupRoot, unit, { populated: true, oomKills: 3 });
        expect(yield* scope.takeOomKills(unit)).toBe(2);

        const codex = yield* launchCodex(scope, "a");
        expect(codex.args).toContain("--property=OOMPolicy=continue");
        expect(codex.args).toContain("--property=TimeoutStopSec=10s");
        activeScope(units, cgroupRoot, unitOf(codex), { populated: true, oomKills: 1 });
        expect(yield* scope.takeOomKills(unitOf(codex))).toBe(0);
      }),
    ),
  );

  it.effect("launches scopes without OOMPolicy on a manager older than systemd 253", () =>
    withFakeSystemd(
      ({ scope }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          expect(agent.unit).toBeDefined();
          expect(agent.args.some((arg) => arg.startsWith("--property=OOMPolicy="))).toBe(false);
        }),
      { oomPolicy: false },
    ),
  );

  it.effect("anchors a shared Codex scope's relative executable to the cwd", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const executable = String(agent.args.at(-1));
        const codex = yield* launchCodex(scope, "a", {
          PATH: NodePath.relative(process.cwd(), NodePath.dirname(executable)),
        });
        // Anchored to the cwd for systemd-run, with its ".." kept; it names the same file.
        const anchored = String(codex.args.at(-2));
        expect(NodePath.isAbsolute(anchored)).toBe(true);
        expect(NodePath.resolve(anchored)).toBe(executable);
        expect(codex.args).toContain("--property=OOMPolicy=continue");
        expect(codex.args).toContain("--property=TimeoutStopSec=10s");
        expect(codex.args).toContain("--collect");
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps a symlinked parent in absolute and relative executable paths",
    () =>
      withFakeSystemd(({ scope }) =>
        Effect.gen(function* () {
          const plain = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "s" });
          const bin = NodePath.dirname(String(plain.args.at(-1)));
          NodeFS.mkdirSync(NodePath.join(bin, "real", "sub"), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(bin, "real", "agent"), "", { mode: 0o755 });
          NodeFS.symlinkSync(NodePath.join(bin, "real", "sub"), NodePath.join(bin, "link"));
          // The kernel follows the link before "..", so this names real/agent, not bin/agent.
          const command = `${NodePath.join(bin, "link")}/../agent`;
          const wrapped = yield* scope.wrap({ command, args: [], name: "t", threadId: "s" });
          expect(wrapped.args.at(-1)).toBe(command);
          // A relative path is anchored to the cwd the same way, without collapsing "..".
          const relative = `${NodePath.relative(process.cwd(), NodePath.join(bin, "link"))}/../agent`;
          const anchored = yield* scope.wrap({
            command: relative,
            args: [],
            name: "t",
            threadId: "s",
          });
          expect(anchored.args.at(-1)).toBe(`${process.cwd()}${NodePath.sep}${relative}`);
        }),
      ),
  );

  it.effect.each([{ oomPolicy: true }, { oomPolicy: false }])(
    "Force stop kills a thread's own scope but never a shared Codex scope (OOM policy $oomPolicy)",
    ({ oomPolicy }) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            activeScope(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
            const codex = yield* launchCodex(scope, "b");
            activeScope(units, cgroupRoot, unitOf(codex), { populated: true, oomKills: 0 });

            expect(yield* scope.kill("a")).toBe(true);
            expect(
              NodeFS.readFileSync(NodePath.join(cgroupRoot, unitOf(agent), "cgroup.kill"), "utf8"),
            ).toBe("1");
            expect(yield* scope.kill("b")).toBe(false);
            expect(NodeFS.existsSync(NodePath.join(cgroupRoot, unitOf(codex), "cgroup.kill"))).toBe(
              false,
            );
            expect(calls.filter(([, verb]) => verb === "kill")).toEqual([]);
          }),
        { oomPolicy },
      ),
  );

  it.effect("delegates every agent scope so rootless containers can manage their cgroups", () =>
    withFakeSystemd(({ scope }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const codex = yield* launchCodex(scope, "a");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        for (const launch of [agent, codex, terminal]) {
          expect(launch.args).toContain("--property=Delegate=yes");
        }
      }),
    ),
  );

  it.effect("caps agent memory and yields CPU, disk, and tasks to the server", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const setProperties = calls.filter(([, verb]) => verb === "set-property");
        expect(setProperties).toEqual([
          [
            "--user",
            "set-property",
            "--runtime",
            "app-t3code-agents.slice",
            expect.stringMatching(/^MemoryHigh=\d+$/),
            expect.stringMatching(/^MemoryMax=\d+$/),
          ],
          [
            "--user",
            "set-property",
            "--runtime",
            "app-t3code.slice",
            "CPUWeight=10",
            "IOWeight=10",
            "TasksMax=25%",
          ],
        ]);
      }),
    ),
  );

  it.effect("follows a live memory or swap change at the next launch", () => {
    memory.total = 16 * GiB;
    memory.swapKb = 2 * 1024 ** 2;
    return withFakeSystemd(({ scope, calls, failingVerbs }) =>
      Effect.gen(function* () {
        const launch = scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const memoryLimits = () =>
          calls
            .filter(
              ([, verb, , slice]) => verb === "set-property" && slice === "app-t3code-agents.slice",
            )
            .map((args) => args.slice(4));
        yield* launch;
        yield* launch;
        expect(memoryLimits()).toEqual([[`MemoryHigh=${10 * GiB}`, `MemoryMax=${12 * GiB}`]]);

        // A VM balloon or `pct set --memory` grows RAM while the server keeps running.
        memory.total = 22 * GiB;
        failingVerbs.add("set-property");
        yield* launch;
        yield* launch;
        failingVerbs.delete("set-property");
        yield* launch;
        yield* launch;
        const grown = [`MemoryHigh=${16 * GiB}`, `MemoryMax=${18 * GiB}`];
        expect(memoryLimits()).toEqual([
          [`MemoryHigh=${10 * GiB}`, `MemoryMax=${12 * GiB}`],
          grown,
          grown,
          grown,
        ]);

        // Without swap, MemoryHigh only throttles; MemoryMax must OOM-kill the runaway.
        memory.swapKb = 0;
        yield* launch;
        expect(memoryLimits().at(-1)).toEqual(["MemoryHigh=infinity", `MemoryMax=${18 * GiB}`]);
        memory.swapKb = 2 * 1024 ** 2;
      }),
    );
  });

  it.effect("stops agents a killed server left before startup completes", () =>
    withFakeSystemd(
      ({ scope, calls, stateDir }) =>
        Effect.gen(function* () {
          expect(stopsOf(calls)).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
          expect(agent.args).toContain("--property=TimeoutStopSec=10s");
          const terminal = yield* scope.wrap({
            command: "agent",
            args: [],
            name: "terminal",
            survivesRestart: true,
          });
          expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
          expect(stopsOf(calls)).toHaveLength(1);
        }),
      { leftovers: true },
    ),
  );

  it.effect("leaves the slice to another live server sharing this home", () =>
    withFakeSystemd(({ calls }) => Effect.sync(() => expect(stopsOf(calls)).toEqual([])), {
      leftovers: true,
      liveOwner: true,
    }),
  );

  it.effect("stops leftover processes only in an active agent scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        expect(agent.unit).toBe(unit);

        yield* scope.stop("session-2.scope");
        expect(calls.some((args) => args.includes("session-2.scope"))).toBe(false);
        yield* scope.stop(unit);
        activeScope(units, cgroupRoot, unit, { populated: false, oomKills: 0 });
        yield* scope.stop(unit);
        activeScope(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        units.get(unit)!.activeState = "deactivating";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);

        units.get(unit)!.activeState = "active";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
      }),
    ),
  );

  it.effect("reaps a tool's leftovers after its agent exits, then forgets the scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        activeScope(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
        expect(yield* scope.takeOomKills(unit)).toBe(0);
        expect(yield* scope.kill("a")).toBe(false);
      }),
    ),
  );

  it.effect("reports failed daemon cleanup and leaves the scope to Force stop", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return withFakeSystemd(
      ({ scope, units, cgroupRoot }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          activeScope(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
          yield* scope.stop(unitOf(agent));
          expect(warnings.flat()).toContain("Could not stop an exited agent's scope");
          expect(yield* scope.kill("a")).toBe(true);
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      { stopFails: true },
    );
  });

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});
