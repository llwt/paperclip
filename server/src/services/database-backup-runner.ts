export const DEFAULT_DATABASE_BACKUP_TIMEOUT_MINUTES = 30;

export function resolveDatabaseBackupTimeoutMs(rawMinutes: string | undefined): number {
  const minutes = Number(rawMinutes);
  const effective = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_DATABASE_BACKUP_TIMEOUT_MINUTES;
  return Math.round(effective * 60_000);
}

export type RunningDatabaseBackup = {
  trigger: string;
  startedAt: Date;
};

export type ExclusiveBackupOutcome<T> =
  | { started: true; value: T }
  | { started: false; running: RunningDatabaseBackup; runningMinutes: number };

/** Allows one backup at a time. The slot is freed when the run settles, also when it rejects. */
export function createExclusiveBackupRunner(now: () => number = Date.now) {
  let running: RunningDatabaseBackup | null = null;
  return {
    async run<T>(trigger: string, fn: () => Promise<T>): Promise<ExclusiveBackupOutcome<T>> {
      if (running) {
        return {
          started: false,
          running,
          runningMinutes: Math.max(0, Math.round((now() - running.startedAt.getTime()) / 60_000)),
        };
      }
      running = { trigger, startedAt: new Date(now()) };
      try {
        return { started: true, value: await fn() };
      } finally {
        running = null;
      }
    },
  };
}
