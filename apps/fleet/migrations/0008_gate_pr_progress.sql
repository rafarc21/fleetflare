-- #1135: the latest gate run's progress time. A live run with no progress inside
-- the stall window is hung, so a manual start ends it instead of reattaching.
-- 0 = never stamped (an older row), which reads as no progress.
ALTER TABLE gate_pr_head ADD COLUMN progressed_at INTEGER NOT NULL DEFAULT 0;
