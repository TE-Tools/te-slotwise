-- Schülerübersicht und Abrechnung: Preise, Anwesenheit und Zahlungen pro Termin.

-- Standardpreis des Arbeitsbereichs in Cent (NULL = noch nicht festgelegt) und worauf er sich bezieht:
-- lesson = pro Termin (Unterrichtsstunde), hour = pro 60 Minuten (anteilig nach Dauer).
ALTER TABLE workspaces ADD COLUMN default_price_cents INTEGER CHECK (default_price_cents IS NULL OR default_price_cents BETWEEN 0 AND 10000000);
ALTER TABLE workspaces ADD COLUMN price_unit TEXT NOT NULL DEFAULT 'lesson' CHECK (price_unit IN ('lesson', 'hour'));

-- Individueller Preis pro Person (Schüler:in) in einem Arbeitsbereich. Gilt statt des Standardpreises.
CREATE TABLE student_rates (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  price_cents  INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Nach dem Termin abhaken:
--   attended      = stattgefunden (wird berechnet)
--   absent_billed = nicht erschienen / zu spät abgesagt (wird berechnet)
--   absent        = ausgefallen / entschuldigt (wird nicht berechnet)
--   NULL          = noch nicht abgehakt
-- price_cents wird beim Abhaken festgeschrieben, damit spätere Preisänderungen alte Termine nicht verändern.
ALTER TABLE bookings ADD COLUMN attendance TEXT CHECK (attendance IS NULL OR attendance IN ('attended', 'absent_billed', 'absent'));
ALTER TABLE bookings ADD COLUMN price_cents INTEGER CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 10000000);
ALTER TABLE bookings ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents BETWEEN 0 AND 10000000);
ALTER TABLE bookings ADD COLUMN paid_at TEXT;
ALTER TABLE bookings ADD COLUMN checked_at TEXT;
CREATE INDEX bookings_ws_user_time ON bookings(workspace_id, user_id, starts_at);

-- Wie wurde eine Sitzung angemeldet? Nach einer Anmeldung per E-Mail-Link darf kurz danach ein neues
-- Passwort ohne das alte gesetzt werden ("Passwort vergessen").
ALTER TABLE sessions ADD COLUMN via_link INTEGER NOT NULL DEFAULT 0;
