import type { Hono } from 'hono';
import { html } from 'hono/html';
import { notFound, requireUser, type AppEnv, type Ctx } from '../context.ts';
import { formatDate } from '../time.ts';
import { emptyState, pageHeader } from '../views/ui.ts';
import { render } from './common.ts';

// Plattform-Verwaltung für den Betreiber (ADMIN_EMAILS). Zeigt Betriebsdaten und Arbeitsbereiche,
// aber keine Buchungsinhalte. Zugang nur mit bestätigter, freigeschalteter E-Mail-Adresse.

export function isPlatformAdmin(c: Ctx) {
  const user = c.get('user');
  return !!user && !!user.email_verified_at && c.get('deps').config.adminEmails.includes(user.email.toLowerCase());
}

const MAIL_LABELS = {
  brevo: 'Brevo',
  emailjs: 'EmailJS (Outlook)',
  resend: 'Resend',
  smtp: 'SMTP',
  console: 'Nur Konsole (Entwicklung) – kein Versand',
  none: 'Nicht eingerichtet – kein Versand, keine Anmeldung möglich',
} as const;

export function registerPlatformRoutes(app: Hono<AppEnv>) {
  app.get('/admin', async (c) => {
    requireUser(c);
    if (!isPlatformAdmin(c)) notFound();
    const { db, config } = c.get('deps');
    const n = async (sql: string) => (await db.get<{ n: number }>(sql))!.n;
    const now = new Date().toISOString();
    const stats = {
      users: await n(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`),
      workspaces: await n(`SELECT COUNT(*) AS n FROM workspaces`),
      upcoming: await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings WHERE status IN ('requested','confirmed') AND ends_at > ?`, [now]).then((r) => r!.n),
      sent7: await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'sent' AND created_at > ?`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]).then((r) => r!.n),
      failed7: await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed' AND created_at > ?`, [new Date(Date.now() - 7 * 86_400_000).toISOString()]).then((r) => r!.n),
    };
    const lastErrors = await db.all<{ created_at: string; template: string; last_error: string }>(
      `SELECT created_at, template, last_error FROM notifications WHERE status = 'failed' ORDER BY created_at DESC LIMIT 5`,
    );
    const workspaces = await db.all<{ id: string; name: string; kind: string; created_at: string; public_enabled: number; owners: string; members: number; slots: number }>(
      `SELECT w.id, w.name, w.kind, w.created_at, w.public_enabled,
         (SELECT group_concat(u.email, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'owner') AS owners,
         (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS members,
         (SELECT COUNT(*) FROM slots s WHERE s.workspace_id = w.id AND s.ends_at > ?) AS slots
       FROM workspaces w ORDER BY w.created_at DESC LIMIT 200`,
      [now],
    );
    const result = c.req.query('test');
    return render(c, {
      title: 'Plattform',
      wide: true,
      body: [
        result === 'ok'
          ? html`<div class="flash flash-ok" role="status">Test-E-Mail wurde an ${c.get('user')!.email} gesendet. Bitte Postfach (und Spam-Ordner) prüfen.</div>`
          : result === 'fail'
            ? html`<div class="flash flash-error" role="alert">Test-E-Mail fehlgeschlagen: ${c.req.query('err') ?? ''}</div>`
            : '',
        pageHeader('Plattform-Verwaltung', 'Betriebsübersicht für den Betreiber. Buchungsinhalte sind hier nicht sichtbar.'),
        html`<div class="stats">
          <div class="stat"><span class="stat-num">${stats.users}</span><span>Konten</span></div>
          <div class="stat"><span class="stat-num">${stats.workspaces}</span><span>Arbeitsbereiche</span></div>
          <div class="stat"><span class="stat-num">${stats.upcoming}</span><span>offene/kommende Buchungen</span></div>
          <div class="stat"><span class="stat-num">${stats.sent7}</span><span>E-Mails gesendet (7 Tage)</span></div>
          <div class="stat ${stats.failed7 ? 'stat-error' : ''}"><span class="stat-num">${stats.failed7}</span><span>E-Mails fehlgeschlagen (7 Tage)</span></div>
        </div>`,
        html`<section class="card"><h2>E-Mail-Versand</h2>
          <p>Versandweg: <strong>${MAIL_LABELS[config.mailMode]}</strong></p>
          <form method="post" action="/admin/test-mail"><button class="btn" type="submit" ${config.mailMode === 'none' ? 'disabled' : ''}>Test-E-Mail an mich senden</button></form>
          ${lastErrors.length
            ? html`<h3>Letzte Fehler</h3><ul class="list">${lastErrors.map((e) => html`<li class="row"><span>${formatDate(Date.parse(e.created_at), 'Europe/Berlin')} · ${e.template}</span><span class="muted">${e.last_error}</span></li>`)}</ul>`
            : ''}
        </section>`,
        html`<section class="card"><h2>Betreiberangaben (Impressum)</h2>
          ${config.operator.name
            ? html`<p>${config.operator.name} · ${config.operator.email}</p>`
            : html`<p class="flash flash-info">Noch nicht hinterlegt. Ohne Angaben ist das Impressum unvollständig.</p>`}
          <p><a href="/impressum">Impressum ansehen</a> · <a href="/datenschutz">Datenschutz ansehen</a></p>
        </section>`,
        html`<section class="card"><h2>Arbeitsbereiche</h2>
          ${workspaces.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Art</th><th>Eigentümer</th><th>Mitglieder</th><th>Kommende Slots</th><th>Öffentlich</th><th>Angelegt</th></tr></thead><tbody>
                ${workspaces.map(
                  (w) => html`<tr><td>${w.name}</td><td>${w.kind === 'organization' ? 'Organisation' : 'Persönlich'}</td><td>${w.owners ?? '–'}</td><td>${w.members}</td><td>${w.slots}</td><td>${w.public_enabled ? 'ja' : 'nein'}</td><td>${formatDate(Date.parse(w.created_at), 'Europe/Berlin')}</td></tr>`,
                )}</tbody></table></div>`
            : emptyState('Noch keine Arbeitsbereiche', 'Sobald jemand einen Arbeitsbereich anlegt, erscheint er hier.', html`<a class="btn" href="/workspaces/new">Eigenen Arbeitsbereich anlegen</a>`)}
        </section>`,
      ],
    });
  });

  app.post('/admin/test-mail', async (c) => {
    const user = requireUser(c);
    if (!isPlatformAdmin(c)) notFound();
    const { mailer, config } = c.get('deps');
    try {
      await mailer.send({
        to: user.email,
        subject: 'TE-Slotwise: Test-E-Mail',
        text: `Hallo,\n\ndiese Test-E-Mail bestätigt, dass der Versand von TE-Slotwise funktioniert.\n\n${config.appUrl}\n\n— TE-Slotwise`,
      });
      return c.redirect('/admin?test=ok', 303);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.redirect(`/admin?test=fail&err=${encodeURIComponent(msg.slice(0, 200))}`, 303);
    }
  });
}
