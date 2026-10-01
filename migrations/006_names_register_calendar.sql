-- Vor- und Nachname, normale Registrierung (Passwort), Kalender-Abo (iCalendar) und App-Zugänge (API).

ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
-- Bisherige Anzeigenamen aufteilen: erstes Wort = Vorname, Rest = Nachname.
UPDATE users SET
  first_name = CASE WHEN instr(trim(display_name), ' ') > 0 THEN substr(trim(display_name), 1, instr(trim(display_name), ' ') - 1) ELSE trim(display_name) END,
  last_name  = CASE WHEN instr(trim(display_name), ' ') > 0 THEN trim(substr(trim(display_name), instr(trim(display_name), ' ') + 1)) ELSE '' END
WHERE deleted_at IS NULL;

-- Geheimer Link für das Kalender-Abo (webcal/https). Neu erzeugen macht den alten ungültig.
ALTER TABLE users ADD COLUMN calendar_token TEXT;
CREATE UNIQUE INDEX users_calendar_token ON users(calendar_token) WHERE calendar_token IS NOT NULL;

-- Zugänge für andere Apps (z. B. Familienplaner): POST /api/login liefert ein Token,
-- damit werden die eigenen Termine gelesen. Gespeichert nur als Hash.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
