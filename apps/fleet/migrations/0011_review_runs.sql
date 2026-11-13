-- #1469: the latest review per PR head. One reviewer per head sha, so the
-- per-PR pointer is keyed by (repo, pr) like gate_pr_head; head_sha, the
-- reviewer studio id and the review task number are overwritten by each new
-- head's review. The commit status gate/review on the head is the dedup key
-- for a re-review: a status that is not pending means the head was already
-- reviewed. task is the board task the reviewer posts its envelope onto.
CREATE TABLE IF NOT EXISTS review_runs (
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  studio_id TEXT NOT NULL,
  task INTEGER NOT NULL,
  PRIMARY KEY (repo, pr)
);