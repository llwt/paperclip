import { probeSystemdCapability, type CapabilityResult } from "./capability.js";
import type { SystemdIsolationPolicy } from "./policy.js";

/** The structured-log shape of pino: `(fields, message)`. */
export interface IsolationLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

export interface IsolationBackoff {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_ISOLATION_BACKOFF: IsolationBackoff = { initialMs: 5_000, maxMs: 300_000 };

export interface IsolationHealthOptions {
  logger: IsolationLogger;
  probe?: (policy: SystemdIsolationPolicy) => Promise<CapabilityResult>;
  backoff?: IsolationBackoff;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What a finished launch tells the health tracker. */
export type LaunchObservation = { enrolled: true } | { enrolled: false; reason: string };

interface Episode {
  reason: string;
  origin: "probe" | "launch";
}

/**
 * Tracks whether systemd isolation works on this host, for one server
 * instance. A failure starts an episode: one warning, then bounded-backoff
 * re-detection. While an episode is open, launches skip the helper and run
 * normally; recovery is logged once and ends the episode. It never throws
 * into a launch path and never blocks one.
 */
export class IsolationHealth {
  private readonly logger: IsolationLogger;
  private readonly probeFn: (policy: SystemdIsolationPolicy) => Promise<CapabilityResult>;
  private readonly backoff: IsolationBackoff;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private episode: Episode | null = null;
  /** True while launches should skip the helper because the last check failed. */
  private blocked = false;
  private nextDelayMs: number;
  private timer: unknown = null;
  private probing = false;
  private stopped = false;

  constructor(
    readonly policy: SystemdIsolationPolicy,
    options: IsolationHealthOptions,
  ) {
    this.logger = options.logger;
    this.probeFn = options.probe ?? ((p) => probeSystemdCapability(p));
    this.backoff = options.backoff ?? DEFAULT_ISOLATION_BACKOFF;
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const handle = setTimeout(callback, ms);
      handle.unref?.();
      return handle;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.nextDelayMs = this.backoff.initialMs;
  }

  /** Run the startup capability check. Resolves once it has been evaluated. */
  async start(): Promise<void> {
    await this.runProbe();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Whether a launch should try the helper. False while the last check failed. */
  shouldAttempt(): boolean {
    return !this.blocked;
  }

  /** The reason of the open failure episode, or null. */
  currentFailure(): string | null {
    return this.episode?.reason ?? null;
  }

  observeLaunch(observation: LaunchObservation): void {
    if (this.stopped) return;
    if (observation.enrolled) {
      this.blocked = false;
      if (this.episode) this.recover();
      this.nextDelayMs = this.backoff.initialMs;
      return;
    }
    this.fail(observation.reason, "launch");
  }

  private fail(reason: string, origin: Episode["origin"]): void {
    if (!this.episode) {
      this.episode = { reason, origin };
      this.logger.warn(
        { reason, slice: this.policy.slice },
        `agent process isolation unavailable: ${reason}; slice ${this.policy.slice}; normal execution used`,
      );
    }
    this.blocked = true;
    this.schedule();
  }

  private recover(): void {
    const episode = this.episode;
    this.episode = null;
    if (!episode) return;
    this.logger.info(
      { slice: this.policy.slice, previousReason: episode.reason },
      `agent process isolation recovered; slice ${this.policy.slice}`,
    );
  }

  private schedule(): void {
    if (this.stopped || this.timer !== null) return;
    const delay = this.nextDelayMs;
    this.nextDelayMs = Math.min(this.backoff.maxMs, this.nextDelayMs * 2);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.runProbe();
    }, delay);
  }

  private async runProbe(): Promise<void> {
    if (this.probing || this.stopped) return;
    this.probing = true;
    let result: CapabilityResult;
    try {
      result = await this.probeFn(this.policy);
    } catch (error) {
      result = { ok: false, reason: "probe_failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      this.probing = false;
    }
    if (this.stopped) return;
    if (!result.ok) {
      this.fail(result.reason, "probe");
      return;
    }
    // The check passes again. Launches may use the helper once more. A
    // failure that came from a launch stays open until a launch enrolls, so
    // a launch-time fault that the check cannot see does not warn again.
    this.blocked = false;
    if (this.episode?.origin === "probe") {
      this.recover();
      this.nextDelayMs = this.backoff.initialMs;
    }
  }
}
