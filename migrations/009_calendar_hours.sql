-- Sichtbarer Zeitraum im Wochen-/Tageskalender (volle Stunden, NULL = automatisch 8–19 Uhr bzw. so weit Termine reichen).
ALTER TABLE workspaces ADD COLUMN cal_from_hour INTEGER;
ALTER TABLE workspaces ADD COLUMN cal_to_hour INTEGER;
