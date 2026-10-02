import type { Db } from '../db.ts';
import { localDate, localTime } from '../time.ts';

// Termine einer Person für Kalender-Apps:
// - als iCalendar (RFC 5545): Abo-Link (webcal/https), Download, einzelner Termin
// - als JSON für andere TE-Apps (Familienplaner), siehe routes/api.ts
// Enthalten sind eigene Buchungen und – für Verwaltende – die Buchungen der eigenen Arbeitsbereiche.

export interface CalendarEntry {
  id: string;
  /** 'mine' = eigene Buchung, 'provider' = Termin in einem Arbeitsbereich, den die Person verwaltet */
  role: 'mine' | 'provider';
  status: 'requested' | 'confirmed' | 'cancelled' | 'declined' | 'withdrawn';
  starts_at: string;
  ends_at: string;
  timezone: string;
  offering_name: string;
  workspace_id: string;
  workspace_name: string;
  booker_name: string;
  location: string;
  online_info: string;
  note: string;
  updated_at: string;
  created_at: string;
  /** gewählte Gruppe (z. B. Instrument) */
  group_name: string | null;
}

export interface CalendarFilter {
  /** nur dieser Arbeitsbereich (muss verwaltet werden) */
  workspaceId?: string;
  fromIso: string;
  toIso: string;
  /** abgesagte Termine mitliefern (für Abos: Kalender entfernen sie dann sauber) */
  includeCancelled?: boolean;
}

export async function calendarEntries(db: Db, userId: string, f: CalendarFilter): Promise<CalendarEntry[]> {
  const statuses = f.includeCancelled ? `('requested','confirmed','cancelled','declined','withdrawn')` : `('requested','confirmed')`;
  const params: Record<string, string> = { uid: userId, from: f.fromIso, to: f.toIso };
  const wsFilter = f.workspaceId ? 'AND b.workspace_id = @ws' : '';
  if (f.workspaceId) params.ws = f.workspaceId;
  // Wer bucht, sieht Online-Infos nur bei bestätigten Terminen (wie in der App).
  return await db.all<CalendarEntry>(
    `SELECT b.id, CASE WHEN b.user_id = @uid THEN 'mine' ELSE 'provider' END AS role, b.status, b.starts_at, b.ends_at, s.timezone,
       o.name AS offering_name, w.id AS workspace_id, w.name AS workspace_name, u.display_name AS booker_name,
       COALESCE(s.location, o.location) AS location,
       CASE WHEN b.user_id <> @uid OR b.status = 'confirmed' THEN COALESCE(s.online_info, o.online_info) ELSE '' END AS online_info,
       CASE WHEN b.user_id = @uid THEN '' ELSE b.note END AS note, b.updated_at, b.created_at,
       (SELECT g.name FROM ws_groups g WHERE g.id = b.group_id) AS group_name
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id AND s.workspace_id = b.workspace_id
     JOIN offerings o ON o.id = b.offering_id AND o.workspace_id = b.workspace_id
     JOIN workspaces w ON w.id = b.workspace_id
     JOIN users u ON u.id = b.user_id
     WHERE b.status IN ${statuses} AND b.starts_at < @to AND b.ends_at > @from ${wsFilter}
       AND (
         (b.user_id = @uid ${f.workspaceId ? 'AND 0' : ''})
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = b.workspace_id AND m.user_id = @uid AND m.role IN ('owner','admin','staff'))
       )
     ORDER BY b.starts_at LIMIT 3000`,
    params,
  );
}

/** Verwaltet die Person diesen Arbeitsbereich (darf dessen Kalender abonnieren)? */
export async function managesWorkspace(db: Db, userId: string, wsId: string) {
  return !!(await db.get(`SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND role IN ('owner','admin','staff')`, [wsId, userId]));
}

export function entryTitle(e: CalendarEntry) {
  const prefix = e.status === 'requested' ? 'Angefragt: ' : e.status === 'confirmed' ? '' : 'Abgesagt: ';
  const what = e.group_name ? `${e.offering_name} – ${e.group_name}` : e.offering_name;
  return e.role === 'provider' ? `${prefix}${e.booker_name || 'Ohne Namen'} · ${what}` : `${prefix}${what} (${e.workspace_name})`;
}

// ---------- iCalendar ----------

function escapeText(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const enc = new TextEncoder();

/** Zeilen nach RFC 5545 auf 75 Byte falten, ohne UTF-8-Zeichen zu zerschneiden. */
function fold(line: string) {
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length ? 74 : 75; // Folgezeilen beginnen mit einem Leerzeichen
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function buildIcs(o: { name: string; entries: CalendarEntry[]; appUrl: string; host: string; now?: number }) {
  const stamp = utc(new Date(o.now ?? Date.now()).toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TE-Slotwise//Termine//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(o.name)}`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of o.entries) {
    const link = e.role === 'provider' ? `${o.appUrl}/w/${e.workspace_id}/bookings?from=${localDate(Date.parse(e.starts_at), e.timezone)}#b-${e.id}` : `${o.appUrl}/bookings`;
    const desc = [
      e.status === 'requested' ? 'Status: angefragt (noch nicht bestätigt)' : e.status === 'confirmed' ? 'Status: bestätigt' : 'Status: abgesagt',
      e.role === 'provider' ? `Buchung von: ${e.booker_name}` : `Bei: ${e.workspace_name}`,
      e.online_info ? `Online: ${e.online_info}` : '',
      e.note ? `Nachricht: ${e.note}` : '',
      `Details: ${link}`,
    ].filter(Boolean);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}-${e.role}@${o.host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utc(e.starts_at)}`,
      `DTEND:${utc(e.ends_at)}`,
      // Änderungen (z. B. verschobene Zeit) erkennen Kalender an einer höheren Sequenz.
      `SEQUENCE:${Math.max(0, Math.floor((Date.parse(e.updated_at) - Date.parse(e.created_at)) / 1000))}`,
      `LAST-MODIFIED:${utc(e.updated_at)}`,
      `SUMMARY:${escapeText(entryTitle(e))}`,
      ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
      `DESCRIPTION:${escapeText(desc.join('\n'))}`,
      `URL:${link}`,
      `STATUS:${e.status === 'confirmed' ? 'CONFIRMED' : e.status === 'requested' ? 'TENTATIVE' : 'CANCELLED'}`,
      `TRANSP:${e.status === 'confirmed' || e.status === 'requested' ? 'OPAQUE' : 'TRANSPARENT'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- JSON für andere TE-Apps ----------

/**
 * Format wie /api/me/termine in Orchester-Orga und Vereinsleben – der Familienplaner liest beide
 * mit demselben Adapter. beginn/ende sind Wanduhrzeit ohne Zeitzone („2026-10-05T16:00“).
 */
export function toTermin(e: CalendarEntry) {
  const s = Date.parse(e.starts_at);
  const en = Date.parse(e.ends_at);
  return {
    id: `${e.id}-${e.role}`,
    titel: `${e.role === 'provider' ? `${e.booker_name || 'Ohne Namen'} · ` : ''}${e.offering_name}${e.group_name ? ` – ${e.group_name}` : ''}`,
    verein_name: e.workspace_name,
    beginn: `${localDate(s, e.timezone)}T${localTime(s, e.timezone)}`,
    ende: `${localDate(en, e.timezone)}T${localTime(en, e.timezone)}`,
    zeitzone: e.timezone,
    ort: e.location || null,
    notiz: [e.status === 'requested' ? 'Angefragt – noch nicht bestätigt.' : '', e.online_info ? `Online: ${e.online_info}` : ''].filter(Boolean).join(' ') || null,
    status: e.status === 'confirmed' ? 'bestaetigt' : e.status === 'requested' ? 'angefragt' : 'abgesagt',
    // wie in Orchester-Orga: zusage / absage / unsicher
    meine_rueckmeldung: e.status === 'confirmed' ? 'zusage' : e.status === 'requested' ? 'unsicher' : 'absage',
    rolle: e.role === 'provider' ? 'anbieter' : 'teilnehmer',
  };
}
