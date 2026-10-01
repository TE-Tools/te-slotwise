-- Installierbare App (PWA) und Push-Benachrichtigungen.

-- Ein Eintrag pro Gerät/Browser, auf dem eine Person Push eingeschaltet hat.
CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  label           TEXT NOT NULL DEFAULT '', -- grobe Gerätebezeichnung, z. B. "Android · Chrome"
  created_at      TEXT NOT NULL,
  last_success_at TEXT,
  failures        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- Einstellungen der Plattform, z. B. automatisch erzeugte VAPID-Schlüssel für Web-Push.
CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- E-Mail abbestellbar, wenn Push genügt (gilt nur, solange Push auf mindestens einem Gerät aktiv ist).
ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;
