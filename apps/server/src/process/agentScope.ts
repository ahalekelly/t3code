// @effect-diagnostics nodeBuiltinImport:off -- unit names and RAM size come from the host.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AgentScope,
  agentScopeCommand,
  type AgentScopeShape,
  type AgentSystemdScope,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const AGENT_SLICE = "app-t3code-agents.slice";
// Owns every agent slice and competes with the server's unit or scope under app.slice.
const AGENTS_PARENT_SLICE = "app-t3code.slice";
// Low weights yield CPU and disk to the server under contention, where the user manager
// has those controllers: current systemd delegates cpu, rarely io. TasksMax keeps agents
// below logind's 33% per-user task limit, leaving forks for the server.
const AGENTS_PARENT_PROPERTIES = ["CPUWeight=10", "IOWeight=10", "TasksMax=25%"];

export function ownedAgentSlice(stateDir: string): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `app-t3code-agents-${hash}.slice`;
}

const GiB = 1024 ** 3;

/**
 * Agents together leave about 6 GB free before they are throttled and 4 GB
 * before the kernel kills one, so the server, sshd, and tailscaled keep
 * working. Small machines still give agents at least half of RAM before
 * throttling and three quarters before a kill.
 */
function agentSliceMemoryLimits(totalBytes: number) {
  return {
    high: Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)),
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

// systemd's default 90 s stop timeout would outlast our leftover-agent wait.
// Delegation lets rootless containers (Podman, kind) manage their own cgroups.
const SCOPE_OPTIONS = ["--property=TimeoutStopSec=10s", "--property=Delegate=yes", "--collect"];
// The kernel kills the biggest agent process, often a tool, which the agent can outlive.
const OOM_POLICY = "--property=OOMPolicy=continue";

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const ownedSlice = ownedAgentSlice(stateDir);

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  const showUnit = Effect.fn("agentScope.showUnit")(function* (systemctl: string, unit: string) {
    const shown = yield* run(systemctl, [
      "--user",
      "show",
      unit,
      "--property=ActiveState,ControlGroup",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return undefined;
    return parseKeyValues(shown.value.stdout);
  });

  /** The control group of an active unit that still holds processes. */
  const runningControlGroup = Effect.fn("agentScope.runningControlGroup")(function* (
    systemctl: string,
    unit: string,
  ) {
    const values = yield* showUnit(systemctl, unit);
    if (values?.get("ActiveState") !== "active") return undefined;
    const controlGroup = values.get("ControlGroup") ?? "";
    const events = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
    return parseCgroupCounter(events, "populated") === 0 ? undefined : controlGroup;
  });

  // Old agents keep their scopes when the server is killed, and the restarted
  // server resumes their sessions. Stop them first, so two copies of one
  // session never work in the same worktree.
  const stopLeftoverAgents = Effect.fn("agentScope.stopLeftoverAgents")(function* (
    systemctl: string,
  ) {
    if ((yield* runningControlGroup(systemctl, ownedSlice)) === undefined) return;
    yield* Effect.logWarning("Stopping agents left by a previous server", { slice: ownedSlice });
    const stopped = yield* runner
      .run({ command: systemctl, args: ["--user", "stop", ownedSlice], timeout: "30 seconds" })
      .pipe(Effect.option);
    if (stopped._tag === "None" || stopped.value.code !== 0) {
      yield* Effect.logWarning("Could not stop agents left by a previous server", {
        slice: ownedSlice,
        stderr: stopped._tag === "Some" ? stopped.value.stderr.trim() : undefined,
      });
    }
  });

  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      if (systemdRun === null || systemctl === null) return undefined;
      yield* stopLeftoverAgents(systemctl);
      const probe = (options: ReadonlyArray<string>) =>
        run(systemdRun, [
          "--user",
          "--scope",
          "--quiet",
          `--slice=${AGENT_SLICE}`,
          ...options,
          "--",
          "true",
        ]).pipe(Effect.map((result) => result._tag === "Some" && result.value.code === 0));
      // Scopes take OOMPolicy from systemd 253. Older managers kill the whole
      // scope on any OOM kill in it, but still get scopes.
      const supportsOomPolicy = yield* probe([...SCOPE_OPTIONS, OOM_POLICY]);
      if (!supportsOomPolicy && !(yield* probe(SCOPE_OPTIONS))) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager");
        return undefined;
      }
      const setProperties = Effect.fn("agentScope.setProperties")(function* (
        slice: string,
        properties: ReadonlyArray<string>,
      ) {
        const result = yield* run(systemctl, [
          "--user",
          "set-property",
          "--runtime",
          slice,
          ...properties,
        ]);
        if (result._tag === "None" || result.value.code !== 0) {
          yield* Effect.logWarning("Could not set resource limits on an agents slice", {
            slice,
            properties,
            stderr: result._tag === "Some" ? result.value.stderr.trim() : undefined,
          });
        }
      });
      const limits = agentSliceMemoryLimits(NodeOS.totalmem());
      yield* setProperties(AGENT_SLICE, [`MemoryHigh=${limits.high}`, `MemoryMax=${limits.max}`]);
      yield* setProperties(AGENTS_PARENT_SLICE, AGENTS_PARENT_PROPERTIES);
      yield* Effect.logInfo("Agent scopes are on", {
        slice: AGENT_SLICE,
        ...limits,
        oomPolicy: supportsOomPolicy,
      });
      return {
        systemdRun,
        systemctl,
        runtimeDir,
        options: supportsOomPolicy ? [...SCOPE_OPTIONS, OOM_POLICY] : SCOPE_OPTIONS,
      };
    }),
  );

  // Owned scopes only: shared ones serve other threads too.
  const unitByThread = new Map<string, string>();
  // The OOM kills each live agent has been told about.
  const oomKillsByUnit = new Map<string, { controlGroup: string | undefined; reported: number }>();

  const takeOomKills: AgentScopeShape["takeOomKills"] = Effect.fn("AgentScope.takeOomKills")(
    function* (unit) {
      const tracked = oomKillsByUnit.get(unit);
      if (tracked === undefined) return 0;
      const scope = yield* systemd;
      if (scope === undefined) return 0;
      if (tracked.controlGroup === undefined) {
        const controlGroup = (yield* showUnit(scope.systemctl, unit))?.get("ControlGroup");
        if (!controlGroup) return 0;
        tracked.controlGroup = controlGroup;
      }
      const events = yield* readCgroupFile(tracked.controlGroup, "memory.events");
      const total = parseCgroupCounter(events, "oom_kill") ?? tracked.reported;
      const fresh = total - tracked.reported;
      tracked.reported = total;
      return fresh;
    },
  );

  const forgetThreadsOf = (unit: string) => {
    for (const [threadId, threadUnit] of unitByThread) {
      if (threadUnit === unit) unitByThread.delete(threadId);
    }
  };

  const stop = Effect.fn("AgentScope.stop")(function* (unit: string) {
    if (!unit.startsWith("t3code-") || !unit.endsWith(".scope")) return;
    oomKillsByUnit.delete(unit);
    const scope = yield* systemd;
    if (scope === undefined) return;
    if ((yield* runningControlGroup(scope.systemctl, unit)) === undefined) {
      forgetThreadsOf(unit);
      return;
    }
    const stopped = yield* run(scope.systemctl, ["--user", "stop", "--no-block", unit]);
    // Force stop can still reach leftovers that systemd failed to stop.
    if (stopped._tag === "Some" && stopped.value.code === 0) {
      forgetThreadsOf(unit);
      return;
    }
    yield* Effect.logWarning("Could not stop an exited agent's scope", {
      unit,
      exitCode: stopped._tag === "Some" ? stopped.value.code : undefined,
    });
  });

  const kill: AgentScopeShape["kill"] = Effect.fn("AgentScope.kill")(function* (threadId) {
    const unit = unitByThread.get(threadId);
    if (unit === undefined) return false;
    const scope = yield* systemd;
    if (scope === undefined) return false;
    const controlGroup = yield* runningControlGroup(scope.systemctl, unit);
    if (controlGroup === undefined) return false;
    // cgroup.kill (Linux 5.14+) kills the whole tree at once; systemd's kill is the fallback.
    const killedByCgroup =
      controlGroup.length > 0 &&
      (yield* fileSystem
        .writeFileString(path.join("/sys/fs/cgroup", controlGroup, "cgroup.kill"), "1")
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ));
    if (killedByCgroup) return true;
    const killed = yield* run(scope.systemctl, ["--user", "kill", "--signal=SIGKILL", unit]);
    return killed._tag === "Some" && killed.value.code === 0;
  });

  const clear: AgentScopeShape["clear"] = (threadId) =>
    Effect.sync(() => void unitByThread.delete(threadId));

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({
      command,
      args,
      name,
      threadId,
      env,
      survivesRestart,
      shared,
    }) {
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      if (resolved === null) return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) return agentScopeCommand({ command: resolved, args });
      const unit = `t3code-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      // A shared scope cannot attribute a tool's OOM kill to one thread.
      if (threadId !== undefined && shared === true) unitByThread.delete(threadId);
      if (threadId !== undefined && shared !== true) {
        unitByThread.set(threadId, unit);
        oomKillsByUnit.set(unit, { controlGroup: undefined, reported: 0 });
      }
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: survivesRestart === true ? AGENT_SLICE : ownedSlice,
        unit,
        options: scope.options,
      };
      return { ...agentScopeCommand({ command: resolved, args, scope: systemdScope }), unit };
    }),
    takeOomKills,
    stop,
    kill,
    clear,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(Layer.provide(ProcessRunner.layer));
