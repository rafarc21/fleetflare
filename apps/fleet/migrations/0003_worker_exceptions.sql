CREATE TABLE IF NOT EXISTS worker_exceptions (
  id          TEXT    PRIMARY KEY,
  ts          INTEGER NOT NULL,
  route       TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  stack_head  TEXT
);

CREATE INDEX IF NOT EXISTS worker_exceptions_ts ON worker_exceptions (ts);
