import { html } from 'hono/html';
import { awaiting, type BookingTimes, type Party } from '../services/bookings.ts';
import { localDate, localTime } from '../time.ts';
import { when, type H } from './ui.ts';

/** Hinweis auf einen offenen Zeitvorschlag aus Sicht von `viewer`. */
export function proposalNote(b: BookingTimes, viewer: Party): H | '' {
  if (!b.proposed_by || !b.proposed_starts_at || !b.proposed_ends_at) return '';
  const mine = b.proposed_by === viewer;
  return html`<div class="proposal ${mine ? 'proposal-mine' : 'proposal-theirs'}">
    <strong>${mine ? 'Dein Vorschlag – wartet auf Zustimmung:' : 'Neuer Zeitvorschlag – bitte bestätigen:'}</strong>
    ${when(b.proposed_starts_at, b.proposed_ends_at, b.timezone)}
    ${b.proposal_note ? html`<p class="muted">Hinweis: ${b.proposal_note}</p>` : ''}
    ${b.status === 'confirmed' ? html`<p class="muted">Bis zur Zustimmung gilt die bisherige Zeit.</p>` : ''}
  </div>`;
}

export function awaitingLabel(b: Pick<BookingTimes, 'status' | 'proposed_by'>, viewer: Party): H | '' {
  const who = awaiting(b);
  if (!who) return '';
  return who === viewer
    ? html`<span class="badge badge-action">Wartet auf dich</span>`
    : html`<span class="badge badge-muted">Wartet auf ${viewer === 'provider' ? 'Buchende' : 'Anbieter'}</span>`;
}

/**
 * Formular "Andere Zeit vorschlagen" – Eingabe in der Zeitzone des Termins.
 * Für die Anbieterseite (`provider`) wird standardmäßig direkt verschoben; nur vorschlagen ist optional
 * (nicht bei Schüler:innen ohne App – die können nicht zustimmen).
 */
export function timeChangeForm(action: string, b: BookingTimes, label: string, provider?: { offline: boolean }): H {
  const s = Date.parse(b.starts_at);
  const minutes = Math.round((Date.parse(b.ends_at) - s) / 60000);
  return html`<details class="inline-form">
    <summary>${label}</summary>
    <form method="post" action="${action}" class="grid-form">
      <label>Datum <input type="date" name="date" required value="${localDate(s, b.timezone)}"></label>
      <label>Beginn <input type="time" name="time" required step="300" value="${localTime(s, b.timezone)}"></label>
      <label>Dauer (Min.) <input type="number" name="duration" min="5" max="1440" step="5" required value="${minutes}"></label>
      <label class="span-all">Hinweis (optional) <input type="text" name="note" maxlength="500"></label>
      ${provider
        ? provider.offline
          ? html`<input type="hidden" name="mode" value="direct"><p class="hint span-all">Zeitzone: ${b.timezone}. Die neue Zeit gilt sofort, der Termin bleibt bestätigt.</p>`
          : html`<fieldset class="span-all segmented-radio"><legend class="sr-only">Wie verschieben?</legend>
              <label class="check"><input type="radio" name="mode" value="direct" checked> Direkt verschieben – gilt sofort und bleibt bestätigt, Schüler:in wird informiert</label>
              <label class="check"><input type="radio" name="mode" value="propose"> Nur vorschlagen – Schüler:in muss zustimmen</label>
            </fieldset><p class="hint span-all">Zeitzone: ${b.timezone}.</p>`
        : html`<p class="hint span-all">Zeitzone: ${b.timezone}. Die andere Seite muss zustimmen, erst dann gilt die neue Zeit.</p>`}
      <button class="btn" type="submit">${provider ? 'Verschieben' : 'Vorschlag senden'}</button>
    </form>
  </details>`;
}
