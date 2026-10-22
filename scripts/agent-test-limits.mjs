export function agentMaxWorkers(env = process.env) {
  const override = env.PAPERCLIP_TEST_MAX_WORKERS;
  if (override !== undefined) {
    const workers = Number(override);
    if (/^\d+$/.test(override) && Number.isSafeInteger(workers) && workers > 0) {
      return workers;
    }
    console.warn("[agent-test-limits] Ignoring invalid PAPERCLIP_TEST_MAX_WORKERS; expected a positive integer.");
  }

  return env.PAPERCLIP_RUN_ID && env.CI !== "true" ? 2 : undefined;
}
