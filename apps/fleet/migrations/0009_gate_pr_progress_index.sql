-- #1148 review: the watchdog's stall read and the unknown-stamp adoption both
-- filter on progressed_at. Without an index each minute's sweep scans every PR row.
CREATE INDEX IF NOT EXISTS gate_pr_head_progressed_at ON gate_pr_head (progressed_at);
