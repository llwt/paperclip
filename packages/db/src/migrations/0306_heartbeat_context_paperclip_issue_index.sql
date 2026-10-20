-- Fork-only (SX-1120). Upstream adds the same index in 0345_luxuriant_carmella_unuscione.sql (paperclipai/paperclip#16278); IF NOT EXISTS makes that a no-op here.
-- Differs from upstream (fork, SX-1120): no CONCURRENTLY, the fork's migration runner applies each file in a transaction.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_created_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'),"created_at" DESC NULLS LAST);
