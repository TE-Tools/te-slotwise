// Schüler:innen ohne App: Die Lehrkraft legt sie nur mit Namen an. Damit Buchungen, Abrechnung und
// Kalender unverändert funktionieren, bekommen sie ein Konto mit Platzhalter-Adresse unter der
// reservierten Domain .invalid (RFC 6761) – dorthin geht nie eine E-Mail, anmelden kann sich damit niemand.

export const OFFLINE_DOMAIN = 'ohne-app.invalid';

export const isOfflineEmail = (email: string | null | undefined) => !!email && email.toLowerCase().endsWith(`@${OFFLINE_DOMAIN}`);

/** E-Mail zum Anzeigen: Platzhalter-Adressen bleiben unsichtbar. */
export const shownEmail = (email: string | null | undefined) => (isOfflineEmail(email) ? '' : (email ?? ''));
