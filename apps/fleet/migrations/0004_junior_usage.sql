CREATE TABLE IF NOT EXISTS junior_usage_log (
  id             TEXT    PRIMARY KEY,
  ts             INTEGER NOT NULL,
  studio_id      TEXT    NOT NULL,
  mode           TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  ok             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS junior_usage_log_ts ON junior_usage_log (ts);
CREATE INDEX IF NOT EXISTS junior_usage_log_studio ON junior_usage_log (studio_id);
