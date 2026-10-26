# @paperclipai/process-launch

Shared launch primitive that puts one agent process tree into its own
transient systemd user scope in a low-weight slice (default
`app-agents.slice`) before any workload code runs. When that is not possible
the target is spawned the ordinary way, once. Plan: SX-2306, "Chosen wrapping
method" and "Ownership, cancellation and restart".

The default mode is `off`. Operator setup and rollback are in `FORK.md`, section "Agent process isolation"; `pnpm check:process-launches` fails CI on a launch that bypasses this package.

## API

```ts
import { spawnIsolated, terminateOwnedProcessTree, OFF_ISOLATION_POLICY } from "@paperclipai/process-launch";

const { child, launch } = spawnIsolated(
  { command, args, options },              // exactly what you would pass to spawn()
  { policy, owner: { kind: "run", id: runId, companyId } },
);
// later: launch.classifyExit(code, signal), launch.readEnrollment()
await terminateOwnedProcessTree(launch.record!, { instanceId });
```

- **Off mode** (`OFF_ISOLATION_POLICY`) is `spawn(command, args, options)`
  with no filesystem or systemd access.
- **Systemd mode** (`createSystemdIsolationPolicy`) is trusted, frozen policy
  built once by the server. The user bus address comes from the server's own
  environment (`resolveUserBusAddress`), never from an agent's env override.
- `prepareIsolatedLaunch` gives the rewritten launch without spawning it.
- Owner ids, instance ids and company ids must be opaque ids. Unit names are
  `pcagent-<hash(instance)>-<hash(owner)>-<nonce>.scope`.

External adapter packages are covered only when they launch local workload
roots through this API.

## The helper

`paperclip-scope-exec` (Rust, `helper/`) is built by `pnpm build` and staged
at `dist/bin/paperclip-scope-exec` (mode 0755, listed in
`publishConfig.executableFiles`). Linux only; on other platforms, or when the
binary is missing, launches fall back to a plain spawn.

```text
paperclip-scope-exec --unit <name.scope> --slice <name.slice>
    [--user-bus unix:path=<socket>] [--status-file <path>]
    [--deadline-ms <n>] [--stop-timeout-ms <n>] [--busctl <path>]
    [--argv0 <arg0>] -- <file> [args...]
```

1. Checks the slice and unit names, that it runs below this UID's own user
   manager, and that the manager has the CPU controller.
2. Calls `StartTransientUnit` through one `/usr/bin/busctl` child with
   `Slice=`, `PIDs=[self]`, `KillMode=control-group`, a finite
   `TimeoutStopUSec=` and `CollectMode=inactive-or-failed`. The busctl child
   gets a minimal environment, `/dev/null` stdin, and none of the caller's
   extra descriptors.
3. Confirms enrollment by reading its own `/proc/self/cgroup`, within one
   combined deadline (default 2 s). A lost or late reply is resolved by that
   membership check, never by a second attempt.
4. Writes its status file, then executes the target once, in place, the way
   Node's spawn does on Linux (glibc `execvp`): PATH from the target's
   environment, and a file the kernel refuses with ENOEXEC (a script without
   `#!`) runs as `/bin/sh <path> args...`.

The process keeps its PID, process group, session, cwd, environment, signal
dispositions and every inherited descriptor. The helper never writes to
descriptors 0 to 2. If enrollment fails for any reason, the target still runs
once in its original cgroup and the status says `degraded` with a reason. If
the target cannot be executed, the helper exits 127 (not found) or 126 and
the status carries `execError`, so `classifyExit` can tell that apart from a
target that exits 127 itself.

## Registry

Records live in `<instance>/runtime/agent-scopes/` (mode 0700). Each launch
has two files with one writer each, both replaced atomically:

- `<unit>.json`: intent manifest, written before spawn and updated with the
  PID and its start time after spawn.
- `<unit>.status.json`: the helper's enrollment status.

They hold identity and enrollment facts only: never provider arguments,
environment, credentials, prompts or output.

## Termination

`terminateOwnedProcessTree` is idempotent:

- With a scope, it signals each process whose own cgroup is exactly the
  owned scope, writes `cgroup.kill` after the grace period, and waits until
  the scope is empty.
- Without one (degraded launch), it signals only the recorded root process,
  or the process group it leads, after checking the boot id and start time.
  A group is done only when no member still runs, not when the leader exits.
  The group id is signalled only while the verified leader, or a member seen
  earlier with the same start time, is still in the group. If that proof is
  lost while members still run, signalling stops and the result is
  `unconfirmed` (`group_ownership_lost`).
- If the degraded root has already exited and been reaped (for example after
  a normal exit), the group id can no longer be tied to the record. Survivors
  that carry it are never signalled; the result is `unconfirmed`
  (`group_ownership_unprovable`) and the record stays. A later call removes
  the record once no process carries the group id. If the root's PID now
  names another process, the recorded group is gone, because the kernel
  never reuses a PID that is still a process group id.
- It never kills by process name, by unit prefix, a whole slice, or an
  unverified PID. When it cannot confirm emptiness it keeps the record and
  returns `unconfirmed`.

## Reconciliation

Read-only facts for restart reconciliation; the server decides what to keep
or stop (`server/src/services/agent-process-scopes.ts`):

- `listOwnedScopeRecords(registryDir, instanceId)`: the records of one
  instance only, plus the ones that could not be read.
- `isScopeLaunchedByThisProcess(ref)`: records this process wrote keep their
  in-memory owner; only records an earlier process left are reconciled.
- `isScopeRootAlive(record)`: the recorded root still runs (same boot, PID
  and start time).
- `listUnmatchedScopeUnits(...)`: live units in the instance's namespace with
  no record. They are reported, never stopped.
- `isScopeUnitOfOwner(unit, owner)`: whether a unit name was built for an
  owner, from the hashed identity in the name. A record that cannot be read
  can still be attributed to its owner, so its cleanup is reported as pending.

Scopes carry no `BindsTo=` or `PartOf=` dependency on the Paperclip service,
so a hot restart can adopt the processes in them.

## Tests

```sh
pnpm --filter @paperclipai/process-launch exec vitest run --maxWorkers=2
pnpm --filter @paperclipai/process-launch typecheck
cargo test --locked --manifest-path packages/process-launch/helper/Cargo.toml
```

The vitest global setup builds the helper. Tests that need a real user
manager use one owned, uniquely named test slice (`app-pcltest<random>.slice`)
that teardown stops; without a usable manager they are skipped with the
reason in the suite name.
