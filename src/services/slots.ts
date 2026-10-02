import { SLOT_VISIBLE_SQL, type Visibility } from '../authz.ts';
import type { Db } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import { addDays, isoWeekday, localDate, localTime, LocalTimeError, localToUtc } from '../time.ts';
import { getAudience, setAudience, type Audience, type Offering } from './offerings.ts';

export type SlotStatus = 'draft' | 'published' | 'closed';
export type SlotVisibility = Visibility | 'inherit';
export type SlotKind = 'fixed' | 'window';
/** normal = hellgrün, reluctant = gelb (anfragbar, aber eher ungern – immer mit manueller Bestätigung). */
export type SlotPreference = 'normal' | 'reluctant';

export interface Slot {
  id: string;
  workspace_id: string;
  offering_id: string;
  series_id: string | null;
  kind: SlotKind;
  starts_at: string;
  ends_at: string;
  timezone: string;
  buffer_min: number;
  location: string | null;
  online_info: string | null;
  capacity: number;
  confirmation_mode: 'manual' | 'auto' | null;
  preference: SlotPreference;
  status: SlotStatus;
  visibility: SlotVisibility;
}

export interface SlotInput {
  kind: SlotKind;
  /** Bei festen Slots die Termindauer, bei Zeitfenstern die Länge des Fensters. */
  durationMin: number;
  bufferMin: number;
  capacity: number;
  location: string | null;
  onlineInfo: string | null;
  confirmationMode: 'manual' | 'auto' | null;
  status: SlotStatus;
  preference: SlotPreference;
  visibility: SlotVisibility;
  audience: Audience;
}

/** Abgeleiteter Anzeigestatus eines Slots. */
export type SlotState = 'past' | 'draft' | 'closed' | 'full' | 'requested' | 'partly' | 'available';

export const SLOT_STATE_LABELS: Record<SlotState, string> = {
  past: 'Vergangen',
  draft: 'Entwurf (nicht veröffentlicht)',
  closed: 'Geschlossen',
  full: 'Ausgebucht',
  requested: 'Angefragt',
  partly: 'Teilweise gebucht',
  available: 'Verfügbar',
};

export function slotState(
  s: { kind: SlotKind; status: SlotStatus; ends_at: string; capacity: number; confirmed: number; requested: number; taken: number },
  now = Date.now(),
): SlotState {
  if (Date.parse(s.ends_at) <= now) return 'past';
  if (s.status === 'draft') return 'draft';
  if (s.status === 'closed') return 'closed';
  // Ein Zeitfenster gilt als verfügbar, solange es veröffentlicht ist; belegte Zeiten werden einzeln angezeigt.
  if (s.kind === 'window') return s.requested > 0 ? 'requested' : s.confirmed > 0 ? 'partly' : 'available';
  if (s.taken >= s.capacity) return s.confirmed >= s.capacity ? 'full' : 'requested';
  if (s.requested > 0 && s.confirmed === 0) return 'requested';
  if (s.confirmed > 0) return 'partly';
  return 'available';
}

/**
 * Belegte Plätze eines Slots: Buchungen desselben Angebots, die sich zeitlich mit dem Slot
 * überschneiden und bestätigt sind (oder als Anfrage die Zeit blockieren). Zeitbasiert, damit
 * verschobene Buchungen dort zählen, wo sie tatsächlich liegen.
 */
export const TAKEN_SQL = `(SELECT COUNT(*) FROM bookings b WHERE b.offering_id = s.offering_id AND b.workspace_id = s.workspace_id
  AND (b.status = 'confirmed' OR (b.status = 'requested' AND b.holds_seat = 1))
  AND b.starts_at < s.ends_at AND b.ends_at > s.starts_at)`;
const COUNTS_SQL = `
  (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS confirmed,
  (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'requested') AS requested,
  ${TAKEN_SQL} AS taken`;

export class SlotError extends Error {}

async function overlaps(db: Db, wsId: string, offeringId: string, startMs: number, endMs: number, bufferMin: number, exceptId: string | null) {
  // Puffer gilt nach jedem Termin: [start, end + buffer) darf sich nicht mit anderen Slots desselben Angebots überschneiden.
  const row = await db.get<{ id: string }>(
    `SELECT id FROM slots WHERE workspace_id = ? AND offering_id = ? AND id <> ?
     AND starts_at < ? AND datetime(ends_at, '+' || buffer_min || ' minutes') > datetime(?)
     LIMIT 1`,
    [wsId, offeringId, exceptId ?? '', nowIso(endMs + bufferMin * 60_000), nowIso(startMs)],
  );
  return !!row;
}

export async function insertSlot(db: Db, wsId: string, offering: Offering, seriesId: string | null, startMs: number, tz: string, p: SlotInput) {
  const id = newId();
  const now = nowIso();
  await db.run(
    `INSERT INTO slots (id, workspace_id, offering_id, series_id, kind, starts_at, ends_at, timezone, buffer_min, location, online_info, capacity,
     confirmation_mode, status, preference, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      wsId,
      offering.id,
      seriesId,
      p.kind,
      nowIso(startMs),
      nowIso(startMs + p.durationMin * 60_000),
      tz,
      p.bufferMin,
      p.location,
      p.onlineInfo,
      p.capacity,
      p.confirmationMode,
      p.status,
      p.preference,
      p.visibility,
      now,
      now,
    ],
  );
  if (p.visibility === 'groups' || p.visibility === 'people') await setAudience(db, 'slot', wsId, id, p.audience);
  return id;
}

export async function createSlot(db: Db, wsId: string, offering: Offering, tz: string, date: string, time: string, p: SlotInput) {
  if (p.kind === 'window' && p.durationMin < offering.duration_min) throw new SlotError('Das Zeitfenster ist kürzer als die Dauer des Angebots.');
  const start = localToUtc(date, time, tz);
  const end = start + p.durationMin * 60_000;
  return await db.tx(async () => {
    if (await overlaps(db, wsId, offering.id, start, end, p.bufferMin, null)) {
      throw new SlotError('Dieser Slot überschneidet sich (inklusive Pufferzeit) mit einem vorhandenen Slot desselben Angebots.');
    }
    return await insertSlot(db, wsId, offering, null, start, tz, p);
  });
}

export interface SeriesInput {
  fromDate: string;
  toDate: string;
  weekdays: number[]; // 1 = Montag … 7 = Sonntag
  windowStart: string; // HH:MM
  windowEnd: string; // HH:MM
  /** 1 = jede Woche (Standard), 2 = alle zwei Wochen … (gezählt ab der Woche des Startdatums) */
  everyWeeks?: number;
}

/** Tage zwischen zwei Daten (YYYY-MM-DD). */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const MAX_SERIES_SLOTS = 500;

function toMinutes(hhmm: string) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new SlotError('Ungültige Uhrzeit.');
  return +m[1] * 60 + +m[2];
}
const fromMinutes = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Erzeugt mehrere Slots: an den gewählten Wochentagen im Zeitraum. Feste Slots liegen im
 * Zeitfenster nacheinander (Dauer + Puffer); bei Art "window" entsteht pro Tag ein freies Zeitfenster. Jede lokale Uhrzeit wird einzeln umgerechnet, damit
 * Sommer-/Winterzeit stimmt. Überschneidungen und nicht existierende Zeiten werden übersprungen.
 */
export async function createSeries(db: Db, wsId: string, userId: string, offering: Offering, tz: string, s: SeriesInput, p: SlotInput) {
  if (s.toDate < s.fromDate) throw new SlotError('Das Enddatum liegt vor dem Startdatum.');
  if (!s.weekdays.length) throw new SlotError('Bitte mindestens einen Wochentag wählen.');
  const winStart = toMinutes(s.windowStart);
  const winEnd = toMinutes(s.windowEnd);
  if (winEnd - winStart < (p.kind === 'window' ? offering.duration_min : p.durationMin)) throw new SlotError('Das Zeitfenster ist kürzer als die Dauer eines Termins.');
  const step = p.kind === 'window' ? Number.POSITIVE_INFINITY : p.durationMin + p.bufferMin;
  if (p.kind === 'window') p = { ...p, durationMin: winEnd - winStart };

  const every = Math.max(1, Math.min(8, Math.floor(s.everyWeeks ?? 1)));
  const firstMonday = addDays(s.fromDate, 1 - isoWeekday(s.fromDate));
  const planned: { date: string; time: string }[] = [];
  for (let date = s.fromDate, i = 0; date <= s.toDate; date = addDays(date, 1), i++) {
    if (i > 366) throw new SlotError('Der Zeitraum darf höchstens ein Jahr umfassen.');
    if (!s.weekdays.includes(isoWeekday(date))) continue;
    if (Math.floor(daysBetween(firstMonday, date) / 7) % every !== 0) continue;
    for (let t = winStart; t + p.durationMin <= winEnd; t += step) planned.push({ date, time: fromMinutes(t) });
  }
  if (planned.length > MAX_SERIES_SLOTS) throw new SlotError(`Das wären ${planned.length} Slots – höchstens ${MAX_SERIES_SLOTS} auf einmal.`);

  return await db.tx(async () => {
    const seriesId = newId();
    await db.run(`INSERT INTO slot_series (id, workspace_id, offering_id, params, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      seriesId,
      wsId,
      offering.id,
      JSON.stringify({ ...s, durationMin: p.durationMin, bufferMin: p.bufferMin, capacity: p.capacity, timezone: tz }),
      userId,
      nowIso(),
    ]);
    let created = 0;
    let skipped = 0;
    for (const item of planned) {
      let start: number;
      try {
        start = localToUtc(item.date, item.time, tz);
      } catch (e) {
        if (e instanceof LocalTimeError) {
          skipped++;
          continue;
        }
        throw e;
      }
      if (await overlaps(db, wsId, offering.id, start, start + p.durationMin * 60_000, p.bufferMin, null)) {
        skipped++;
        continue;
      }
      await insertSlot(db, wsId, offering, seriesId, start, tz, p);
      created++;
    }
    return { seriesId, created, skipped };
  });
}

export interface AdminSlotRow extends Slot {
  offering_name: string;
  confirmed: number;
  requested: number;
  taken: number;
}

export async function listSlotsAdmin(db: Db, wsId: string, f: { fromIso: string; toIso: string; offeringId?: string; status?: string }) {
  const where = [`s.workspace_id = @ws`, `s.starts_at >= @from`, `s.starts_at < @to`];
  const params: Record<string, string> = { ws: wsId, from: f.fromIso, to: f.toIso };
  if (f.offeringId) {
    where.push(`s.offering_id = @off`);
    params.off = f.offeringId;
  }
  if (f.status && ['draft', 'published', 'closed'].includes(f.status)) {
    where.push(`s.status = @st`);
    params.st = f.status;
  }
  return await db.all<AdminSlotRow>(
    `SELECT s.*, o.name AS offering_name, ${COUNTS_SQL}
     FROM slots s JOIN offerings o ON o.id = s.offering_id AND o.workspace_id = s.workspace_id
     WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 1000`,
    params,
  );
}

export async function getSlot(db: Db, wsId: string, slotId: string) {
  return await db.get<AdminSlotRow>(
    `SELECT s.*, o.name AS offering_name, ${COUNTS_SQL} FROM slots s JOIN offerings o ON o.id = s.offering_id
     WHERE s.id = ? AND s.workspace_id = ?`,
    [slotId, wsId],
  );
}

export async function updateSlot(db: Db, wsId: string, slotId: string, tz: string, date: string, time: string, p: SlotInput) {
  return await db.tx(async () => {
    const slot = await getSlot(db, wsId, slotId);
    if (!slot) throw new SlotError('Slot nicht gefunden.');
    const start = localToUtc(date, time, tz);
    const end = start + p.durationMin * 60_000;
    const active = slot.confirmed + slot.requested;
    const timeChanged = nowIso(start) !== slot.starts_at || nowIso(end) !== slot.ends_at || tz !== slot.timezone;
    if (active > 0 && timeChanged) {
      throw new SlotError('Zeit und Dauer lassen sich nicht ändern, solange es offene oder bestätigte Buchungen gibt. Bitte diese zuerst absagen.');
    }
    if (p.kind !== slot.kind) throw new SlotError('Die Art eines Slots lässt sich nachträglich nicht ändern.');
    if (p.capacity < slot.taken && slot.kind === 'fixed') throw new SlotError(`Die Kapazität darf nicht unter die belegten Plätze (${slot.taken}) sinken.`);
    if (await overlaps(db, wsId, slot.offering_id, start, end, p.bufferMin, slotId)) {
      throw new SlotError('Dieser Slot überschneidet sich (inklusive Pufferzeit) mit einem vorhandenen Slot desselben Angebots.');
    }
    await db.run(
      `UPDATE slots SET starts_at = ?, ends_at = ?, timezone = ?, buffer_min = ?, location = ?, online_info = ?, capacity = ?, confirmation_mode = ?,
       status = ?, preference = ?, visibility = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      [
        nowIso(start),
        nowIso(end),
        tz,
        p.bufferMin,
        p.location,
        p.onlineInfo,
        p.capacity,
        p.confirmationMode,
        p.status,
        p.preference,
        p.visibility,
        nowIso(),
        slotId,
        wsId,
      ],
    );
    await setAudience(db, 'slot', wsId, slotId, p.visibility === 'groups' || p.visibility === 'people' ? p.audience : { groupIds: [], membershipIds: [] });
  });
}

export type BulkAction = 'publish' | 'unpublish' | 'close' | 'delete' | 'reluctant' | 'normal';

/** Sammelaktion. Slots mit Buchungen werden nie gelöscht und nicht in den Entwurf zurückgesetzt. */
export async function bulkSlots(db: Db, wsId: string, slotIds: string[], action: BulkAction) {
  return await db.tx(async () => {
    let done = 0;
    let skipped = 0;
    for (const id of new Set(slotIds)) {
      const hasBookings = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ? AND workspace_id = ?`, [id, wsId]);
      const active = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ? AND workspace_id = ? AND status IN ('requested','confirmed')`, [id, wsId]);
      let changed = 0;
      if (action === 'publish') changed = await db.run(`UPDATE slots SET status = 'published', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowIso(), id, wsId]);
      else if (action === 'reluctant' || action === 'normal')
        changed = await db.run(`UPDATE slots SET preference = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`, [action, nowIso(), id, wsId]);
      else if (action === 'close') changed = await db.run(`UPDATE slots SET status = 'closed', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowIso(), id, wsId]);
      else if (action === 'unpublish') {
        if (!active?.n) changed = await db.run(`UPDATE slots SET status = 'draft', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowIso(), id, wsId]);
      } else if (action === 'delete') {
        if (!hasBookings?.n) changed = await db.run(`DELETE FROM slots WHERE id = ? AND workspace_id = ?`, [id, wsId]);
      }
      if (changed) done++;
      else skipped++;
    }
    return { done, skipped };
  });
}

export interface VisibleSlotRow {
  id: string;
  preference: SlotPreference;
  kind: SlotKind;
  duration_min: number;
  offering_id: string;
  offering_name: string;
  offering_description: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location: string;
  online_info: string;
  capacity: number;
  taken: number;
  mode: 'manual' | 'auto';
  my_status: string | null;
}

/**
 * Slots, die eine Person sehen und buchen kann: veröffentlicht, in der Zukunft (inkl. Vorlaufzeit),
 * Angebot aktiv, Zielgruppe passt, noch Platz frei – oder bereits von ihr selbst gebucht.
 * Für öffentliche Besucher: membershipId = null. Es werden nie Daten anderer Buchender geliefert.
 */
export async function listVisibleSlots(
  db: Db,
  wsId: string,
  membershipId: string | null,
  userId: string | null,
  f: { offeringId?: string; fromIso?: string; toIso?: string } = {},
  now = Date.now(),
) {
  const params: Record<string, string | null> = {
    ws: wsId,
    mid: membershipId,
    uid: userId,
    now: nowIso(now),
    from: f.fromIso ?? nowIso(now),
    to: f.toIso ?? '9999',
    off: f.offeringId ?? null,
  };
  return await db.all<VisibleSlotRow>(
    `SELECT s.id, s.kind, o.duration_min, s.offering_id, o.name AS offering_name, o.description AS offering_description, s.starts_at, s.ends_at, s.timezone,
       COALESCE(s.location, o.location) AS location, COALESCE(s.online_info, o.online_info) AS online_info, s.capacity,
       ${TAKEN_SQL} AS taken, CASE WHEN s.preference = 'reluctant' THEN 'manual' ELSE COALESCE(s.confirmation_mode, o.confirmation_mode) END AS mode, s.preference,
       (SELECT b.status FROM bookings b WHERE b.slot_id = s.id AND b.user_id = @uid AND b.status IN ('requested','confirmed')) AS my_status
     FROM slots s JOIN offerings o ON o.id = s.offering_id AND o.workspace_id = s.workspace_id
     WHERE s.workspace_id = @ws AND s.status = 'published' AND o.archived_at IS NULL
       AND (CASE WHEN s.kind = 'window' THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.ends_at, '-' || o.duration_min || ' minutes') ELSE s.starts_at END)
           > strftime('%Y-%m-%dT%H:%M:%fZ', @now, '+' || o.min_notice_hours || ' hours')
       AND s.ends_at > @from AND s.starts_at < @to
       AND (@off IS NULL OR s.offering_id = @off)
       AND ${SLOT_VISIBLE_SQL}
       AND (s.kind = 'window' OR ${TAKEN_SQL} < s.capacity OR EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.user_id = @uid AND b.status IN ('requested','confirmed')))
     ORDER BY s.starts_at LIMIT 500`,
    params,
  );
}

/**
 * Bereits fest vergebene Zeiten innerhalb von Zeitfenstern – nur Beginn/Ende, ohne Personenbezug.
 * So sehen Buchende, welche Wunschzeiten sicher nicht mehr gehen.
 */
export async function busyTimes(db: Db, wsId: string, slotIds: string[]) {
  const out = new Map<string, { starts_at: string; ends_at: string }[]>();
  for (const id of slotIds) {
    const rows = await db.all<{ starts_at: string; ends_at: string }>(
      `SELECT b.starts_at, b.ends_at FROM slots s JOIN bookings b ON b.offering_id = s.offering_id AND b.workspace_id = s.workspace_id
       WHERE s.id = ? AND s.workspace_id = ? AND (b.status = 'confirmed' OR (b.status = 'requested' AND b.holds_seat = 1))
         AND b.starts_at < s.ends_at AND b.ends_at > s.starts_at ORDER BY b.starts_at`,
      [id, wsId],
    );
    out.set(id, rows);
  }
  return out;
}

export interface OccupiedRow {
  starts_at: string;
  ends_at: string;
  timezone: string;
  first_name: string;
  mine: number;
}

/**
 * Fest vergebene Termine, die eine Person im Kalender als "belegt" sehen darf: bestätigte Buchungen
 * zu Slots, die für sie sichtbar sind. Geliefert werden nur Zeit und Vorname; ob der Name angezeigt
 * wird, entscheidet die Einstellung des Arbeitsbereichs.
 */
export async function occupiedTimes(db: Db, wsId: string, membershipId: string | null, userId: string | null, fromIso: string, toIso: string) {
  return await db.all<OccupiedRow>(
    `SELECT b.starts_at, b.ends_at, s.timezone,
       u.first_name AS first_name,
       (b.user_id = @uid) AS mine
     FROM bookings b JOIN slots s ON s.id = b.slot_id AND s.workspace_id = b.workspace_id
     JOIN offerings o ON o.id = s.offering_id AND o.workspace_id = s.workspace_id
     JOIN users u ON u.id = b.user_id
     WHERE b.workspace_id = @ws AND b.status = 'confirmed' AND b.ends_at > @from AND b.starts_at < @to
       AND s.status <> 'draft' AND o.archived_at IS NULL AND ${SLOT_VISIBLE_SQL}
     ORDER BY b.starts_at LIMIT 1000`,
    { ws: wsId, mid: membershipId, uid: userId ?? '', from: fromIso, to: toIso },
  );
}

/**
 * „Woche wiederholen“: Alle Slots einer Woche (ab Montag `weekStart`) werden in die folgenden Wochen
 * übernommen – gleiche Uhrzeit (Ortszeit), gleiche Einstellungen, ohne Buchungen; feste Slots und freie
 * Zeitfenster. Geschlossene Slots (z. B. einzeln eingetragene Stunden) bleiben außen vor; Überschneidungen werden übersprungen.
 */
export async function repeatWeek(db: Db, wsId: string, weekStart: string, tz: string, weeks: number, everyWeeks = 1) {
  weeks = Math.max(1, Math.min(52, Math.floor(weeks)));
  everyWeeks = Math.max(1, Math.min(4, Math.floor(everyWeeks)));
  const from = new Date(localToUtc(weekStart, '00:00', tz)).toISOString();
  const to = new Date(localToUtc(addDays(weekStart, 7), '00:00', tz)).toISOString();
  const source = await db.all<Slot>(
    `SELECT * FROM slots WHERE workspace_id = ? AND starts_at >= ? AND starts_at < ? AND status <> 'closed' ORDER BY starts_at`,
    [wsId, from, to],
  );
  if (weeks * source.length > MAX_SERIES_SLOTS) throw new SlotError(`Das wären ${weeks * source.length} Slots – höchstens ${MAX_SERIES_SLOTS} auf einmal.`);
  const offerings = new Map<string, Offering>();
  let created = 0;
  let skipped = 0;
  await db.tx(async () => {
    for (const sl of source) {
      if (!offerings.has(sl.offering_id)) {
        const o = await db.get<Offering>(`SELECT * FROM offerings WHERE id = ? AND workspace_id = ?`, [sl.offering_id, wsId]);
        if (o) offerings.set(o.id, o);
      }
      const off = offerings.get(sl.offering_id);
      if (!off || off.archived_at) continue;
      const startMs = Date.parse(sl.starts_at);
      const duration = Math.round((Date.parse(sl.ends_at) - startMs) / 60_000);
      const day = localDate(startMs, sl.timezone);
      const time = localTime(startMs, sl.timezone);
      const audience = sl.visibility === 'groups' || sl.visibility === 'people' ? await getAudience(db, 'slot', wsId, sl.id) : { groupIds: [], membershipIds: [] };
      for (let k = 1; k <= weeks; k++) {
        let start: number;
        try {
          start = localToUtc(addDays(day, 7 * everyWeeks * k), time, sl.timezone);
        } catch (e) {
          if (e instanceof LocalTimeError) {
            skipped++;
            continue;
          }
          throw e;
        }
        if (await overlaps(db, wsId, off.id, start, start + duration * 60_000, sl.buffer_min, null)) {
          skipped++;
          continue;
        }
        await insertSlot(db, wsId, off, sl.series_id, start, sl.timezone, {
          kind: sl.kind,
          durationMin: duration,
          bufferMin: sl.buffer_min,
          capacity: sl.capacity,
          location: sl.location,
          onlineInfo: sl.online_info,
          confirmationMode: sl.confirmation_mode,
          status: sl.status,
          preference: sl.preference,
          visibility: sl.visibility,
          audience,
        });
        created++;
      }
    }
  });
  return { source: source.length, created, skipped };
}
