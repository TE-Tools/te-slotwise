import { html, raw } from 'hono/html';
import { addDays, isoWeekday, localDate, localParts, localToUtc } from '../time.ts';
import type { H } from './ui.ts';

// Großer Wochenkalender mit Zeitachse. Reines HTML/CSS: Termine werden absolut in ihrer
// Tagesspalte positioniert, überlappende Einträge teilen sich die Breite.

export type WeekItemKind = 'free' | 'reluctant' | 'confirmed' | 'requested' | 'proposal' | 'mine' | 'draft' | 'closed' | 'blocked';

export interface WeekItem {
  start: number; // UTC-Millisekunden
  end: number;
  title: string;
  detail?: string;
  href?: string;
  kind: WeekItemKind;
  /** Hintergrund-Einträge (Zeitfenster) liegen unter den anderen und belegen keine eigene Spalte. */
  background?: boolean;
}

const DAY_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const HOUR_PX = 56;

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
}): H {
  const now = Date.now();
  const today = localDate(now, o.tz);
  const days = Array.from({ length: 7 }, (_, i) => addDays(o.weekStart, i));

  // Einträge auf Tage verteilen (über Mitternacht reichende Einträge werden aufgeteilt).
  const perDay = new Map<string, { item: WeekItem; top: number; bottom: number }[]>(days.map((d) => [d, []]));
  let minHour = 8;
  let maxHour = 19;
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
      perDay.get(d)!.push({ item, top, bottom: Math.max(bottom, top + 15) });
      minHour = Math.min(minHour, Math.floor(top / 60));
      maxHour = Math.max(maxHour, Math.ceil(bottom / 60));
    }
  }
  const startMin = minHour * 60;
  const height = (maxHour - minHour) * HOUR_PX;
  const y = (min: number) => ((min - startMin) / 60) * HOUR_PX;
  const nowParts = localParts(now, o.tz);
  const nowMin = nowParts.hour * 60 + nowParts.minute;

  const first = days[0];
  const last = days[6];
  const fmtDay = (d: string) => `${Number(d.slice(8))}.${Number(d.slice(5, 7))}.`;
  const title = `${fmtDay(first)} – ${fmtDay(last)}${last.slice(0, 4)}`;

  return html`<section class="week" aria-label="Wochenkalender ${title}">
    <div class="week-head">
      <div class="week-nav">
        <a class="btn btn-secondary btn-small" href="${o.hrefFor(addDays(o.weekStart, -7))}" aria-label="Vorherige Woche">‹</a>
        <a class="btn btn-secondary btn-small" href="${o.hrefFor(weekStartOf(today))}">Heute</a>
        <a class="btn btn-secondary btn-small" href="${o.hrefFor(addDays(o.weekStart, 7))}" aria-label="Nächste Woche">›</a>
      </div>
      <h2 class="week-title">${title}</h2>
      <span class="muted">${o.tz}</span>
    </div>
    ${o.legend ? html`<ul class="week-legend">${o.legend.map((l) => html`<li><span class="swatch ev-${l.kind}"></span>${l.label}</li>`)}</ul>` : ''}
    <div class="week-scroll">
      <div class="week-grid" style="--hours:${maxHour - minHour};--hour-px:${HOUR_PX}px">
        <div class="week-corner"></div>
        ${days.map(
          (d, i) => html`<div class="week-dayhead ${d === today ? 'is-today' : ''}">${o.dayHref
            ? html`<a href="${o.dayHref(d)}"><span>${DAY_NAMES[i]}</span> <strong>${fmtDay(d)}</strong></a>`
            : html`<span>${DAY_NAMES[i]}</span> <strong>${fmtDay(d)}</strong>`}</div>`,
        )}
        <div class="week-axis" style="height:${height}px">
          ${Array.from({ length: maxHour - minHour }, (_, i) => html`<span style="top:${i * HOUR_PX}px">${String(minHour + i).padStart(2, '0')}:00</span>`)}
        </div>
        ${days.map((d) => {
          const entries = perDay.get(d)!;
          const bg = entries.filter((e) => e.item.background);
          const fg = placeDay(entries.filter((e) => !e.item.background));
          return html`<div class="week-day ${d === today ? 'is-today' : ''} ${d < today ? 'is-past' : ''}" style="height:${height}px">
            ${bg.map((e) => event(e.item, y(e.top), y(e.bottom) - y(e.top), 0, 1, o.tz, true))}
            ${fg.map((p) => event(p.item, y(p.top), y(p.bottom) - y(p.top), p.lane, p.lanes, o.tz, false))}
            ${d === today && nowMin >= startMin && nowMin <= maxHour * 60 ? html`<div class="week-now" style="top:${y(nowMin)}px" aria-hidden="true"></div>` : ''}
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

function event(item: WeekItem, top: number, h: number, lane: number, lanes: number, tz: string, background: boolean): H {
  const sp = localParts(item.start, tz);
  const ep = localParts(item.end, tz);
  const t = `${String(sp.hour).padStart(2, '0')}:${String(sp.minute).padStart(2, '0')}–${String(ep.hour).padStart(2, '0')}:${String(ep.minute).padStart(2, '0')}`;
  const style = `top:${top}px;height:${Math.max(h, 18)}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)`;
  const label = `${t} ${item.title}${item.detail ? `, ${item.detail}` : ''}`;
  const inner = html`<span class="ev-time">${t}</span><span class="ev-title">${item.title}</span>${item.detail && h > 40 ? html`<span class="ev-detail">${item.detail}</span>` : ''}`;
  const cls = `ev ev-${item.kind} ${background ? 'ev-bg' : ''} ${h < 34 ? 'ev-compact' : ''}`;
  return item.href
    ? html`<a class="${cls}" style="${raw(style)}" href="${item.href}" title="${label}" aria-label="${label}">${inner}</a>`
    : html`<div class="${cls}" style="${raw(style)}" title="${label}">${inner}</div>`;
}
