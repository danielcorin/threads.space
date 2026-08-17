-- Fresh-install schema for one standalone Threads instance.

CREATE TABLE users (
  id                     TEXT PRIMARY KEY,
  username               TEXT NOT NULL UNIQUE,
  password_hash          TEXT NOT NULL,
  email                  TEXT,
  email_normalized       TEXT,
  email_verified_at      INTEGER,
  display_name           TEXT,
  avatar_url             TEXT,
  name_color             TEXT,
  code_theme             TEXT,
  is_admin               INTEGER NOT NULL DEFAULT 0,
  role                   TEXT NOT NULL DEFAULT 'human' CHECK (role IN ('human', 'bot')),
  bot_capabilities_json  TEXT,
  ephemeral_bot_id       TEXT REFERENCES users(id),
  created_at             INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_users_email_normalized
  ON users(email_normalized) WHERE email_normalized IS NOT NULL;

CREATE TABLE sessions (
  token             TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at        INTEGER NOT NULL,
  credential_id     TEXT NOT NULL,
  token_verifier    TEXT NOT NULL,
  verifier_version  INTEGER NOT NULL,
  last_used_at      INTEGER,
  revoked_at        INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE UNIQUE INDEX idx_sessions_credential_id
  ON sessions(credential_id) WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX idx_sessions_verifier
  ON sessions(token_verifier) WHERE token_verifier IS NOT NULL;

CREATE TABLE api_tokens (
  token             TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  scopes            TEXT NOT NULL DEFAULT '["threads:read","threads:write"]',
  expires_at        INTEGER,
  credential_id     TEXT NOT NULL,
  token_verifier    TEXT NOT NULL,
  verifier_version  INTEGER NOT NULL,
  token_hint        TEXT NOT NULL,
  last_used_at      INTEGER,
  revoked_at        INTEGER,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_api_tokens_expires_at ON api_tokens(expires_at);
CREATE UNIQUE INDEX idx_api_tokens_credential_id
  ON api_tokens(credential_id) WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX idx_api_tokens_verifier
  ON api_tokens(token_verifier) WHERE token_verifier IS NOT NULL;

CREATE TABLE channels (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL UNIQUE,
  description                TEXT,
  is_private                 INTEGER NOT NULL DEFAULT 0,
  is_dm                      INTEGER NOT NULL DEFAULT 0,
  dm_partner_id              TEXT,
  processing_mode            TEXT NOT NULL DEFAULT 'immediate',
  board_enabled              INTEGER NOT NULL DEFAULT 0,
  is_ephemeral               INTEGER NOT NULL DEFAULT 0,
  auto_named_at              INTEGER,
  archived_at                INTEGER,
  consecutive_non_human_count INTEGER NOT NULL DEFAULT 0,
  non_human_window_started_at INTEGER,
  bot_loop_tripped_at        INTEGER,
  auto_respond_bot_id        TEXT REFERENCES users(id),
  created_by                 TEXT NOT NULL REFERENCES users(id),
  created_at                 INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_channels_ephemeral ON channels(is_ephemeral, archived_at);

CREATE TABLE channel_members (
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  hidden_at     TEXT,
  left_at       TEXT,
  position      INTEGER,
  notifications TEXT NOT NULL DEFAULT 'all' CHECK (notifications IN ('all', 'mentions', 'none')),
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE messages (
  id                                  TEXT PRIMARY KEY,
  channel_id                          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id                             TEXT REFERENCES users(id),
  content                             TEXT,
  thread_id                           TEXT REFERENCES messages(id),
  thread_title                        TEXT,
  thread_title_updated_at             INTEGER,
  type                                TEXT NOT NULL DEFAULT 'message',
  message_type                        TEXT NOT NULL DEFAULT 'human'
    CHECK (message_type IN ('human', 'response', 'progress', 'tool_output', 'thinking')),
  process_id                          TEXT,
  process_status                      TEXT,
  process_error_text                  TEXT,
  metadata                            TEXT,
  process_input_tokens                INTEGER,
  process_output_tokens               INTEGER,
  process_cache_creation_input_tokens INTEGER,
  process_cache_read_input_tokens     INTEGER,
  idempotency_key                     TEXT,
  resolved_at                         INTEGER,
  resolved_by                         TEXT,
  edited_at                           INTEGER,
  deleted_at                          INTEGER,
  created_at                          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at ASC);
CREATE INDEX idx_messages_process ON messages(process_id) WHERE process_id IS NOT NULL;
CREATE UNIQUE INDEX idx_messages_idempotency
  ON messages(channel_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content=messages,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TABLE reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_reactions_message ON reactions(message_id);

CREATE TABLE channel_reads (
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id           TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id TEXT,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE message_reads (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  read_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX idx_message_reads_message ON message_reads(message_id);

CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username   TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_mentions_user ON message_mentions(user_id);

CREATE TABLE link_previews (
  url_hash    TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  image_url   TEXT,
  site_name   TEXT,
  fetched_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE message_link_previews (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url_hash   TEXT NOT NULL REFERENCES link_previews(url_hash) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  PRIMARY KEY (message_id, url_hash)
);

CREATE TABLE drafts (
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE draft_attachments (
  user_id       TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, channel_id, attachment_id)
);

CREATE TABLE saved_drafts (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  scheduled_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_saved_drafts_channel_user ON saved_drafts(channel_id, user_id);

CREATE TABLE processes (
  id                          TEXT PRIMARY KEY,
  channel_id                  TEXT NOT NULL REFERENCES channels(id),
  message_id                  TEXT NOT NULL REFERENCES messages(id),
  user_id                     TEXT NOT NULL REFERENCES users(id),
  bot_id                      TEXT REFERENCES users(id),
  status                      TEXT NOT NULL DEFAULT 'running',
  tool_call_count             INTEGER NOT NULL DEFAULT 0,
  reply_count                 INTEGER NOT NULL DEFAULT 0,
  pid                         INTEGER,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  started_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT,
  ended_at                    TEXT
);
CREATE INDEX idx_processes_status ON processes(status);
CREATE INDEX idx_processes_started_at ON processes(started_at);
CREATE INDEX idx_processes_message_id ON processes(message_id);

CREATE TABLE channel_documents (
  channel_id             TEXT PRIMARY KEY REFERENCES channels(id),
  proof_slug             TEXT NOT NULL,
  proof_access_token     TEXT,
  proof_owner_secret     TEXT,
  proof_token_created_at TEXT,
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE widgets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT NOT NULL DEFAULT '⚡',
  code        TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE channel_widgets (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  widget_id  TEXT NOT NULL REFERENCES widgets(id),
  added_by   TEXT NOT NULL REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, widget_id)
);
CREATE INDEX idx_channel_widgets_widget ON channel_widgets(widget_id);
CREATE INDEX idx_channel_widgets_channel ON channel_widgets(channel_id);

CREATE TABLE widget_kv (
  widget_id TEXT NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (widget_id, user_id, key)
);

CREATE TABLE channel_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  collapsed  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_channel_folders_user ON channel_folders(user_id);

CREATE TABLE channel_folder_items (
  folder_id  TEXT NOT NULL REFERENCES channel_folders(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, channel_id, user_id)
);
CREATE INDEX idx_channel_folder_items_user ON channel_folder_items(user_id);

CREATE TABLE kanban_boards (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL UNIQUE,
  columns    TEXT NOT NULL DEFAULT '["todo","in-progress","review","done"]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE kanban_cards (
  id                TEXT PRIMARY KEY,
  board_id          TEXT NOT NULL REFERENCES kanban_boards(id),
  column_key        TEXT NOT NULL DEFAULT 'todo',
  title             TEXT NOT NULL,
  description       TEXT,
  assignee          TEXT,
  priority          TEXT DEFAULT 'normal',
  position          REAL NOT NULL,
  source_message_id TEXT,
  metadata          TEXT,
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE kanban_activity (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pinned_messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  pinned_by  TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_pinned_messages_channel ON pinned_messages(channel_id);

CREATE TABLE push_subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE push_preferences (
  user_id              TEXT PRIMARY KEY REFERENCES users(id),
  enabled              INTEGER NOT NULL DEFAULT 1,
  notify_mentions_only INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE schedules (
  id         TEXT PRIMARY KEY DEFAULT 'default',
  data       TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sync_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE error_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  method        TEXT,
  path          TEXT,
  error_message TEXT,
  stack         TEXT,
  timestamp     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE metrics (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  data      TEXT NOT NULL
);
CREATE INDEX idx_metrics_timestamp ON metrics(timestamp);

CREATE TABLE webhooks (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token              TEXT NOT NULL REFERENCES api_tokens(token) ON DELETE CASCADE,
  token_id           TEXT NOT NULL,
  url                TEXT NOT NULL,
  secret             TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL,
  active             INTEGER NOT NULL DEFAULT 1,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_status        INTEGER,
  last_delivered_at  INTEGER,
  disabled_reason    TEXT,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_webhooks_user ON webhooks(user_id, active);
CREATE INDEX idx_webhooks_token_id ON webhooks(token_id);

CREATE TABLE webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  channel_id      TEXT,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_deliveries_pending ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE user_email_verifications (
  user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pending_email            TEXT NOT NULL,
  pending_email_normalized TEXT NOT NULL,
  token_hash               TEXT NOT NULL UNIQUE,
  expires_at               INTEGER NOT NULL,
  last_sent_at             INTEGER NOT NULL,
  send_count               INTEGER NOT NULL DEFAULT 1,
  window_started_at        INTEGER NOT NULL,
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX idx_user_email_verifications_pending
  ON user_email_verifications(pending_email_normalized);
CREATE INDEX idx_user_email_verifications_expires ON user_email_verifications(expires_at);

CREATE TABLE mfa_credentials (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  secret_iv         TEXT NOT NULL,
  last_used_step    INTEGER,
  enabled_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE mfa_enrollments (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  secret_iv         TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_mfa_enrollments_expires ON mfa_enrollments(expires_at);

CREATE TABLE mfa_challenges (
  token_hash         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose            TEXT NOT NULL CHECK (purpose IN ('verify', 'enroll')),
  secret_ciphertext  TEXT,
  secret_iv          TEXT,
  attempts_remaining INTEGER NOT NULL DEFAULT 5 CHECK (attempts_remaining >= 0),
  expires_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_mfa_challenges_user ON mfa_challenges(user_id);
CREATE INDEX idx_mfa_challenges_expires ON mfa_challenges(expires_at);

CREATE TABLE workspace_security (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  require_mfa_for_humans INTEGER NOT NULL DEFAULT 0 CHECK (require_mfa_for_humans IN (0, 1)),
  updated_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at             INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO workspace_security (id, require_mfa_for_humans) VALUES (1, 0);

-- Built-in feedback room. It is product state rather than deploy-time seed
-- data, so every instance receives it through the baseline migration.
INSERT INTO users (id, username, password_hash, display_name, name_color, role, is_admin)
VALUES ('feedback-bot', 'feedback-bot', '!', 'Dan', '#7c3aed', 'bot', 0);
INSERT INTO channels (id, name, description, is_private, created_by)
VALUES ('feedback', 'feedback', 'Send feedback to the team — we read everything.', 0, 'feedback-bot');
INSERT INTO channel_members (channel_id, user_id, notifications)
VALUES ('feedback', 'feedback-bot', 'none');
