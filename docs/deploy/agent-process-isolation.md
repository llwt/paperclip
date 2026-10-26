---
title: Agent Process Isolation
summary: Run agent processes in their own low-weight systemd user scopes
---

On a Linux host with a systemd user manager, Paperclip can start each agent
process tree in its own transient scope under a low-weight slice. A runaway
agent then competes for CPU at the slice's weight instead of at the weight of
the Paperclip service, and the scope gives Paperclip one handle to stop the
whole tree, including descendants that left the process group.

The feature is off by default. With `mode: off` Paperclip starts agent
processes exactly as before.

## Configuration

Set `server.agentProcessIsolation` in the instance config file:

```json
{
  "server": {
    "agentProcessIsolation": { "mode": "systemd", "slice": "app-agents.slice" }
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `mode` | `off` | `off` or `systemd` |
| `slice` | `app-agents.slice` | User slice that holds the agent scopes |

Two environment variables override the file. See
[Environment variables](/deploy/environment-variables).

| Variable | Overrides |
|----------|-----------|
| `PAPERCLIP_AGENT_PROCESS_ISOLATION` | `mode` |
| `PAPERCLIP_AGENT_SYSTEMD_SLICE` | `slice` |

An invalid `PAPERCLIP_AGENT_PROCESS_ISOLATION` value stops startup. The slice
name is checked only in `systemd` mode, where an invalid name stops startup.

## Host setup

CPU weights are relative among sibling cgroups. They do not reserve cores, and
an idle host lets any group use all of it. `MemoryHigh` is left unset.

Create `~/.config/systemd/user/app-agents.slice`:

```ini
[Unit]
Description=Paperclip agent workloads

[Slice]
CPUWeight=20
```

Create `~/.config/systemd/user/paperclipai.service.d/50-agent-process-isolation.conf`:

```ini
[Service]
CPUWeight=1000
Environment=PAPERCLIP_AGENT_PROCESS_ISOLATION=systemd
Environment=PAPERCLIP_AGENT_SYSTEMD_SLICE=app-agents.slice
```

Apply it and check the result:

```sh
systemd-analyze --user verify ~/.config/systemd/user/app-agents.slice
systemctl --user daemon-reload
systemctl --user start app-agents.slice
paperclipai service restart
systemctl --user show app-agents.slice -p CPUWeight
systemd-cgls --user-unit app-agents.slice
```

Restarting the service ends agent runs that are in progress, so choose the
moment. Do not change `KillMode` on `paperclipai.service` for this feature.
Agent processes that were already running before the restart are not moved.

## When isolation cannot be applied

If the helper binary, `busctl` or the systemd user manager is unavailable, the
process is executed once, in the original cgroup. Paperclip logs one warning
per episode and writes a line starting
`[paperclip] agent process isolation degraded` to the run log. It never starts
the process twice and it never blocks the run.

## Rollback

1. Stop starting new managed workloads and let running ones finish.
2. Set `PAPERCLIP_AGENT_PROCESS_ISOLATION=off`, or remove that line from the
   drop-in, and restart with `paperclipai service restart`.
3. Check that `systemd-cgls --user-unit app-agents.slice` shows no scope owned
   by this instance.
4. Remove only `50-agent-process-isolation.conf` and `app-agents.slice`, run
   `systemctl --user daemon-reload`, and restart again.
5. If you also roll back the Paperclip build, do it after step 3.

Do not remove other drop-ins, change `KillMode`, stop scopes this instance does
not own, or restart Postgres separately.

## What is covered

Every built-in adapter that starts a local provider, the Paperclip Runner, the
server's tool, workspace and relay helpers, and the plugin workers start their
processes through the shared launch API. Remote-only adapters start no local
process. A coverage gate (`pnpm check:process-launches`) fails CI when a new
launch is not classified.

External adapters are covered only if they use the shared launch contract. An
adapter that starts its provider with `child_process` directly stays in the
server cgroup. See [External adapters](/adapters/external-adapters).
