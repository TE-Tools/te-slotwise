-- Anschrift und Geburtstag (für Rechnungen), von der Person selbst oder ihrer Lehrkraft gepflegt.
ALTER TABLE users ADD COLUMN address_street TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN address_zip TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN address_city TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN birth_date TEXT;            -- YYYY-MM-DD
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN billing_name TEXT NOT NULL DEFAULT ''; -- abweichender Rechnungsempfänger, z. B. Eltern

-- Wofür ist der Termin? Gruppe des Arbeitsbereichs (z. B. Instrument), bei mehreren Gruppen wählt die buchende Person.
ALTER TABLE bookings ADD COLUMN group_id TEXT REFERENCES ws_groups(id) ON DELETE SET NULL;
