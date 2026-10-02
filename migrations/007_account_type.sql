-- Kontoart: Jede Person ist zunächst Schüler:in (bucht nur). Wer Termine anbieten will, stellt im
-- Profil auf Lehrkraft um – erst dann lassen sich Arbeitsbereiche anlegen.
ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'student' CHECK (account_type IN ('student', 'teacher'));
-- Wer schon einen Arbeitsbereich verwaltet, bleibt Lehrkraft.
UPDATE users SET account_type = 'teacher' WHERE id IN (SELECT user_id FROM memberships WHERE role IN ('owner', 'admin', 'staff'));
