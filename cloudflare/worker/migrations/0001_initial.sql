CREATE TABLE IF NOT EXISTS account_data (
  account_id TEXT PRIMARY KEY,
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'line')),
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  FOREIGN KEY (account_id) REFERENCES account_data(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identities_account_id ON identities(account_id);
