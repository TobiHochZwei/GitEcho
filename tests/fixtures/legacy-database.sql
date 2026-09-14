-- Synthetic schema and records from before versioned migrations.
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_error TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT,
  repos_total INTEGER DEFAULT 0,
  repos_success INTEGER DEFAULT 0,
  repos_failed INTEGER DEFAULT 0,
  error_summary TEXT,
  backup_mode TEXT NOT NULL
);

CREATE TABLE backup_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backup_runs(id),
  repository_id INTEGER NOT NULL REFERENCES repositories(id),
  status TEXT,
  error TEXT,
  checksum TEXT,
  zip_path TEXT,
  started_at TEXT,
  completed_at TEXT
);

INSERT INTO repositories (id, url, provider, owner, name)
VALUES (42, 'https://example.test/legacy/repo.git', 'github', 'legacy', 'repo');
INSERT INTO backup_runs (id, started_at, status, backup_mode)
VALUES (7, '2026-01-01T00:00:00.000Z', 'success', 'option1');
INSERT INTO backup_items (id, run_id, repository_id, status, checksum)
VALUES (9, 7, 42, 'success', 'legacy-checksum');
