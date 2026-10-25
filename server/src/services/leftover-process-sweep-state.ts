// Differs from upstream (fork, SX-2456). The adopting server records the
// leftover process sweep of an adopted run with its own merge write, while
// the run is still being settled. A terminal write that built its resultJson
// from an older read of the run (the orphan reaper) must not erase that
// record: keep the stored sweep when the incoming result has none.
export function preserveLeftoverProcessSweep(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  const stored = current?.leftoverProcessSweep;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return incoming;
  if ((stored as Record<string, unknown>).kind !== "leftover_process_sweep") return incoming;
  if (incoming?.leftoverProcessSweep) return incoming;
  return { ...incoming, leftoverProcessSweep: stored };
}
