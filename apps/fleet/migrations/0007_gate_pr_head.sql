-- Issue #1082: the latest gate run per PR. Workflows cannot list instances, so a
-- new head sha reads its PR's previous run here and ends it when still live.
-- repo is stored lowercased (auto-run.ts keys runs case-insensitively); one row
-- per PR, overwritten by each new run. run_id is the Workflows instance id.
CREATE TABLE IF NOT EXISTS gate_pr_head (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
