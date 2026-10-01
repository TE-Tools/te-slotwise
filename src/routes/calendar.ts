import type { Hono } from 'hono';
import { html } from 'hono/html';
import { notFound, requireUser, type AppEnv, type Ctx } from '../context.ts';
import { calendarToken, listApiTokens, revokeApiToken, userForCalendarToken, type User } from '../services/auth.ts';
import { buildIcs, calendarEntries, managesWorkspace } from '../services/calendar.ts';
import { listWorkspacesForUser } from '../services/workspaces.ts';
import { can } from '../authz.ts';
import { formatDate } from '../time.ts';
import { shareBox, type H } from '../views/ui.ts';
import { back } from './common.ts';

// Kalender: Abo-Link (webcal/https) für Google, Apple, Outlook usw., Download als .ics, einzelner Termin.

const DAY = 86_400_000;

async function icsFor(c: Ctx, user: User, wsId: string | undefined, name: string) {
  const { db, config } = c.get('deps');
  const now = Date.now();
  const entries = await calendarEntries(db, user.id, {
    workspaceId: wsId,
    fromIso: new Date(now - 90 * DAY).toISOString(),
    toIso: new Date(now + 400 * DAY).toISOString(),
    includeCancelled: true,
  });
  return buildIcs({ name, entries, appUrl: config.appUrl, host: new URL(config.appUrl).host, now });
}

function icsResponse(c: Ctx, body: string, filename: string, download: boolean) {
  c.header('Content-Type', 'text/calendar; charset=utf-8');
  c.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  c.header('Cache-Control', 'private, no-store');
  return c.body(body);
}

/** Abo-Links und Knöpfe für die gängigen Kalender. */
export function calendarLinks(httpsUrl: string, label: string): H {
  const webcal = httpsUrl.replace(/^https?:/, 'webcal:');
  return html`<div class="cal-links">
    ${shareBox(httpsUrl, label, 'Diesen Link in deinem Kalender als „Kalender abonnieren“ / „Per URL hinzufügen“ eintragen. Er ist geheim – wer ihn kennt, sieht diese Termine.', 'Abo-Link für deinen Kalender')}
    <div class="actions">
      <a class="btn btn-secondary btn-small" href="${webcal}">Apple / Outlook (webcal)</a>
      <a class="btn btn-secondary btn-small" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}" target="_blank" rel="noopener">Google Kalender</a>
      <a class="btn btn-secondary btn-small" href="https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(httpsUrl)}&name=${encodeURIComponent(label)}" target="_blank" rel="noopener">Outlook.com</a>
    </div>
  </div>`;
}

/** Profilbereich: Kalender verknüpfen, herunterladen, Familienplaner und verbundene Apps. */
export async function calendarSection(c: Ctx): Promise<H> {
  const user = c.get('user')!;
  const { db, config } = c.get('deps');
  const token = await calendarToken(db, user.id);
  const feed = `${config.appUrl}/cal/${token}.ics`;
  const managed = (await listWorkspacesForUser(db, user.id)).filter((w) => can(w.role, 'bookings.manage'));
  const apps = await listApiTokens(db, user.id);
  return html`<section class="card narrow" id="kalender">
    <h2>Kalender verknüpfen</h2>
    <p>Deine Termine${managed.length ? ' und die Buchungen in deinen Arbeitsbereichen' : ''} erscheinen automatisch in deinem Kalender – Änderungen kommen von selbst nach (je nach Kalender-App alle paar Stunden).</p>
    ${calendarLinks(feed, 'TE-Slotwise')}
    <div class="actions">
      <a class="btn btn-secondary" href="/calendar.ics" download>Alle Termine herunterladen (.ics)</a>
      <form method="post" action="/profile/calendar/rotate" class="inline" data-confirm="Neuen Link erzeugen? Bestehende Kalender-Abos funktionieren dann nicht mehr."><button class="btn btn-secondary" type="submit">Neuen Link erzeugen</button></form>
    </div>
    ${managed.length
      ? html`<details><summary>Nur einen Arbeitsbereich abonnieren</summary>
          <ul class="list">${managed.map((w) => html`<li><strong>${w.name}</strong>${calendarLinks(`${feed}?ws=${w.id}`, `TE-Slotwise – ${w.name}`)}</li>`)}</ul>
        </details>`
      : ''}
    <h3>Familienplaner &amp; andere TE-Apps</h3>
    <p>Im <strong>Familienplaner</strong>: Profil → Kalender-Verknüpfungen → „+ Verknüpfung hinzufügen“ → <strong>TE-Slotwise</strong> wählen und mit deiner TE-Slotwise-E-Mail und deinem Passwort verbinden. Dein Passwort wird dort nicht gespeichert. Andere Apps, die Kalender-Abos können (z. B. Orchester-Orga oder Kalender-Apps), nutzen den Link oben.</p>
    ${apps.length
      ? html`<h3>Verbundene Apps</h3><ul class="list">${apps.map(
          (a) => html`<li class="row"><span>${a.label || 'App'} <span class="muted">· zuletzt ${formatDate(Date.parse(a.last_used_at), 'Europe/Berlin')}</span></span>
            <form method="post" action="/profile/apps/${a.id}/revoke" class="inline" data-confirm="Verbindung trennen? Die App sieht deine Termine dann nicht mehr."><button class="btn btn-small btn-secondary" type="submit">Trennen</button></form></li>`,
        )}</ul>`
      : ''}
  </section>`;
}

export function registerCalendarRoutes(app: Hono<AppEnv>) {
  // Abo-Link: /cal/<token>.ics[?ws=<Arbeitsbereich>] – ohne Anmeldung, der Token ist das Geheimnis.
  app.get('/cal/:file', async (c) => {
    const { db, limiter } = c.get('deps');
    const file = c.req.param('file');
    if (!file.endsWith('.ics')) notFound();
    const token = file.slice(0, -4);
    if (!limiter.take(`cal:${token.slice(0, 16)}`, 60, 600_000)) return c.text('Zu viele Abrufe', 429);
    const user = await userForCalendarToken(db, token);
    if (!user) notFound();
    const wsId = c.req.query('ws') || undefined;
    if (wsId && !(await managesWorkspace(db, user.id, wsId))) notFound();
    const wsName = wsId ? (await db.get<{ name: string }>(`SELECT name FROM workspaces WHERE id = ?`, [wsId]))?.name : undefined;
    return icsResponse(c, await icsFor(c, user, wsId, wsName ? `TE-Slotwise – ${wsName}` : 'TE-Slotwise'), 'te-slotwise.ics', false);
  });

  app.get('/calendar.ics', async (c) => {
    const user = requireUser(c);
    return icsResponse(c, await icsFor(c, user, undefined, 'TE-Slotwise'), 'te-slotwise-termine.ics', true);
  });

  app.get('/w/:wid/calendar.ics', async (c) => {
    const user = requireUser(c);
    if (!(await managesWorkspace(c.get('deps').db, user.id, c.req.param('wid')))) notFound();
    return icsResponse(c, await icsFor(c, user, c.req.param('wid'), 'TE-Slotwise'), 'te-slotwise-arbeitsbereich.ics', true);
  });

  // Einzelner Termin „Zum Kalender hinzufügen“ – eigene Buchung oder Buchung in einem verwalteten Bereich.
  app.get('/bookings/:id/ics', async (c) => {
    const user = requireUser(c);
    const { db, config } = c.get('deps');
    const b = await db.get<{ starts_at: string; ends_at: string }>(`SELECT starts_at, ends_at FROM bookings WHERE id = ?`, [c.req.param('id')]);
    if (!b) notFound();
    const entries = (await calendarEntries(db, user.id, { fromIso: new Date(Date.parse(b.starts_at) - 1000).toISOString(), toIso: b.ends_at, includeCancelled: true })).filter(
      (e) => e.id === c.req.param('id'),
    );
    if (!entries.length) notFound();
    return icsResponse(c, buildIcs({ name: 'TE-Slotwise', entries, appUrl: config.appUrl, host: new URL(config.appUrl).host }), 'termin.ics', true);
  });

  app.post('/profile/calendar/rotate', async (c) => {
    const user = requireUser(c);
    await calendarToken(c.get('deps').db, user.id, true);
    return back(c, '/profile', 'calendar_rotated');
  });

  app.post('/profile/apps/:id/revoke', async (c) => {
    const user = requireUser(c);
    await revokeApiToken(c.get('deps').db, user.id, c.req.param('id'));
    return back(c, '/profile', 'app_revoked');
  });
}
