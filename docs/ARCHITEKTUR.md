# TE-Slotwise – Produktgrenzen und Architektur

## Produktgrenzen (MVP)

Enthalten:

- Anmeldung/Registrierung per E-Mail-Link (ohne Passwort), Profil, Benachrichtigungseinstellungen, Datenexport, Kontolöschung
- Arbeitsbereiche (persönlich oder Organisation), Mitglieder mit Rollen, Wechsel zwischen Bereichen
- Einladungen per E-Mail (Bereich, Gruppe oder Angebot), erneut senden, widerrufen, 7 Tage gültig
- Gruppen mit frei wählbaren Namen
- Angebote mit Dauer, Puffer, Ort, Online-Info, Plätzen und Buchungsregeln
- Slots: **feste Termine** und **freie Zeitfenster** (Buchende wählen eine Wunschzeit), einzeln oder als Serie
- Sichtbarkeit pro Angebot oder Slot: öffentlich, ausgewählte Gruppen/Personen, intern
- Buchung mit manueller oder automatischer Bestätigung, Schutz gegen Doppelbuchung
- **Verschieben mit Gegenbestätigung**: Jede Seite kann eine andere Zeit vorschlagen; fix ist ein Termin erst, wenn beide zugestimmt haben
- Großer **Wochenkalender** (Zeitachse) für Anbieter und Buchende, dazu Liste und Monatsübersicht, mobil nutzbar
- **Farben im Kalender**: hellgrün = frei, gelb = anfragbar aber eher ungern (immer manuelle Bestätigung), dunkelgrün = belegt, grau = gesperrt (keine Freigabe). Ob belegte Termine für andere anonym, mit Vornamen oder gar nicht erscheinen, ist pro Arbeitsbereich getrennt für öffentlich und Mitglieder einstellbar
- Rolle **Mitarbeiter:in** (Slots und Buchungen verwalten)
- Impressum und Datenschutzseite aus Betreiberangaben, automatische Löschfristen
- E-Mail-Benachrichtigungen mit Versandprotokoll und erneutem Versand
- Teilen per Web Share API und „Link kopieren“

Nicht enthalten (architektonisch vorbereitet, siehe unten): Zahlungen/Tarife, Kalender-Synchronisierung,
automatisch wiederkehrende Verfügbarkeiten, Teilnehmerlisten-Funktionen, weitere Kanäle (SMS, Push),
Mehrsprachigkeit, Kontaktimport, WhatsApp-Automatisierung.

## Rollen

| Rolle | Rechte |
|---|---|
| Eigentümer:in | alles, inkl. Arbeitsbereich löschen |
| Administrator:in | alles außer Löschen des Arbeitsbereichs |
| Mitarbeiter:in (`staff`) | Slots und Buchungen verwalten, Kalender sehen, selbst buchen |
| Mitglied | sehen und buchen, was für sie freigegeben ist |
| Externe Person (ohne Mitgliedschaft) | öffentliche Slots buchen, eigene Buchungen verwalten |
| Öffentliche Besucher | nur öffentliche Angebote und freie Zeiten sehen; zum Buchen anmelden |

Routen prüfen immer ein **Recht** (`src/authz.ts`, `can(role, permission)`), nie direkt eine Rolle.
Neue Rollen (z. B. Lehrkraft) werden dort ergänzt.

## Technik

- Läuft auf **Cloudflare Pages Functions + D1** (online) und auf **Node.js + SQLite** (lokal, Tests). Gemeinsame Datenbank-Schnittstelle `src/db.ts` mit den Umsetzungen `db-d1.ts` und `db-node.ts`; dieselben SQL-Migrationen für beide.
- **Hono** als Web-Framework, serverseitig gerendertes HTML (automatisches Escaping), wenig JavaScript im Browser
- E-Mail über **Resend** (HTTP, beide Plattformen) oder SMTP (nur Node)
- Wartung (Mails nachversenden, Löschfristen): unter Node alle 5 Minuten, auf Cloudflare höchstens alle 10 Minuten im Hintergrund normaler Anfragen

Module:

| Pfad | Aufgabe |
|---|---|
| `src/db.ts`, `src/db-node.ts`, `src/db-d1.ts` | Datenbank-Schnittstelle, Node-SQLite (mit Transaktionen) und Cloudflare D1 |
| `src/server.ts`, `src/worker.ts`, `functions/` | Einstieg Node bzw. Cloudflare Pages |
| `src/views/week.ts` | Wochenkalender |
| `src/authz.ts` | Rollen, Rechte, Sichtbarkeitsregeln als SQL |
| `src/time.ts` | Zeitzonen-Umrechnung und Anzeige (Sommer-/Winterzeit) |
| `src/services/*` | Fachlogik: Anmeldung, Arbeitsbereiche, Angebote, Slots, Buchungen, Benachrichtigungen |
| `src/mail/*` | Versandkanal (Schnittstelle `Mailer`) und Texte |
| `src/routes/*` | HTTP-Routen; prüfen Anmeldung und Berechtigung |
| `src/views/*` | HTML-Bausteine |
| `public/` | CSS, kleines JS (Kopieren/Teilen, Rückfragen), Icon |

## Sicherheit

- Anmeldung: Einmal-Token (256 Bit, 15 Min. gültig), gespeichert nur als SHA-256-Hash. Der Link
  führt auf eine Bestätigungsseite; erst das Absenden verbraucht das Token (Link-Vorschauen in
  Mailprogrammen melden niemanden an). Die Anmeldung bestätigt die E-Mail-Adresse.
- Sitzungen: zufälliges Token im `HttpOnly`-, `SameSite=Lax`-Cookie (`Secure` bei https), in der DB nur als Hash, 30 Tage gleitend.
- CSRF: Herkunftsprüfung (`Origin`/`Sec-Fetch-Site`) für alle Formulare.
- Content-Security-Policy ohne Inline-Skripte, `frame-ancestors 'none'`, Referrer nur gleiche Herkunft.
- Jede Arbeitsbereichs-Route lädt den Bereich **nur über die Mitgliedschaft** der angemeldeten Person
  (`requireWs`) und prüft das Recht. Fremde oder unbekannte IDs liefern 404 – die Existenz wird nicht verraten.
- Alle IDs sind zufällig (96 Bit), öffentliche Links 256 Bit; der öffentliche Link lässt sich neu erzeugen.
- Einladungslinks gewähren allein keinen Zugriff: Annahme nur, wenn die angemeldete, bestätigte Adresse der eingeladenen entspricht.
- Missbrauchsbremse: Anmeldelinks (pro IP und pro Adresse), Einladungen pro Bereich, Buchungen pro Person, neue Arbeitsbereiche pro Person.

## Mandantentrennung

- Jede mandantenbezogene Tabelle hat `workspace_id`.
- Verknüpfungen innerhalb eines Bereichs (Gruppenmitglieder, Zielgruppen, Slots, Buchungen) laufen über
  **zusammengesetzte Fremdschlüssel** `(id, workspace_id)`. Die Datenbank lehnt damit z. B. ab, ein
  Mitglied aus Bereich A in eine Gruppe von Bereich B einzutragen.
- Alle Abfragen in Verwaltungsrouten filtern zusätzlich nach `workspace_id`.

## Datenmodell

| Tabelle | Inhalt |
|---|---|
| `users` | Konto, E-Mail (bestätigt), Anzeigename, Benachrichtigungswünsche |
| `sessions`, `login_tokens` | Sitzungen und Anmeldelinks (nur Hashes) |
| `workspaces` | Arbeitsbereich, Art, Zeitzone, öffentlicher Link |
| `memberships` | Person ↔ Bereich mit Rolle |
| `invitations` | Einladung mit Rolle, optional Gruppe/Angebot, Frist, Status, Versandzähler |
| `ws_groups`, `group_members` | Gruppen und Zugehörigkeiten |
| `offerings`, `offering_audience` | Angebote, Buchungsregeln, Zielgruppe (Gruppen + Personen) |
| `slot_series` | Parameter, mit denen mehrere Slots erzeugt wurden |
| `slots`, `slot_audience` | Feste Slots oder Zeitfenster, eigene Sichtbarkeit optional |
| `bookings` | Buchung mit **eigener Zeit** (`starts_at`/`ends_at`), Status, offenem Zeitvorschlag (`proposed_*`, `proposed_by`) |
| `booking_events` | Statushistorie und Änderungen |
| `notifications` | Outbox mit Versandstatus, Versuchen, Fehlertext |

Zeiten werden als UTC-ISO-Text gespeichert, die IANA-Zeitzone steht am Bereich und am Slot.
Lokale Eingaben werden einzeln umgerechnet; in der Zeitumstellung nicht existierende Uhrzeiten
werden abgelehnt (bei Serien übersprungen), doppelte Uhrzeiten nehmen die frühere.

## Buchungsablauf

1. Buchende wählen einen festen Slot oder eine Wunschzeit (5-Minuten-Raster) in einem Zeitfenster.
2. **Automatische Bestätigung**: sofort `bestätigt`, wenn die Zeit frei ist (die Anbieterseite hat vorab zugestimmt).
   **Manuelle Bestätigung**: `angefragt`. Mehrere – auch überlappende – Anfragen sind erlaubt, solange
   „Offene Anfragen blockieren die Zeit“ ausgeschaltet ist (Standard).
3. Die Anbieterseite kann bestätigen, ablehnen, absagen oder **eine andere Zeit vorschlagen**.
4. Buchende können eine offene Anfrage zurückziehen oder ihre Wunschzeit ändern; bei festen
   Terminen schlagen sie eine andere Zeit vor.
5. Ein Vorschlag wird erst wirksam, wenn **die andere Seite zustimmt**. Bei festen Terminen gilt bis
   dahin die alte Zeit; Ablehnen verwirft den Vorschlag.
6. Absage durch Buchende: direkt, wenn erlaubt und vor der Frist – sonst als „Absage angefragt“.

Überbuchungsschutz: Unter Node laufen Buchungsänderungen in einer `BEGIN IMMEDIATE`-Transaktion. D1 kennt keine
interaktiven Transaktionen; entscheidend sind deshalb Datenbank-Trigger, die auf beiden Plattformen verhindern, dass sich pro Angebot
mehr belegende Buchungen zeitlich überschneiden (inkl. Pufferzeit), als der Slot Plätze hat. Ein
eindeutiger Index verhindert, dass eine Person denselben Slot zweimal aktiv bucht.

Angezeigte Status: verfügbar, angefragt, teilweise gebucht, ausgebucht, bestätigt, abgelehnt,
abgesagt, zurückgezogen, geschlossen, Entwurf, vergangen.

## Benachrichtigungen

Fachliche Änderungen schreiben in derselben Transaktion Einträge in `notifications` (Outbox). Der Versand
läuft danach und setzt nur den Versandstatus (`gesendet`, `fehlgeschlagen`, `nicht eingerichtet`, `nur Konsole`).
Fehlgeschlagene Mails werden automatisch bis zu dreimal neu versucht und lassen sich im Verwaltungsbereich
erneut senden. Mails mit geheimen Links (Anmeldung, Einladung) werden sofort versendet; protokolliert wird
ohne Link. Weitere Kanäle implementieren die Schnittstelle `Mailer` bzw. erweitern `notifications.channel`.

## Erweiterbarkeit

- **Bezahlung/Tarife**: eigene Tabellen (z. B. `subscriptions`, `invoices`) mit `workspace_id` bzw. `user_id`; keine Änderung am Buchungskern nötig. Preise/Anbieter sind bewusst offen.
- **Mehrere Mitarbeitende**: Rolle `staff` ist nutzbar; als Nächstes ein optionales `slots.host_membership_id` (wer den Termin gibt).
- **Gruppentermine**: Kapazität > 1 funktioniert bereits; Teilnehmerlisten sind eine reine Ansicht auf `bookings`.
- **Kalender-Sync**: ICS-Export pro Person/Bereich aus `bookings` ableitbar.
- **Wiederkehrende Verfügbarkeiten**: `slot_series.params` speichert die Regeln schon.
- **Mehrsprachigkeit**: Texte liegen in Views/Templates; nächster Schritt wäre eine Übersetzungstabelle.
- **Mehrere Serverprozesse**: Missbrauchsbremse in einen geteilten Speicher verlagern; für größere Last ggf. PostgreSQL.
