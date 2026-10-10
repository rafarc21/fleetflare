-- Issue #335: wall time of one call (ms, first env.AI.run attempt to final
-- byte or error, retry backoff included) and how many env.AI.run attempts it
-- took (1 = no retry). NULL on rows written before these columns existed and
-- on rows from callers that do not measure them (junior delegation).
ALTER TABLE junior_usage_log ADD COLUMN duration_ms INTEGER;
ALTER TABLE junior_usage_log ADD COLUMN attempts INTEGER;
