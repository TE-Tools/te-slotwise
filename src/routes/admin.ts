import type { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { ASSIGNABLE_ROLES, can, ROLE_LABELS, VISIBILITY_LABELS, type Role, type Visibility } from '../authz.ts';
import { isOfflineEmail, shownEmail } from '../offline.ts';
import { bool, int, list, notFound, oneOf, readForm, requireWs, str, type AppEnv, type Ctx, type Form, type WsContext } from '../context.ts';
import { normalizeEmail } from '../services/auth.ts';
import {
  awaiting,
  bookingHistory,
  bookingPeople,
  BOOKING_STATUS_LABELS,
  getWorkspaceBooking,
  listWorkspaceBookings,
  proposeTime,
  providerDecision,
  respondToProposal,
  type WsBookingRow,
} from '../services/bookings.ts';
import { ATTENDANCE_LABELS, uncheckedCount } from '../services/billing.ts';
import { retryNotification, sendSecret } from '../services/notifications.ts';
import { getAudience, getOffering, listOfferings, saveOffering, setArchived, type Audience, type Offering, type OfferingInput } from '../services/offerings.ts';
import {
  bulkSlots,
  createSeries,
  repeatWeek,
  createSlot,
  getSlot,
  listSlotsAdmin,
  SlotError,
  slotState,
  deleteSlots,
  followingInSeries,
  seriesFromIds,
  updateSlots,
  type SlotChangeResult,
  type BulkAction,
  type SlotInput,
  type SlotKind,
  type SlotVisibility,
} from '../services/slots.ts';
import {
  changeRole,
  createInvitation,
  deleteGroup,
  deleteWorkspace,
  getGroup,
  groupMemberIds,
  invitationsCreatedSince,
  listGroups,
  listInvitations,
  listMembers,
  markInvitationSent,
  removeMember,
  renewInvitation,
  revokeInvitation,
  rotatePublicToken,
  setBookedDisplay,
  saveGroup,
  setGroupMembers,
  updateWorkspace,
  type Invitation,
} from '../services/workspaces.ts';
import { TEMPLATE_LABELS, type Template } from '../mail/templates.ts';
import { addDays, COMMON_TIME_ZONES, durationLabel, isoWeekday, formatDate, formatTime, isValidTimeZone, LocalTimeError, localDate, localTime, localToUtc } from '../time.ts';
import { awaitingLabel, proposalNote, timeChangeForm } from '../views/booking.ts';
import { monthAgenda, monthCalendar, monthRange, parseMonth, type AgendaEntry } from '../views/calendar.ts';
import { parseWeek, weekCalendar, weekRange, type WeekItem } from '../views/week.ts';
import { bookingBadge, checked, emptyState, errorBox, flash, options, pageHeader, shareBox, slotStateBadge, when, type Frag, type H } from '../views/ui.ts';
import { parseTimeChange } from './account.ts';
import { back, render } from './common.ts';

const page = (c: Ctx, ws: WsContext, section: string, title: string, body: Frag | Frag[], status: 200 | 400 = 200) =>
  render(c, { title: `${title} – ${ws.name}`, ws, section, body, wide: true }, status);

/** Auswahl einer Zielgruppe: Gruppen und einzelne Personen. */
async function audiencePicker(c: Ctx, ws: WsContext, selected: Audience) {
  const { db } = c.get('deps');
  const groups = await listGroups(db, ws.id);
  const members = await listMembers(db, ws.id);
  const g = new Set(selected.groupIds);
  const m = new Set(selected.membershipIds);
  return html`<fieldset class="field audience" data-audience>
    <legend>Zielgruppe (nur bei „ausgewählte Gruppen/Personen“)</legend>
    <div class="audience-cols">
      <div><p class="label">Gruppen</p>${groups.length
        ? groups.map((x) => html`<label class="check"><input type="checkbox" name="aud_group" value="${x.id}" ${checked(g.has(x.id))}> ${x.name} <span class="muted">(${x.member_count})</span></label>`)
        : html`<p class="muted">Noch keine Gruppen. <a href="/w/${ws.id}/groups">Gruppe anlegen</a></p>`}</div>
      <div><p class="label">Personen</p>${members.map(
        (x) => html`<label class="check"><input type="checkbox" name="aud_member" value="${x.membership_id}" ${checked(m.has(x.membership_id))}> ${x.display_name || x.email}</label>`,
      )}</div>
    </div>
  </fieldset>`;
}

const readAudience = (f: Form): Audience => ({ groupIds: list(f, 'aud_group'), membershipIds: list(f, 'aud_member') });

function visibilitySelect(name: string, value: string, withInherit: boolean): H {
  const items: { value: string; label: string }[] = (Object.keys(VISIBILITY_LABELS) as Visibility[]).map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }));
  if (withInherit) items.unshift({ value: 'inherit', label: 'Wie das Angebot' });
  return html`<select id="${name}" name="${name}" data-visibility>${options(items, value)}</select>`;
}

const VIS_VALUES = ['public', 'groups', 'people', 'internal'] as const;
const BOOKED_OPTIONS = [
  { value: 'anonymous', label: 'Anonym („Belegt“)' },
  { value: 'names', label: 'Mit Vornamen' },
  { value: 'hidden', label: 'Gar nicht anzeigen (wirkt wie gesperrt)' },
];
const SLOT_VIS_VALUES = ['inherit', ...VIS_VALUES] as const;

export function registerAdminRoutes(app: Hono<AppEnv>) {
  // ---------- Übersicht ----------

  app.get('/w/:wid', async (c) => {
    const { ws } = await requireWs(c);
    if (!can(ws.role, 'bookings.manage')) return c.redirect(`/w/${ws.id}/book${c.req.query('msg') ? `?msg=${encodeURIComponent(c.req.query('msg')!)}` : ''}`);
    const { db, config } = c.get('deps');
    const now = Date.now();
    const upcoming = await listWorkspaceBookings(db, ws.id, { fromIso: new Date(now).toISOString() });
    const needsMe = upcoming.filter((b) => awaiting(b) === 'provider' || (b.status === 'confirmed' && b.cancel_requested_at));
    const confirmed = upcoming.filter((b) => b.status === 'confirmed');
    const offerings = await listOfferings(db, ws.id);
    const failed = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE workspace_id = ? AND status = 'failed'`, [ws.id]))!.n;
    const toCheck = can(ws.role, 'billing.manage') ? await uncheckedCount(db, ws.id, now) : 0;
    return page(c, ws, 'overview', 'Übersicht', [
      flash(c.req.query('msg')),
      pageHeader(ws.name, undefined, html`<a class="btn" href="/w/${ws.id}/slots/new">Slots anlegen</a>`),
      html`<div class="stats">
        <a class="stat ${needsMe.length ? 'stat-action' : ''}" href="/w/${ws.id}/bookings?status=awaiting_me"><span class="stat-num">${needsMe.length}</span><span>warten auf dich</span></a>
        <a class="stat" href="/w/${ws.id}/bookings?status=confirmed"><span class="stat-num">${confirmed.length}</span><span>feste kommende Termine</span></a>
        <a class="stat" href="/w/${ws.id}/offerings"><span class="stat-num">${offerings.length}</span><span>aktive Angebote</span></a>
        ${toCheck ? html`<a class="stat stat-action" href="/w/${ws.id}/students/check"><span class="stat-num">${toCheck}</span><span>Termine abzuhaken</span></a>` : ''}
        ${failed ? html`<a class="stat stat-error" href="/w/${ws.id}/notifications"><span class="stat-num">${failed}</span><span>fehlgeschlagene E-Mails</span></a>` : ''}
      </div>`,
      !offerings.length
        ? html`<section class="card"><h2>Erste Schritte</h2><ol class="steps">
            <li><a href="/w/${ws.id}/offerings/new">Angebot anlegen</a> – was kann gebucht werden?</li>
            <li><a href="/w/${ws.id}/slots/new">Slots oder Zeitfenster freigeben</a></li>
            <li><a href="/w/${ws.id}/members">Personen einladen</a> oder den <a href="/w/${ws.id}/settings">öffentlichen Link</a> aktivieren und teilen</li>
          </ol></section>`
        : '',
      html`<section class="card"><h2>Als Nächstes</h2>
        ${confirmed.length
          ? html`<ul class="list">${confirmed.slice(0, 8).map(
              (b) => html`<li class="row"><span>${when(b.starts_at, b.ends_at, b.timezone)} · <strong>${b.booker_name}</strong> · ${b.offering_name}</span>${awaitingLabel(b, 'provider')}</li>`,
            )}</ul>`
          : emptyState('Keine festen Termine', 'Bestätigte Buchungen erscheinen hier.')}
      </section>`,
      ws.public_enabled
        ? html`<section class="card"><h2>Öffentliche Buchungsseite</h2>${shareBox(`${config.appUrl}/p/${ws.public_token}`, ws.name, 'Zeigt nur öffentliche Angebote und freie Termine – keine Namen, keine Buchungen anderer.')}</section>`
        : '',
    ]);
  });

  // ---------- Einstellungen ----------

  app.get('/w/:wid/settings', async (c) => {
    const { ws } = await requireWs(c, 'workspace.manage');
    const { config } = c.get('deps');
    return page(c, ws, 'settings', 'Einstellungen', [
      flash(c.req.query('msg')),
      pageHeader('Einstellungen'),
      html`<section class="card"><form method="post" action="/w/${ws.id}/settings" class="stack">
        <div class="field"><label for="name">Name</label><input id="name" name="name" required maxlength="120" value="${ws.name}"></div>
        <fieldset class="field"><legend>Art</legend>
          <label class="check"><input type="radio" name="kind" value="personal" ${checked(ws.kind === 'personal')}> Persönlich</label>
          <label class="check"><input type="radio" name="kind" value="organization" ${checked(ws.kind === 'organization')}> Organisation</label>
        </fieldset>
        <div class="field"><label for="timezone">Zeitzone</label><select id="timezone" name="timezone">${options(
          [...new Set([ws.timezone, ...COMMON_TIME_ZONES])].map((z) => ({ value: z, label: z })),
          ws.timezone,
        )}</select><span class="hint">Gilt für neue Slots. Bestehende Slots behalten ihre Zeitzone.</span></div>
        <div class="field"><label for="description">Beschreibung (öffentlich sichtbar, wenn die öffentliche Seite aktiv ist)</label><textarea id="description" name="description" rows="3" maxlength="2000">${ws.description}</textarea></div>
        <label class="check"><input type="checkbox" name="public_enabled" value="1" ${checked(ws.public_enabled)}> Öffentliche Buchungsseite aktivieren</label>
        <fieldset class="field"><legend>Belegte Termine im Kalender (dunkelgrün)</legend>
          <div class="grid-form">
            <label>Für öffentliche Besucher <select name="show_booked_public">${options(BOOKED_OPTIONS, ws.show_booked_public)}</select></label>
            <label>Für Mitglieder und Gruppen <select name="show_booked_members">${options(BOOKED_OPTIONS, ws.show_booked_members)}</select></label>
          </div>
          <span class="hint">Mit Namen wird nur der Vorname gezeigt, nie die E-Mail-Adresse. Bitte nur mit Einverständnis der Buchenden. Jede Person sieht nur Termine, die für sie freigegeben sind.</span>
        </fieldset>
        <button class="btn" type="submit">Speichern</button>
      </form></section>`,
      html`<section class="card"><h2>Öffentlicher Link</h2>
        ${ws.public_enabled
          ? shareBox(`${config.appUrl}/p/${ws.public_token}`, ws.name, 'Der Link ist nicht erratbar. Sichtbar sind nur öffentliche Angebote und freie Termine.')
          : html`<p class="muted">Die öffentliche Seite ist ausgeschaltet. Der Link funktioniert erst nach dem Aktivieren.</p>`}
        <form method="post" action="/w/${ws.id}/settings/rotate" data-confirm="Neuen Link erzeugen? Der alte Link funktioniert danach nicht mehr."><button class="btn btn-secondary" type="submit">Neuen Link erzeugen</button></form>
      </section>`,
      can(ws.role, 'workspace.delete')
        ? html`<section class="card danger-zone"><h2>Arbeitsbereich löschen</h2>
            <p>Löscht alle Angebote, Slots, Gruppen, Mitgliedschaften, Einladungen und Buchungen dieses Bereichs endgültig.</p>
            <form method="post" action="/w/${ws.id}/settings/delete" class="stack" data-confirm="Wirklich endgültig löschen?">
              <div class="field"><label for="confirm_name">Zur Bestätigung den Namen eingeben: <strong>${ws.name}</strong></label><input id="confirm_name" name="confirm_name" required></div>
              <button class="btn btn-danger" type="submit">Endgültig löschen</button>
            </form></section>`
        : '',
    ]);
  });

  app.post('/w/:wid/settings', async (c) => {
    const { ws } = await requireWs(c, 'workspace.manage');
    const f = await readForm(c);
    const name = str(f, 'name', 120);
    const tz = str(f, 'timezone', 64);
    if (!name || !isValidTimeZone(tz)) return back(c, `/w/${ws.id}/settings`, 'invalid_state');
    await updateWorkspace(c.get('deps').db, ws.id, {
      name,
      kind: oneOf(str(f, 'kind'), ['personal', 'organization'] as const, ws.kind),
      timezone: tz,
      description: str(f, 'description', 2000),
      publicEnabled: bool(f, 'public_enabled'),
    });
    const modes = ['hidden', 'anonymous', 'names'] as const;
    await setBookedDisplay(c.get('deps').db, ws.id, oneOf(str(f, 'show_booked_public'), modes, 'anonymous'), oneOf(str(f, 'show_booked_members'), modes, 'anonymous'));
    return back(c, `/w/${ws.id}/settings`, 'saved');
  });

  app.post('/w/:wid/settings/rotate', async (c) => {
    const { ws } = await requireWs(c, 'workspace.manage');
    await rotatePublicToken(c.get('deps').db, ws.id);
    return back(c, `/w/${ws.id}/settings`, 'link_rotated');
  });

  app.post('/w/:wid/settings/delete', async (c) => {
    const { ws } = await requireWs(c, 'workspace.delete');
    const f = await readForm(c);
    if (str(f, 'confirm_name', 200) !== ws.name) return back(c, `/w/${ws.id}/settings`, 'confirm_mismatch');
    await deleteWorkspace(c.get('deps').db, ws.id);
    return back(c, '/dashboard', 'deleted');
  });

  // ---------- Mitglieder & Einladungen ----------

  const membersPage = async (c: Ctx, ws: WsContext, extra: Frag = '', error?: string) => {
    const { db, mailer } = c.get('deps');
    const members = await listMembers(db, ws.id);
    const invitations = await listInvitations(db, ws.id);
    const groups = await listGroups(db, ws.id);
    const offerings = await listOfferings(db, ws.id);
    return page(c, ws, 'members', 'Mitglieder', [
      flash(c.req.query('msg')),
      errorBox(error),
      extra,
      pageHeader('Mitglieder & Einladungen'),
      mailer.mode === 'none'
        ? html`<div class="flash flash-info">Es ist kein E-Mail-Versand eingerichtet. Einladungen werden <strong>nicht</strong> per E-Mail verschickt – teile den angezeigten Link selbst (z. B. per Messenger). Eingeladene können sich alternativ mit ihrer Adresse anmelden und die Einladung in ihrer Übersicht annehmen.</div>`
        : '',
      html`<section class="card"><h2>Person einladen</h2>
        <form method="post" action="/w/${ws.id}/invitations" class="grid-form">
          <label>E-Mail-Adresse <input type="email" name="email" required maxlength="254"></label>
          <label>Rolle <select name="role">${options(ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })), 'member')}</select></label>
          <label>Zu Gruppe hinzufügen (optional) <select name="group_id"><option value="">– keine –</option>${options(groups.map((g) => ({ value: g.id, label: g.name })), null)}</select></label>
          <label>Für Angebot freischalten (optional) <select name="offering_id"><option value="">– keines –</option>${options(offerings.map((o) => ({ value: o.id, label: o.name })), null)}</select></label>
          <p class="hint span-all">Einladungen gelten 7 Tage und nur für diese Adresse. Der Link allein gewährt keinen Zugriff – die Person muss sich mit der Adresse anmelden.</p>
          <button class="btn" type="submit">Einladen</button>
        </form></section>`,
      html`<section class="card"><h2>Offene Einladungen</h2>
        ${invitations.length
          ? html`<div class="table-wrap"><table><thead><tr><th>E-Mail</th><th>Rolle</th><th>Bezug</th><th>Gültig bis</th><th>Versand</th><th><span class="sr-only">Aktionen</span></th></tr></thead><tbody>
              ${invitations.map((i) => invitationRow(ws, i))}
            </tbody></table></div>`
          : html`<p class="muted">Keine offenen Einladungen.</p>`}
      </section>`,
      html`<section class="card"><h2>Mitglieder</h2><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th><span class="sr-only">Aktionen</span></th></tr></thead><tbody>
        ${members.map(
          (m) => html`<tr><td>${m.display_name || '–'}</td><td>${isOfflineEmail(m.email) ? html`<span class="badge badge-muted">ohne App</span>` : m.email}</td>
            <td>${m.role === 'owner'
              ? ROLE_LABELS.owner
              : html`<form method="post" action="/w/${ws.id}/members/${m.membership_id}/role" class="inline">
                  <label class="sr-only" for="role-${m.membership_id}">Rolle</label>
                  <select id="role-${m.membership_id}" name="role" data-autosubmit>${options(
                    (m.role === 'staff' ? [...ASSIGNABLE_ROLES, 'staff' as Role] : ASSIGNABLE_ROLES).map((r) => ({ value: r, label: ROLE_LABELS[r] })),
                    m.role,
                  )}</select><noscript><button class="btn btn-small" type="submit">Ändern</button></noscript></form>`}</td>
            <td>${m.role === 'owner'
              ? ''
              : html`<form method="post" action="/w/${ws.id}/members/${m.membership_id}/remove" class="inline" data-confirm="Mitglied entfernen? Gruppenzuordnungen gehen verloren, Buchungen bleiben erhalten."><button class="btn btn-small btn-danger" type="submit">Entfernen</button></form>`}</td></tr>`,
        )}</tbody></table></div></section>`,
    ]);
  };

  function invitationRow(ws: WsContext, i: Invitation & { group_name: string | null; offering_name: string | null }): H {
    return html`<tr><td>${i.email}</td><td>${ROLE_LABELS[i.role]}</td>
      <td>${[i.group_name && `Gruppe ${i.group_name}`, i.offering_name && `Angebot ${i.offering_name}`].filter(Boolean).join(', ') || 'Arbeitsbereich'}</td>
      <td>${Date.parse(i.expires_at) < Date.now() ? html`<span class="badge badge-declined">abgelaufen</span>` : formatDate(Date.parse(i.expires_at), ws.timezone)}</td>
      <td>${i.send_count ? `${i.send_count}× gesendet` : html`<span class="muted">nicht per E-Mail</span>`}</td>
      <td class="actions">
        <form method="post" action="/w/${ws.id}/invitations/${i.id}/resend" class="inline"><button class="btn btn-small btn-secondary" type="submit">Erneut senden</button></form>
        <form method="post" action="/w/${ws.id}/invitations/${i.id}/revoke" class="inline" data-confirm="Einladung widerrufen?"><button class="btn btn-small btn-danger" type="submit">Widerrufen</button></form>
      </td></tr>`;
  }

  app.get('/w/:wid/members', async (c) => {
    const { ws } = await requireWs(c, 'members.manage');
    return membersPage(c, ws);
  });

  /** Versendet eine Einladung und zeigt den Link einmalig zum Teilen an. */
  async function deliverInvitation(c: Ctx, ws: WsContext, invitationId: string, email: string, token: string, offeringName: string | null) {
    const { db, mailer, config, limiter } = c.get('deps');
    const link = `${config.appUrl}/invite/${token}`;
    let status: string = 'not_configured';
    if (mailer.mode !== 'none' && limiter.take(`invite-mail:${email}`, 3, 3600_000)) {
      status = await sendSecret(db, mailer, ws.id, { userId: null, email }, 'invitation', { workspaceName: ws.name, offeringName: offeringName ?? undefined }, link);
      if (status === 'sent' || status === 'logged') await markInvitationSent(db, invitationId);
    }
    const info =
      status === 'sent'
        ? html`<div class="flash flash-ok" role="status">Einladung an ${email} per E-Mail gesendet.</div>`
        : status === 'logged'
          ? html`<div class="flash flash-info" role="status">Entwicklungsmodus: E-Mail an ${email} wurde nur in der Serverkonsole ausgegeben.</div>`
          : status === 'failed'
            ? html`<div class="flash flash-error" role="alert">Die E-Mail an ${email} konnte nicht versendet werden. Die Einladung ist trotzdem gültig – teile den Link selbst oder versuche es später erneut.</div>`
            : html`<div class="flash flash-info" role="status">Es wurde keine E-Mail versendet. Teile den Link selbst mit ${email}.</div>`;
    return html`<section class="card highlight">${info}${shareBox(link, `Einladung zu ${ws.name}`, 'Dieser Link wird nur jetzt angezeigt. „Erneut senden“ erzeugt einen neuen Link.')}</section>`;
  }

  app.post('/w/:wid/invitations', async (c) => {
    const { user, ws } = await requireWs(c, 'members.manage');
    const { db } = c.get('deps');
    const f = await readForm(c);
    const email = normalizeEmail(str(f, 'email', 300));
    if (!email) return membersPage(c, ws, '', 'Bitte eine gültige E-Mail-Adresse eingeben.');
    if (await invitationsCreatedSince(db, ws.id, Date.now() - 3600_000) >= 50) return back(c, `/w/${ws.id}/members`, 'invite_rate');
    const role = oneOf(str(f, 'role'), ASSIGNABLE_ROLES, 'member');
    const groupId = str(f, 'group_id', 50) || null;
    const offeringId = str(f, 'offering_id', 50) || null;
    if (groupId && !await getGroup(db, ws.id, groupId)) notFound();
    const offering = offeringId ? await getOffering(db, ws.id, offeringId) : null;
    if (offeringId && !offering) notFound();
    const { id, token } = await createInvitation(db, ws.id, user.id, { email, role, groupId, offeringId });
    return membersPage(c, ws, await deliverInvitation(c, ws, id, email, token, offering?.name ?? null));
  });

  app.post('/w/:wid/invitations/:iid/resend', async (c) => {
    const { ws } = await requireWs(c, 'members.manage');
    const { db } = c.get('deps');
    const inv = await db.get<{ id: string; email: string; offering_name: string | null }>(
      `SELECT i.id, i.email, o.name AS offering_name FROM invitations i LEFT JOIN offerings o ON o.id = i.offering_id WHERE i.id = ? AND i.workspace_id = ? AND i.status = 'pending'`,
      [c.req.param('iid'), ws.id],
    );
    if (!inv) notFound();
    const token = (await renewInvitation(db, ws.id, inv.id))!;
    return membersPage(c, ws, await deliverInvitation(c, ws, inv.id, inv.email, token, inv.offering_name));
  });

  app.post('/w/:wid/invitations/:iid/revoke', async (c) => {
    const { ws } = await requireWs(c, 'members.manage');
    await revokeInvitation(c.get('deps').db, ws.id, c.req.param('iid'));
    return back(c, `/w/${ws.id}/members`, 'invite_revoked');
  });

  app.post('/w/:wid/members/:mid/role', async (c) => {
    const { ws } = await requireWs(c, 'members.manage');
    const f = await readForm(c);
    const role = oneOf(str(f, 'role'), [...ASSIGNABLE_ROLES, 'staff'] as Role[], 'member');
    const r = await changeRole(c.get('deps').db, ws.id, c.req.param('mid'), role);
    if (r === 'not_found') notFound();
    return back(c, `/w/${ws.id}/members`, r === 'ok' ? 'saved' : 'last_owner');
  });

  app.post('/w/:wid/members/:mid/remove', async (c) => {
    const { ws } = await requireWs(c, 'members.manage');
    const r = await removeMember(c.get('deps').db, ws.id, c.req.param('mid'));
    if (r === 'not_found') notFound();
    return back(c, `/w/${ws.id}/members`, r === 'ok' ? 'deleted' : 'last_owner');
  });

  // ---------- Gruppen ----------

  app.get('/w/:wid/groups', async (c) => {
    const { ws } = await requireWs(c, 'groups.manage');
    const groups = await listGroups(c.get('deps').db, ws.id);
    return page(c, ws, 'groups', 'Gruppen', [
      flash(c.req.query('msg')),
      pageHeader('Gruppen', 'Gruppen bündeln Personen, z. B. Klassen, Kurse, Teams oder Unterrichtsgruppen. Mitglieder sehen nur ihre eigenen Gruppen.'),
      html`<section class="card"><h2>Neue Gruppe</h2><form method="post" action="/w/${ws.id}/groups" class="grid-form">
        <label>Name <input name="name" required maxlength="120"></label>
        <label>Beschreibung (optional) <input name="description" maxlength="500"></label>
        <button class="btn" type="submit">Anlegen</button></form></section>`,
      groups.length
        ? html`<section class="card"><ul class="list">${groups.map(
            (g) => html`<li class="row"><a href="/w/${ws.id}/groups/${g.id}"><strong>${g.name}</strong></a><span class="muted">${g.member_count} Mitglieder</span></li>`,
          )}</ul></section>`
        : emptyState('Noch keine Gruppen', 'Gruppen sind optional. Du brauchst sie, um Termine nur für bestimmte Personenkreise freizugeben.'),
    ]);
  });

  app.post('/w/:wid/groups', async (c) => {
    const { ws } = await requireWs(c, 'groups.manage');
    const f = await readForm(c);
    const name = str(f, 'name', 120);
    if (!name) return back(c, `/w/${ws.id}/groups`, 'invalid_state');
    const id = await saveGroup(c.get('deps').db, ws.id, null, { name, description: str(f, 'description', 500) });
    return back(c, `/w/${ws.id}/groups/${id}`, 'saved');
  });

  app.get('/w/:wid/groups/:gid', async (c) => {
    const { ws } = await requireWs(c, 'groups.manage');
    const { db } = c.get('deps');
    const group = await getGroup(db, ws.id, c.req.param('gid'));
    if (!group) notFound();
    const inGroup = await groupMemberIds(db, ws.id, group.id);
    const members = await listMembers(db, ws.id);
    return page(c, ws, 'groups', group.name, [
      flash(c.req.query('msg')),
      pageHeader(group.name),
      html`<section class="card"><form method="post" action="/w/${ws.id}/groups/${group.id}" class="stack">
        <div class="field"><label for="name">Name</label><input id="name" name="name" required maxlength="120" value="${group.name}"></div>
        <div class="field"><label for="description">Beschreibung</label><input id="description" name="description" maxlength="500" value="${group.description}"></div>
        <fieldset class="field"><legend>Mitglieder</legend>
          ${members.length
            ? members.map((m) => html`<label class="check"><input type="checkbox" name="members" value="${m.membership_id}" ${checked(inGroup.has(m.membership_id))}> ${m.display_name || m.email} <span class="muted">${shownEmail(m.email)}</span></label>`)
            : html`<p class="muted">Noch keine Mitglieder – <a href="/w/${ws.id}/members">Personen einladen</a>.</p>`}
        </fieldset>
        <p class="hint">Neue Personen kannst du direkt in diese Gruppe einladen: unter „Mitglieder“ beim Einladen die Gruppe wählen.</p>
        <button class="btn" type="submit">Speichern</button>
      </form></section>`,
      html`<form method="post" action="/w/${ws.id}/groups/${group.id}/delete" data-confirm="Gruppe löschen? Freigaben für diese Gruppe entfallen."><button class="btn btn-danger" type="submit">Gruppe löschen</button></form>`,
    ]);
  });

  app.post('/w/:wid/groups/:gid', async (c) => {
    const { ws } = await requireWs(c, 'groups.manage');
    const { db } = c.get('deps');
    const group = await getGroup(db, ws.id, c.req.param('gid'));
    if (!group) notFound();
    const f = await readForm(c);
    await saveGroup(db, ws.id, group.id, { name: str(f, 'name', 120) || group.name, description: str(f, 'description', 500) });
    await setGroupMembers(db, ws.id, group.id, list(f, 'members'));
    return back(c, `/w/${ws.id}/groups/${group.id}`, 'saved');
  });

  app.post('/w/:wid/groups/:gid/delete', async (c) => {
    const { ws } = await requireWs(c, 'groups.manage');
    if (!await deleteGroup(c.get('deps').db, ws.id, c.req.param('gid'))) notFound();
    return back(c, `/w/${ws.id}/groups`, 'deleted');
  });

  // ---------- Angebote ----------

  app.get('/w/:wid/offerings', async (c) => {
    const { ws } = await requireWs(c, 'offerings.manage');
    const { db, config } = c.get('deps');
    const offerings = await listOfferings(db, ws.id, true);
    return page(c, ws, 'offerings', 'Angebote', [
      flash(c.req.query('msg')),
      pageHeader('Angebote', 'Ein Angebot beschreibt, was gebucht werden kann – z. B. Unterrichtsstunde, Beratung, Kurs, Raum oder Veranstaltung.', html`<a class="btn" href="/w/${ws.id}/offerings/new">Neues Angebot</a>`),
      offerings.length
        ? html`<div class="cards">${offerings.map(
            (o) => html`<article class="card ${o.archived_at ? 'archived' : ''}">
              <h2><a href="/w/${ws.id}/offerings/${o.id}">${o.name}</a> ${o.archived_at ? html`<span class="badge badge-muted">archiviert</span>` : ''}</h2>
              <p class="muted">${durationLabel(o.duration_min)}${o.buffer_min ? ` + ${o.buffer_min} Min. Puffer` : ''} · ${o.confirmation_mode === 'auto' ? 'automatische Bestätigung' : 'manuelle Bestätigung'} · ${VISIBILITY_LABELS[o.visibility]}</p>
              <p>${o.upcoming_slots} kommende Slots · <a href="/w/${ws.id}/slots/new?offering=${o.id}">Slots anlegen</a></p>
              ${!o.archived_at
                ? o.visibility === 'public' && ws.public_enabled
                  ? html`<details><summary>Link teilen</summary>${shareBox(`${config.appUrl}/p/${ws.public_token}`, o.name)}</details>`
                  : html`<details><summary>Link teilen (nur für Berechtigte)</summary>${shareBox(`${config.appUrl}/w/${ws.id}/o/${o.id}`, o.name, 'Wer den Link öffnet, muss sich anmelden und berechtigt sein.')}</details>`
                : ''}
            </article>`,
          )}</div>`
        : emptyState('Noch keine Angebote', 'Lege dein erstes Angebot an. Danach gibst du dafür Slots oder Zeitfenster frei.', html`<a class="btn" href="/w/${ws.id}/offerings/new">Angebot anlegen</a>`),
    ]);
  });

  const offeringForm = (c: Ctx, ws: WsContext, o: Offering | null, audience: Audience, error?: string) =>
    page(c, ws, 'offerings', o ? o.name : 'Neues Angebot', [
      flash(c.req.query('msg')),
      errorBox(error),
      pageHeader(o ? `Angebot: ${o.name}` : 'Neues Angebot'),
      html`<section class="card"><form method="post" action="/w/${ws.id}/offerings${o ? `/${o.id}` : ''}" class="stack">
        <div class="field"><label for="name">Name</label><input id="name" name="name" required maxlength="120" value="${o?.name ?? ''}" placeholder="z. B. Einzelstunde, Erstgespräch, Raum A"></div>
        <div class="field"><label for="description">Beschreibung</label><textarea id="description" name="description" rows="3" maxlength="2000">${o?.description ?? ''}</textarea></div>
        <div class="grid-form">
          <label>Standarddauer (Min.) <input type="number" name="duration_min" min="5" max="1440" step="5" required value="${o?.duration_min ?? 60}"></label>
          <label>Pufferzeit danach (Min.) <input type="number" name="buffer_min" min="0" max="240" step="5" value="${o?.buffer_min ?? 0}"></label>
          <label>Plätze pro Termin <input type="number" name="default_capacity" min="1" max="500" value="${o?.default_capacity ?? 1}"></label>
          <label>Ort <input name="location" maxlength="300" value="${o?.location ?? ''}"></label>
          <label class="span-all">Online-Information (nur für bestätigte Buchende sichtbar) <input name="online_info" maxlength="500" value="${o?.online_info ?? ''}" placeholder="z. B. Link zum Videoraum"></label>
        </div>
        <fieldset class="field"><legend>Buchungsregeln</legend>
          <label class="check"><input type="radio" name="confirmation_mode" value="manual" ${checked(!o || o.confirmation_mode === 'manual')}> Manuelle Bestätigung – du prüfst jede Anfrage</label>
          <label class="check"><input type="radio" name="confirmation_mode" value="auto" ${checked(o?.confirmation_mode === 'auto')}> Automatische Bestätigung – direkt fest, wenn die Zeit frei ist</label>
          <label class="check"><input type="checkbox" name="hold_on_request" value="1" ${checked(o?.hold_on_request)}> Offene Anfragen blockieren die Zeit für andere<span class="hint">Aus: Mehrere Personen können dieselbe oder überlappende Zeiten anfragen; du entscheidest.</span></label>
          <label class="check"><input type="checkbox" name="allow_self_cancel" value="1" ${checked(!o || o.allow_self_cancel)}> Buchende dürfen feste Termine selbst absagen</label>
          <div class="grid-form">
            <label>… bis Stunden vor Beginn <input type="number" name="cancel_cutoff_hours" min="0" max="720" value="${o?.cancel_cutoff_hours ?? 24}"></label>
            <label>Mindestvorlauf für Buchungen (Std.) <input type="number" name="min_notice_hours" min="0" max="720" value="${o?.min_notice_hours ?? 0}"></label>
          </div>
        </fieldset>
        <div class="field"><label for="visibility">Wer darf sehen und buchen?</label>${visibilitySelect('visibility', o?.visibility ?? 'internal', false)}</div>
        ${audiencePicker(c, ws, audience)}
        <button class="btn" type="submit">Speichern</button>
      </form></section>`,
      o
        ? html`<form method="post" action="/w/${ws.id}/offerings/${o.id}/archive"><input type="hidden" name="archived" value="${o.archived_at ? '0' : '1'}">
            <button class="btn btn-secondary" type="submit">${o.archived_at ? 'Wieder aktivieren' : 'Archivieren (nicht mehr buchbar)'}</button></form>`
        : '',
    ]);

  function readOffering(f: Form): OfferingInput {
    return {
      name: str(f, 'name', 120),
      description: str(f, 'description', 2000),
      duration_min: int(f, 'duration_min', 5, 1440, 60),
      buffer_min: int(f, 'buffer_min', 0, 240, 0),
      default_capacity: int(f, 'default_capacity', 1, 500, 1),
      location: str(f, 'location', 300),
      online_info: str(f, 'online_info', 500),
      confirmation_mode: oneOf(str(f, 'confirmation_mode'), ['manual', 'auto'] as const, 'manual'),
      hold_on_request: bool(f, 'hold_on_request') ? 1 : 0,
      allow_self_cancel: bool(f, 'allow_self_cancel') ? 1 : 0,
      cancel_cutoff_hours: int(f, 'cancel_cutoff_hours', 0, 720, 24),
      min_notice_hours: int(f, 'min_notice_hours', 0, 720, 0),
      visibility: oneOf(str(f, 'visibility'), VIS_VALUES, 'internal'),
    };
  }

  app.get('/w/:wid/offerings/new', async (c) => {
    const { ws } = await requireWs(c, 'offerings.manage');
    return offeringForm(c, ws, null, { groupIds: [], membershipIds: [] });
  });

  app.post('/w/:wid/offerings', async (c) => {
    const { ws } = await requireWs(c, 'offerings.manage');
    const f = await readForm(c);
    const input = readOffering(f);
    if (!input.name) return offeringForm(c, ws, null, readAudience(f), 'Bitte einen Namen eingeben.');
    const id = (await saveOffering(c.get('deps').db, ws.id, null, input, readAudience(f)))!;
    return back(c, `/w/${ws.id}/offerings/${id}`, 'saved');
  });

  app.get('/w/:wid/offerings/:oid', async (c) => {
    const { ws } = await requireWs(c, 'offerings.manage');
    const { db } = c.get('deps');
    const o = await getOffering(db, ws.id, c.req.param('oid'));
    if (!o) notFound();
    return offeringForm(c, ws, o, await getAudience(db, 'offering', ws.id, o.id));
  });

  app.post('/w/:wid/offerings/:oid', async (c) => {
    const { ws } = await requireWs(c, 'offerings.manage');
    const { db } = c.get('deps');
    const o = await getOffering(db, ws.id, c.req.param('oid'));
    if (!o) notFound();
    const f = await readForm(c);
    const input = readOffering(f);
    if (!input.name) return offeringForm(c, ws, o, readAudience(f), 'Bitte einen Namen eingeben.');
    await saveOffering(db, ws.id, o.id, input, readAudience(f));
    return back(c, `/w/${ws.id}/offerings/${o.id}`, 'saved');
  });

  app.post('/w/:wid/offerings/:oid/archive', async (c) => {
    const { ws } = await requireWs(c, 'offerings.manage');
    const f = await readForm(c);
    if (!await setArchived(c.get('deps').db, ws.id, c.req.param('oid'), str(f, 'archived') === '1')) notFound();
    return back(c, `/w/${ws.id}/offerings`, 'saved');
  });

  // ---------- Wochenkalender ----------

  app.get('/w/:wid/calendar', async (c) => {
    const { ws } = await requireWs(c, 'bookings.manage');
    const { db } = c.get('deps');
    const tz = ws.timezone;
    const today = localDate(Date.now(), tz);
    // Ansicht: Tag, Woche (Standard) oder Monat.
    const view = oneOf(c.req.query('view') ?? '', ['day', 'week', 'month'] as const, 'week');
    const dayParam = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('day') ?? '') ? c.req.query('day')! : null;
    const weekStart = view === 'day' ? (dayParam ?? today) : parseWeek(c.req.query('week') ?? dayParam ?? undefined, today);
    const month = parseMonth(c.req.query('month'), dayParam ?? c.req.query('week') ?? today);
    const [fromIso, toIso] =
      view === 'month'
        ? (monthRange(month).map((d) => new Date(localToUtc(d, '00:00', tz)).toISOString()) as [string, string])
        : view === 'day'
          ? ([new Date(localToUtc(weekStart, '00:00', tz)).toISOString(), new Date(localToUtc(addDays(weekStart, 1), '00:00', tz)).toISOString()] as [string, string])
          : weekRange(weekStart, tz);
    const offeringId = c.req.query('offering') || undefined;
    const slots = await listSlotsAdmin(db, ws.id, { fromIso: new Date(Date.parse(fromIso) - 86_400_000).toISOString(), toIso, offeringId });
    const bookings = (await listWorkspaceBookings(db, ws.id, { fromIso, toIso, offeringId })).filter((b) => b.status === 'requested' || b.status === 'confirmed');
    const items: WeekItem[] = [];
    for (const sl of slots) {
      const kind = sl.status === 'draft' ? 'draft' : sl.status === 'closed' ? 'closed' : sl.preference === 'reluctant' ? 'reluctant' : 'free';
      const full = sl.kind === 'fixed' && sl.confirmed >= sl.capacity;
      items.push({
        start: Date.parse(sl.starts_at),
        end: Date.parse(sl.ends_at),
        title: sl.offering_name,
        detail: sl.kind === 'window' ? 'Zeitfenster' : sl.capacity > 1 ? `${sl.confirmed}/${sl.capacity} Plätze` : undefined,
        href: `/w/${ws.id}/slots/${sl.id}`,
        kind,
        // Belegte Einzeltermine zeigt die Buchung selbst; Zeitfenster bleiben als Hintergrund sichtbar.
        background: sl.kind === 'window' || full || sl.confirmed + sl.requested > 0,
      });
    }
    const billing = can(ws.role, 'billing.manage');
    const now = Date.now();
    for (const b of bookings) {
      const day = localDate(Date.parse(b.starts_at), tz);
      // Vergangene feste Termine führen zum Abhaken (Anwesenheit, Zahlung) auf der Schülerseite.
      const done = b.status === 'confirmed' && Date.parse(b.ends_at) <= now;
      const href = done && billing ? `/w/${ws.id}/students/${b.user_id}?month=${day.slice(0, 7)}#l-${b.id}` : `/w/${ws.id}/bookings?from=${day}&to=${day}#b-${b.id}`;
      const check = !done ? '' : b.attendance === 'attended' ? '✓ war da · ' : b.attendance === 'absent_billed' ? 'gefehlt · ' : b.attendance === 'absent' ? 'ausgefallen · ' : '➜ abhaken · ';
      items.push({
        start: Date.parse(b.starts_at),
        end: Date.parse(b.ends_at),
        title: b.booker_name || 'Ohne Namen',
        detail: `${check}${b.group_name ? `${b.group_name} · ` : ''}${b.offering_name}${b.status === 'requested' ? ' · angefragt' : ''}${b.proposed_by ? ' · Änderung offen' : ''}`,
        href,
        kind: b.status === 'confirmed' ? 'confirmed' : 'requested',
        mark: done ? (b.attendance ? 'checked' : 'todo') : undefined,
      });
      if (b.proposed_starts_at && b.proposed_ends_at) {
        items.push({ start: Date.parse(b.proposed_starts_at), end: Date.parse(b.proposed_ends_at), title: `Vorschlag: ${b.booker_name}`, detail: b.proposed_by === 'provider' ? 'wartet auf Buchende' : 'wartet auf dich', href, kind: 'proposal' });
      }
    }
    const offerings = await listOfferings(db, ws.id, true);
    const q = (extra: Record<string, string | undefined>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ offering: offeringId, ...extra })) if (v) p.set(k, v);
      return `/w/${ws.id}/calendar?${p}`;
    };
    // Bezugstag beim Umschalten: heute, wenn er im angezeigten Zeitraum liegt, sonst Monatsanfang bzw. Wochenmitte.
    const anchorDay =
      view === 'month'
        ? today.startsWith(month)
          ? today
          : `${month}-01`
        : view === 'week'
          ? weekStart <= today && today < addDays(weekStart, 7)
            ? today
            : addDays(weekStart, 3)
          : weekStart;
    const toolbar = html`<div class="segmented" role="group" aria-label="Ansicht">
      <a href="${q({ view: 'day', day: anchorDay })}" ${view === 'day' ? raw('aria-current="true"') : ''}>Tag</a>
      <a href="${q({ view: 'week', week: anchorDay })}" ${view === 'week' ? raw('aria-current="true"') : ''}>Woche</a>
      <a href="${q({ view: 'month', month: anchorDay.slice(0, 7) })}" ${view === 'month' ? raw('aria-current="true"') : ''}>Monat</a>
    </div>`;
    const legend = [
      { kind: 'free' as const, label: 'Frei (gern)' },
      { kind: 'reluctant' as const, label: 'Eher ungern' },
      { kind: 'confirmed' as const, label: 'Belegt (fest)' },
      { kind: 'requested' as const, label: 'Angefragt' },
      { kind: 'proposal' as const, label: 'Zeitvorschlag offen' },
      ...(billing ? [{ kind: 'todo' as const, label: 'Vergangen, noch abzuhaken' }] : []),
      { kind: 'blocked' as const, label: 'Gesperrt (kein Slot)' },
    ];
    let calendarView: H;
    if (view === 'month') {
      // Pro Tag: Buchungen mit Uhrzeit und Name, freie Slots als Anzahl.
      const entries = new Map<string, AgendaEntry[]>();
      const free = new Map<string, number>();
      for (const it of items.sort((a, b) => a.start - b.start)) {
        const d = localDate(it.start, tz);
        if (it.kind === 'free' || it.kind === 'reluctant') {
          if (!it.background) free.set(d, (free.get(d) ?? 0) + 1);
          continue;
        }
        if (it.kind !== 'confirmed' && it.kind !== 'requested' && it.kind !== 'proposal') continue;
        if (!entries.has(d)) entries.set(d, []);
        entries.get(d)!.push({ time: localTime(it.start, tz), label: it.title, kind: it.mark === 'todo' ? 'todo' : it.kind, href: it.href });
      }
      calendarView = monthAgenda({ month, today, entries, free, dayHref: (d) => q({ view: 'day', day: d }), monthHref: (m) => q({ view: 'month', month: m }), toolbar });
    } else {
      calendarView = weekCalendar({
        weekStart,
        tz,
        items,
        days: view === 'day' ? 1 : 7,
        toolbar,
        hrefFor: (w) => (view === 'day' ? q({ view: 'day', day: w }) : q({ week: w })),
        dayHref: view === 'week' ? (d) => q({ view: 'day', day: d }) : undefined,
        cellHref: can(ws.role, 'slots.manage') ? (d, hhmm) => `/w/${ws.id}/slots/new?date=${d}&from=${hhmm}${offeringId ? `&offering=${offeringId}` : ''}` : undefined,
        legend,
      });
    }
    return page(c, ws, 'calendar', 'Kalender', [
      flash(c.req.query('msg'), c.req.query('n') ? `(${Number(c.req.query('n'))} angelegt${Number(c.req.query('k')) ? `, ${Number(c.req.query('k'))} übersprungen` : ''})` : undefined),
      pageHeader(
        'Kalender',
        view === 'month' ? 'Alle Termine des Monats. Klick auf einen Tag öffnet die Tagesansicht.' : 'Auf eine freie (graue) Uhrzeit klicken, um dort Slots anzulegen. Klick auf einen Eintrag öffnet Slot oder Buchung.',
        html`<a class="btn btn-secondary" href="/profile#kalender">Kalender abonnieren</a> <a class="btn" href="/w/${ws.id}/slots/new">Slots anlegen</a>`,
      ),
      html`<form method="get" action="/w/${ws.id}/calendar" class="filters">
        <input type="hidden" name="view" value="${view}">
        ${view === 'month' ? html`<input type="hidden" name="month" value="${month}">` : view === 'day' ? html`<input type="hidden" name="day" value="${weekStart}">` : html`<input type="hidden" name="week" value="${weekStart}">`}
        <label>Angebot <select name="offering"><option value="">alle</option>${options(offerings.map((o) => ({ value: o.id, label: o.name })), offeringId)}</select></label>
        <button class="btn btn-secondary" type="submit">Filtern</button>
      </form>`,
      calendarView,
      can(ws.role, 'slots.manage') && view === 'week'
        ? html`<section class="card repeat-week"><h2>Woche wiederholen</h2>
            ${(() => {
              const n = slots.filter((sl) => sl.status !== 'closed' && Date.parse(sl.starts_at) >= Date.parse(fromIso)).length;
              return n
                ? html`<p>Diese Woche hat <strong>${n === 1 ? 'einen Slot' : `${n} Slots`}</strong>. Übernimm sie mit gleichen Uhrzeiten in die nächsten Wochen – ohne Buchungen, vorhandene Slots bleiben unberührt.</p>
                    <form method="post" action="/w/${ws.id}/slots/repeat-week" class="filters">
                      <input type="hidden" name="week" value="${weekStart}">
                      <label>Für <select name="weeks">${options(
                        [1, 2, 3, 4, 6, 8, 12, 16, 26].map((w) => ({ value: String(w), label: w === 1 ? 'die nächste Woche' : `die nächsten ${w} Wochen` })),
                        '4',
                      )}</select></label>
                      <label>Rhythmus <select name="every">${options(
                        [
                          { value: '1', label: 'jede Woche' },
                          { value: '2', label: 'alle 2 Wochen' },
                        ],
                        '1',
                      )}</select></label>
                      <button class="btn" type="submit">Woche übernehmen</button>
                    </form>`
                : html`<p class="muted">In dieser Woche gibt es noch keine Slots. Klicke im Kalender auf eine Uhrzeit oder <a href="/w/${ws.id}/slots/new?date=${weekStart}">lege Slots an</a> – danach kannst du die Woche hier für die folgenden Wochen übernehmen.</p>`;
            })()}
          </section>`
        : '',
    ]);
  });

  // ---------- Slots ----------

  app.get('/w/:wid/slots', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    const { db } = c.get('deps');
    const tz = ws.timezone;
    const now = Date.now();
    const today = localDate(now, tz);
    const view = c.req.query('view') === 'calendar' ? 'calendar' : 'list';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('day') ?? '') ? c.req.query('day')! : null;
    const month = parseMonth(c.req.query('month'), day ?? today);
    const offeringId = c.req.query('offering') || undefined;
    const status = c.req.query('status') || undefined;
    const showPast = c.req.query('past') === '1';
    const offerings = await listOfferings(db, ws.id, true);

    let fromIso: string;
    let toIso: string;
    if (view === 'calendar') {
      const [a, b] = day ? [day, addDays(day, 1)] : monthRange(month);
      fromIso = new Date(localToUtc(a, '00:00', tz)).toISOString();
      toIso = new Date(localToUtc(b, '00:00', tz)).toISOString();
    } else {
      fromIso = showPast ? new Date(now - 90 * 86_400_000).toISOString() : new Date(now).toISOString();
      toIso = new Date(now + 400 * 86_400_000).toISOString();
    }
    const slots = await listSlotsAdmin(db, ws.id, { fromIso, toIso, offeringId, status });

    const qs = (extra: Record<string, string | undefined>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ view: view === 'calendar' ? 'calendar' : undefined, offering: offeringId, status, ...extra })) if (v) p.set(k, v);
      return `/w/${ws.id}/slots?${p}`;
    };

    let calendar: Frag = '';
    if (view === 'calendar') {
      const [mFrom, mTo] = monthRange(month);
      const monthSlots = await listSlotsAdmin(db, ws.id, {
        fromIso: new Date(localToUtc(mFrom, '00:00', tz)).toISOString(),
        toIso: new Date(localToUtc(mTo, '00:00', tz)).toISOString(),
        offeringId,
        status,
      });
      const counts = new Map<string, number>();
      for (const s of monthSlots) {
        const d = localDate(Date.parse(s.starts_at), s.timezone);
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      calendar = monthCalendar({
        month,
        today,
        counts,
        countLabel: (n) => (n === 1 ? '1 Slot' : `${n} Slots`),
        dayHref: (d) => qs({ month, day: d }),
        monthHref: (m) => qs({ month: m }),
        selected: day,
      });
    }

    const rows = view === 'calendar' && !day ? [] : slots;
    return page(c, ws, 'slots', 'Slots', [
      flash(
        c.req.query('msg'),
        c.req.query('n')
          ? c.req.query('msg') === 'slots_deleted'
            ? `(${Number(c.req.query('n'))} gelöscht${Number(c.req.query('k')) ? `, ${Number(c.req.query('k'))} nicht – aktive Buchung oder schon abgerechnet` : ''})`
            : `(${Number(c.req.query('n'))} erledigt${Number(c.req.query('k')) ? `, ${Number(c.req.query('k'))} übersprungen` : ''})`
          : undefined,
      ),
      pageHeader('Slots & Zeitfenster', `Zeiten in ${tz}.`, html`<a class="btn" href="/w/${ws.id}/slots/new">Neu anlegen</a>`),
      html`<form method="get" action="/w/${ws.id}/slots" class="filters">
        ${view === 'calendar' ? html`<input type="hidden" name="view" value="calendar"><input type="hidden" name="month" value="${month}">` : ''}
        <label>Angebot <select name="offering"><option value="">alle</option>${options(offerings.map((o) => ({ value: o.id, label: o.name })), offeringId)}</select></label>
        <label>Status <select name="status"><option value="">alle</option>${options(
          [
            { value: 'published', label: 'Veröffentlicht' },
            { value: 'draft', label: 'Entwurf' },
            { value: 'closed', label: 'Geschlossen' },
          ],
          status,
        )}</select></label>
        ${view === 'list' ? html`<label class="check"><input type="checkbox" name="past" value="1" ${checked(showPast)}> Vergangene zeigen</label>` : ''}
        <button class="btn btn-secondary" type="submit">Filtern</button>
        <div class="segmented" role="group" aria-label="Ansicht">
          <a href="/w/${ws.id}/slots" ${view === 'list' ? raw('aria-current="true"') : ''}>Liste</a>
          <a href="/w/${ws.id}/slots?view=calendar" ${view === 'calendar' ? raw('aria-current="true"') : ''}>Kalender</a>
        </div>
      </form>`,
      calendar,
      rows.length
        ? html`<form method="post" action="/w/${ws.id}/slots/bulk" class="bulk">
            <div class="table-wrap"><table class="slots-table">
              <thead><tr><th><input type="checkbox" data-select-all aria-label="Alle auswählen"></th><th>Zeit</th><th>Angebot</th><th>Art</th><th>Status</th><th>Belegung</th><th><span class="sr-only">Bearbeiten</span></th></tr></thead>
              <tbody>${rows.map((s) => {
                const state = slotState(s, now);
                return html`<tr>
                  <td><input type="checkbox" name="ids" value="${s.id}" aria-label="Slot auswählen"></td>
                  <td>${when(s.starts_at, s.ends_at, s.timezone)}</td>
                  <td>${s.offering_name}</td>
                  <td>${s.kind === 'window' ? 'Zeitfenster' : 'Fest'}</td>
                  <td>${slotStateBadge(state)}${s.preference === 'reluctant' ? html` <span class="badge badge-reluctant">eher ungern</span>` : ''}</td>
                  <td>${s.kind === 'window' ? `${s.confirmed} fest, ${s.requested} Anfragen` : `${s.confirmed}/${s.capacity} fest${s.requested ? `, ${s.requested} Anfr.` : ''}`}</td>
                  <td><a href="/w/${ws.id}/slots/${s.id}">Bearbeiten</a></td>
                </tr>`;
              })}</tbody>
            </table></div>
            <div class="bulk-actions">
              <label for="bulk-action">Ausgewählte:</label>
              <select id="bulk-action" name="action">${options(
                [
                  { value: 'publish', label: 'Veröffentlichen' },
                  { value: 'normal', label: 'Hellgrün markieren (gern buchbar)' },
                  { value: 'reluctant', label: 'Gelb markieren (eher ungern)' },
                  { value: 'close', label: 'Schließen (keine neuen Buchungen)' },
                  { value: 'unpublish', label: 'Zurückziehen (Entwurf, nur ohne aktive Buchungen)' },
                ],
                'publish',
              )}</select>
              <button class="btn btn-secondary" type="submit">Ausführen</button>
              <button class="btn btn-danger" type="submit" name="delete" value="1" data-confirm="Ausgewählte Slots löschen? Slots mit aktiven Buchungen bleiben erhalten.">Ausgewählte löschen</button>
            </div>
          </form>`
        : view === 'calendar' && !day
          ? html`<p class="muted">Wähle einen Tag im Kalender.</p>`
          : emptyState('Keine Slots im gewählten Zeitraum', 'Lege einzelne Slots, Serien oder freie Zeitfenster an.', html`<a class="btn" href="/w/${ws.id}/slots/new">Slots anlegen</a>`),
    ]);
  });

  app.post('/w/:wid/slots/bulk', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    const f = await readForm(c);
    // Eigener Knopf „Ausgewählte löschen“ – sonst die Aktion aus der Auswahl.
    const action = str(f, 'delete') === '1' ? 'delete' : oneOf(str(f, 'action'), ['publish', 'unpublish', 'close', 'delete', 'normal', 'reluctant'] as BulkAction[], 'publish');
    const r = await bulkSlots(c.get('deps').db, ws.id, list(f, 'ids'), action);
    return c.redirect(`/w/${ws.id}/slots?msg=${action === 'delete' ? 'slots_deleted' : 'bulk_done'}&n=${r.done}&k=${r.skipped}`, 303);
  });

  const slotCommonFields = (c: Ctx, ws: WsContext, v: { capacity: number; location: string | null; online: string | null; mode: string; visibility: SlotVisibility; status: string; buffer: number; preference: string }, audience: Audience) => html`
    <div class="grid-form">
      <label>Plätze <input type="number" name="capacity" min="1" max="500" value="${v.capacity}"></label>
      <label>Pufferzeit danach (Min.) <input type="number" name="buffer_min" min="0" max="240" step="5" value="${v.buffer}"></label>
      <label>Ort (leer = vom Angebot) <input name="location" maxlength="300" value="${v.location ?? ''}"></label>
      <label>Online-Information (leer = vom Angebot) <input name="online_info" maxlength="500" value="${v.online ?? ''}"></label>
      <label>Bestätigung <select name="confirmation_mode">${options(
        [
          { value: '', label: 'Wie das Angebot' },
          { value: 'manual', label: 'Manuell' },
          { value: 'auto', label: 'Automatisch' },
        ],
        v.mode,
      )}</select></label>
      <label>Status <select name="status">${options(
        [
          { value: 'published', label: 'Veröffentlicht (buchbar)' },
          { value: 'draft', label: 'Entwurf (unsichtbar)' },
          { value: 'closed', label: 'Geschlossen' },
        ],
        v.status,
      )}</select></label>
      <label>Farbe im Kalender <select name="preference">${options(
        [
          { value: 'normal', label: 'Hellgrün – gern buchbar' },
          { value: 'reluctant', label: 'Gelb – anfragbar, aber eher ungern' },
        ],
        v.preference,
      )}</select></label>
    </div>
    <p class="hint">Gelbe Slots werden immer erst angefragt und von dir bestätigt. Alle Zeiten ohne Slot sind im Kalender gesperrt (grau).</p>
    <div class="field"><label for="visibility">Sichtbarkeit</label>${visibilitySelect('visibility', v.visibility, true)}</div>
    ${audiencePicker(c, ws, audience)}`;

  function readSlotInput(f: Form, offering: Offering, kind: SlotKind, durationMin: number): SlotInput {
    return {
      kind,
      durationMin,
      bufferMin: int(f, 'buffer_min', 0, 240, offering.buffer_min),
      capacity: int(f, 'capacity', 1, 500, offering.default_capacity),
      location: str(f, 'location', 300) || null,
      onlineInfo: str(f, 'online_info', 500) || null,
      confirmationMode: (oneOf(str(f, 'confirmation_mode'), ['', 'manual', 'auto'] as const, '') || null) as SlotInput['confirmationMode'],
      status: oneOf(str(f, 'status'), ['draft', 'published', 'closed'] as const, 'published'),
      preference: oneOf(str(f, 'preference'), ['normal', 'reluctant'] as const, 'normal'),
      visibility: oneOf(str(f, 'visibility'), SLOT_VIS_VALUES, 'inherit'),
      audience: readAudience(f),
    };
  }

  /**
   * Einfaches Formular: Tag, Uhrzeit von–bis (wird in Termine der Angebotsdauer aufgeteilt) und
   * Wiederholung (einmalig, jede Woche, alle 2 Wochen) für eine wählbare Dauer.
   */
  const newSlotsPage = async (c: Ctx, ws: WsContext, error?: string) => {
    const { db } = c.get('deps');
    const offerings = await listOfferings(db, ws.id);
    if (!offerings.length) {
      return page(c, ws, 'slots', 'Slots anlegen', [pageHeader('Slots anlegen'), emptyState('Zuerst ein Angebot anlegen', 'Slots gehören immer zu einem Angebot (z. B. „Einzelstunde, 45 Min.“).', html`<a class="btn" href="/w/${ws.id}/offerings/new">Angebot anlegen</a>`)]);
    }
    const preselect = c.req.query('offering') ?? offerings[0].id;
    const off = offerings.find((o) => o.id === preselect) ?? offerings[0];
    const qDate = c.req.query('date');
    const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : addDays(localDate(Date.now(), ws.timezone), 1);
    const qFrom = c.req.query('from');
    const from = qFrom && /^\d{2}:\d{2}$/.test(qFrom) ? qFrom : '16:00';
    const fromMin = Number(from.slice(0, 2)) * 60 + Number(from.slice(3));
    const toMin = Math.min(fromMin + Math.max(off.duration_min + off.buffer_min, 60), 23 * 60 + 55);
    const to = `${String(Math.floor(toMin / 60)).padStart(2, '0')}:${String(toMin % 60).padStart(2, '0')}`;
    const weekday = isoWeekday(date);
    const repeat = oneOf(c.req.query('repeat') ?? '', ['once', 'weekly', 'biweekly'] as const, 'weekly');
    const kind = oneOf(c.req.query('kind') ?? '', ['fixed', 'window'] as const, 'fixed');
    const common = slotCommonFields(c, ws, { capacity: off.default_capacity, location: null, online: null, mode: '', visibility: 'inherit', status: 'published', buffer: off.buffer_min, preference: 'normal' }, { groupIds: [], membershipIds: [] });
    const offeringField =
      offerings.length === 1
        ? html`<input type="hidden" name="offering_id" value="${off.id}" data-duration="${off.duration_min}" data-buffer="${off.buffer_min}"><p class="span-all"><strong>${off.name}</strong> <span class="muted">· ${durationLabel(off.duration_min)} pro Termin${off.buffer_min ? ` + ${off.buffer_min} Min. Pause` : ''}</span></p>`
        : html`<label class="span-all">Angebot <select name="offering_id">${offerings.map(
            (o) => html`<option value="${o.id}" data-duration="${o.duration_min}" data-buffer="${o.buffer_min}" ${o.id === off.id ? raw('selected') : ''}>${o.name} (${durationLabel(o.duration_min)}${o.buffer_min ? ` + ${o.buffer_min} Min. Pause` : ''})</option>`,
          )}</select></label>`;
    return page(c, ws, 'slots', 'Slots anlegen', [
      errorBox(error),
      pageHeader('Slots anlegen', `Zeiten in ${ws.timezone}. Schüler:innen können nur diese Termine buchen.`, html`<a class="btn btn-secondary" href="/w/${ws.id}/calendar">Zum Kalender</a>`),
      html`<section class="card"><form method="post" action="/w/${ws.id}/slots/series" class="stack" data-slot-form>
        <div class="grid-form">
          ${offeringField}
          <label>Tag <input type="date" name="from" required value="${date}" data-weekday-source></label>
          <label>Von <input type="time" name="window_start" required step="300" value="${from}"></label>
          <label>Bis <input type="time" name="window_end" required step="300" value="${to}"></label>
        </div>
        <fieldset class="field repeat-choice"><legend>Art</legend>
          <div class="segmented-radio">
            <label><input type="radio" name="kind" value="fixed" ${checked(kind === 'fixed')}> Feste Termine</label>
            <label><input type="radio" name="kind" value="window" ${checked(kind === 'window')}> Freies Zeitfenster</label>
          </div>
          <span class="hint">Feste Termine: Die Zeit wird in Termine der Angebotsdauer aufgeteilt. Freies Zeitfenster: Schüler:innen wählen innerhalb von „Von–Bis“ selbst ihre Startzeit.</span>
        </fieldset>
        <fieldset class="field repeat-choice"><legend>Wiederholen</legend>
          <div class="segmented-radio">
            <label><input type="radio" name="repeat" value="once" ${checked(repeat === 'once')}> Einmalig</label>
            <label><input type="radio" name="repeat" value="weekly" ${checked(repeat === 'weekly')}> Jede Woche</label>
            <label><input type="radio" name="repeat" value="biweekly" ${checked(repeat === 'biweekly')}> Alle 2 Wochen</label>
          </div>
        </fieldset>
        <div class="grid-form" data-repeat-only>
          <label>Wie lange? <select name="weeks">${options(
            [
              { value: '4', label: '4 Wochen' },
              { value: '8', label: '8 Wochen' },
              { value: '12', label: '12 Wochen (ca. 3 Monate)' },
              { value: '26', label: '26 Wochen (ca. ½ Jahr)' },
              { value: '52', label: '52 Wochen (1 Jahr)' },
            ],
            '12',
          )}</select></label>
          <label>… oder bis Datum (optional) <input type="date" name="until" min="${date}"></label>
          <fieldset class="field weekdays span-all"><legend>An diesen Wochentagen</legend>
            ${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d, i) => html`<label class="check"><input type="checkbox" name="weekday" value="${i + 1}" ${checked(i + 1 === weekday)} data-weekday="${i + 1}"> ${d}</label>`)}
          </fieldset>
        </div>
        <p class="slot-preview" data-slot-preview aria-live="polite">Der Zeitraum wird automatisch in Termine mit der Dauer des Angebots aufgeteilt, z. B. 16:00–18:00 bei 60 Min. → 16:00 und 17:00. Überschneidungen mit vorhandenen Slots werden übersprungen.</p>
        <details class="advanced"><summary>Weitere Einstellungen (Plätze, Ort, Farbe, Sichtbarkeit …)</summary>
          <div class="stack">
            <label>Abweichende Dauer je Termin (Min., leer = wie Angebot) <input type="number" name="duration" min="5" max="1440" step="5" placeholder="${off.duration_min}"></label>
            ${common}
          </div>
        </details>
        <button class="btn btn-large" type="submit">Slots anlegen</button>
      </form></section>`,
      html`<p class="hint">Tipp: Eine fertig eingerichtete Woche kannst du im <a href="/w/${ws.id}/calendar">Kalender</a> mit „Woche wiederholen“ für die nächsten Wochen übernehmen.</p>`,
    ]);
  };

  app.get('/w/:wid/slots/new', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    return newSlotsPage(c, ws);
  });

  app.post('/w/:wid/slots', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    const { db } = c.get('deps');
    const f = await readForm(c);
    const off = await getOffering(db, ws.id, str(f, 'offering_id', 50));
    if (!off || off.archived_at) notFound();
    const kind = oneOf(str(f, 'kind'), ['fixed', 'window'] as const, 'fixed');
    try {
      let duration = int(f, 'duration', 5, 1440, off.duration_min);
      if (kind === 'window') {
        const s = localToUtc(str(f, 'date', 10), str(f, 'time', 5), ws.timezone);
        const e = localToUtc(str(f, 'date', 10), str(f, 'end_time', 5), ws.timezone);
        duration = Math.round((e - s) / 60000);
        if (duration < off.duration_min) throw new SlotError('Das Zeitfenster muss mindestens so lang sein wie die Dauer des Angebots.');
      }
      await createSlot(db, ws.id, off, ws.timezone, str(f, 'date', 10), str(f, 'time', 5), readSlotInput(f, off, kind, duration));
    } catch (e) {
      if (e instanceof SlotError || e instanceof LocalTimeError) return newSlotsPage(c, ws, e.message);
      throw e;
    }
    return c.redirect(`/w/${ws.id}/slots?msg=saved&n=1`, 303);
  });

  app.post('/w/:wid/slots/series', async (c) => {
    const { user, ws } = await requireWs(c, 'slots.manage');
    const { db } = c.get('deps');
    const f = await readForm(c);
    const off = await getOffering(db, ws.id, str(f, 'offering_id', 50));
    if (!off || off.archived_at) notFound();
    const kind = oneOf(str(f, 'kind'), ['fixed', 'window'] as const, 'fixed');
    const from = str(f, 'from', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return newSlotsPage(c, ws, 'Bitte einen Tag angeben.');
    // Ältere Formulare schicken statt „repeat“ ein Enddatum „to“.
    const legacyTo = str(f, 'to', 10);
    const repeat = oneOf(str(f, 'repeat'), ['once', 'weekly', 'biweekly'] as const, legacyTo ? 'weekly' : 'once');
    let to = from;
    let weekdays = [isoWeekday(from)];
    if (repeat !== 'once') {
      const until = str(f, 'until', 10) || legacyTo;
      to = /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : addDays(from, int(f, 'weeks', 1, 52, 12) * 7 - 1);
      // Der Wochentag des gewählten Tages ist immer dabei, weitere sind optional.
      weekdays = [...new Set([...(legacyTo ? [] : [isoWeekday(from)]), ...list(f, 'weekday').map(Number).filter((n) => n >= 1 && n <= 7)])];
      if (!weekdays.length) weekdays = [isoWeekday(from)];
    }
    try {
      const r = await createSeries(
        db,
        ws.id,
        user.id,
        off,
        ws.timezone,
        {
          fromDate: from,
          toDate: to,
          weekdays,
          windowStart: str(f, 'window_start', 5),
          windowEnd: str(f, 'window_end', 5),
          everyWeeks: repeat === 'biweekly' ? 2 : 1,
        },
        readSlotInput(f, off, kind, int(f, 'duration', 5, 1440, off.duration_min)),
      );
      if (!r.created) return newSlotsPage(c, ws, r.skipped ? 'Keine neuen Slots: Alle Zeiten überschneiden sich mit vorhandenen Slots.' : 'Keine Slots angelegt – ist die Zeitspanne mindestens so lang wie ein Termin?');
      return c.redirect(`/w/${ws.id}/calendar?week=${from}&msg=${kind === 'window' ? 'windows_created' : 'slots_created'}&n=${r.created}&k=${r.skipped}`, 303);
    } catch (e) {
      if (e instanceof SlotError || e instanceof LocalTimeError) return newSlotsPage(c, ws, e.message);
      throw e;
    }
  });

  // „Woche wiederholen“ aus dem Kalender: alle Slots der angezeigten Woche in die nächsten Wochen übernehmen.
  app.post('/w/:wid/slots/repeat-week', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    const f = await readForm(c);
    const week = parseWeek(str(f, 'week', 10), localDate(Date.now(), ws.timezone));
    try {
      const r = await repeatWeek(c.get('deps').db, ws.id, week, ws.timezone, int(f, 'weeks', 1, 52, 4), str(f, 'every') === '2' ? 2 : 1);
      if (!r.source) return c.redirect(`/w/${ws.id}/calendar?week=${week}&msg=week_empty`, 303);
      return c.redirect(`/w/${ws.id}/calendar?week=${addDays(week, 7)}&msg=week_repeated&n=${r.created}&k=${r.skipped}`, 303);
    } catch (e) {
      if (e instanceof SlotError) return c.redirect(`/w/${ws.id}/calendar?week=${week}&msg=week_too_many`, 303);
      throw e;
    }
  });

  const editSlotPage = async (c: Ctx, ws: WsContext, slotId: string, error?: string, result?: SlotChangeResult) => {
    const { db } = c.get('deps');
    const s = await getSlot(db, ws.id, slotId);
    if (!s) notFound();
    const start = Date.parse(s.starts_at);
    const end = Date.parse(s.ends_at);
    const bookings = await listWorkspaceBookings(db, ws.id, { slotId: s.id });
    const following = await followingInSeries(db, ws.id, s);
    const activeBookings = s.confirmed + s.requested;
    return page(c, ws, 'slots', 'Slot bearbeiten', [
      flash(c.req.query('msg'), c.req.query('n') ? `(${Number(c.req.query('n'))} geändert${Number(c.req.query('c')) ? `, ${Number(c.req.query('c'))} neu` : ''})` : undefined),
      errorBox(error),
      result && result.skipped.length
        ? html`<div class="flash flash-info" role="status"><strong>Gespeichert – mit Ausnahmen:</strong>
            <ul>${result.skipped.map((x) => html`<li>${formatDate(Date.parse(x.startsAt), x.timezone)}, ${formatTime(Date.parse(x.startsAt), x.timezone)} Uhr: ${x.reason}</li>`)}</ul>
            ${result.updated ? html`<p>${result.updated} Slot(s) geändert${result.created ? `, ${result.created} neu angelegt` : ''}.</p>` : ''}</div>`
        : '',
      pageHeader(`${s.offering_name}: ${s.kind === 'window' ? 'Zeitfenster' : 'Slot'} bearbeiten`, undefined, slotStateBadge(slotState(s))),
      html`<section class="card"><form method="post" action="/w/${ws.id}/slots/${s.id}" class="stack">
        <fieldset class="field"><legend>Art</legend>
          <div class="segmented-radio">
            <label><input type="radio" name="kind" value="fixed" ${checked(s.kind === 'fixed')}> Fester Termin</label>
            <label><input type="radio" name="kind" value="window" ${checked(s.kind === 'window')}> Freies Zeitfenster</label>
          </div>
          <span class="hint">${activeBookings
            ? 'Die Art lässt sich erst ändern, wenn es keine offenen oder bestätigten Buchungen mehr gibt.'
            : s.kind === 'window'
              ? 'Wird das Zeitfenster zu festen Terminen, wird es in Termine der Angebotsdauer aufgeteilt.'
              : 'Ein fester Termin wird zum Zeitfenster gleicher Länge – Schüler:innen wählen darin ihre Startzeit.'}</span>
        </fieldset>
        <div class="grid-form">
          <label>Datum <input type="date" name="date" required value="${localDate(start, s.timezone)}"></label>
          <label>Von <input type="time" name="time" required step="300" value="${localTime(start, s.timezone)}"></label>
          <label>Bis <input type="time" name="end_time" required step="300" value="${localTime(end, s.timezone)}"></label>
        </div>
        <p class="hint" data-kind-hint="fixed" ${s.kind === 'fixed' ? '' : raw('hidden')}>Fester Termin: genau diese Zeit ist buchbar.${s.kind === 'window' ? ' Beim Umwandeln wird die Zeitspanne in Termine der Angebotsdauer aufgeteilt.' : ''}</p>
        <p class="hint" data-kind-hint="window" ${s.kind === 'window' ? '' : raw('hidden')}>Freies Zeitfenster: Schüler:innen wählen zwischen „Von“ und „Bis“ ihre Startzeit (Dauer laut Angebot).</p>
        <p class="hint">Zeitzone dieses Slots: ${s.timezone}.${activeBookings
          ? s.kind === 'window'
            ? ' Das Zeitfenster lässt sich verlängern oder verkürzen, solange alle Buchungen darin Platz haben.'
            : ' Dieser Termin ist gebucht – die Zeit bleibt, bis die Buchung abgesagt oder verschoben ist.'
          : ''}</p>
        ${slotCommonFields(c, ws, { capacity: s.capacity, location: s.location, online: s.online_info, mode: s.confirmation_mode ?? '', visibility: s.visibility, status: s.status, buffer: s.buffer_min, preference: s.preference }, await getAudience(db, 'slot', ws.id, s.id))}
        ${following > 1
          ? html`<fieldset class="field"><legend>Was soll geändert werden?</legend>
              <div class="segmented-radio">
                <label><input type="radio" name="scope" value="one" checked> Nur dieser Slot</label>
                <label><input type="radio" name="scope" value="following"> Dieser und alle folgenden der Serie (${following})</label>
              </div>
              <span class="hint">Bei der Serie wird eine Verschiebung (anderer Tag oder andere Uhrzeit) auf alle folgenden Slots übertragen; Dauer, Art und Einstellungen gelten für alle. Gebuchte Slots behalten ihre Zeit – du siehst danach, welche.</span>
            </fieldset>`
          : ''}
        <button class="btn" type="submit">Speichern</button>
      </form></section>`,
      html`<section class="card"><h2>Buchungen zu diesem Slot</h2>
        ${bookings.length ? bookingTable(ws, bookings) : html`<p class="muted">Keine Buchungen.</p>`}
      </section>`,
      html`<section class="card danger-zone"><h2>Löschen</h2>
        ${activeBookings
          ? html`<p class="muted">Dieser Slot hat eine aktive Buchung. Sage sie zuerst ab oder verschiebe sie, dann lässt er sich löschen.</p>`
          : html`<div class="actions">
              <form method="post" action="/w/${ws.id}/slots/${s.id}/delete" class="inline" data-confirm="Diesen Slot löschen?"><input type="hidden" name="scope" value="one"><button class="btn btn-danger" type="submit">Diesen Slot löschen</button></form>
              ${following > 1
                ? html`<form method="post" action="/w/${ws.id}/slots/${s.id}/delete" class="inline" data-confirm="Diesen und alle folgenden ${following} Slots der Serie löschen? Gebuchte Slots bleiben erhalten."><input type="hidden" name="scope" value="following"><button class="btn btn-danger" type="submit">Diesen und alle folgenden der Serie löschen (${following})</button></form>`
                : ''}
            </div>`}
        ${activeBookings && following > 1
          ? html`<form method="post" action="/w/${ws.id}/slots/${s.id}/delete" class="inline" data-confirm="Alle folgenden Slots der Serie löschen? Gebuchte Slots bleiben erhalten."><input type="hidden" name="scope" value="following"><button class="btn btn-danger" type="submit">Alle folgenden der Serie löschen (gebuchte bleiben)</button></form>`
          : ''}
      </section>`,
    ]);
  };

  app.post('/w/:wid/slots/:sid/delete', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    const { db } = c.get('deps');
    const f = await readForm(c);
    const ids = str(f, 'scope') === 'following' ? await seriesFromIds(db, ws.id, c.req.param('sid')) : [c.req.param('sid')];
    if (!ids.length) notFound();
    const r = await deleteSlots(db, ws.id, ids);
    if (r.blocked.length && !r.deleted) return editSlotPage(c, ws, c.req.param('sid'), `Nicht gelöscht: ${r.blocked[0].reason}.`);
    return c.redirect(`/w/${ws.id}/slots?msg=slots_deleted&n=${r.deleted}&k=${r.blocked.length}`, 303);
  });

  app.get('/w/:wid/slots/:sid', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    return editSlotPage(c, ws, c.req.param('sid'));
  });

  app.post('/w/:wid/slots/:sid', async (c) => {
    const { ws } = await requireWs(c, 'slots.manage');
    const { db } = c.get('deps');
    const s = await getSlot(db, ws.id, c.req.param('sid'));
    if (!s) notFound();
    const off = (await getOffering(db, ws.id, s.offering_id))!;
    const f = await readForm(c);
    const kind = oneOf(str(f, 'kind'), ['fixed', 'window'] as const, s.kind);
    const scope = str(f, 'scope') === 'following' ? 'following' : 'one';
    // Von–Bis (neues Formular) oder Dauer (älteres Formular).
    const hm = (v: string) => (/^\d{2}:\d{2}$/.test(v) ? +v.slice(0, 2) * 60 + +v.slice(3) : null);
    const from = hm(str(f, 'time', 5));
    const to = hm(str(f, 'end_time', 5));
    let duration = int(f, 'duration', 5, 1440, off.duration_min);
    if (from !== null && to !== null) {
      if (to <= from) return editSlotPage(c, ws, s.id, '„Bis“ muss nach „Von“ liegen.');
      duration = to - from;
    }
    let r: SlotChangeResult;
    try {
      r = await updateSlots(db, ws.id, s.id, { date: str(f, 'date', 10), time: str(f, 'time', 5), input: readSlotInput(f, off, kind, duration) }, scope);
    } catch (e) {
      if (e instanceof SlotError || e instanceof LocalTimeError) return editSlotPage(c, ws, s.id, e.message);
      throw e;
    }
    if (r.skipped.length) return editSlotPage(c, ws, s.id, undefined, r);
    return c.redirect(`/w/${ws.id}/slots/${s.id}?msg=saved${scope === 'following' || r.created ? `&n=${r.updated}&c=${r.created}` : ''}`, 303);
  });

  // ---------- Buchungen ----------

  function bookingTable(ws: WsContext, rows: WsBookingRow[]): H {
    const now = Date.now();
    return html`<ul class="cards">${rows.map((b) => {
      const past = Date.parse(b.ends_at) <= now;
      const active = (b.status === 'requested' || b.status === 'confirmed') && !past;
      const act = (path: string, label: string, cls = 'btn-secondary', confirm?: string, extra?: H) =>
        html`<form method="post" action="/w/${ws.id}/bookings/${b.id}/${path}" class="inline" ${confirm ? raw(`data-confirm="${confirm}"`) : ''}>${extra ?? ''}<button class="btn btn-small ${cls}" type="submit">${label}</button></form>`;
      return html`<li class="card booking" id="b-${b.id}">
        <div class="booking-head">
          <div><strong>${b.booker_name || 'Ohne Namen'}</strong> <span class="muted">${b.booker_email}</span> ${b.is_member ? '' : html`<span class="badge badge-muted">extern</span>`}</div>
          <div>${bookingBadge(b.status, past)} ${active ? awaitingLabel(b, 'provider') : ''}</div>
        </div>
        <p>${when(b.starts_at, b.ends_at, b.timezone)} · ${b.offering_name}${b.group_name ? html` <span class="badge badge-group">${b.group_name}</span>` : ''}${b.slot_kind === 'window' ? html` <span class="badge badge-window">Wunschzeit</span>` : ''}</p>
        ${b.conflicts && active ? html`<p class="flash flash-warn">Überschneidet sich mit ${b.conflicts} anderen offenen oder festen Termin(en) in diesem Arbeitsbereich.</p>` : ''}
        ${b.note ? html`<p class="muted">Nachricht: ${b.note}</p>` : ''}
        ${past && b.status === 'confirmed' && can(ws.role, 'billing.manage')
          ? html`<p>${b.attendance ? html`<span class="badge badge-confirmed">${ATTENDANCE_LABELS[b.attendance]}</span>` : html`<span class="badge badge-requested">noch nicht abgehakt</span>`}
              <a href="/w/${ws.id}/students/${b.user_id}?month=${localDate(Date.parse(b.starts_at), ws.timezone).slice(0, 7)}#l-${b.id}">${b.attendance ? 'Abrechnung ansehen' : 'Jetzt abhaken'}</a></p>`
          : ''}
        ${b.cancel_requested_at && b.status === 'confirmed' ? html`<p class="flash flash-action">Die buchende Person bittet um Absage.</p>` : ''}
        ${active ? proposalNote(b, 'provider') : ''}
        ${active
          ? html`<div class="actions">
              ${b.proposed_by === 'booker' ? [act('proposal', 'Neue Zeit annehmen', '', undefined, html`<input type="hidden" name="accept" value="1">`), act('proposal', 'Vorschlag ablehnen', 'btn-secondary', undefined, html`<input type="hidden" name="accept" value="0">`)] : ''}
              ${b.status === 'requested' ? [act('confirm', 'Bestätigen', ''), act('decline', 'Ablehnen', 'btn-secondary', 'Anfrage ablehnen?')] : ''}
              ${act('cancel', 'Absagen', 'btn-danger', 'Termin wirklich absagen? Die Person wird informiert.')}
            </div>
            ${timeChangeForm(`/w/${ws.id}/bookings/${b.id}/propose`, b, 'Verschieben / andere Zeit vorschlagen')}`
          : ''}
        <details><summary>Verlauf</summary><div data-history="/w/${ws.id}/bookings/${b.id}/history"><a href="/w/${ws.id}/bookings/${b.id}/history">Verlauf anzeigen</a></div></details>
      </li>`;
    })}</ul>`;
  }

  app.get('/w/:wid/bookings', async (c) => {
    const { ws } = await requireWs(c, 'bookings.manage');
    const { db } = c.get('deps');
    const q = c.req.query();
    const tz = ws.timezone;
    const toIsoDate = (d: string | undefined, fallback?: string) => {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return fallback;
      try {
        return new Date(localToUtc(d, '00:00', tz)).toISOString();
      } catch {
        return fallback;
      }
    };
    const from = q.from ?? (q.status ? '' : localDate(Date.now(), tz));
    const filter = {
      status: q.status || undefined,
      fromIso: toIsoDate(from),
      toIso: q.to ? toIsoDate(addDays(q.to, 1)) : undefined,
      offeringId: q.offering || undefined,
      groupId: q.group || undefined,
      userId: q.person || undefined,
    };
    const rows = await listWorkspaceBookings(db, ws.id, filter);
    const statusOptions = [
      { value: 'awaiting_me', label: 'Wartet auf mich' },
      { value: 'awaiting_booker', label: 'Wartet auf Buchende' },
      ...(Object.keys(BOOKING_STATUS_LABELS) as (keyof typeof BOOKING_STATUS_LABELS)[]).filter((k) => k !== 'past').map((k) => ({ value: k, label: BOOKING_STATUS_LABELS[k] })),
    ];
    return page(c, ws, 'bookings', 'Buchungen', [
      flash(c.req.query('msg')),
      pageHeader('Buchungen', 'Bestätigen, ablehnen, verschieben oder absagen. Verschiebungen muss die buchende Person bestätigen – und umgekehrt.'),
      html`<form method="get" action="/w/${ws.id}/bookings" class="filters">
        <label>Status <select name="status"><option value="">alle</option>${options(statusOptions, q.status)}</select></label>
        <label>Ab <input type="date" name="from" value="${from}"></label>
        <label>Bis <input type="date" name="to" value="${q.to ?? ''}"></label>
        <label>Angebot <select name="offering"><option value="">alle</option>${options((await listOfferings(db, ws.id, true)).map((o) => ({ value: o.id, label: o.name })), q.offering)}</select></label>
        <label>Gruppe <select name="group"><option value="">alle</option>${options((await listGroups(db, ws.id)).map((g) => ({ value: g.id, label: g.name })), q.group)}</select></label>
        <label>Person <select name="person"><option value="">alle</option>${options((await bookingPeople(db, ws.id)).map((p) => ({ value: p.user_id, label: p.display_name || p.email })), q.person)}</select></label>
        <button class="btn btn-secondary" type="submit">Filtern</button>
      </form>`,
      rows.length ? bookingTable(ws, rows) : emptyState('Keine Buchungen gefunden', 'Passe die Filter an oder teile deine Buchungsseite.'),
    ]);
  });

  app.get('/w/:wid/bookings/:bid/history', async (c) => {
    const { ws } = await requireWs(c, 'bookings.manage');
    const { db } = c.get('deps');
    const b = await getWorkspaceBooking(db, ws.id, c.req.param('bid'));
    if (!b) notFound();
    const events = await bookingHistory(db, ws.id, b.id);
    return page(c, ws, 'bookings', 'Verlauf', [
      pageHeader(`Verlauf: ${b.booker_name} · ${b.offering_name}`),
      html`<section class="card"><ol class="timeline">${events.map(
        (e) => html`<li><time>${formatDate(Date.parse(e.created_at), ws.timezone)}, ${formatTime(Date.parse(e.created_at), ws.timezone)}</time>
          ${e.from_status !== e.to_status ? html`<strong>${BOOKING_STATUS_LABELS[e.to_status as keyof typeof BOOKING_STATUS_LABELS] ?? e.to_status}</strong>` : ''}
          ${e.note ? html` – ${e.note}` : ''} <span class="muted">(${e.actor_name ?? 'System'})</span></li>`,
      )}</ol><p><a href="/w/${ws.id}/bookings">Zurück zu den Buchungen</a></p></section>`,
    ]);
  });

  /** Nach einer Aktion zurück zur Seite, von der sie kam (nur innerhalb dieses Arbeitsbereichs). */
  const returnPath = (c: Ctx, ws: WsContext) => {
    try {
      const u = new URL(c.req.header('referer') ?? '');
      if (u.origin === c.get('deps').config.appOrigin && u.pathname.startsWith(`/w/${ws.id}/`)) {
        for (const k of ['msg', 'n', 'k']) u.searchParams.delete(k);
        return u.pathname + u.search;
      }
    } catch {
      // ungültiger oder fehlender Referer
    }
    return `/w/${ws.id}/bookings`;
  };

  const decisionMsg = { ok: '', not_found: 'invalid_state', invalid_state: 'invalid_state', full: 'full', bad_time: 'bad_time' } as const;

  for (const action of ['confirm', 'decline', 'cancel'] as const) {
    app.post(`/w/:wid/bookings/:bid/${action}`, async (c) => {
      const { user, ws } = await requireWs(c, 'bookings.manage');
      const { db, config, kick } = c.get('deps');
      const f = await readForm(c);
      const r = await providerDecision(db, config.appUrl, ws.id, c.req.param('bid'), user.id, action, str(f, 'note', 500));
      kick();
      const okMsg = action === 'confirm' ? 'confirmed' : action === 'decline' ? 'declined' : 'cancelled';
      return back(c, returnPath(c, ws), r === 'ok' ? okMsg : decisionMsg[r]);
    });
  }

  app.post('/w/:wid/bookings/:bid/propose', async (c) => {
    const { user, ws } = await requireWs(c, 'bookings.manage');
    const { db, config, kick } = c.get('deps');
    const b = await getWorkspaceBooking(db, ws.id, c.req.param('bid'));
    if (!b) notFound();
    const f = await readForm(c);
    const t = parseTimeChange(f, b.timezone);
    const r = t ? await proposeTime(db, config.appUrl, 'provider', { wsId: ws.id, userId: user.id }, b.id, t.start, t.end, str(f, 'note', 500)) : 'bad_time';
    kick();
    return back(c, returnPath(c, ws), r === 'ok' ? 'proposal_sent' : r === 'full' ? 'proposal_conflict' : decisionMsg[r]);
  });

  app.post('/w/:wid/bookings/:bid/proposal', async (c) => {
    const { user, ws } = await requireWs(c, 'bookings.manage');
    const { db, config, kick } = c.get('deps');
    const f = await readForm(c);
    const accept = str(f, 'accept') === '1';
    const r = await respondToProposal(db, config.appUrl, 'provider', { wsId: ws.id, userId: user.id }, c.req.param('bid'), accept);
    kick();
    return back(c, returnPath(c, ws), r === 'ok' ? (accept ? 'proposal_accepted' : 'proposal_rejected') : r === 'full' ? 'proposal_conflict' : decisionMsg[r]);
  });

  // ---------- Benachrichtigungen ----------

  app.get('/w/:wid/notifications', async (c) => {
    const { ws } = await requireWs(c, 'notifications.manage');
    const { db, mailer } = c.get('deps');
    const rows = await db.all<{ id: string; recipient_email: string; channel: string; template: Template; status: string; attempts: number; last_error: string | null; created_at: string; retryable: number }>(
      `SELECT id, recipient_email, channel, template, status, attempts, last_error, created_at, retryable FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`,
      [ws.id],
    );
    const statusLabel: Record<string, string> = { pending: 'Ausstehend', sent: 'Gesendet', failed: 'Fehlgeschlagen', not_configured: 'Nicht gesendet (kein Versand eingerichtet)', logged: 'Nur Konsole (Entwicklung)' };
    return page(c, ws, 'notifications', 'Benachrichtigungen', [
      flash(c.req.query('msg')),
      pageHeader('Benachrichtigungen', 'Versandprotokoll der E-Mails dieses Arbeitsbereichs. Der Versandstatus ist unabhängig vom Buchungsstatus.'),
      mailer.mode === 'none' ? html`<div class="flash flash-info">Es ist kein E-Mail-Versand eingerichtet – es werden keine E-Mails verschickt.</div>` : '',
      rows.length
        ? html`<div class="table-wrap"><table><thead><tr><th>Zeit</th><th>Art</th><th>Empfänger</th><th>Status</th><th>Fehler</th><th><span class="sr-only">Aktion</span></th></tr></thead><tbody>
            ${rows.map(
              (r) => html`<tr><td>${formatDate(Date.parse(r.created_at), ws.timezone)} ${formatTime(Date.parse(r.created_at), ws.timezone)}</td>
                <td>${r.channel === 'push' ? html`<span class="badge badge-muted">Push</span> ` : ''}${TEMPLATE_LABELS[r.template] ?? r.template}</td><td>${r.recipient_email}</td>
                <td><span class="badge badge-n-${r.status}">${statusLabel[r.status] ?? r.status}</span>${r.attempts > 1 ? html` <span class="muted">(${r.attempts} Versuche)</span>` : ''}</td>
                <td class="muted">${r.last_error ?? ''}</td>
                <td>${(r.status === 'failed' || r.status === 'not_configured') && r.retryable && r.channel === 'email' && mailer.mode !== 'none'
                  ? html`<form method="post" action="/w/${ws.id}/notifications/${r.id}/retry" class="inline"><button class="btn btn-small btn-secondary" type="submit">Erneut senden</button></form>`
                  : r.status === 'failed' && !r.retryable
                    ? html`<span class="muted">Einladung: über „Mitglieder“ erneut senden</span>`
                    : ''}</td></tr>`,
            )}</tbody></table></div>`
        : emptyState('Noch keine Benachrichtigungen', 'Hier erscheinen versendete und fehlgeschlagene E-Mails.'),
    ]);
  });

  app.post('/w/:wid/notifications/:nid/retry', async (c) => {
    const { ws } = await requireWs(c, 'notifications.manage');
    const { db, mailer } = c.get('deps');
    await retryNotification(db, mailer, ws.id, c.req.param('nid'));
    return back(c, `/w/${ws.id}/notifications`, 'retry_done');
  });
}
