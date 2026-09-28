CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT    PRIMARY KEY,
  event_id      TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  params        TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  requested_ts  INTEGER NOT NULL,
  decided_ts    INTEGER,
  decided_by    TEXT,
  chat_id       TEXT    NOT NULL,
  message_id    INTEGER,
  result        TEXT
);

CREATE INDEX IF NOT EXISTS approvals_lookup ON approvals (project, action, requested_ts);
CREATE INDEX IF NOT EXISTS approvals_state  ON approvals (state);

CREATE TABLE IF NOT EXISTS deploy_targets (
  id       TEXT PRIMARY KEY,
  project  TEXT NOT NULL,
  repo     TEXT NOT NULL,
  ref      TEXT NOT NULL,
  workdir  TEXT NOT NULL,
  command  TEXT NOT NULL,
  secrets  TEXT NOT NULL,
  env      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    INTEGER NOT NULL
);
