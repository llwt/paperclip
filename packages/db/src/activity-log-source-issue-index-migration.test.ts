import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("activity_log source issue index migration (SX-1597)", () => {
  it("creates the partial index, the source-issue lookup uses it, and the migration is idempotent", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("sx1597-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const [index] = await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'activity_log_company_source_issue_idx'`;
    expect(index?.indexdef).toContain("WHERE (action = ANY");

    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM activity_log WHERE company_id = '00000000-0000-0000-0000-000000000001' AND action IN ('project.created', 'company.skill_created') AND details ->> 'sourceIssueId' = 'x'",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("activity_log_company_source_issue_idx");

    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0335_activity_log_source_issue_index.sql", import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }, 240_000);
});
