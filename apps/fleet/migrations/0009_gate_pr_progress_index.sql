-- #1148 (refs #1135, #1150 review): the watchdog sweeps the progress stamp every minute.
-- Without this index both of its statements scan the whole per-PR table.
CREATE INDEX IF NOT EXISTS gate_pr_head_progressed ON gate_pr_head (progressed_at);
