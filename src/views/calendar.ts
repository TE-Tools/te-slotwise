import { html, raw } from 'hono/html';
import { addDays, isoWeekday } from '../time.ts';
import type { H } from './ui.ts';

export const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export function parseMonth(raw: string | undefined, fallbackDate: string): string {
  return raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : fallbackDate.slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Erster Tag des Monats und erster Tag des Folgemonats (YYYY-MM-DD). */
export function monthRange(month: string): [string, string] {
  return [`${month}-01`, `${shiftMonth(month, 1)}-01`];
}

/**
 * Monatskalender. `counts` ordnet einem Datum eine Zahl zu (z. B. freie Termine).
 * Auf schmalen Bildschirmen bleibt er lesbar, weil pro Tag nur Zahl und Markierung erscheinen.
 */
export function monthCalendar(o: {
  month: string;
  today: string;
  counts: Map<string, number>;
  countLabel: (n: number) => string;
  dayHref: (date: string) => string;
  monthHref: (month: string) => string;
  selected?: string | null;
}): H {
  const [first, next] = monthRange(o.month);
  const [y, m] = o.month.split('-').map(Number);
  const cells: (string | null)[] = [];
  for (let i = 1; i < isoWeekday(first); i++) cells.push(null);
  for (let d = first; d < next; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return html`<div class="calendar">
    <div class="calendar-head">
      <a class="btn btn-secondary btn-small" href="${o.monthHref(shiftMonth(o.month, -1))}" aria-label="Vorheriger Monat">‹</a>
      <h2 class="calendar-title">${MONTHS[m - 1]} ${y}</h2>
      <a class="btn btn-secondary btn-small" href="${o.monthHref(shiftMonth(o.month, 1))}" aria-label="Nächster Monat">›</a>
    </div>
    <table class="calendar-grid">
      <thead><tr>${WEEKDAYS.map((w) => html`<th scope="col">${w}</th>`)}</tr></thead>
      <tbody>
        ${weeks.map(
          (week) => html`<tr>${week.map((d) => {
            if (!d) return html`<td class="empty-cell"></td>`;
            const n = o.counts.get(d) ?? 0;
            const cls = [d === o.today ? 'today' : '', d < o.today ? 'past' : '', n ? 'has' : '', d === o.selected ? 'selected' : ''].join(' ');
            const label = `${Number(d.slice(8))}. ${MONTHS[m - 1]}${n ? `, ${o.countLabel(n)}` : ''}`;
            return html`<td class="${cls}">${n
              ? html`<a href="${o.dayHref(d)}" aria-label="${label}" ${d === o.selected ? raw('aria-current="date"') : ''}><span class="day">${Number(d.slice(8))}</span><span class="count">${n}</span></a>`
              : html`<span class="day" aria-label="${label}">${Number(d.slice(8))}</span>`}</td>`;
          })}</tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}
