# TE-Slotwise

Online: **https://te-slotwise.pages.dev** (Cloudflare Pages + D1). Quellcode: https://github.com/TE-Tools/te-slotwise

Flexible Termin- und Buchungsplattform: Einzelpersonen und Organisationen bieten feste Termine
oder freie Zeitfenster an, geben sie gezielt frei (öffentlich, für Gruppen, für einzelne Personen,
intern) und verwalten Buchungen. Erster Anwendungsfall ist Musikunterricht – Produkt, Datenmodell
und Oberfläche sind aber allgemein gehalten (Unterricht, Beratung, Kurse, Räume, Veranstaltungen).

Für Lehrkräfte gibt es unter **Schüler** eine Abrechnungsübersicht: Standard- und Einzelpreise, Termine nach der Stunde abhaken, bezahlte Beträge, Monats- und Jahresübersicht und CSV-Export.

TE-Slotwise ist als **App installierbar** (Startbildschirm, wie der Familienplaner) und schickt auf Wunsch **Push-Benachrichtigungen** – einschalten unter Profil → „App & Push-Benachrichtigungen“. Auf dem iPhone zuerst über Safari → Teilen → „Zum Home-Bildschirm“ installieren (Push ab iOS 16.4). Die Push-Schlüssel (VAPID) erzeugt die App beim ersten Bedarf selbst; optional fest vorgeben mit `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (Secrets) und `VAPID_SUBJECT`.

Weitere Dokumente:

- [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) – Produktgrenzen, Rollen, Architektur, Datenmodell, Buchungsablauf
- [docs/DATENSCHUTZ.md](docs/DATENSCHUTZ.md) – gespeicherte Daten, Aufbewahrung, Export, Löschung, offene Entscheidungen

## Aufbau in einem Satz

Dieselbe Anwendung läuft auf zwei Wegen: **online auf Cloudflare Pages** (Datenbank D1, Einstieg `functions/[[path]].ts` → `src/worker.ts`) und **lokal mit Node** (SQLite-Datei, Einstieg `src/server.ts`) für Entwicklung und Tests.

## Voraussetzungen

- Node.js 22.18 oder neuer (getestet mit 24.18). Kein Build-Schritt; TypeScript läuft direkt.
- Für Cloudflare: `npx wrangler login` (auf dem Entwicklungsrechner eingerichtet).

## Veröffentlichen (Cloudflare)

```bash
npm run deploy
```

Das wendet neue Datenbank-Migrationen auf die Online-Datenbank `te-slotwise-db` an und lädt die Seite zu Cloudflare Pages (Projekt `te-slotwise`). Einstellungen stehen in `wrangler.toml` unter `[vars]`. Geheimnisse (E-Mail-Schlüssel) werden **nicht** in Dateien gespeichert, sondern so gesetzt:

```bash
npx wrangler pages secret put BREVO_API_KEY --project-name te-slotwise
```

E-Mail-Versand online: über **Brevo** (kostenlos, 300 Mails/Tag, gemeinsames Konto mit anderen TE-Apps). Absender (`MAIL_FROM`) muss in Brevo unter „Senders“ bestätigt sein. Alternativ: `EMAILJS_*` (EmailJS) oder `RESEND_API_KEY`. **Ohne E-Mail-Versand ist online keine Anmeldung möglich**, weil Anmeldelinks per E-Mail kommen.

Plattform-Admin: Adressen in `ADMIN_EMAILS` (Secret, kommagetrennt) sehen nach der Anmeldung den Menüpunkt „Plattform“ (`/admin`) mit Betriebsübersicht und Test-E-Mail.

Lokal die Cloudflare-Version ausprobieren: `npm run cf:dev` (lokale D1-Datenbank). Rauchtest: `node scripts/smoke.ts http://localhost:8788` – dafür den Dev-Server mit `--binding DEV_LOGIN_LINKS=1 --binding NODE_ENV=development --binding APP_URL=http://localhost:8788` starten.

## Lokal starten

```bash
npm install
cp .env.example .env      # danach .env anpassen (siehe unten)
npm run seed:demo         # optional: Beispieldaten
npm run dev               # startet mit automatischem Neustart bei Änderungen
```

Für die lokale Entwicklung ohne Mailserver in `.env` setzen:

```
DEV_LOGIN_LINKS=1
```

Dann zeigt die Anmeldeseite den Anmeldelink direkt an (es wird ausdrücklich gesagt, dass **keine**
E-Mail verschickt wurde). Alternativ `MAIL_TRANSPORT=console`: Mails erscheinen in der Serverkonsole.

Demo-Konten nach `npm run seed:demo`: `lehrkraft@example.test` (Anbieter), `schuelerin@example.test`
(Mitglied einer Gruppe), `besucher@example.test` (extern). Anmeldung jeweils per Link.

## Befehle

| Befehl | Zweck |
|---|---|
| `npm start` | Server starten |
| `npm run dev` | Server mit Neustart bei Dateiänderungen |
| `npm run migrate` | Datenbankmigrationen anwenden (passiert auch automatisch beim Start) |
| `npm run seed:demo` | Beispieldaten anlegen (verweigert bei `NODE_ENV=production`) |
| `npm test` | Automatische Tests (Node-Testrunner) |
| `npm run check` | TypeScript-Typprüfung |

## Umgebungsvariablen

Siehe [.env.example](.env.example). Geheimnisse gehören ausschließlich in `.env` bzw. die
Umgebungsvariablen des Servers, nie ins Repository.

| Variable | Bedeutung |
|---|---|
| `APP_URL` | Öffentliche Adresse, z. B. `https://termine.example.de`. Bestimmt Links in E-Mails, CSRF-Prüfung und ob Cookies als `Secure` gesetzt werden. |
| `PORT` | Port des Servers (Standard 3000) |
| `DATABASE_PATH` | Pfad der SQLite-Datei (Standard `./data/slotwise.db`) |
| `BREVO_API_KEY` | E-Mail-Versand über Brevo (online verwendet; als Secret setzen) |
| `EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY` | Alternative: Versand über EmailJS (Vorlage mit {{subject}}, {{{message_html}}}, {{to_email}}) |
| `RESEND_API_KEY` | Alternative: Versand über Resend |
| `ADMIN_EMAILS` | Plattform-Admins (kommagetrennt), Zugang zu /admin |
| `SMTP_URL` | SMTP-Zugang, z. B. `smtps://benutzer:passwort@smtp.example.com:465`. Ohne diese Variable wird **nichts** versendet. |
| `MAIL_FROM` | Absender, z. B. `Slotwise <noreply@example.de>` |
| `MAIL_TRANSPORT=console` | Nur Entwicklung: Mails in der Konsole ausgeben statt senden |
| `DEV_LOGIN_LINKS=1` | Nur Entwicklung: Anmeldelinks auf der Seite zeigen, wenn kein Versand eingerichtet ist. Wird bei `NODE_ENV=production` ignoriert. |
| `TRUST_PROXY=1` | Hinter einem Reverse-Proxy: Client-IP aus `X-Forwarded-For` für die Missbrauchsbremse verwenden |
| `NODE_ENV=production` | Produktionsbetrieb |
| `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL`, `OPERATOR_PHONE` | Angaben für Impressum und Datenschutz (Adresszeilen mit senkrechtem Strich trennen) |
| `RETENTION_NOTIFICATION_DAYS` | Versandprotokolle nach so vielen Tagen löschen (Standard 180) |
| `RETENTION_BOOKING_DAYS` | Buchungen so viele Tage nach Terminende löschen (Standard 0 = nie) |

## Datenbank und Migrationen

- SQLite-Datei, WAL-Modus, Fremdschlüssel aktiv.
- Migrationen liegen in `migrations/` als nummerierte SQL-Dateien (`001_init.sql`, …) und werden
  beim Start bzw. mit `npm run migrate` in Reihenfolge angewendet; angewendete Versionen stehen in
  `schema_migrations`. Neue Änderungen immer als **neue** Datei anlegen, bestehende nicht ändern,
  sobald sie irgendwo produktiv gelaufen sind.
- Sicherung: Die Datei `DATABASE_PATH` (plus `-wal`/`-shm`) regelmäßig sichern, am besten mit
  `sqlite3 slotwise.db ".backup sicherung.db"` im laufenden Betrieb.

## Eigener Server statt Cloudflare (optional)

`npm ci --omit=dev`, Umgebungsvariablen setzen (`NODE_ENV=production`, `APP_URL` mit https, `RESEND_API_KEY` oder `SMTP_URL`), hinter einen Reverse-Proxy mit TLS stellen (`TRUST_PROXY=1`) und `npm start` als Dienst laufen lassen. Nur ein Prozess pro Datenbankdatei.

## Hinweis zum Speicherort

Das Projekt liegt in einem OneDrive-Ordner. OneDrive synchronisiert dann auch `node_modules/` und
die Datenbank in `data/`. Für den Dauerbetrieb oder intensive Entwicklung ist ein Ordner außerhalb
von OneDrive mit Git als Sicherung besser.
