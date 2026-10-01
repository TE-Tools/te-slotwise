-- Slotwise Grundschema.
-- Zeiten werden als ISO-8601-Text in UTC gespeichert (z. B. 2026-10-05T12:30:00.000Z),
-- die Zeitzone für Anzeige und Eingabe steht separat am Arbeitsbereich bzw. Slot.
-- Mandantentrennung: Jede mandantenbezogene Tabelle trägt workspace_id. Beziehungen
-- innerhalb eines Arbeitsbereichs laufen über zusammengesetzte Fremdschlüssel
-- (id, workspace_id), damit die Datenbank selbst keine Verknüpfung über
-- Arbeitsbereichsgrenzen hinweg zulässt.

CREATE TABLE users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name           TEXT NOT NULL DEFAULT '',
  email_verified_at      TEXT,
  notify_booking_updates INTEGER NOT NULL DEFAULT 1, -- Mails zu eigenen Buchungen
  notify_new_requests    INTEGER NOT NULL DEFAULT 1, -- Mails an Anbieter bei neuen Anfragen
  created_at             TEXT NOT NULL,
  deleted_at             TEXT
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_tokens (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL COLLATE NOCASE,
  next_path  TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX login_tokens_email ON login_tokens(email, created_at);

CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('personal', 'organization')),
  description    TEXT NOT NULL DEFAULT '',
  timezone       TEXT NOT NULL,
  public_enabled INTEGER NOT NULL DEFAULT 0,
  public_token   TEXT NOT NULL UNIQUE,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE memberships (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'member')),
  created_at   TEXT NOT NULL,
  UNIQUE (workspace_id, user_id),
  UNIQUE (id, workspace_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE ws_groups (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  UNIQUE (id, workspace_id)
);

CREATE TABLE group_members (
  group_id      TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (group_id, membership_id),
  FOREIGN KEY (group_id, workspace_id) REFERENCES ws_groups(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, workspace_id) REFERENCES memberships(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX group_members_membership ON group_members(membership_id);

CREATE TABLE offerings (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  duration_min          INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  buffer_min            INTEGER NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 240),
  location              TEXT NOT NULL DEFAULT '',
  online_info           TEXT NOT NULL DEFAULT '',
  default_capacity      INTEGER NOT NULL DEFAULT 1 CHECK (default_capacity BETWEEN 1 AND 500),
  confirmation_mode     TEXT NOT NULL DEFAULT 'manual' CHECK (confirmation_mode IN ('manual', 'auto')),
  hold_on_request       INTEGER NOT NULL DEFAULT 0, -- 1 = offene Anfrage blockiert die Zeit für andere
  allow_self_cancel     INTEGER NOT NULL DEFAULT 1, -- Buchende dürfen bestätigte Termine selbst absagen
  cancel_cutoff_hours   INTEGER NOT NULL DEFAULT 24 CHECK (cancel_cutoff_hours BETWEEN 0 AND 720),
  min_notice_hours      INTEGER NOT NULL DEFAULT 0 CHECK (min_notice_hours BETWEEN 0 AND 720),
  visibility            TEXT NOT NULL DEFAULT 'internal'
                        CHECK (visibility IN ('public', 'groups', 'people', 'internal')),
  archived_at           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (id, workspace_id)
);

-- Zielgruppe eines Angebots: entweder eine Gruppe oder eine einzelne Mitgliedschaft.
CREATE TABLE offering_audience (
  id            TEXT PRIMARY KEY,
  offering_id   TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  group_id      TEXT,
  membership_id TEXT,
  CHECK ((group_id IS NULL) <> (membership_id IS NULL)),
  FOREIGN KEY (offering_id, workspace_id) REFERENCES offerings(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, workspace_id) REFERENCES ws_groups(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, workspace_id) REFERENCES memberships(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX offering_audience_group ON offering_audience(offering_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX offering_audience_member ON offering_audience(offering_id, membership_id) WHERE membership_id IS NOT NULL;

-- Eine Serie hält fest, mit welchen Parametern mehrere Slots auf einmal erzeugt wurden.
CREATE TABLE slot_series (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  offering_id  TEXT NOT NULL,
  params       TEXT NOT NULL, -- JSON
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (offering_id, workspace_id) REFERENCES offerings(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE slots (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  offering_id       TEXT NOT NULL,
  series_id         TEXT,
  -- fixed  = fester Termin (Beginn und Ende stehen fest)
  -- window = freies Zeitfenster: Buchende wählen eine Wunschzeit innerhalb des Fensters
  kind              TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'window')),
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  timezone          TEXT NOT NULL,
  buffer_min        INTEGER NOT NULL DEFAULT 0,
  location          TEXT,          -- NULL = vom Angebot übernehmen
  online_info       TEXT,          -- NULL = vom Angebot übernehmen
  capacity          INTEGER NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 500),
  confirmation_mode TEXT CHECK (confirmation_mode IS NULL OR confirmation_mode IN ('manual', 'auto')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
  visibility        TEXT NOT NULL DEFAULT 'inherit'
                    CHECK (visibility IN ('inherit', 'public', 'groups', 'people', 'internal')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (offering_id, workspace_id) REFERENCES offerings(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (series_id, workspace_id) REFERENCES slot_series(id, workspace_id) ON DELETE SET NULL
);
CREATE INDEX slots_ws_start ON slots(workspace_id, starts_at);
CREATE INDEX slots_offering ON slots(offering_id, starts_at);

CREATE TABLE slot_audience (
  id            TEXT PRIMARY KEY,
  slot_id       TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  group_id      TEXT,
  membership_id TEXT,
  CHECK ((group_id IS NULL) <> (membership_id IS NULL)),
  FOREIGN KEY (slot_id, workspace_id) REFERENCES slots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, workspace_id) REFERENCES ws_groups(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, workspace_id) REFERENCES memberships(id, workspace_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX slot_audience_group ON slot_audience(slot_id, group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX slot_audience_member ON slot_audience(slot_id, membership_id) WHERE membership_id IS NOT NULL;

CREATE TABLE invitations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'staff', 'member')),
  group_id      TEXT,
  offering_id   TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  expires_at    TEXT NOT NULL,
  invited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at   TEXT,
  send_count    INTEGER NOT NULL DEFAULT 0,
  last_sent_at  TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (group_id, workspace_id) REFERENCES ws_groups(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (offering_id, workspace_id) REFERENCES offerings(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX invitations_ws ON invitations(workspace_id, status);
CREATE INDEX invitations_email ON invitations(email, status);

-- Eine Buchung hat ihre eigene Zeit (starts_at/ends_at). Bei festen Slots entspricht sie
-- zunächst dem Slot, bei Zeitfenstern der Wunschzeit; beide Seiten können sie später ändern.
-- Änderungsvorschläge stehen in proposed_* und gelten erst, wenn die andere Seite zustimmt.
CREATE TABLE bookings (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  slot_id             TEXT NOT NULL,
  offering_id         TEXT NOT NULL,
  user_id             TEXT NOT NULL REFERENCES users(id),
  status              TEXT NOT NULL CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled', 'withdrawn')),
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  holds_seat          INTEGER NOT NULL DEFAULT 0, -- blockiert eine offene Anfrage die Zeit?
  note                TEXT NOT NULL DEFAULT '',
  proposed_starts_at  TEXT,
  proposed_ends_at    TEXT,
  proposed_by         TEXT CHECK (proposed_by IS NULL OR proposed_by IN ('provider', 'booker')),
  proposal_note       TEXT NOT NULL DEFAULT '',
  cancel_requested_at TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (slot_id, workspace_id) REFERENCES slots(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (offering_id, workspace_id) REFERENCES offerings(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX bookings_slot ON bookings(slot_id, status);
CREATE INDEX bookings_offering_time ON bookings(offering_id, starts_at);
CREATE INDEX bookings_user ON bookings(user_id, created_at);
CREATE INDEX bookings_ws ON bookings(workspace_id, status);
-- Eine Person hat pro Slot höchstens eine aktive Buchung.
CREATE UNIQUE INDEX bookings_one_active ON bookings(slot_id, user_id) WHERE status IN ('requested', 'confirmed');

-- Letzte Verteidigungslinie gegen Überbuchung, zusätzlich zur Prüfung in der Transaktion:
-- Pro Angebot dürfen sich höchstens "Kapazität" belegende Buchungen zeitlich überschneiden
-- (inklusive Pufferzeit). Belegend = bestätigt, oder angefragt mit holds_seat = 1.
CREATE TRIGGER bookings_capacity_insert
BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed' OR (NEW.status = 'requested' AND NEW.holds_seat = 1)
BEGIN
  SELECT RAISE(ABORT, 'slot_full')
  WHERE (SELECT COUNT(*) FROM bookings b JOIN offerings o ON o.id = b.offering_id
         WHERE b.offering_id = NEW.offering_id
           AND (b.status = 'confirmed' OR (b.status = 'requested' AND b.holds_seat = 1))
           AND b.starts_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ends_at, '+' || o.buffer_min || ' minutes')
           AND strftime('%Y-%m-%dT%H:%M:%fZ', b.ends_at, '+' || o.buffer_min || ' minutes') > NEW.starts_at)
        >= (SELECT capacity FROM slots WHERE id = NEW.slot_id);
END;

CREATE TRIGGER bookings_capacity_update
BEFORE UPDATE OF status, starts_at, ends_at, holds_seat ON bookings
WHEN NEW.status = 'confirmed' OR (NEW.status = 'requested' AND NEW.holds_seat = 1)
BEGIN
  SELECT RAISE(ABORT, 'slot_full')
  WHERE (SELECT COUNT(*) FROM bookings b JOIN offerings o ON o.id = b.offering_id
         WHERE b.offering_id = NEW.offering_id AND b.id <> NEW.id
           AND (b.status = 'confirmed' OR (b.status = 'requested' AND b.holds_seat = 1))
           AND b.starts_at < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ends_at, '+' || o.buffer_min || ' minutes')
           AND strftime('%Y-%m-%dT%H:%M:%fZ', b.ends_at, '+' || o.buffer_min || ' minutes') > NEW.starts_at)
        >= (SELECT capacity FROM slots WHERE id = NEW.slot_id);
END;

CREATE TABLE booking_events (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX booking_events_booking ON booking_events(booking_id, created_at);

-- Benachrichtigungen (Outbox). Buchungsstatus und Versandstatus sind bewusst getrennt.
CREATE TABLE notifications (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  recipient_email   TEXT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'email',
  template          TEXT NOT NULL,
  payload           TEXT NOT NULL, -- JSON, enthält nie geheime Links
  retryable         INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'not_configured', 'logged')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  sent_at           TEXT
);
CREATE INDEX notifications_status ON notifications(status, created_at);
CREATE INDEX notifications_ws ON notifications(workspace_id, created_at);
