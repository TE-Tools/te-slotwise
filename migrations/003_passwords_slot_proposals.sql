-- Passwort-Anmeldung (zusätzlich zum E-Mail-Link) und Vorschläge eines anderen Slots durch Buchende.

ALTER TABLE users ADD COLUMN password_hash TEXT;          -- NULL = kein Passwort, nur E-Mail-Link
ALTER TABLE users ADD COLUMN password_updated_at TEXT;
ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;           -- nach zu vielen Fehlversuchen kurz gesperrt

-- Schlägt die buchende Person einen anderen (vorgegebenen) Slot vor, steht er hier.
-- Nimmt die Anbieterseite an, wechselt die Buchung auf diesen Slot.
ALTER TABLE bookings ADD COLUMN proposed_slot_id TEXT;
