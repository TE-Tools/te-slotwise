import { html, raw } from 'hono/html';
import { addDays, isoWeekday, localDate, localParts, localToUtc } from '../time.ts';
import type { H } from './ui.ts';

// Großer Wochenkalender mit Zeitachse. Reines HTML/CSS: Termine werden absolut in ihrer
// Tagesspalte positioniert, überlappende Einträge teilen sich die Breite.

export type WeekItemKind = 'free' | 'reluctant' | 'confirmed' | 'requested' | 'proposal' | 'mine' | 'draft' | 'closed' | 'blocked' | 'todo';

export interface WeekItem {
  start: number; // UTC-Millisekunden
  end: number;
  title: string;
  detail?: string;
  href?: string;
  kind: WeekItemKind;
  /** Hintergrund-Einträge (Zeitfenster) liegen unter den anderen und belegen keine eigene Spalte. */
  background?: boolean;
  /** Vergangener Termin: abgehakt oder noch abzuhaken (Markierung am Rand). */
  mark?: 'checked' | 'todo';
}

const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
/** Mindesthöhe einer Stunde; per CSS wächst sie mit der Bildschirmhöhe (--hour-px), Positionen sind relativ dazu. */
const MIN_HOUR_PX = 64;
const at = (hours: number) => `calc(var(--hour-px) * ${+hours.toFixed(4)})`;

/** Montag der Woche, in der `date` liegt. */
export function weekStartOf(date: string) {
  return addDays(date, 1 - isoWeekday(date));
}

export function parseWeek(raw: string | undefined, today: string) {
  return weekStartOf(raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today);
}

/** UTC-Grenzen der Woche in der Zeitzone. */
export function weekRange(weekStart: string, tz: string): [string, string] {
  return [new Date(localToUtc(weekStart, '00:00', tz)).toISOString(), new Date(localToUtc(addDays(weekStart, 7), '00:00', tz)).toISOString()];
}

interface Placed {
  item: WeekItem;
  top: number; // Minuten seit Mitternacht
  bottom: number;
  lane: number;
  lanes: number;
}

function placeDay(items: { item: WeekItem; top: number; bottom: number }[]): Placed[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const placed: Placed[] = [];
  let group: Placed[] = [];
  let groupEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    for (const p of group) p.lanes = lanes;
    placed.push(...group);
    group = [];
  };
  for (const it of sorted) {
    if (it.top >= groupEnd && group.length) flush();
    const used = new Set(group.filter((p) => p.bottom > it.top).map((p) => p.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    group.push({ ...it, lane, lanes: 1 });
    groupEnd = Math.max(groupEnd, it.bottom);
  }
  if (group.length) flush();
  return placed;
}

export function weekCalendar(o: {
  weekStart: string;
  tz: string;
  items: WeekItem[];
  hrefFor: (weekStart: string) => string;
  dayHref?: (date: string) => string;
  legend?: { kind: WeekItemKind; label: string }[];
  /** Klick auf eine leere Stunde (z. B. „hier Slots anlegen“). */
  cellHref?: (date: string, hhmm: string) => string;
  /** 7 = Woche (Standard), 1 = einzelner Tag ab `weekStart` */
  days?: number;
  /** zusätzliche Bedienelemente rechts im Kopf (z. B. Tag/Woche/Monat) */
  toolbar?: H;
  /** fest eingestellter sichtbarer Zeitraum (volle Stunden); sonst automatisch */
  hours?: { from: number | null; to: number | null };
  /** Link zur Einstellung des Zeitraums (nur für Verwaltende) */
  hoursHref?: string;
}): H {
  const now = Date.now();
  const today = localDate(now, o.tz);
  const span = o.days === 1 ? 1 : 7;
  const days = Array.from({ length: span }, (_, i) => addDays(o.weekStart, i));

  // Einträge auf Tage verteilen (über Mitternacht reichende Einträge werden aufgeteilt).
  const perDay = new Map<string, { item: WeekItem; top: number; bottom: number }[]>(days.map((d) => [d, []]));
  const fixed = o.hours && o.hours.from !== null && o.hours.to !== null && o.hours.to > o.hours.from ? { from: o.hours.from, to: o.hours.to } : null;
  let minHour = fixed?.from ?? 8;
  let maxHour = fixed?.to ?? 19;
  let hidden = 0;
  for (const item of o.items) {
    for (const d of days) {
      const dayStart = localToUtcSafe(d, o.tz);
      const dayEnd = localToUtcSafe(addDays(d, 1), o.tz);
      if (item.end <= dayStart || item.start >= dayEnd) continue;
      const s = Math.max(item.start, dayStart);
      const e = Math.min(item.end, dayEnd);
      const sp = localParts(s, o.tz);
      const top = localDate(s, o.tz) === d ? sp.hour * 60 + sp.minute : 0;
      const ep = localParts(e, o.tz);
      const bottom = e >= dayEnd ? 24 * 60 : ep.hour * 60 + ep.minute;
      if (fixed) {
        // Nur den eingestellten Zeitraum zeigen; Einträge außerhalb werden gezählt, angeschnittene gekürzt.
        const t = Math.max(top, fixed.from * 60);
        const b = Math.min(bottom, fixed.to * 60);
        if (b <= t) {
          if (!item.background) hidden++;
          continue;
        }
        perDay.get(d)!.push({ item, top: t, bottom: Math.max(b, t + 15) });
        continue;
      }
      perDay.get(d)!.push({ item, top, bottom: Math.max(bottom, top + 15) });
      minHour = Math.min(minHour, Math.floor(top / 60));
      maxHour = Math.max(maxHour, Math.ceil(bottom / 60));
    }
  }
  const startMin = minHour * 60;
  const hours = maxHour - minHour;
  const y = (min: number) => (min - startMin) / 60; // in Stunden ab Beginn
  const nowParts = localParts(now, o.tz);
  const nowMin = nowParts.hour * 60 + nowParts.minute;

  const first = days[0];
  const last = days[days.length - 1];
  const fmtDay = (d: string) => `${Number(d.slice(8))}.${Number(d.slice(5, 7))}.`;
  const title = span === 1 ? `${DAY_LONG[isoWeekday(first) - 1]}, ${fmtDay(first)}${first.slice(0, 4)}` : `${fmtDay(first)} – ${fmtDay(last)}${last.slice(0, 4)}`;

  return html`<section class="week" aria-label="Wochenkalender ${title}">
    <div class="week-head">
      <div class="week-nav">
        <a class="btn btn-secondary btn-small" href="${o.hrefFor(addDays(o.weekStart, -span))}" aria-label="${span === 1 ? 'Vorheriger Tag' : 'Vorherige Woche'}">‹</a>
        <a class="btn btn-secondary btn-small" href="${o.hrefFor(span === 1 ? today : weekStartOf(today))}">Heute</a>
        <a class="btn btn-secondary btn-small" href="${o.hrefFor(addDays(o.weekStart, span))}" aria-label="${span === 1 ? 'Nächster Tag' : 'Nächste Woche'}">›</a>
      </div>
      <h2 class="week-title">${title}</h2>
      <span class="muted">${o.tz}</span>
      ${o.toolbar ?? ''}
    </div>
    ${o.legend ? html`<ul class="week-legend">${o.legend.map((l) => html`<li><span class="swatch ev-${l.kind}"></span>${l.label}</li>`)}</ul>` : ''}
    ${hidden
      ? html`<p class="hint week-hidden">${hidden === 1 ? 'Ein Eintrag liegt' : `${hidden} Einträge liegen`} außerhalb der angezeigten Zeit (${minHour}–${maxHour} Uhr).${o.hoursHref ? html` <a href="${o.hoursHref}">Anzeigezeit ändern</a>` : ''}</p>`
      : ''}
    <div class="week-scroll">
      <div class="week-grid ${span === 1 ? 'is-day' : ''}" style="--hours:${hours};--hour-min:${MIN_HOUR_PX}px;--days:${span}">
        <div class="week-corner"></div>
        ${days.map(
          (d) => html`<div class="week-dayhead ${d === today ? 'is-today' : ''}">${o.dayHref
            ? html`<a href="${o.dayHref(d)}"><span>${DAY_NAMES[isoWeekday(d) - 1]}</span> <strong>${fmtDay(d)}</strong></a>`
            : html`<span>${DAY_NAMES[isoWeekday(d) - 1]}</span> <strong>${fmtDay(d)}</strong>`}</div>`,
        )}
        <div class="week-axis" style="height:${at(hours)}">
          ${Array.from({ length: hours }, (_, i) => html`<span style="top:${at(i)}">${String(minHour + i).padStart(2, '0')}:00</span>`)}
        </div>
        ${days.map((d) => {
          const entries = perDay.get(d)!;
          const bg = entries.filter((e) => e.item.background);
          const fg = placeDay(entries.filter((e) => !e.item.background));
          const cells =
            o.cellHref && d >= today
              ? Array.from({ length: hours }, (_, i) => {
                  const hh = String(minHour + i).padStart(2, '0');
                  return html`<a class="week-cell" style="top:${at(i)};height:${at(1)}" href="${o.cellHref!(d, `${hh}:00`)}" aria-label="Slots am ${fmtDay(d)} ab ${hh}:00 anlegen" title="Hier Slots anlegen (${hh}:00)"></a>`;
                })
              : '';
          return html`<div class="week-day ${d === today ? 'is-today' : ''} ${d < today ? 'is-past' : ''}" style="height:${at(hours)}">
            ${cells}
            ${bg.map((e) => event(e.item, y(e.top), y(e.bottom) - y(e.top), 0, 1, o.tz, true))}
            ${fg.map((p) => event(p.item, y(p.top), y(p.bottom) - y(p.top), p.lane, p.lanes, o.tz, false))}
            ${d === today && nowMin >= startMin && nowMin <= maxHour * 60 ? html`<div class="week-now" style="top:${at(y(nowMin))}" aria-hidden="true"></div>` : ''}
          </div>`;
        })}
      </div>
    </div>
  </section>`;
}

function localToUtcSafe(date: string, tz: string) {
  // Mitternacht existiert in allen gängigen Zonen; zur Sicherheit 01:00 als Rückfall.
  try {
    return localToUtc(date, '00:00', tz);
  } catch {
    return localToUtc(date, '01:00', tz);
  }
}

/** `top` und `h` in Stunden; die Mindesthöhe in Pixeln entscheidet über die kompakte Darstellung. */
function event(item: WeekItem, top: number, hHours: number, lane: number, lanes: number, tz: string, background: boolean): H {
  const h = hHours * MIN_HOUR_PX;
  const sp = localParts(item.start, tz);
  const ep = localParts(item.end, tz);
  const t = `${String(sp.hour).padStart(2, '0')}:${String(sp.minute).padStart(2, '0')}–${String(ep.hour).padStart(2, '0')}:${String(ep.minute).padStart(2, '0')}`;
  const style = `top:${at(top)};height:max(${at(hHours)}, 20px);left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)`;
  const label = `${t} ${item.title}${item.detail ? `, ${item.detail}` : ''}`;
  const inner = html`<span class="ev-time">${t}</span><span class="ev-title">${item.title}</span>${item.detail && h > 40 ? html`<span class="ev-detail">${item.detail}</span>` : ''}`;
  const cls = `ev ev-${item.kind} ${background ? 'ev-bg' : ''} ${h < 34 ? 'ev-compact' : ''} ${item.mark ? `ev-${item.mark}` : ''}`;
  return item.href
    ? html`<a class="${cls}" style="${raw(style)}" href="${item.href}" title="${label}" aria-label="${label}">${inner}</a>`
    : html`<div class="${cls}" style="${raw(style)}" title="${label}">${inner}</div>`;
}
