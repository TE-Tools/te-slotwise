import { SLOT_VISIBLE_SQL } from '../authz.ts';
import type { Db } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import type { Payload, Template } from '../mail/templates.ts';
import { formatRange, localDate, LocalTimeError, localToUtc } from '../time.ts';
import { enqueue } from './notifications.ts';
import type { Offering } from './offerings.ts';
import { insertSlot, TAKEN_SQL } from './slots.ts';
import { providerRecipients } from './workspaces.ts';

// Buchungsablauf in Kürze:
// - Buchende fragen einen festen Slot oder eine Wunschzeit in einem Zeitfenster an.
// - Fix (status = 'confirmed') ist ein Termin erst, wenn beide Seiten zugestimmt haben.
//   Bei automatischer Bestätigung hat die Anbieterseite vorab zugestimmt.
// - Jede Seite kann eine andere Zeit vorschlagen (proposed_*). Die andere Seite muss zustimmen.
//   Bis dahin gilt bei fixen Terminen weiter die bisherige Zeit.

export type BookingStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled' | 'withdrawn';
export type Party = 'provider' | 'booker';

export const BOOKING_STATUS_LABELS: Record<BookingStatus | 'past', string> = {
  requested: 'Angefragt',
  confirmed: 'Bestätigt',
  declined: 'Abgelehnt',
  cancelled: 'Abgesagt',
  withdrawn: 'Zurückgezogen',
  past: 'Vergangen',
};

/** Wer ist als Nächstes am Zug? */
export function awaiting(b: { status: BookingStatus; proposed_by: Party | null }): Party | null {
  if (b.status !== 'requested' && b.status !== 'confirmed') return null;
  if (b.proposed_by) return b.proposed_by === 'provider' ? 'booker' : 'provider';
  return b.status === 'requested' ? 'provider' : null;
}

export type BookResult =
  | { ok: true; bookingId: string; status: 'requested' | 'confirmed' }
  | { ok: false; code: 'not_found' | 'too_late' | 'full' | 'already_booked' | 'bad_time' };

interface BookingCtx {
  id: string;
  workspace_id: string;
  slot_id: string;
  offering_id: string;
  user_id: string;
  status: BookingStatus;
  holds_seat: number;
  starts_at: string;
  ends_at: string;
  proposed_starts_at: string | null;
  proposed_ends_at: string | null;
  proposed_by: Party | null;
  cancel_requested_at: string | null;
  timezone: string;
  workspace_name: string;
  offering_name: string;
  allow_self_cancel: number;
  cancel_cutoff_hours: number;
  booker_email: string;
  booker_name: string;
  booker_notify: number;
}

async function loadCtx(db: Db, bookingId: string) {
  return await db.get<BookingCtx>(
    `SELECT b.id, b.workspace_id, b.slot_id, b.offering_id, b.user_id, b.status, b.holds_seat, b.starts_at, b.ends_at,
       b.proposed_starts_at, b.proposed_ends_at, b.proposed_by, b.cancel_requested_at,
       s.timezone, w.name AS workspace_name, o.name AS offering_name,
       o.allow_self_cancel, o.cancel_cutoff_hours, u.email AS booker_email, u.display_name AS booker_name, u.notify_booking_updates AS booker_notify
     FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN offerings o ON o.id = b.offering_id
     JOIN workspaces w ON w.id = b.workspace_id JOIN users u ON u.id = b.user_id WHERE b.id = ?`,
    [bookingId],
  );
}

async function logEvent(db: Db, b: { id: string; workspace_id: string }, from: string | null, to: string, actor: string | null, note = '') {
  await db.run(
    `INSERT INTO booking_events (id, booking_id, workspace_id, from_status, to_status, actor_user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), b.id, b.workspace_id, from, to, actor, note.slice(0, 500), nowIso()],
  );
}

function payload(appUrl: string, c: BookingCtx, forProvider: boolean, extra: Partial<Payload> = {}): Payload {
  return {
    workspaceName: c.workspace_name,
    offeringName: c.offering_name,
    when: formatRange(c.starts_at, c.ends_at, c.timezone),
    bookerName: c.booker_name || 'Eine Person',
    link: forProvider ? `${appUrl}/w/${c.workspace_id}/bookings` : `${appUrl}/bookings`,
    ...extra,
  };
}

async function notifyBooker(db: Db, appUrl: string, c: BookingCtx, template: Template, extra: Partial<Payload> = {}) {
  if (!c.booker_notify || !c.booker_email) return;
  await enqueue(db, c.workspace_id, { userId: c.user_id, email: c.booker_email }, template, payload(appUrl, c, false, extra));
}

async function notifyProviders(db: Db, appUrl: string, c: BookingCtx, template: Template, exceptUserId?: string, extra: Partial<Payload> = {}) {
  for (const r of await providerRecipients(db, c.workspace_id)) {
    if (r.user_id === exceptUserId) continue;
    await enqueue(db, c.workspace_id, { userId: r.user_id, email: r.email }, template, payload(appUrl, c, true, extra));
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed: bookings/.test(e.message);
const isFull = (e: unknown) => e instanceof Error && /slot_full/.test(e.message);

/**
 * Bucht oder fragt an. Alles geschieht in einer Schreibtransaktion (BEGIN IMMEDIATE):
 * Sichtbarkeit, Zeit, Vorlauf, Kapazität und Doppelbuchung werden geprüft, bevor die
 * Buchung entsteht. Ein Datenbank-Trigger verhindert Überschneidungen zusätzlich.
 * Bei Zeitfenstern gibt `time` (HH:MM, Ortszeit des Slots) die Wunschzeit an.
 */
export async function requestBooking(
  db: Db,
  appUrl: string,
  p: { workspaceId: string; slotId: string; userId: string; membershipId: string | null; note: string; time?: string; groupId?: string | null },
  now = Date.now(),
): Promise<BookResult> {
  try {
    return await db.tx(async (): Promise<BookResult> => {
      const slot = await db.get<{
        id: string;
        kind: 'fixed' | 'window';
        offering_id: string;
        capacity: number;
        taken: number;
        mode: 'manual' | 'auto';
        hold_on_request: number;
        min_notice_hours: number;
        duration_min: number;
        starts_at: string;
        ends_at: string;
        timezone: string;
      }>(
        `SELECT s.id, s.kind, s.offering_id, s.capacity, ${TAKEN_SQL} AS taken, CASE WHEN s.preference = 'reluctant' THEN 'manual' ELSE COALESCE(s.confirmation_mode, o.confirmation_mode) END AS mode,
           o.hold_on_request, o.min_notice_hours, o.duration_min, s.starts_at, s.ends_at, s.timezone
         FROM slots s JOIN offerings o ON o.id = s.offering_id AND o.workspace_id = s.workspace_id
         WHERE s.id = @sid AND s.workspace_id = @ws AND s.status = 'published' AND o.archived_at IS NULL AND ${SLOT_VISIBLE_SQL}`,
        { sid: p.slotId, ws: p.workspaceId, mid: p.membershipId },
      );
      if (!slot) return { ok: false, code: 'not_found' };

      let start = Date.parse(slot.starts_at);
      let end = Date.parse(slot.ends_at);
      if (slot.kind === 'window') {
        if (!p.time || !/^\d{2}:\d{2}$/.test(p.time) || +p.time.slice(3) % 5 !== 0) return { ok: false, code: 'bad_time' };
        try {
          start = localToUtc(localDate(Date.parse(slot.starts_at), slot.timezone), p.time, slot.timezone);
        } catch (e) {
          if (e instanceof LocalTimeError) return { ok: false, code: 'bad_time' };
          throw e;
        }
        end = start + slot.duration_min * 60_000;
        if (start < Date.parse(slot.starts_at) || end > Date.parse(slot.ends_at)) return { ok: false, code: 'bad_time' };
      }
      if (start <= now + slot.min_notice_hours * 3600_000) return { ok: false, code: 'too_late' };
      const mine = await db.get(`SELECT id FROM bookings WHERE slot_id = ? AND user_id = ? AND status IN ('requested','confirmed')`, [slot.id, p.userId]);
      if (mine) return { ok: false, code: 'already_booked' };

      const groupId = await resolveGroup(db, p.workspaceId, p.membershipId, p.groupId);
      const status = slot.mode === 'auto' ? 'confirmed' : 'requested';
      const holds = status === 'confirmed' || slot.hold_on_request ? 1 : 0;
      // Feste Slots: nur solange Platz frei ist. Zeitfenster: Überschneidungen prüft der Trigger,
      // überlappende Anfragen ohne Platzreservierung sind ausdrücklich erlaubt.
      if (slot.kind === 'fixed' && slot.taken >= slot.capacity) return { ok: false, code: 'full' };

      const id = newId();
      const ts = nowIso(now);
      await db.run(
        `INSERT INTO bookings (id, workspace_id, slot_id, offering_id, user_id, status, starts_at, ends_at, holds_seat, note, group_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, p.workspaceId, slot.id, slot.offering_id, p.userId, status, nowIso(start), nowIso(end), holds, p.note.slice(0, 1000), groupId, ts, ts],
      );
      await logEvent(db, { id, workspace_id: p.workspaceId }, null, status, p.userId);
      const ctx = (await loadCtx(db, id))!;
      await notifyBooker(db, appUrl, ctx, status === 'confirmed' ? 'booking_confirmed' : 'booking_requested_booker');
      await notifyProviders(db, appUrl, ctx, status === 'confirmed' ? 'provider_new_booking' : 'provider_new_request', p.userId);
      return { ok: true, bookingId: id, status };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: 'already_booked' };
    if (isFull(e)) return { ok: false, code: 'full' };
    throw e;
  }
}

/**
 * Gruppe (z. B. Instrument) einer Buchung: die gewählte, sofern die Person ihr angehört; ohne Wahl
 * automatisch die einzige Gruppe der Person; sonst keine.
 */
export async function resolveGroup(db: Db, wsId: string, membershipId: string | null, wanted?: string | null) {
  if (!membershipId) return null;
  const groups = await db.all<{ id: string }>(
    `SELECT g.id FROM ws_groups g JOIN group_members gm ON gm.group_id = g.id AND gm.workspace_id = g.workspace_id WHERE g.workspace_id = ? AND gm.membership_id = ?`,
    [wsId, membershipId],
  );
  if (wanted && groups.some((g) => g.id === wanted)) return wanted;
  return groups.length === 1 ? groups[0].id : null;
}

export type ActionResult = 'ok' | 'not_found' | 'invalid_state' | 'full' | 'bad_time';

/** Entscheidungen der Anbieterseite: bestätigen, ablehnen, absagen. */
export async function providerDecision(
  db: Db,
  appUrl: string,
  wsId: string,
  bookingId: string,
  actorId: string,
  action: 'confirm' | 'decline' | 'cancel',
  note = '',
): Promise<ActionResult> {
  try {
    return await db.tx(async (): Promise<ActionResult> => {
      const c = await loadCtx(db, bookingId);
      if (!c || c.workspace_id !== wsId) return 'not_found';
      const allowed: Record<typeof action, BookingStatus[]> = {
        confirm: ['requested'],
        decline: ['requested'],
        cancel: ['requested', 'confirmed'],
      };
      if (!allowed[action].includes(c.status)) return 'invalid_state';
      const to: BookingStatus = action === 'confirm' ? 'confirmed' : action === 'decline' ? 'declined' : 'cancelled';
      // Bestätigt wird die von der buchenden Person angefragte Zeit; ein eigener offener Vorschlag entfällt damit.
      await db.run(
        `UPDATE bookings SET status = ?, holds_seat = CASE WHEN ? = 'confirmed' THEN 1 ELSE holds_seat END,
           proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_by = NULL, proposed_slot_id = NULL, proposal_note = '',
           cancel_requested_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`,
        [to, to, nowIso(), bookingId, wsId],
      );
      await logEvent(db, c, c.status, to, actorId, note);
      const template: Template = to === 'confirmed' ? 'booking_confirmed' : to === 'declined' ? 'booking_declined' : 'booking_cancelled';
      await notifyBooker(db, appUrl, c, template, { note: note.slice(0, 500) || undefined });
      return 'ok';
    });
  } catch (e) {
    if (isFull(e)) return 'full';
    throw e;
  }
}

/**
 * Eine Seite schlägt eine andere Zeit vor.
 * - Anbieterseite: wird als Vorschlag gespeichert, die buchende Person muss zustimmen –
 *   oder mit `direct` sofort verschoben (Termin ist damit fest, die buchende Person wird informiert).
 * - Buchende bei offener Anfrage: die Anfrage selbst wird geändert (wartet weiter auf die Anbieterseite).
 * - Buchende bei fixem Termin: Vorschlag, die Anbieterseite muss zustimmen; bis dahin gilt die alte Zeit.
 */
export async function proposeTime(
  db: Db,
  appUrl: string,
  by: Party,
  scope: { wsId?: string; userId: string },
  bookingId: string,
  startMs: number,
  endMs: number,
  note = '',
  now = Date.now(),
  direct = false,
): Promise<ActionResult> {
  if (!(endMs > startMs) || endMs - startMs > 24 * 3600_000 || startMs <= now) return 'bad_time';
  try {
    return await db.tx(async (): Promise<ActionResult> => {
      const c = await loadCtx(db, bookingId);
      if (!c) return 'not_found';
      if (by === 'provider' && c.workspace_id !== scope.wsId) return 'not_found';
      if (by === 'booker' && c.user_id !== scope.userId) return 'not_found';
      if (c.status !== 'requested' && c.status !== 'confirmed') return 'invalid_state';
      const s = nowIso(startMs);
      const e = nowIso(endMs);
      const newWhen = formatRange(s, e, c.timezone);

      if (by === 'booker' && c.status === 'requested') {
        await db.run(
          `UPDATE bookings SET starts_at = ?, ends_at = ?, proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_by = NULL, proposed_slot_id = NULL,
             proposal_note = ?, updated_at = ? WHERE id = ?`,
          [s, e, note.slice(0, 500), nowIso(now), c.id],
        );
        await logEvent(db, c, c.status, c.status, scope.userId, `Wunschzeit geändert: ${newWhen}`);
        await notifyProviders(db, appUrl, c, 'proposal_to_provider', scope.userId, { newWhen, note: note || undefined });
        return 'ok';
      }

      if (by === 'provider' && direct) {
        await db.run(
          `UPDATE bookings SET status = 'confirmed', holds_seat = 1, starts_at = ?, ends_at = ?, proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_by = NULL,
             proposed_slot_id = NULL, proposal_note = '', updated_at = ? WHERE id = ?`,
          [s, e, nowIso(now), c.id],
        );
        await logEvent(db, c, c.status, 'confirmed', scope.userId, `Verschoben: ${newWhen}`);
        await notifyBooker(db, appUrl, c, 'booking_moved', { newWhen, note: note || undefined });
        return 'ok';
      }

      await db.run(`UPDATE bookings SET proposed_starts_at = ?, proposed_ends_at = ?, proposed_by = ?, proposed_slot_id = NULL, proposal_note = ?, updated_at = ? WHERE id = ?`, [
        s,
        e,
        by,
        note.slice(0, 500),
        nowIso(now),
        c.id,
      ]);
      await logEvent(db, c, c.status, c.status, scope.userId, `Neue Zeit vorgeschlagen: ${newWhen}`);
      if (by === 'provider') await notifyBooker(db, appUrl, c, 'proposal_to_booker', { newWhen, note: note || undefined });
      else await notifyProviders(db, appUrl, c, 'proposal_to_provider', scope.userId, { newWhen, note: note || undefined });
      return 'ok';
    });
  } catch (e) {
    if (isFull(e)) return 'full';
    throw e;
  }
}

/** Antwort auf einen Vorschlag der jeweils anderen Seite. Zustimmen macht den Termin fix. */
export async function respondToProposal(
  db: Db,
  appUrl: string,
  by: Party,
  scope: { wsId?: string; userId: string },
  bookingId: string,
  accept: boolean,
  now = Date.now(),
): Promise<ActionResult> {
  try {
    return await db.tx(async (): Promise<ActionResult> => {
      const c = await loadCtx(db, bookingId);
      if (!c) return 'not_found';
      if (by === 'provider' && c.workspace_id !== scope.wsId) return 'not_found';
      if (by === 'booker' && c.user_id !== scope.userId) return 'not_found';
      if (!c.proposed_by || c.proposed_by === by || !c.proposed_starts_at || !c.proposed_ends_at) return 'invalid_state';
      if (c.status !== 'requested' && c.status !== 'confirmed') return 'invalid_state';
      const newWhen = formatRange(c.proposed_starts_at, c.proposed_ends_at, c.timezone);
      if (accept) {
        if (Date.parse(c.proposed_starts_at) <= now) return 'bad_time';
        // Beide Seiten haben dieser Zeit zugestimmt → fix.
        await db.run(
          `UPDATE bookings SET status = 'confirmed', holds_seat = 1, starts_at = proposed_starts_at, ends_at = proposed_ends_at, slot_id = COALESCE(proposed_slot_id, slot_id),
             proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_by = NULL, proposed_slot_id = NULL, proposal_note = '', updated_at = ? WHERE id = ?`,
          [nowIso(now), c.id],
        );
        await logEvent(db, c, c.status, 'confirmed', scope.userId, `Vorschlag angenommen: ${newWhen}`);
      } else {
        await db.run(`UPDATE bookings SET proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_by = NULL, proposed_slot_id = NULL, proposal_note = '', updated_at = ? WHERE id = ?`, [
          nowIso(now),
          c.id,
        ]);
        await logEvent(db, c, c.status, c.status, scope.userId, `Vorschlag abgelehnt: ${newWhen}`);
      }
      const template: Template = accept ? 'proposal_accepted' : 'proposal_rejected';
      if (by === 'provider') await notifyBooker(db, appUrl, c, template, { newWhen });
      else await notifyProviders(db, appUrl, c, template, scope.userId, { newWhen });
      return 'ok';
    });
  } catch (e) {
    if (isFull(e)) return 'full';
    throw e;
  }
}

/**
 * Buchende schlagen statt einer freien Uhrzeit einen anderen vorgegebenen Slot vor.
 * Der Slot muss für die Person sichtbar, veröffentlicht, fest, frei und vom selben Angebot sein.
 * Bei einer offenen Anfrage wechselt die Anfrage direkt (die Anbieterseite muss sie ohnehin bestätigen);
 * bei einem festen Termin entsteht ein Vorschlag, dem die Anbieterseite zustimmen muss.
 */
export async function proposeSlot(
  db: Db,
  appUrl: string,
  userId: string,
  membershipId: string | null,
  bookingId: string,
  slotId: string,
  now = Date.now(),
): Promise<ActionResult> {
  try {
    return await db.tx(async (): Promise<ActionResult> => {
      const c = await loadCtx(db, bookingId);
      if (!c || c.user_id !== userId) return 'not_found';
      if (c.status !== 'requested' && c.status !== 'confirmed') return 'invalid_state';
      if (Date.parse(c.starts_at) <= now) return 'invalid_state';
      const slot = await db.get<{ id: string; starts_at: string; ends_at: string; capacity: number; taken: number }>(
        `SELECT s.id, s.starts_at, s.ends_at, s.capacity, ${TAKEN_SQL} AS taken
         FROM slots s JOIN offerings o ON o.id = s.offering_id AND o.workspace_id = s.workspace_id
         WHERE s.id = @sid AND s.workspace_id = @ws AND s.offering_id = @off AND s.kind = 'fixed' AND s.status = 'published'
           AND o.archived_at IS NULL AND s.id <> @cur AND ${SLOT_VISIBLE_SQL}`,
        { sid: slotId, ws: c.workspace_id, off: c.offering_id, cur: c.slot_id, mid: membershipId },
      );
      if (!slot) return 'not_found';
      if (Date.parse(slot.starts_at) <= now) return 'bad_time';
      if (slot.taken >= slot.capacity) return 'full';
      const newWhen = formatRange(slot.starts_at, slot.ends_at, c.timezone);
      if (c.status === 'requested') {
        await db.run(
          `UPDATE bookings SET slot_id = ?, starts_at = ?, ends_at = ?, proposed_starts_at = NULL, proposed_ends_at = NULL, proposed_by = NULL, proposed_slot_id = NULL, updated_at = ? WHERE id = ?`,
          [slot.id, slot.starts_at, slot.ends_at, nowIso(now), c.id],
        );
        await logEvent(db, c, c.status, c.status, userId, `Anderen Termin gewählt: ${newWhen}`);
      } else {
        await db.run(
          `UPDATE bookings SET proposed_starts_at = ?, proposed_ends_at = ?, proposed_by = 'booker', proposed_slot_id = ?, proposal_note = '', updated_at = ? WHERE id = ?`,
          [slot.starts_at, slot.ends_at, slot.id, nowIso(now), c.id],
        );
        await logEvent(db, c, c.status, c.status, userId, `Anderen Termin vorgeschlagen: ${newWhen}`);
      }
      await notifyProviders(db, appUrl, c, 'proposal_to_provider', userId, { newWhen });
      return 'ok';
    });
  } catch (e) {
    if (isUniqueViolation(e)) return 'invalid_state';
    if (isFull(e)) return 'full';
    throw e;
  }
}

export type BookerResult = 'withdrawn' | 'cancelled' | 'cancel_requested' | 'not_found' | 'invalid_state';

/** Buchende: Anfrage zurückziehen oder fixen Termin absagen (bzw. Absage anfragen). */
export async function bookerAction(db: Db, appUrl: string, userId: string, bookingId: string, action: 'withdraw' | 'cancel', now = Date.now()): Promise<BookerResult> {
  return await db.tx(async (): Promise<BookerResult> => {
    const c = await loadCtx(db, bookingId);
    if (!c || c.user_id !== userId) return 'not_found';
    if (Date.parse(c.starts_at) <= now) return 'invalid_state';
    if (action === 'withdraw') {
      if (c.status !== 'requested') return 'invalid_state';
      await db.run(`UPDATE bookings SET status = 'withdrawn', proposed_by = NULL, proposed_slot_id = NULL, proposed_starts_at = NULL, proposed_ends_at = NULL, updated_at = ? WHERE id = ?`, [
        nowIso(now),
        c.id,
      ]);
      await logEvent(db, c, c.status, 'withdrawn', userId);
      await notifyProviders(db, appUrl, c, 'provider_withdrawn', userId);
      return 'withdrawn';
    }
    if (c.status !== 'confirmed') return 'invalid_state';
    const beforeCutoff = Date.parse(c.starts_at) - c.cancel_cutoff_hours * 3600_000 > now;
    if (c.allow_self_cancel && beforeCutoff) {
      await db.run(`UPDATE bookings SET status = 'cancelled', proposed_by = NULL, proposed_slot_id = NULL, proposed_starts_at = NULL, proposed_ends_at = NULL, updated_at = ? WHERE id = ?`, [
        nowIso(now),
        c.id,
      ]);
      await logEvent(db, c, c.status, 'cancelled', userId, 'Absage durch buchende Person');
      await notifyProviders(db, appUrl, c, 'provider_cancelled_by_booker', userId);
      return 'cancelled';
    }
    if (c.cancel_requested_at) return 'cancel_requested';
    await db.run(`UPDATE bookings SET cancel_requested_at = ?, updated_at = ? WHERE id = ?`, [nowIso(now), nowIso(now), c.id]);
    await logEvent(db, c, c.status, c.status, userId, 'Absage angefragt');
    await notifyProviders(db, appUrl, c, 'provider_cancel_requested', userId);
    return 'cancel_requested';
  });
}

export interface BookingTimes {
  status: BookingStatus;
  starts_at: string;
  ends_at: string;
  timezone: string;
  proposed_starts_at: string | null;
  proposed_ends_at: string | null;
  proposed_by: Party | null;
  proposal_note: string;
}

export interface MyBookingRow extends BookingTimes {
  id: string;
  slot_id: string;
  offering_id: string;
  cancel_requested_at: string | null;
  location: string;
  online_info: string;
  offering_name: string;
  workspace_name: string;
  workspace_id: string;
  allow_self_cancel: number;
  cancel_cutoff_hours: number;
  created_at: string;
  group_name: string | null;
}

export async function listMyBookings(db: Db, userId: string) {
  return await db.all<MyBookingRow>(
    `SELECT b.id, b.status, b.cancel_requested_at, b.starts_at, b.ends_at, s.timezone,
       b.proposed_starts_at, b.proposed_ends_at, b.proposed_by, b.proposal_note, b.slot_id, b.offering_id,
       COALESCE(s.location, o.location) AS location, COALESCE(s.online_info, o.online_info) AS online_info,
       o.name AS offering_name, w.name AS workspace_name, w.id AS workspace_id, o.allow_self_cancel, o.cancel_cutoff_hours, b.created_at,
       (SELECT g.name FROM ws_groups g WHERE g.id = b.group_id) AS group_name
     FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN offerings o ON o.id = b.offering_id JOIN workspaces w ON w.id = b.workspace_id
     WHERE b.user_id = ? ORDER BY b.starts_at DESC LIMIT 500`,
    [userId],
  );
}

export interface WsBookingRow extends BookingTimes {
  id: string;
  note: string;
  cancel_requested_at: string | null;
  created_at: string;
  offering_name: string;
  slot_id: string;
  slot_kind: 'fixed' | 'window';
  booker_name: string;
  booker_email: string;
  /** 1 = Schüler:in ohne App (keine E-Mails, kann nicht zustimmen) */
  booker_offline: number;
  user_id: string;
  is_member: number;
  conflicts: number;
  attendance: 'attended' | 'absent_billed' | 'absent' | null;
  /** gewählte Gruppe (z. B. Instrument) */
  group_name: string | null;
}

export interface BookingFilter {
  status?: string;
  fromIso?: string;
  toIso?: string;
  offeringId?: string;
  groupId?: string;
  userId?: string;
  slotId?: string;
}

export async function listWorkspaceBookings(db: Db, wsId: string, f: BookingFilter & { id?: string }) {
  const where = ['b.workspace_id = @ws'];
  const params: Record<string, string> = { ws: wsId };
  if (f.id) {
    where.push('b.id = @id');
    params.id = f.id;
  }
  if (f.status === 'awaiting_me') {
    where.push(`b.status IN ('requested','confirmed') AND ((b.proposed_by = 'booker') OR (b.status = 'requested' AND b.proposed_by IS NULL) OR b.cancel_requested_at IS NOT NULL)`);
  } else if (f.status === 'awaiting_booker') {
    where.push(`b.status IN ('requested','confirmed') AND b.proposed_by = 'provider'`);
  } else if (f.status && f.status in BOOKING_STATUS_LABELS && f.status !== 'past') {
    where.push('b.status = @st');
    params.st = f.status;
  }
  if (f.fromIso) {
    where.push('b.ends_at > @from');
    params.from = f.fromIso;
  }
  if (f.toIso) {
    where.push('b.starts_at < @to');
    params.to = f.toIso;
  }
  if (f.offeringId) {
    where.push('b.offering_id = @off');
    params.off = f.offeringId;
  }
  if (f.userId) {
    where.push('b.user_id = @uid');
    params.uid = f.userId;
  }
  if (f.slotId) {
    where.push('b.slot_id = @sid');
    params.sid = f.slotId;
  }
  if (f.groupId) {
    where.push(`EXISTS (SELECT 1 FROM memberships m JOIN group_members gm ON gm.membership_id = m.id
                 WHERE m.workspace_id = b.workspace_id AND m.user_id = b.user_id AND gm.group_id = @grp)`);
    params.grp = f.groupId;
  }
  return await db.all<WsBookingRow>(
    `SELECT b.id, b.status, b.note, b.cancel_requested_at, b.created_at, b.starts_at, b.ends_at, s.timezone, b.attendance,
       (SELECT g.name FROM ws_groups g WHERE g.id = b.group_id) AS group_name,
       b.proposed_starts_at, b.proposed_ends_at, b.proposed_by, b.proposal_note, b.slot_id, b.offering_id,
       o.name AS offering_name, s.id AS slot_id, s.kind AS slot_kind,
       u.display_name AS booker_name, CASE WHEN u.email LIKE '%@ohne-app.invalid' THEN '' ELSE u.email END AS booker_email, (u.email LIKE '%@ohne-app.invalid') AS booker_offline, u.id AS user_id,
       EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = b.workspace_id AND m.user_id = b.user_id) AS is_member,
       (SELECT COUNT(*) FROM bookings x WHERE x.workspace_id = b.workspace_id AND x.id <> b.id AND x.status IN ('requested','confirmed')
          AND x.starts_at < b.ends_at AND x.ends_at > b.starts_at) AS conflicts
     FROM bookings b JOIN slots s ON s.id = b.slot_id AND s.workspace_id = b.workspace_id
     JOIN offerings o ON o.id = b.offering_id JOIN users u ON u.id = b.user_id
     WHERE ${where.join(' AND ')} ORDER BY b.starts_at LIMIT 1000`,
    params,
  );
}

/** Personen, die in diesem Arbeitsbereich gebucht haben oder Mitglied sind – für den Personenfilter. */
export async function bookingPeople(db: Db, wsId: string) {
  return await db.all<{ user_id: string; display_name: string; email: string }>(
    `SELECT u.id AS user_id, u.display_name, CASE WHEN u.email LIKE '%@ohne-app.invalid' THEN '' ELSE u.email END AS email FROM users u WHERE u.id IN (
       SELECT user_id FROM bookings WHERE workspace_id = ? UNION SELECT user_id FROM memberships WHERE workspace_id = ?)
     ORDER BY u.display_name COLLATE NOCASE`,
    [wsId, wsId],
  );
}

export async function bookingHistory(db: Db, wsId: string, bookingId: string) {
  return await db.all<{ from_status: string | null; to_status: string; note: string; created_at: string; actor_name: string | null }>(
    `SELECT e.from_status, e.to_status, e.note, e.created_at, u.display_name AS actor_name FROM booking_events e
     LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.booking_id = ? AND e.workspace_id = ? ORDER BY e.created_at`,
    [bookingId, wsId],
  );
}

export async function getWorkspaceBooking(db: Db, wsId: string, bookingId: string) {
  return (await listWorkspaceBookings(db, wsId, { id: bookingId }))[0];
}

export type AddLessonResult = { ok: true; bookingId: string } | { ok: false; code: 'full' | 'already_booked' };

/**
 * Die Anbieterseite trägt einen festen Termin für eine Person ein – z. B. eine Stunde nachtragen,
 * die außerhalb der App vereinbart wurde, oder Schüler:innen direkt einplanen.
 * Gibt es zu dieser Zeit schon einen festen Slot des Angebots, wird er verwendet, sonst entsteht ein
 * geschlossener, interner Slot nur für diesen Termin. Überschneidungen verhindert der Datenbank-Trigger.
 */
export async function providerAddBooking(
  db: Db,
  appUrl: string,
  p: { workspaceId: string; offering: Offering; userId: string; actorId: string; tz: string; startMs: number; durationMin: number; note: string; notify?: boolean; groupId?: string | null },
  now = Date.now(),
): Promise<AddLessonResult> {
  const endMs = p.startMs + p.durationMin * 60_000;
  try {
    return await db.tx(async (): Promise<AddLessonResult> => {
      const existing = await db.get<{ id: string }>(
        `SELECT id FROM slots WHERE workspace_id = ? AND offering_id = ? AND kind = 'fixed' AND starts_at = ? AND ends_at = ? AND status <> 'draft'`,
        [p.workspaceId, p.offering.id, nowIso(p.startMs), nowIso(endMs)],
      );
      const slotId =
        existing?.id ??
        (await insertSlot(db, p.workspaceId, p.offering, null, p.startMs, p.tz, {
          kind: 'fixed',
          durationMin: p.durationMin,
          bufferMin: 0,
          capacity: 1,
          location: null,
          onlineInfo: null,
          confirmationMode: null,
          status: 'closed',
          preference: 'normal',
          visibility: 'internal',
          audience: { groupIds: [], membershipIds: [] },
        }));
      const id = newId();
      const ts = nowIso(now);
      const membership = await db.get<{ id: string }>(`SELECT id FROM memberships WHERE workspace_id = ? AND user_id = ?`, [p.workspaceId, p.userId]);
      const groupId = await resolveGroup(db, p.workspaceId, membership?.id ?? null, p.groupId);
      await db.run(
        `INSERT INTO bookings (id, workspace_id, slot_id, offering_id, user_id, status, starts_at, ends_at, holds_seat, note, group_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, 1, ?, ?, ?, ?)`,
        [id, p.workspaceId, slotId, p.offering.id, p.userId, nowIso(p.startMs), nowIso(endMs), p.note.slice(0, 1000), groupId, ts, ts],
      );
      await logEvent(db, { id, workspace_id: p.workspaceId }, null, 'confirmed', p.actorId, 'Von der Anbieterseite eingetragen');
      // Nur künftige Termine ankündigen; nachgetragene Stunden brauchen keine E-Mail.
      if (p.startMs > now && p.notify !== false) await notifyBooker(db, appUrl, (await loadCtx(db, id))!, 'booking_confirmed');
      return { ok: true, bookingId: id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, code: 'already_booked' };
    if (isFull(e)) return { ok: false, code: 'full' };
    throw e;
  }
}
