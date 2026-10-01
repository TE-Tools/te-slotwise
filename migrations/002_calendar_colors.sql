-- Wochenkalender-Farben und Anzeige belegter Termine.

-- normal = hellgrün (gern buchbar), reluctant = gelb (anfragbar, aber eher ungern; immer manuelle Bestätigung)
ALTER TABLE slots ADD COLUMN preference TEXT NOT NULL DEFAULT 'normal' CHECK (preference IN ('normal', 'reluctant'));

-- Wie belegte Termine (dunkelgrün) für andere angezeigt werden:
-- hidden = gar nicht, anonymous = "Belegt", names = mit Vornamen der buchenden Person
ALTER TABLE workspaces ADD COLUMN show_booked_public TEXT NOT NULL DEFAULT 'anonymous' CHECK (show_booked_public IN ('hidden', 'anonymous', 'names'));
ALTER TABLE workspaces ADD COLUMN show_booked_members TEXT NOT NULL DEFAULT 'anonymous' CHECK (show_booked_members IN ('hidden', 'anonymous', 'names'));
