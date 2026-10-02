import { html, raw } from 'hono/html';
import { can, ROLE_LABELS, type Role } from '../authz.ts';
import type { User } from '../services/auth.ts';
import { BOOKING_STATUS_LABELS, type BookingStatus } from '../services/bookings.ts';
import { SLOT_STATE_LABELS, type SlotState } from '../services/slots.ts';
import { durationLabel, formatDate, formatTime, zoneLabel } from '../time.ts';

export type H = ReturnType<typeof html>;
/** Ein Seitenbaustein oder nichts. */
export type Frag = H | '';

/** Rückmeldungen nach Weiterleitungen – nur feste Texte, nie Eingaben aus der URL. */
const MESSAGES: Record<string, { text: string; kind: 'ok' | 'error' | 'info' }> = {
  saved: { text: 'Gespeichert.', kind: 'ok' },
  deleted: { text: 'Gelöscht.', kind: 'ok' },
  logged_out: { text: 'Du bist abgemeldet.', kind: 'info' },
  ws_created: { text: 'Arbeitsbereich angelegt. Lege als Nächstes ein Angebot an.', kind: 'ok' },
  invited: { text: 'Einladung erstellt.', kind: 'ok' },
  invite_resent: { text: 'Einladung erneuert. Der vorherige Link ist ungültig.', kind: 'ok' },
  invite_revoked: { text: 'Einladung widerrufen.', kind: 'ok' },
  invite_accepted: { text: 'Einladung angenommen. Willkommen!', kind: 'ok' },
  invite_rate: { text: 'Zu viele Einladungen in kurzer Zeit. Bitte später erneut versuchen.', kind: 'error' },
  booked_requested: { text: 'Anfrage gesendet. Du wirst informiert, sobald sie bestätigt oder abgelehnt wurde.', kind: 'ok' },
  booked_confirmed: { text: 'Gebucht und bestätigt.', kind: 'ok' },
  book_full: { text: 'Dieser Slot ist inzwischen belegt. Bitte wähle einen anderen.', kind: 'error' },
  book_already: { text: 'Du hast diesen Slot bereits angefragt oder gebucht.', kind: 'error' },
  book_too_late: { text: 'Dieser Slot kann nicht mehr gebucht werden (Vorlaufzeit unterschritten).', kind: 'error' },
  book_not_found: { text: 'Dieser Slot ist nicht (mehr) verfügbar.', kind: 'error' },
  book_rate: { text: 'Zu viele Buchungsversuche. Bitte warte einen Moment.', kind: 'error' },
  withdrawn: { text: 'Anfrage zurückgezogen.', kind: 'ok' },
  cancelled: { text: 'Termin abgesagt.', kind: 'ok' },
  cancel_requested: { text: 'Absage angefragt. Die Anbieterseite entscheidet darüber.', kind: 'info' },
  invalid_state: { text: 'Diese Aktion ist im aktuellen Status nicht möglich.', kind: 'error' },
  confirmed: { text: 'Buchung bestätigt.', kind: 'ok' },
  declined: { text: 'Anfrage abgelehnt.', kind: 'ok' },
  full: { text: 'Bestätigen nicht möglich: Der Slot ist bereits voll.', kind: 'error' },
  link_rotated: { text: 'Neuer öffentlicher Link erstellt. Der alte Link funktioniert nicht mehr.', kind: 'ok' },
  bulk_done: { text: 'Sammelaktion ausgeführt.', kind: 'ok' },
  retry_done: { text: 'Neuer Versandversuch ausgeführt – Status siehe Liste.', kind: 'info' },
  last_owner: { text: 'Der letzte Eigentümer kann nicht entfernt oder herabgestuft werden.', kind: 'error' },
  sole_owner: { text: 'Konto kann nicht gelöscht werden: Du bist alleinige:r Eigentümer:in eines Arbeitsbereichs. Übertrage oder lösche ihn zuerst.', kind: 'error' },
  proposal_sent: { text: 'Vorschlag gesendet. Die andere Seite muss zustimmen, erst dann gilt die neue Zeit.', kind: 'ok' },
  proposal_accepted: { text: 'Vorschlag angenommen – der Termin ist jetzt fest.', kind: 'ok' },
  proposal_rejected: { text: 'Vorschlag abgelehnt. Es gilt die bisherige Zeit.', kind: 'info' },
  proposal_conflict: { text: 'Die vorgeschlagene Zeit überschneidet sich mit einem festen Termin. Bitte eine andere Zeit wählen.', kind: 'error' },
  bad_time: { text: 'Ungültige Zeit: Bitte Datum, Uhrzeit und Dauer prüfen (in der Zukunft, im angebotenen Zeitfenster, in 5-Minuten-Schritten).', kind: 'error' },
  password_saved: { text: 'Passwort gespeichert. Du kannst dich jetzt mit E-Mail und Passwort anmelden.', kind: 'ok' },
  password_weak: { text: 'Das Passwort ist zu kurz (mindestens 10 Zeichen).', kind: 'error' },
  password_mismatch: { text: 'Die beiden Passwörter stimmen nicht überein.', kind: 'error' },
  password_wrong: { text: 'Das aktuelle Passwort stimmt nicht.', kind: 'error' },
  slots_created: { text: 'Slots angelegt.', kind: 'ok' },
  slot_switched: { text: 'Deine Anfrage gilt jetzt für den neuen Termin und wartet auf Bestätigung.', kind: 'ok' },
  confirm_mismatch: { text: 'Die Bestätigung stimmt nicht überein – nichts wurde gelöscht.', kind: 'error' },
  push_on: { text: 'Push ist eingeschaltet. Mit „Test-Benachrichtigung senden“ kannst du es ausprobieren.', kind: 'ok' },
  push_test_ok: { text: 'Test-Benachrichtigung gesendet – sie sollte gleich erscheinen.', kind: 'ok' },
  push_test_failed: { text: 'Die Test-Benachrichtigung konnte keinem Gerät zugestellt werden. Schalte Push auf dem Gerät aus und wieder ein.', kind: 'error' },
  push_none: { text: 'Auf keinem Gerät ist Push eingeschaltet.', kind: 'info' },
  push_rate: { text: 'Bitte warte kurz, bevor du erneut testest.', kind: 'error' },
  push_device_removed: { text: 'Gerät entfernt – es bekommt keine Push-Benachrichtigungen mehr.', kind: 'ok' },
  name_required: { text: 'Bitte Vor- und Nachnamen angeben.', kind: 'error' },
  calendar_rotated: { text: 'Neuer Kalender-Link erzeugt. Trage ihn in deinen Kalendern neu ein – der alte funktioniert nicht mehr.', kind: 'ok' },
  app_revoked: { text: 'Verbindung getrennt.', kind: 'ok' },
  lessons_added: { text: 'Feste Termine eingetragen.', kind: 'ok' },
  week_repeated: { text: 'Woche übernommen.', kind: 'ok' },
  week_empty: { text: 'In dieser Woche gibt es keine Slots zum Übernehmen.', kind: 'info' },
  week_too_many: { text: 'Das wären zu viele Slots auf einmal (höchstens 500). Bitte weniger Wochen wählen.', kind: 'error' },
  money_invalid: { text: 'Ungültiger Betrag – bitte z. B. 25 oder 25,50 eingeben. Nichts wurde gespeichert.', kind: 'error' },
  lessons_saved: { text: 'Gespeichert.', kind: 'ok' },
  lesson_added: { text: 'Termin eingetragen.', kind: 'ok' },
  lesson_full: { text: 'Zu dieser Zeit gibt es schon einen festen Termin dieses Angebots. Bitte eine andere Zeit wählen.', kind: 'error' },
};

export function flash(code: string | undefined, extra?: string): H | '' {
  const m = code ? MESSAGES[code] : undefined;
  if (!m) return '';
  return html`<div class="flash flash-${m.kind}" role="${m.kind === 'error' ? 'alert' : 'status'}">${m.text}${extra ? ` ${extra}` : ''}</div>`;
}

export function errorBox(text: string | null | undefined): H | '' {
  return text ? html`<div class="flash flash-error" role="alert">${text}</div>` : '';
}

export interface LayoutOpts {
  title: string;
  user: User | null;
  body: Frag | Frag[];
  ws?: { id: string; name: string; role: Role } | null;
  section?: string;
  workspaces?: { id: string; name: string }[];
  wide?: boolean;
  /** Plattform-Admin: zeigt den Link zur Plattform-Verwaltung. */
  isAdmin?: boolean;
}

function wsNav(ws: NonNullable<LayoutOpts['ws']>, section?: string) {
  const items: [string, string, boolean][] = [
    ['overview', 'Übersicht', true],
    ['calendar', 'Kalender', can(ws.role, 'bookings.manage')],
    ['book', 'Termine buchen', can(ws.role, 'book')],
    ['slots', 'Slots', can(ws.role, 'slots.manage')],
    ['bookings', 'Buchungen', can(ws.role, 'bookings.manage')],
    ['students', 'Schüler', can(ws.role, 'billing.manage')],
    ['offerings', 'Angebote', can(ws.role, 'offerings.manage')],
    ['groups', 'Gruppen', can(ws.role, 'groups.manage')],
    ['members', 'Mitglieder', can(ws.role, 'members.manage')],
    ['notifications', 'Benachrichtigungen', can(ws.role, 'notifications.manage')],
    ['settings', 'Einstellungen', can(ws.role, 'workspace.manage')],
  ];
  const href = (k: string) => (k === 'overview' ? `/w/${ws.id}` : `/w/${ws.id}/${k}`);
  return html`<nav class="subnav" aria-label="Arbeitsbereich">
    <div class="subnav-title"><span class="ws-name">${ws.name}</span> <span class="badge badge-muted">${ROLE_LABELS[ws.role]}</span></div>
    <ul>
      ${items
        .filter(([, , show]) => show)
        .map(([k, label]) => html`<li><a href="${href(k)}" ${section === k ? raw('aria-current="page"') : ''}>${label}</a></li>`)}
    </ul>
  </nav>`;
}

export function layout(o: LayoutOpts): H {
  return html`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${o.title} · TE-Slotwise</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<meta name="theme-color" content="#0f766e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Slotwise">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<script src="/static/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Zum Inhalt springen</a>
<header class="topbar">
  <a class="brand" href="${o.user ? '/dashboard' : '/'}"><span class="brand-mark" aria-hidden="true"></span>TE-Slotwise</a>
  ${o.user
    ? html`<nav class="topnav" aria-label="Hauptnavigation">
        ${o.workspaces && o.workspaces.length
          ? html`<details class="switcher">
              <summary>Arbeitsbereiche</summary>
              <ul>
                ${o.workspaces.map((w) => html`<li><a href="/w/${w.id}">${w.name}</a></li>`)}
                <li><a href="/workspaces/new">+ Neuer Arbeitsbereich</a></li>
              </ul>
            </details>`
          : ''}
        <a href="/dashboard">Übersicht</a>
        <a href="/bookings">Meine Termine</a>
        <a href="/profile">Profil</a>
        <button class="linklike" type="button" data-install hidden>App installieren</button>
        ${o.isAdmin ? html`<a href="/admin">Plattform</a>` : ''}
        <form method="post" action="/logout" class="inline"><button class="linklike" type="submit">Abmelden</button></form>
      </nav>`
    : html`<nav class="topnav" aria-label="Hauptnavigation"><a href="/login">Anmelden</a> <a href="/register">Registrieren</a></nav>`}
</header>
<div class="shell ${o.ws ? 'with-subnav' : ''}">
  ${o.ws ? wsNav(o.ws, o.section) : ''}
  <main id="main" class="${o.wide ? 'wide' : ''}" tabindex="-1">
    ${o.body}
  </main>
</div>
<footer class="footer">TE-Slotwise · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></footer>
</body>
</html>`;
}

export function emptyState(title: string, text: string, action?: H): H {
  return html`<div class="empty"><p class="empty-title">${title}</p><p>${text}</p>${action ?? ''}</div>`;
}

export function slotStateBadge(state: SlotState): H {
  return html`<span class="badge badge-${state}">${SLOT_STATE_LABELS[state]}</span>`;
}

export function bookingBadge(status: BookingStatus, past = false): H {
  if (past && status === 'confirmed') return html`<span class="badge badge-past">${BOOKING_STATUS_LABELS.past}</span>`;
  return html`<span class="badge badge-${status}">${BOOKING_STATUS_LABELS[status]}</span>`;
}

/** Klare Zeitangabe: Datum, Beginn–Ende, Dauer, Zeitzone. */
export function when(startIso: string, endIso: string, tz: string, opts: { long?: boolean } = {}): H {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  const minutes = Math.round((e - s) / 60000);
  return html`<span class="when"><time datetime="${startIso}"><strong>${formatDate(s, tz, opts.long)}</strong>, ${formatTime(s, tz)}–${formatTime(e, tz)} Uhr</time>
    <span class="muted">(${durationLabel(minutes)}, ${zoneLabel(s, tz)} · ${tz})</span></span>`;
}

/** Teilen-Box: Web Share API (falls verfügbar) und immer „Link kopieren“. */
export function shareBox(url: string, title: string, hint?: string, label = 'Link zum Teilen'): H {
  const id = `share-${Math.abs(hashCode(url))}`;
  return html`<div class="share">
    <label for="${id}">${label}</label>
    <div class="share-row">
      <input id="${id}" type="text" readonly value="${url}" class="share-input">
      <button type="button" class="btn" data-copy="${id}">Link kopieren</button>
      <button type="button" class="btn btn-secondary" data-share-url="${url}" data-share-title="${title}" hidden>Teilen …</button>
    </div>
    <p class="hint" data-copy-status="${id}" aria-live="polite">${hint ?? ''}</p>
  </div>`;
}

function hashCode(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function field(label: string, control: H, hint?: string): H {
  return html`<div class="field">${label ? html`<span class="label">${label}</span>` : ''}${control}${hint ? html`<span class="hint">${hint}</span>` : ''}</div>`;
}

export function options(items: { value: string; label: string }[], selected: string | null | undefined): H[] {
  return items.map((i) => html`<option value="${i.value}" ${i.value === selected ? raw('selected') : ''}>${i.label}</option>`);
}

export const checked = (on: boolean | number | null | undefined) => (on ? raw('checked') : '');

export function pageHeader(title: string, intro?: string, actions?: H): H {
  return html`<div class="page-header"><div><h1>${title}</h1>${intro ? html`<p class="lead">${intro}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
}

export function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  if (!domain) return '***';
  return `${name.slice(0, 1)}***@${domain}`;
}
