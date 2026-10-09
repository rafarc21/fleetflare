-- Issue #302: why a call failed (upstream status/error class, idle timeout,
-- client abort). NULL on every ok row and on every row written before this
-- column existed. Never prompt or response text — see junior/usage.ts.
ALTER TABLE junior_usage_log ADD COLUMN error TEXT;
