import type { Hono } from 'hono';
import { html } from 'hono/html';
import { ROLE_LABELS, safeNextPath } from '../authz.ts';
import { bool, notFound, readForm, requireUser, str, oneOf, type AppEnv, type Ctx } from '../context.ts';
import { deleteAccount, exportUserData, updateProfile } from '../services/auth.ts';
import { awaiting, bookerAction, listMyBookings, proposeTime, respondToProposal, type MyBookingRow } from '../services/bookings.ts';
import {
  acceptInvitation,
  createWorkspace,
  findInvitationByToken,
  listWorkspacesForUser,
  pendingInvitationsForEmail,
} from '../services/workspaces.ts';
import { COMMON_TIME_ZONES, isValidTimeZone, LocalTimeError, localToUtc } from '../time.ts';
import { awaitingLabel, proposalNote, timeChangeForm } from '../views/booking.ts';
import { bookingBadge, emptyState, errorBox, flash, maskEmail, options, pageHeader, when, type H } from '../views/ui.ts';
import { startLogin } from './auth.ts';
import { back, render } from './common.ts';

function bookingCard(b: MyBookingRow, now: number): H {
  const past = Date.parse(b.ends_at) <= now;
  const started = Date.parse(b.starts_at) <= now;
  const active = (b.status === 'requested' || b.status === 'confirmed') && !started;
  const canSelfCancel = b.allow_self_cancel && Date.parse(b.starts_at) - b.cancel_cutoff_hours * 3600_000 > now;
  return html`<li class="card booking">
    <div class="booking-head">
      <div><strong>${b.offering_name}</strong> <span class="muted">· ${b.workspace_name}</span></div>
      <div>${bookingBadge(b.status, past)} ${active ? awaitingLabel(b, 'booker') : ''}</div>
    </div>
    <p>${when(b.starts_at, b.ends_at, b.timezone, { long: true })}</p>
    ${b.location ? html`<p class="muted">Ort: ${b.location}</p>` : ''}
    ${b.online_info && b.status === 'confirmed' ? html`<p class="muted">Online: ${b.online_info}</p>` : ''}
    ${b.cancel_requested_at && b.status === 'confirmed' ? html`<p class="flash flash-info">Absage angefragt – die Anbieterseite entscheidet.</p>` : ''}
    ${active ? proposalNote(b, 'booker') : ''}
    ${active
      ? html`<div class="actions">
          ${b.proposed_by === 'provider'
            ? html`<form method="post" action="/bookings/${b.id}/proposal" class="inline"><input type="hidden" name="accept" value="1"><button class="btn" type="submit">Neue Zeit annehmen</button></form>
                <form method="post" action="/bookings/${b.id}/proposal" class="inline"><input type="hidden" name="accept" value="0"><button class="btn btn-secondary" type="submit">Vorschlag ablehnen</button></form>`
            : ''}
          ${b.status === 'requested'
            ? html`<form method="post" action="/bookings/${b.id}/withdraw" class="inline" data-confirm="Anfrage wirklich zurückziehen?"><button class="btn btn-secondary" type="submit">Anfrage zurückziehen</button></form>`
            : html`<form method="post" action="/bookings/${b.id}/cancel" class="inline" data-confirm="${canSelfCancel ? 'Termin wirklich absagen?' : 'Absage bei der Anbieterseite anfragen?'}">
                <button class="btn btn-danger" type="submit">${canSelfCancel ? 'Termin absagen' : 'Absage anfragen'}</button></form>`}
        </div>
        ${timeChangeForm(`/bookings/${b.id}/propose`, b, b.status === 'requested' ? 'Wunschzeit ändern' : 'Andere Zeit vorschlagen')}`
      : ''}
  </li>`;
}

export function registerAccountRoutes(app: Hono<AppEnv>) {
  app.get('/', async (c) => {
    if (c.get('user')) return c.redirect('/dashboard');
    return render(c, {
      title: 'Willkommen',
      body: html`<section class="hero">
        <h1>Termine anbieten, gezielt freigeben, entspannt buchen lassen.</h1>
        <p class="lead">TE-Slotwise hilft Einzelpersonen und Organisationen – Lehrkräften, Schulen, Beratungen, Vereinen –, Zeitfenster anzubieten und Buchungen zu verwalten. Du bestimmst, wer was sieht: öffentlich, für Gruppen, für einzelne Personen oder nur intern.</p>
        <p><a class="btn btn-large" href="/login">Kostenlos starten</a></p>
        <ul class="features">
          <li><strong>Feste Termine oder freie Zeitfenster</strong> – Buchende wählen ihre Wunschzeit.</li>
          <li><strong>Verschieben mit Zustimmung</strong> – fix ist ein Termin erst, wenn beide Seiten zugestimmt haben.</li>
          <li><strong>Privat bleibt privat</strong> – niemand sieht Namen oder Buchungen anderer.</li>
        </ul>
      </section>`,
    });
  });

  const operatorBlock = (c: Ctx) => {
    const op = c.get('deps').config.operator;
    if (!op.name) return html`<p class="flash flash-info">Die Angaben zum Betreiber sind noch nicht hinterlegt (Einstellungen OPERATOR_NAME, OPERATOR_ADDRESS, OPERATOR_EMAIL).</p>`;
    return html`<p>${op.name}<br>${op.address.split('|').map((l, i) => html`${i ? html`<br>` : ''}${l.trim()}`)}</p>
      <p>${op.email ? html`E-Mail: <a href="mailto:${op.email}">${op.email}</a>` : ''}${op.phone ? html`<br>Telefon: ${op.phone}` : ''}</p>`;
  };

  app.get('/impressum', async (c) =>
    render(c, {
      title: 'Impressum',
      body: html`<article class="card prose"><h1>Impressum</h1><h2>Angaben gemäß § 5 DDG</h2>${operatorBlock(c)}</article>`,
    }),
  );

  app.get('/datenschutz', async (c) => {
    const { config } = c.get('deps');
    return render(c, {
      title: 'Datenschutz',
      body: html`<article class="card prose">
        <h1>Datenschutzhinweise</h1>
        <h2>Verantwortlich</h2>
        ${operatorBlock(c)}
        <h2>Welche Daten wir verarbeiten</h2>
        <p>TE-Slotwise speichert nur, was für Terminbuchungen nötig ist: E-Mail-Adresse, Anzeigename, Mitgliedschaften und Gruppenzugehörigkeiten, Buchungen samt Verlauf und Nachrichten sowie den Versandstatus von E-Mail-Benachrichtigungen. Passwörter gibt es nicht; die Anmeldung erfolgt über einmalige Links per E-Mail. Es gibt keine Werbe- oder Analyse-Cookies und keine Inhalte von Drittanbietern. Ein technisch notwendiges Cookie hält die Anmeldung aufrecht.</p>
        <h2>Zweck und Rechtsgrundlage</h2>
        <p>Die Daten werden verarbeitet, um Termine anzubieten, zu buchen und darüber zu informieren (Vertragserfüllung bzw. vorvertragliche Maßnahmen, Art. 6 Abs. 1 lit. b DSGVO) sowie zur sicheren Bereitstellung des Dienstes (berechtigtes Interesse, Art. 6 Abs. 1 lit. f DSGVO).</p>
        <h2>Wer die Daten sieht</h2>
        <p>E-Mail-Adressen und Namen sind nie öffentlich sichtbar. Anbieter (Verwaltende eines Arbeitsbereichs) sehen Name und E-Mail-Adresse nur von Personen, die bei ihnen gebucht haben oder Mitglied ihres Arbeitsbereichs sind. Andere Buchende sehen keine Personendaten.</p>
        <h2>Dienstleister</h2>
        <p>Betrieb und Datenbank: Cloudflare, Inc. (Rechenzentren auch außerhalb der EU; Grundlage: EU-Standardvertragsklauseln bzw. Data Privacy Framework). E-Mail-Versand${config.mailMode === 'brevo' ? ': Brevo (Sendinblue SAS, Frankreich)' : config.mailMode === 'emailjs' ? ': EmailJS (EmailJS Ltd.) über Microsoft Outlook' : config.mailMode === 'resend' ? ': Resend (Plus Five Five, Inc.)' : ' über einen beauftragten E-Mail-Dienst'}.</p>
        <h2>Speicherdauer</h2>
        <p>Anmeldelinks verfallen nach 15 Minuten, Sitzungen nach 30 Tagen ohne Nutzung. Protokolle über versendete E-Mails werden nach ${config.retentionNotificationDays} Tagen gelöscht. ${config.retentionBookingDays > 0 ? `Buchungen werden ${config.retentionBookingDays} Tage nach dem Termin gelöscht.` : 'Buchungen bleiben gespeichert, bis das Konto oder der Arbeitsbereich gelöscht wird.'}</p>
        <h2>Deine Rechte</h2>
        <p>Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde. Im Profil kannst du deine Daten selbst exportieren und dein Konto löschen.</p>
        <p class="muted">Diese Hinweise wurden nicht rechtlich geprüft.</p>
      </article>`,
    });
  });

  app.get('/dashboard', async (c) => {
    const user = requireUser(c);
    const { db } = c.get('deps');
    const workspaces = await listWorkspacesForUser(db, user.id);
    const invitations = await pendingInvitationsForEmail(db, user.email);
    const now = Date.now();
    const upcoming = (await listMyBookings(db, user.id))
      .filter((b) => (b.status === 'requested' || b.status === 'confirmed') && Date.parse(b.ends_at) > now)
      .reverse();
    const needsMe = upcoming.filter((b) => awaiting(b) === 'booker');
    return render(c, {
      title: 'Übersicht',
      body: [
        flash(c.req.query('msg')),
        pageHeader(`Hallo ${user.display_name}`, undefined, html`<a class="btn" href="/workspaces/new">Neuer Arbeitsbereich</a>`),
        needsMe.length
          ? html`<div class="flash flash-action" role="status">${needsMe.length === 1 ? 'Ein Termin wartet' : `${needsMe.length} Termine warten`} auf deine Zustimmung. <a href="/bookings">Ansehen</a></div>`
          : '',
        invitations.length
          ? html`<section class="card"><h2>Offene Einladungen</h2><ul class="list">
              ${invitations.map(
                (i) => html`<li class="row"><span><strong>${i.workspace_name}</strong>${i.group_name ? html` · Gruppe ${i.group_name}` : ''}${i.offering_name ? html` · Angebot ${i.offering_name}` : ''}</span>
                  <form method="post" action="/invitations/${i.id}/accept" class="inline"><button class="btn" type="submit">Annehmen</button></form></li>`,
              )}
            </ul></section>`
          : '',
        html`<section class="card"><h2>Deine Arbeitsbereiche</h2>
          ${workspaces.length
            ? html`<ul class="list">${workspaces.map(
                (w) => html`<li class="row"><a href="/w/${w.id}"><strong>${w.name}</strong></a><span class="badge badge-muted">${ROLE_LABELS[w.role]}</span></li>`,
              )}</ul>`
            : emptyState('Noch kein Arbeitsbereich', 'Lege einen eigenen Bereich an, um Termine anzubieten – oder nimm eine Einladung an, um bei anderen zu buchen.', html`<a class="btn" href="/workspaces/new">Arbeitsbereich anlegen</a>`)}
        </section>`,
        html`<section class="card"><h2>Nächste Termine</h2>
          ${upcoming.length
            ? html`<ul class="list">${upcoming.slice(0, 5).map(
                (b) => html`<li class="row"><span>${when(b.starts_at, b.ends_at, b.timezone)} · ${b.offering_name}</span><span>${bookingBadge(b.status)} ${awaitingLabel(b, 'booker')}</span></li>`,
              )}</ul><p><a href="/bookings">Alle eigenen Termine</a></p>`
            : emptyState('Keine anstehenden Termine', 'Gebuchte und angefragte Termine erscheinen hier.')}
        </section>`,
      ],
    });
  });

  // ---------- Arbeitsbereich anlegen ----------

  const wsForm = (error?: string, v: { name?: string; kind?: string; timezone?: string; description?: string } = {}) => html`<section class="card narrow">
    <h1>Neuer Arbeitsbereich</h1>
    <p class="lead">Ein Arbeitsbereich gehört dir oder deiner Organisation. Darin verwaltest du Angebote, Gruppen, Mitglieder und Termine.</p>
    ${errorBox(error)}
    <form method="post" action="/workspaces" class="stack">
      <div class="field"><label for="name">Name</label><input id="name" name="name" required maxlength="120" value="${v.name ?? ''}" placeholder="z. B. Unterricht Müller, Beratungsstelle Nord"></div>
      <fieldset class="field"><legend>Art</legend>
        <label class="check"><input type="radio" name="kind" value="personal" ${v.kind !== 'organization' ? 'checked' : ''}> Persönlich (Einzelperson)</label>
        <label class="check"><input type="radio" name="kind" value="organization" ${v.kind === 'organization' ? 'checked' : ''}> Organisation (Schule, Verein, Team …)</label>
      </fieldset>
      <div class="field"><label for="timezone">Zeitzone</label><select id="timezone" name="timezone">${options(
        COMMON_TIME_ZONES.map((z) => ({ value: z, label: z })),
        v.timezone ?? 'Europe/Berlin',
      )}</select></div>
      <div class="field"><label for="description">Kurzbeschreibung (optional, auf der öffentlichen Seite sichtbar)</label><textarea id="description" name="description" maxlength="2000" rows="3">${v.description ?? ''}</textarea></div>
      <button class="btn" type="submit">Anlegen</button>
    </form>
  </section>`;

  app.get('/workspaces/new', async (c) => {
    requireUser(c);
    return render(c, { title: 'Neuer Arbeitsbereich', body: wsForm() });
  });

  app.post('/workspaces', async (c) => {
    const user = requireUser(c);
    const f = await readForm(c);
    const v = { name: str(f, 'name', 120), kind: oneOf(str(f, 'kind'), ['personal', 'organization'] as const, 'personal'), timezone: str(f, 'timezone', 64), description: str(f, 'description', 2000) };
    if (!v.name) return render(c, { title: 'Neuer Arbeitsbereich', body: wsForm('Bitte einen Namen eingeben.', v) }, 400);
    if (!isValidTimeZone(v.timezone)) return render(c, { title: 'Neuer Arbeitsbereich', body: wsForm('Unbekannte Zeitzone.', v) }, 400);
    if (!c.get('deps').limiter.take(`ws-create:${user.id}`, 10, 3600_000)) return render(c, { title: 'Neuer Arbeitsbereich', body: wsForm('Zu viele neue Arbeitsbereiche in kurzer Zeit.', v) }, 429);
    const id = await createWorkspace(c.get('deps').db, user.id, v);
    return back(c, `/w/${id}/offerings`, 'ws_created');
  });

  // ---------- Profil ----------

  app.get('/profile', async (c) => {
    const user = requireUser(c);
    const setup = c.req.query('setup') === '1';
    const next = safeNextPath(c.req.query('next')) ?? '';
    return render(c, {
      title: 'Profil',
      body: [
        flash(c.req.query('msg')),
        html`<section class="card narrow">
          <h1>${setup ? 'Willkommen! Wie heißt du?' : 'Profil'}</h1>
          ${setup ? html`<p class="lead">Dein Name ist nur für Anbieter sichtbar, bei denen du buchst oder Mitglied bist – nie öffentlich.</p>` : ''}
          <form method="post" action="/profile" class="stack">
            <input type="hidden" name="next" value="${next}">
            <div class="field"><label for="display_name">Anzeigename</label><input id="display_name" name="display_name" required maxlength="80" value="${user.display_name}" autocomplete="name"></div>
            <div class="field"><span class="label">E-Mail-Adresse</span><span>${user.email} ${user.email_verified_at ? html`<span class="badge badge-confirmed">bestätigt</span>` : ''}</span></div>
            <fieldset class="field"><legend>E-Mail-Benachrichtigungen</legend>
              <label class="check"><input type="checkbox" name="notify_booking_updates" value="1" ${user.notify_booking_updates ? 'checked' : ''}> Zu meinen eigenen Buchungen (Bestätigung, Absage, Zeitvorschläge)</label>
              <label class="check"><input type="checkbox" name="notify_new_requests" value="1" ${user.notify_new_requests ? 'checked' : ''}> Als Anbieter: neue Anfragen und Änderungswünsche</label>
            </fieldset>
            <button class="btn" type="submit">Speichern</button>
          </form>
        </section>`,
        setup
          ? ''
          : html`<section class="card narrow">
              <h2>Deine Daten</h2>
              <p><a class="btn btn-secondary" href="/profile/export">Daten exportieren (JSON)</a></p>
              <details><summary>Konto löschen</summary>
                <form method="post" action="/profile/delete" class="stack" data-confirm="Konto endgültig löschen?">
                  <p>Offene und zukünftige Buchungen werden abgesagt. Vergangene Buchungen bleiben bei den Anbietern ohne Namen und E-Mail-Adresse erhalten.</p>
                  <div class="field"><label for="confirm_email">Zur Bestätigung deine E-Mail-Adresse eingeben</label><input id="confirm_email" name="confirm_email" type="email" required></div>
                  <button class="btn btn-danger" type="submit">Konto löschen</button>
                </form>
              </details>
            </section>`,
      ],
    });
  });

  app.post('/profile', async (c) => {
    const user = c.get('user');
    if (!user) return c.redirect('/login', 303);
    const f = await readForm(c);
    const name = str(f, 'display_name', 80);
    if (!name) return back(c, '/profile?setup=1');
    await updateProfile(c.get('deps').db, user.id, {
      displayName: name,
      notifyBookingUpdates: bool(f, 'notify_booking_updates'),
      notifyNewRequests: bool(f, 'notify_new_requests'),
    });
    const next = safeNextPath(str(f, 'next'));
    return next ? c.redirect(next, 303) : back(c, '/profile', 'saved');
  });

  app.get('/profile/export', async (c) => {
    const user = requireUser(c);
    c.header('Content-Disposition', 'attachment; filename="slotwise-daten.json"');
    c.header('Cache-Control', 'no-store');
    return c.json(await exportUserData(c.get('deps').db, user.id));
  });

  app.post('/profile/delete', async (c) => {
    const user = requireUser(c);
    const f = await readForm(c);
    if (str(f, 'confirm_email', 300).toLowerCase() !== user.email.toLowerCase()) return back(c, '/profile', 'confirm_mismatch');
    const r = await deleteAccount(c.get('deps').db, user.id);
    if (!r.ok) return back(c, '/profile', 'sole_owner');
    return c.redirect('/login?msg=logged_out', 303);
  });

  // ---------- Eigene Termine ----------

  app.get('/bookings', async (c) => {
    const user = requireUser(c);
    const now = Date.now();
    const all = await listMyBookings(c.get('deps').db, user.id);
    const upcoming = all.filter((b) => Date.parse(b.ends_at) > now && (b.status === 'requested' || b.status === 'confirmed')).reverse();
    const rest = all.filter((b) => !upcoming.includes(b));
    return render(c, {
      title: 'Meine Termine',
      body: [
        flash(c.req.query('msg')),
        pageHeader('Meine Termine', 'Nur du siehst diese Übersicht.'),
        html`<h2>Anstehend</h2>${upcoming.length ? html`<ul class="cards">${upcoming.map((b) => bookingCard(b, now))}</ul>` : emptyState('Keine anstehenden Termine', 'Buche über einen Arbeitsbereich oder einen geteilten Link.')}`,
        rest.length ? html`<h2>Vergangen, abgesagt, abgelehnt</h2><ul class="cards">${rest.slice(0, 100).map((b) => bookingCard(b, now))}</ul>` : '',
      ],
    });
  });

  const bookerResultMsg: Record<string, string> = {
    withdrawn: 'withdrawn',
    cancelled: 'cancelled',
    cancel_requested: 'cancel_requested',
    not_found: 'invalid_state',
    invalid_state: 'invalid_state',
  };

  app.post('/bookings/:id/withdraw', async (c) => {
    const user = requireUser(c);
    const { db, config, kick } = c.get('deps');
    const r = await bookerAction(db, config.appUrl, user.id, c.req.param('id'), 'withdraw');
    kick();
    return back(c, '/bookings', bookerResultMsg[r]);
  });

  app.post('/bookings/:id/cancel', async (c) => {
    const user = requireUser(c);
    const { db, config, kick } = c.get('deps');
    const r = await bookerAction(db, config.appUrl, user.id, c.req.param('id'), 'cancel');
    kick();
    return back(c, '/bookings', bookerResultMsg[r]);
  });

  app.post('/bookings/:id/propose', async (c) => {
    const user = requireUser(c);
    const { db, config, kick } = c.get('deps');
    const f = await readForm(c);
    const booking = (await listMyBookings(db, user.id)).find((b) => b.id === c.req.param('id'));
    if (!booking) notFound();
    const parsed = parseTimeChange(f, booking.timezone);
    if (!parsed) return back(c, '/bookings', 'bad_time');
    const r = await proposeTime(db, config.appUrl, 'booker', { userId: user.id }, booking.id, parsed.start, parsed.end, str(f, 'note', 500));
    kick();
    return back(c, '/bookings', r === 'ok' ? 'proposal_sent' : r === 'bad_time' ? 'bad_time' : 'invalid_state');
  });

  app.post('/bookings/:id/proposal', async (c) => {
    const user = requireUser(c);
    const { db, config, kick } = c.get('deps');
    const f = await readForm(c);
    const accept = str(f, 'accept') === '1';
    const r = await respondToProposal(db, config.appUrl, 'booker', { userId: user.id }, c.req.param('id'), accept);
    kick();
    return back(c, '/bookings', r === 'ok' ? (accept ? 'proposal_accepted' : 'proposal_rejected') : r === 'full' ? 'proposal_conflict' : 'invalid_state');
  });

  // ---------- Einladungen ----------

  app.get('/invite/:token', async (c) => {
    const { db } = c.get('deps');
    const inv = await findInvitationByToken(db, c.req.param('token'));
    if (!inv) {
      return render(
        c,
        {
          title: 'Einladung ungültig',
          body: html`<section class="card narrow"><h1>Einladung nicht gültig</h1><p>Der Link ist abgelaufen, wurde widerrufen oder bereits verwendet. Bitte frage nach einer neuen Einladung.</p></section>`,
        },
        404,
      );
    }
    const user = c.get('user');
    const path = c.req.path;
    const intro = html`<h1>Einladung zu „${inv.workspace_name}“</h1>${inv.offering_name ? html`<p>Angebot: <strong>${inv.offering_name}</strong></p>` : ''}
      <p class="muted">Die Einladung gilt für die Adresse ${maskEmail(inv.email)}.</p>`;
    let action: H;
    if (!user) {
      action = html`<p>Melde dich mit der eingeladenen Adresse an. Hast du noch kein Konto, wird es dabei angelegt.</p>
        <form method="post" action="${path}/login"><button class="btn" type="submit">Anmeldelink an ${maskEmail(inv.email)} senden</button></form>`;
    } else if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
      action = html`<div class="flash flash-error" role="alert">Du bist als ${user.email} angemeldet. Diese Einladung gilt für eine andere Adresse.</div>
        <form method="post" action="/logout"><button class="btn btn-secondary" type="submit">Abmelden und mit der eingeladenen Adresse anmelden</button></form>`;
    } else {
      action = html`<form method="post" action="${path}"><button class="btn" type="submit">Einladung annehmen</button></form>`;
    }
    return render(c, { title: 'Einladung', body: html`<section class="card narrow">${intro}${action}</section>` });
  });

  // Anmeldung für die eingeladene Adresse – ohne sie im Klartext anzuzeigen.
  app.post('/invite/:token/login', async (c) => {
    const inv = await findInvitationByToken(c.get('deps').db, c.req.param('token'));
    if (!inv) return c.redirect(`/invite/${encodeURIComponent(c.req.param('token'))}`, 303);
    return startLogin(c, inv.email, `/invite/${c.req.param('token')}`, maskEmail(inv.email));
  });

  app.post('/invite/:token', async (c) => {
    const user = requireUser(c);
    const { db } = c.get('deps');
    const inv = await findInvitationByToken(db, c.req.param('token'));
    if (!inv) return c.redirect(`/invite/${encodeURIComponent(c.req.param('token'))}`, 303);
    const r = await acceptInvitation(db, inv, user);
    if (r !== 'ok') return c.redirect(`/invite/${encodeURIComponent(c.req.param('token'))}`, 303);
    return back(c, `/w/${inv.workspace_id}`, 'invite_accepted');
  });

  // Annahme aus der Übersicht: Die E-Mail-Adresse ist durch die Anmeldung bestätigt.
  app.post('/invitations/:id/accept', async (c) => {
    const user = requireUser(c);
    const { db } = c.get('deps');
    const inv = await db.get<{ id: string; workspace_id: string; email: string; role: 'admin' | 'member'; group_id: string | null; offering_id: string | null }>(
      `SELECT id, workspace_id, email, role, group_id, offering_id FROM invitations WHERE id = ? AND email = ? AND status = 'pending' AND expires_at > ?`,
      [c.req.param('id'), user.email, new Date().toISOString()],
    );
    if (!inv) notFound();
    const r = await acceptInvitation(db, inv, user);
    return r === 'ok' ? back(c, `/w/${inv.workspace_id}`, 'invite_accepted') : back(c, '/dashboard', 'invalid_state');
  });
}

/** Liest Datum, Uhrzeit und Dauer aus einem Formular und rechnet in UTC um. */
export function parseTimeChange(f: Parameters<typeof str>[0], tz: string): { start: number; end: number } | null {
  const duration = Number.parseInt(str(f, 'duration', 5), 10);
  if (!Number.isFinite(duration) || duration < 5 || duration > 1440) return null;
  try {
    const start = localToUtc(str(f, 'date', 10), str(f, 'time', 5), tz);
    return { start, end: start + duration * 60_000 };
  } catch (e) {
    if (e instanceof LocalTimeError) return null;
    throw e;
  }
}

