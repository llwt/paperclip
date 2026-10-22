-- Fork-only (SX-1597): partial index for the source-issue branch of activity forIssue, which scanned all of activity_log.
-- No CONCURRENTLY: the fork's migration runner applies each file in a transaction. The index holds only two rare actions.
CREATE INDEX IF NOT EXISTS "activity_log_company_source_issue_idx" ON "activity_log" USING btree ("company_id",("details" ->> 'sourceIssueId')) WHERE "activity_log"."action" IN ('project.created', 'company.skill_created');
