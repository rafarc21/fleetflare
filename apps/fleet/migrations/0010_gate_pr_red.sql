-- #1119 review: a run whose leg went red is final. The watchdog reads this flag
-- on a stalled run and ends it with the final error verdict, never an infra rerun.
-- 1 = a leg of the pointed run reported red. A new run or a rerun handoff clears it.
ALTER TABLE gate_pr_head ADD COLUMN red INTEGER NOT NULL DEFAULT 0;
