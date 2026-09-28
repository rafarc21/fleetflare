CREATE TABLE IF NOT EXISTS events (
  id            TEXT    PRIMARY KEY,
  ts            INTEGER NOT NULL,
  from_agent    TEXT    NOT NULL,
  to_agent      TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  ref           TEXT,
  thread        TEXT,
  body          TEXT    NOT NULL,
  requires_ack  INTEGER NOT NULL DEFAULT 0,
  acked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS events_to_ts  ON events (to_agent, ts);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread);
