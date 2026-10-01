# Datenschutz – technische Umsetzung und offene Entscheidungen

> Dieses Dokument beschreibt, was die Software technisch tut. Es ist **keine** rechtliche Prüfung
> und ersetzt keine Datenschutzerklärung. Eine vollständige rechtliche Konformität (z. B. DSGVO)
> wird nicht behauptet.

## Welche personenbezogenen Daten werden gespeichert?

| Daten | Zweck | Wer sieht sie |
|---|---|---|
| E-Mail-Adresse | Anmeldung, Benachrichtigungen | die Person selbst; Verwaltende von Bereichen, in denen sie Mitglied ist oder gebucht hat |
| Anzeigename | Zuordnung von Buchungen | wie oben |
| Mitgliedschaften, Rollen, Gruppen | Berechtigungen | die Person sieht nur eigene Gruppen; Verwaltende sehen alle im eigenen Bereich |
| Buchungen, Nachrichten, Verlauf | Terminverwaltung | die Person selbst und Verwaltende des Bereichs |
| Anwesenheit, Preis und bezahlter Betrag pro Termin, individueller Preis | Abrechnung des Unterrichts (Schülerübersicht) | Eigentümer:innen und Administrator:innen des Bereichs; die Person selbst über den Datenexport |
| Passwort (nur falls festgelegt) | Anmeldung | niemand – gespeichert nur als gesalzener PBKDF2-Hash |
| Benachrichtigungsprotokoll (Empfänger, Art, Status, Fehler) | Nachvollziehbarkeit des Versands | Verwaltende des Bereichs |
| Sitzungen, Anmeldelinks | Anmeldung | niemand (nur Hashes) |

Nicht gespeichert werden: Passwörter im Klartext, IP-Adressen (die Missbrauchsbremse hält sie nur kurz im
Arbeitsspeicher), Browser-Kennungen, Tracking- oder Analysedaten. Es gibt keine Drittanbieter-Skripte.

Öffentlich sichtbar sind nur ausdrücklich veröffentlichte Angaben (Name und Beschreibung des
Bereichs, öffentliche Angebote) und freie Zeiten. Belegte Zeiten erscheinen je nach Einstellung des
Arbeitsbereichs gar nicht, anonym („Belegt“) oder mit **Vornamen** – nie mit E-Mail-Adresse. Die
Anzeige mit Vornamen sollte nur mit Einverständnis der Buchenden gewählt werden. Online-Informationen (z. B. Videolink) sehen nur bestätigte Buchende.

## Aufbewahrung und Löschung

- Abgelaufene Sitzungen und Anmeldelinks werden automatisch gelöscht.
- Versandprotokolle werden nach `RETENTION_NOTIFICATION_DAYS` (Standard 180) Tagen gelöscht, Buchungen optional `RETENTION_BOOKING_DAYS` Tage nach Terminende. Abgehakte oder (teil)bezahlte Termine bleiben davon ausgenommen, weil sie für die Abrechnung gebraucht werden (steuerliche Aufbewahrungspflichten beachten).
- **Konto löschen** (Profil): Offene/künftige Buchungen werden abgesagt, Mitgliedschaften und Sitzungen
  gelöscht, E-Mail und Name im Konto ersetzt; in Benachrichtigungsprotokollen werden Empfängeradresse und
  Inhalt geleert. Vergangene Buchungen bleiben für die Anbieter ohne Personenbezug erhalten.
  Wer alleinige:r Eigentümer:in eines Bereichs ist, muss diesen zuerst übertragen oder löschen.
- **Arbeitsbereich löschen**: entfernt alle Daten des Bereichs endgültig (Angebote, Slots, Buchungen,
  Gruppen, Einladungen, Protokolle).
- **Export**: Profil → „Daten exportieren“ liefert eine JSON-Datei mit Profil, Mitgliedschaften,
  Gruppen und Buchungen.

## Offene Entscheidungen für den Betreiber

1. Betreiberangaben (`OPERATOR_*`) eintragen; `/impressum` und `/datenschutz` werden daraus erzeugt. Die Texte sind nicht rechtlich geprüft.
2. Verhältnis Plattformbetreiber ↔ Arbeitsbereich-Inhaber (vermutlich Auftragsverarbeitung) – rechtlich klären.
3. Speicherfrist für Buchungen festlegen (`RETENTION_BOOKING_DAYS`, derzeit 0 = unbegrenzt).
4. E-Mail-Anbieter (vorgesehen: Resend) und Hosting (Cloudflare): Auftragsverarbeitungsverträge abschließen.
5. Ob Arbeitsbereiche Daten ihrer Mitglieder exportieren dürfen/sollen.
6. Hosting-Standort und Backup-Konzept (Verschlüsselung, Aufbewahrung der Sicherungen).
7. Einwilligungen bei Minderjährigen (relevant für Musikunterricht).
8. Aufbewahrungsdauer der Abrechnungsdaten (Anwesenheit, Preise, Zahlungen) festlegen; sie werden derzeit nicht automatisch gelöscht.
