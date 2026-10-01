import type { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { list, notFound, oneOf, readForm, requireWs, str, type AppEnv, type Ctx, type Form, type WsContext } from '../context.ts';
import { providerAddBooking } from '../services/bookings.ts';
import {
  ATTENDANCE_LABELS,
  centsCsv,
  dueCents,
  emptyTotals,
  formatHours,
  formatMoney,
  getStudent,
  listLessons,
  listStudents,
  markAttended,
  markPaid,
  moneyInput,
  monthsOfYear,
  parseMoney,
  parsePeriod,
  periodRangeIso,
  PRICE_UNIT_LABELS,
  saveBillingSettings,
  saveLessons,
  setStudentRate,
  shownPrice,
  toCsv,
  totalsBy,
  uncheckedCount,
  type Attendance,
  type LessonRow,
  type LessonUpdate,
  type Period,
  type PriceUnit,
  type StudentRow,
  type Totals,
} from '../services/billing.ts';
import { getOffering, listOfferings } from '../services/offerings.ts';
import { durationLabel, formatDate, formatTime, LocalTimeError, localDate, localToUtc } from '../time.ts';
import { MONTHS } from '../views/calendar.ts';
import { emptyState, errorBox, flash, options, pageHeader, type Frag, type H } from '../views/ui.ts';
import { back, render } from './common.ts';

// Schülerübersicht für Lehrkräfte: Wer war wie oft da, was kostet es, was ist bezahlt –
// pro Monat und pro Jahr, mit Abhaken nach dem Termin und CSV-Export.

const page = (c: Ctx, ws: WsContext, title: string, body: Frag | Frag[], status: 200 | 400 = 200) =>
  render(c, { title: `${title} – ${ws.name}`, ws, section: 'students', body, wide: true }, status);

const ATTENDANCE_VALUES = ['', 'attended', 'absent_billed', 'absent'] as const;
const studentName = (s: { display_name: string; email: string }) => s.display_name || s.email;

function periodFromQuery(c: Ctx, ws: WsContext): Period {
  return parsePeriod({ month: c.req.query('month'), year: c.req.query('year') }, localDate(Date.now(), ws.timezone));
}

/** Monat/Jahr umschalten und blättern. */
function periodNav(base: string, p: Period, extra?: H): H {
  const sep = base.includes('?') ? '&' : '?';
  const href = (q: string) => `${base}${sep}${q}`;
  const prevQ = p.kind === 'month' ? `month=${p.prev}` : `year=${p.prev}`;
  const nextQ = p.kind === 'month' ? `month=${p.next}` : `year=${p.next}`;
  const thisYear = p.key.slice(0, 4);
  return html`<div class="period-nav">
    <div class="week-nav">
      <a class="btn btn-secondary btn-small" href="${href(prevQ)}" aria-label="Zurück">‹</a>
      <h2 class="period-title">${p.label}</h2>
      <a class="btn btn-secondary btn-small" href="${href(nextQ)}" aria-label="Weiter">›</a>
    </div>
    <div class="segmented" role="group" aria-label="Zeitraum">
      <a href="${href(`month=${p.kind === 'month' ? p.key : `${thisYear}-01`}`)}" ${p.kind === 'month' ? raw('aria-current="true"') : ''}>Monat</a>
      <a href="${href(`year=${thisYear}`)}" ${p.kind === 'year' ? raw('aria-current="true"') : ''}>Jahr</a>
    </div>
    ${extra ?? ''}
  </div>`;
}

const money = (cents: number) => html`<span class="num">${formatMoney(cents)}</span>`;

function openCell(t: Totals): H {
  const open = t.dueCents - t.paidCents;
  if (open > 0) return html`<span class="num money-open">${formatMoney(open)}</span>`;
  if (open < 0) return html`<span class="num money-credit" title="Mehr bezahlt als berechnet">${formatMoney(-open)} Guthaben</span>`;
  return html`<span class="num muted">${formatMoney(0)}</span>`;
}

function statCards(t: Totals, uncheckedHref?: string): H {
  return html`<div class="stats">
    <div class="stat"><span class="stat-num">${t.attended}</span><span>stattgefunden (${formatHours(t.attendedMinutes)})</span></div>
    <div class="stat"><span class="stat-num">${formatMoney(t.dueCents)}</span><span>berechnet</span></div>
    <div class="stat"><span class="stat-num">${formatMoney(t.paidCents)}</span><span>bezahlt</span></div>
    <div class="stat ${t.dueCents - t.paidCents > 0 ? 'stat-action' : ''}"><span class="stat-num">${formatMoney(Math.max(0, t.dueCents - t.paidCents))}</span><span>offen</span></div>
    ${t.unchecked
      ? uncheckedHref
        ? html`<a class="stat stat-action" href="${uncheckedHref}"><span class="stat-num">${t.unchecked}</span><span>noch abzuhaken</span></a>`
        : html`<div class="stat stat-action"><span class="stat-num">${t.unchecked}</span><span>noch abzuhaken</span></div>`
      : ''}
  </div>`;
}

function paymentBadge(l: LessonRow): H | '' {
  const due = dueCents(l);
  if (!due && !l.paid_cents) return '';
  if (l.paid_cents > due) return html`<span class="badge badge-confirmed">bezahlt (+${formatMoney(l.paid_cents - due)})</span>`;
  if (l.paid_cents === due) return html`<span class="badge badge-confirmed">bezahlt</span>`;
  if (l.paid_cents > 0) return html`<span class="badge badge-requested">teilweise</span>`;
  return html`<span class="badge badge-declined">offen</span>`;
}

/**
 * Tabelle zum Abhaken: Anwesenheit, Preis und bezahlter Betrag pro Termin, alles in einem Formular.
 * `backPath` ist die Seite, auf die nach dem Speichern zurückgeleitet wird.
 */
function lessonForm(ws: WsContext, lessons: LessonRow[], backPath: string, showStudent: boolean): H {
  const now = Date.now();
  const hasPast = lessons.some((l) => l.attendance === null && Date.parse(l.ends_at) <= now && l.status === 'confirmed');
  const hasDue = lessons.some((l) => dueCents(l) > l.paid_cents);
  return html`<form method="post" action="/w/${ws.id}/lessons" class="lessons">
    <input type="hidden" name="back" value="${backPath}">
    <div class="table-wrap"><table class="lesson-table">
      <thead><tr>
        <th>Termin</th>${showStudent ? html`<th>Schüler:in</th>` : ''}<th>Angebot</th>
        <th>Abhaken</th><th>Preis (€)</th><th>Bezahlt (€)</th><th><span class="sr-only">Zahlstatus</span></th>
      </tr></thead>
      <tbody>${lessons.map((l) => {
        const start = Date.parse(l.starts_at);
        const past = Date.parse(l.ends_at) <= now;
        const price = shownPrice(l);
        const cls = [l.attendance === null && past && l.status === 'confirmed' ? 'row-todo' : '', l.status !== 'confirmed' ? 'row-cancelled' : ''].join(' ');
        return html`<tr id="l-${l.id}" class="${cls}">
          <td><input type="hidden" name="ids" value="${l.id}">
            <strong>${formatDate(start, l.timezone)}</strong><br><span class="muted">${formatTime(start, l.timezone)} Uhr · ${durationLabel(l.minutes)}</span>
            ${l.status !== 'confirmed' ? html`<br><span class="badge badge-cancelled">abgesagt</span>` : !past ? html`<br><span class="badge badge-muted">geplant</span>` : ''}</td>
          ${showStudent ? html`<td><a href="/w/${ws.id}/students/${l.user_id}?month=${localDate(start, ws.timezone).slice(0, 7)}">${l.student_name || l.student_email}</a></td>` : ''}
          <td>${l.offering_name}</td>
          <td><label class="sr-only" for="att-${l.id}">Anwesenheit</label>
            <select id="att-${l.id}" name="att_${l.id}" class="att-${l.attendance ?? 'none'}">
              <option value="">${past ? '– offen –' : '– geplant –'}</option>
              ${options((Object.keys(ATTENDANCE_LABELS) as Attendance[]).map((a) => ({ value: a, label: ATTENDANCE_LABELS[a] })), l.attendance)}
            </select></td>
          <td><label class="sr-only" for="price-${l.id}">Preis in Euro</label>
            <input id="price-${l.id}" name="price_${l.id}" class="money" inputmode="decimal" maxlength="12" value="${moneyInput(price)}" placeholder="${price === null ? 'kein Preis' : ''}"></td>
          <td><div class="paid-cell"><label class="sr-only" for="paid-${l.id}">Bezahlt in Euro</label>
            <input id="paid-${l.id}" name="paid_${l.id}" class="money" inputmode="decimal" maxlength="12" value="${l.paid_cents ? moneyInput(l.paid_cents) : ''}" placeholder="0,00">
            <button type="button" class="btn btn-small btn-secondary" data-fill-from="price-${l.id}" data-fill-to="paid-${l.id}" hidden title="Preis als bezahlt eintragen">voll</button></div></td>
          <td>${paymentBadge(l)}</td>
        </tr>`;
      })}</tbody>
    </table></div>
    <div class="actions lesson-actions">
      <button class="btn" type="submit">Speichern</button>
      ${hasPast ? html`<button class="btn btn-secondary" type="submit" name="bulk" value="attended">Alle offenen vergangenen als „stattgefunden“</button>` : ''}
      ${hasDue ? html`<button class="btn btn-secondary" type="submit" name="bulk" value="paid">Alle berechneten als bezahlt</button>` : ''}
    </div>
    <p class="hint">Preis: beim Abhaken wird der Preis am Termin festgeschrieben – spätere Preisänderungen ändern ihn nicht. „Gefehlt (wird berechnet)“ z. B. bei zu später Absage; „Ausgefallen“ wird nicht berechnet. Beträge wie 25 oder 25,50.</p>
  </form>`;
}

function studentTable(ws: WsContext, students: StudentRow[], totals: Map<string, Totals>, p: Period, defaultPrice: string): H {
  const sum = emptyTotals();
  for (const t of totals.values()) for (const k of Object.keys(sum) as (keyof Totals)[]) sum[k] += t[k];
  const rows = students.map((s) => ({ s, t: totals.get(s.user_id) ?? emptyTotals() }));
  return html`<div class="table-wrap"><table class="students-table">
    <thead><tr>
      <th>Schüler:in</th><th>Preis</th><th class="num">Termine</th><th class="num">Anwesend</th><th class="num">Gefehlt / Ausgefallen</th>
      <th class="num">Abzuhaken</th><th class="num">Berechnet</th><th class="num">Bezahlt</th><th class="num">Offen</th>
    </tr></thead>
    <tbody>${rows.map(
      ({ s, t }) => html`<tr class="${t.lessons ? '' : 'row-empty'}">
        <td><a href="/w/${ws.id}/students/${s.user_id}?${p.query}"><strong>${studentName(s)}</strong></a>${s.role ? '' : html` <span class="badge badge-muted">extern</span>`}</td>
        <td>${s.own_price_cents !== null ? html`<span class="num">${formatMoney(s.own_price_cents)}</span> <span class="badge badge-muted">individuell</span>` : html`<span class="muted">${defaultPrice}</span>`}</td>
        <td class="num">${t.lessons || '–'}${t.planned ? html` <span class="muted">(${t.planned} geplant)</span>` : ''}</td>
        <td class="num">${t.attended ? html`${t.attended} <span class="muted">· ${formatHours(t.attendedMinutes)}</span>` : '–'}</td>
        <td class="num">${t.absentBilled || t.absent ? `${t.absentBilled} / ${t.absent}` : '–'}</td>
        <td class="num">${t.unchecked ? html`<span class="badge badge-requested">${t.unchecked}</span>` : '–'}</td>
        <td class="num">${money(t.dueCents)}</td>
        <td class="num">${money(t.paidCents)}</td>
        <td class="num">${openCell(t)}</td>
      </tr>`,
    )}</tbody>
    <tfoot><tr>
      <th>Summe</th><th></th><th class="num">${sum.lessons}</th><th class="num">${sum.attended} · ${formatHours(sum.attendedMinutes)}</th>
      <th class="num">${sum.absentBilled} / ${sum.absent}</th><th class="num">${sum.unchecked || '–'}</th>
      <th class="num">${money(sum.dueCents)}</th><th class="num">${money(sum.paidCents)}</th><th class="num">${openCell(sum)}</th>
    </tr></tfoot>
  </table></div>`;
}

/** Jahresübersicht nach Monaten. */
function monthTable(ws: WsContext, year: string, lessons: LessonRow[], linkBase: string): H {
  const byMonth = totalsBy(lessons, (l) => localDate(Date.parse(l.starts_at), ws.timezone).slice(0, 7));
  const sum = emptyTotals();
  for (const t of byMonth.values()) for (const k of Object.keys(sum) as (keyof Totals)[]) sum[k] += t[k];
  return html`<div class="table-wrap"><table class="students-table">
    <thead><tr><th>Monat</th><th class="num">Termine</th><th class="num">Anwesend</th><th class="num">Abzuhaken</th><th class="num">Berechnet</th><th class="num">Bezahlt</th><th class="num">Offen</th></tr></thead>
    <tbody>${monthsOfYear(year).map((m) => {
      const t = byMonth.get(m) ?? emptyTotals();
      return html`<tr class="${t.lessons ? '' : 'row-empty'}">
        <td><a href="${linkBase}${linkBase.includes('?') ? '&' : '?'}month=${m}">${MONTHS[Number(m.slice(5)) - 1]}</a></td>
        <td class="num">${t.lessons || '–'}</td>
        <td class="num">${t.attended ? html`${t.attended} <span class="muted">· ${formatHours(t.attendedMinutes)}</span>` : '–'}</td>
        <td class="num">${t.unchecked || '–'}</td>
        <td class="num">${money(t.dueCents)}</td><td class="num">${money(t.paidCents)}</td><td class="num">${openCell(t)}</td>
      </tr>`;
    })}</tbody>
    <tfoot><tr><th>Jahr ${year}</th><th class="num">${sum.lessons}</th><th class="num">${sum.attended} · ${formatHours(sum.attendedMinutes)}</th><th class="num">${sum.unchecked || '–'}</th>
      <th class="num">${money(sum.dueCents)}</th><th class="num">${money(sum.paidCents)}</th><th class="num">${openCell(sum)}</th></tr></tfoot>
  </table></div>`;
}

const priceLabel = (ws: WsContext) =>
  ws.default_price_cents === null ? 'kein Standardpreis' : `${formatMoney(ws.default_price_cents)} ${ws.price_unit === 'hour' ? 'pro Std.' : 'pro Termin'}`;

/** Rücksprungziel nach dem Speichern – nur Schülerseiten dieses Arbeitsbereichs. */
function safeBack(ws: WsContext, raw: string) {
  const ok = raw.startsWith(`/w/${ws.id}/students`) && !raw.includes('//') && !raw.includes('\\') && raw.length < 300;
  return ok ? raw.replace(/[?&]msg=[^&#]*/g, '') : `/w/${ws.id}/students`;
}

function readLessonUpdates(f: Form, ids: string[]): LessonUpdate[] | null {
  const out: LessonUpdate[] = [];
  for (const id of ids) {
    if (!(`att_${id}` in f)) continue;
    const price = parseMoney(str(f, `price_${id}`, 20));
    const paid = parseMoney(str(f, `paid_${id}`, 20));
    if (price === undefined || paid === undefined) return null;
    const att = oneOf(str(f, `att_${id}`), ATTENDANCE_VALUES, '');
    out.push({ id, attendance: att || null, priceCents: price, paidCents: paid ?? 0 });
  }
  return out;
}

export function registerStudentRoutes(app: Hono<AppEnv>) {
  // ---------- Übersicht aller Schüler:innen ----------

  app.get('/w/:wid/students', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const { db } = c.get('deps');
    const p = periodFromQuery(c, ws);
    const [fromIso, toIso] = periodRangeIso(p, ws.timezone);
    const students = await listStudents(db, ws.id);
    const lessons = await listLessons(db, ws.id, { fromIso, toIso });
    const totals = totalsBy(lessons, (l) => l.user_id);
    const all = totalsBy(lessons, () => 'all').get('all') ?? emptyTotals();
    const unchecked = await uncheckedCount(db, ws.id);
    const offerings = await listOfferings(db, ws.id);
    return page(c, ws, 'Schüler', [
      flash(c.req.query('msg')),
      pageHeader(
        'Schüler & Abrechnung',
        'Wer war wie oft da, was wurde berechnet, was ist bezahlt. Nach jedem Termin abhaken – Preise legst du unten fest.',
        html`<a class="btn btn-secondary" href="/w/${ws.id}/members">Schüler:in einladen</a>`,
      ),
      unchecked
        ? html`<div class="flash flash-action" role="status">${unchecked === 1 ? 'Ein vergangener Termin ist' : `${unchecked} vergangene Termine sind`} noch nicht abgehakt. <a href="/w/${ws.id}/students/check">Jetzt abhaken</a></div>`
        : '',
      ws.default_price_cents === null && !students.some((s) => s.own_price_cents !== null)
        ? html`<div class="flash flash-info">Noch kein Preis festgelegt. Trage unten einen Standardpreis ein – individuelle Preise setzt du auf der Seite der jeweiligen Person.</div>`
        : '',
      html`<section class="card">
        ${periodNav(`/w/${ws.id}/students`, p, html`<a class="btn btn-secondary btn-small" href="/w/${ws.id}/students/export.csv?${p.query}" download>Als CSV herunterladen</a>`)}
        ${statCards(all)}
        ${students.length
          ? studentTable(ws, students, totals, p, priceLabel(ws))
          : emptyState('Noch keine Schüler:innen', 'Hier erscheinen alle Mitglieder deines Arbeitsbereichs und alle, die bei dir einen festen Termin gebucht haben.', html`<a class="btn" href="/w/${ws.id}/members">Schüler:in einladen</a>`)}
      </section>`,
      p.kind === 'year' ? html`<section class="card"><h2>Nach Monaten</h2>${monthTable(ws, p.key, lessons, `/w/${ws.id}/students`)}</section>` : '',
      html`<section class="card" id="preise"><h2>Standardpreis</h2>
        <form method="post" action="/w/${ws.id}/students/settings" class="grid-form">
          <label>Preis (€) <input name="default_price" class="money" inputmode="decimal" maxlength="12" value="${moneyInput(ws.default_price_cents)}" placeholder="z. B. 30,00"></label>
          <label>Gilt <select name="price_unit">${options((Object.keys(PRICE_UNIT_LABELS) as PriceUnit[]).map((u) => ({ value: u, label: PRICE_UNIT_LABELS[u] })), ws.price_unit)}</select></label>
          <p class="hint span-all">Gilt für alle ohne individuellen Preis. Bei „pro 60 Minuten“ kostet ein 45-Minuten-Termin drei Viertel des Preises. Bereits abgehakte Termine behalten ihren Preis.${offerings.length > 1 ? ' Der Preis gilt für alle Angebote; abweichende Preise kannst du pro Termin eintragen.' : ''}</p>
          <button class="btn" type="submit">Speichern</button>
        </form></section>`,
    ]);
  });

  app.post('/w/:wid/students/settings', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const f = await readForm(c);
    const cents = parseMoney(str(f, 'default_price', 20));
    if (cents === undefined) return back(c, `/w/${ws.id}/students`, 'money_invalid');
    await saveBillingSettings(c.get('deps').db, ws.id, cents, oneOf(str(f, 'price_unit'), ['lesson', 'hour'] as const, 'lesson'));
    return back(c, `/w/${ws.id}/students`, 'saved');
  });

  // ---------- Abhaken: alle vergangenen, offenen Termine ----------

  app.get('/w/:wid/students/check', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const lessons = await listLessons(c.get('deps').db, ws.id, { uncheckedBeforeIso: new Date().toISOString() });
    return page(c, ws, 'Abhaken', [
      flash(c.req.query('msg')),
      pageHeader('Termine abhaken', 'Alle vergangenen festen Termine, die noch nicht abgehakt sind. Hat die Stunde stattgefunden? Wurde bezahlt?', html`<a class="btn btn-secondary" href="/w/${ws.id}/students">Zur Übersicht</a>`),
      lessons.length
        ? html`<section class="card">${lessonForm(ws, lessons.slice(-300), `/w/${ws.id}/students/check`, true)}</section>`
        : emptyState('Alles abgehakt', 'Es gibt keine vergangenen Termine, die noch abgehakt werden müssen.', html`<a class="btn" href="/w/${ws.id}/students">Zur Übersicht</a>`),
    ]);
  });

  // ---------- CSV-Export ----------

  app.get('/w/:wid/students/export.csv', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const p = periodFromQuery(c, ws);
    const [fromIso, toIso] = periodRangeIso(p, ws.timezone);
    const userId = c.req.query('user') || undefined;
    const lessons = await listLessons(c.get('deps').db, ws.id, { fromIso, toIso, userId });
    const rows: (string | number)[][] = [
      ['Datum', 'Beginn', 'Ende', 'Dauer (Min.)', 'Schüler:in', 'E-Mail', 'Angebot', 'Termin', 'Anwesenheit', 'Preis (EUR)', 'Berechnet (EUR)', 'Bezahlt (EUR)', 'Bezahlt am'],
    ];
    for (const l of lessons) {
      const s = Date.parse(l.starts_at);
      rows.push([
        localDate(s, ws.timezone),
        formatTime(s, ws.timezone),
        formatTime(Date.parse(l.ends_at), ws.timezone),
        l.minutes,
        l.student_name,
        l.student_email,
        l.offering_name,
        l.status === 'confirmed' ? (Date.parse(l.ends_at) > Date.now() ? 'geplant' : 'fest') : 'abgesagt',
        l.attendance ? ATTENDANCE_LABELS[l.attendance] : 'nicht abgehakt',
        centsCsv(shownPrice(l)),
        centsCsv(dueCents(l)),
        centsCsv(l.paid_cents),
        l.paid_at ? localDate(Date.parse(l.paid_at), ws.timezone) : '',
      ]);
    }
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="abrechnung-${p.key}.csv"`);
    c.header('Cache-Control', 'no-store');
    return c.body(toCsv(rows));
  });

  // ---------- Einzelne Person ----------

  app.get('/w/:wid/students/:uid', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const { db } = c.get('deps');
    const s = await getStudent(db, ws.id, c.req.param('uid'));
    if (!s) notFound();
    const p = periodFromQuery(c, ws);
    const [fromIso, toIso] = periodRangeIso(p, ws.timezone);
    const lessons = await listLessons(db, ws.id, { fromIso, toIso, userId: s.user_id });
    const t = totalsBy(lessons, () => 'x').get('x') ?? emptyTotals();
    const offerings = await listOfferings(db, ws.id);
    const base = `/w/${ws.id}/students/${s.user_id}`;
    const today = localDate(Date.now(), ws.timezone);
    const defaultDate = p.kind === 'month' && !today.startsWith(p.key) ? `${p.key}-01` : today;
    return page(c, ws, studentName(s), [
      flash(c.req.query('msg')),
      errorBox(c.req.query('err') === 'time' ? 'Ungültige Zeit: Bitte Datum, Uhrzeit und Dauer prüfen.' : null),
      pageHeader(studentName(s), s.email, html`<a class="btn btn-secondary" href="/w/${ws.id}/students?${p.query}">Alle Schüler:innen</a>
        <a class="btn btn-secondary" href="/w/${ws.id}/bookings?person=${s.user_id}&status=confirmed">Buchungen</a>`),
      html`<section class="card">
        ${periodNav(base, p, html`<a class="btn btn-secondary btn-small" href="/w/${ws.id}/students/export.csv?${p.query}&user=${s.user_id}" download>CSV</a>`)}
        ${statCards(t)}
        ${lessons.length
          ? lessonForm(ws, lessons, `${base}?${p.query}`, false)
          : emptyState('Keine Termine in diesem Zeitraum', 'Feste Termine erscheinen hier automatisch. Du kannst unten auch selbst einen Termin eintragen.')}
      </section>`,
      p.kind === 'year' ? html`<section class="card"><h2>Nach Monaten</h2>${monthTable(ws, p.key, lessons, base)}</section>` : '',
      html`<div class="two-col">
        <section class="card"><h2>Preis</h2>
          <form method="post" action="${base}/rate" class="stack">
            <div class="field"><label for="own_price">Individueller Preis (€, ${ws.price_unit === 'hour' ? 'pro 60 Minuten' : 'pro Termin'})</label>
              <input id="own_price" name="price" class="money" inputmode="decimal" maxlength="12" value="${moneyInput(s.own_price_cents)}" placeholder="${ws.default_price_cents === null ? '' : moneyInput(ws.default_price_cents)}">
              <span class="hint">Leer lassen = Standardpreis (${priceLabel(ws)}). Gilt für noch nicht abgehakte Termine.</span></div>
            <button class="btn" type="submit">Preis speichern</button>
          </form></section>
        <section class="card"><h2>Termin eintragen</h2>
          ${offerings.length
            ? html`<form method="post" action="${base}/lessons" class="stack">
                <div class="grid-form">
                  <label class="span-all">Angebot <select name="offering_id">${options(offerings.map((o) => ({ value: o.id, label: `${o.name} (${durationLabel(o.duration_min)})` })), offerings[0].id)}</select></label>
                  <label>Datum <input type="date" name="date" required value="${defaultDate}"></label>
                  <label>Uhrzeit <input type="time" name="time" required step="300" value="16:00"></label>
                  <label>Dauer (Min., leer = wie Angebot) <input type="number" name="duration" min="5" max="1440" step="5"></label>
                </div>
                <label class="check"><input type="checkbox" name="attended" value="1"> Hat schon stattgefunden – gleich als „stattgefunden“ abhaken</label>
                <p class="hint">Für Stunden, die außerhalb der App vereinbart wurden, oder um ${studentName(s)} direkt einzuplanen. Der Termin ist sofort fest${s.email ? '; bei künftigen Terminen gibt es eine Bestätigung per E-Mail' : ''}.</p>
                <button class="btn" type="submit">Termin eintragen</button>
              </form>`
            : html`<p class="muted">Lege zuerst ein <a href="/w/${ws.id}/offerings/new">Angebot</a> an.</p>`}
        </section>
      </div>`,
    ]);
  });

  app.post('/w/:wid/students/:uid/rate', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const { db } = c.get('deps');
    const s = await getStudent(db, ws.id, c.req.param('uid'));
    if (!s) notFound();
    const f = await readForm(c);
    const cents = parseMoney(str(f, 'price', 20));
    if (cents === undefined) return back(c, `/w/${ws.id}/students/${s.user_id}`, 'money_invalid');
    await setStudentRate(db, ws.id, s.user_id, cents);
    return back(c, `/w/${ws.id}/students/${s.user_id}`, 'saved');
  });

  app.post('/w/:wid/students/:uid/lessons', async (c) => {
    const { user, ws } = await requireWs(c, 'billing.manage');
    const { db, config, kick } = c.get('deps');
    const s = await getStudent(db, ws.id, c.req.param('uid'));
    if (!s) notFound();
    const f = await readForm(c);
    const off = await getOffering(db, ws.id, str(f, 'offering_id', 50));
    if (!off || off.archived_at) notFound();
    const date = str(f, 'date', 10);
    const base = `/w/${ws.id}/students/${s.user_id}?month=${/^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : ''}`;
    const duration = Number.parseInt(str(f, 'duration', 5), 10) || off.duration_min;
    let startMs: number;
    try {
      if (duration < 5 || duration > 1440) throw new LocalTimeError('Dauer');
      startMs = localToUtc(date, str(f, 'time', 5), ws.timezone);
    } catch (e) {
      if (e instanceof LocalTimeError) return c.redirect(`${base}&err=time`, 303);
      throw e;
    }
    const r = await providerAddBooking(db, config.appUrl, { workspaceId: ws.id, offering: off, userId: s.user_id, actorId: user.id, tz: ws.timezone, startMs, durationMin: duration, note: '' });
    kick();
    if (!r.ok) return back(c, base, r.code === 'full' ? 'lesson_full' : 'book_already');
    if (f.attended && startMs + duration * 60_000 <= Date.now()) await markAttended(db, ws.id, [r.bookingId]);
    return back(c, base, 'lesson_added');
  });

  // ---------- Speichern (Abhaken, Preise, Zahlungen) ----------

  app.post('/w/:wid/lessons', async (c) => {
    const { ws } = await requireWs(c, 'billing.manage');
    const { db } = c.get('deps');
    const f = await readForm(c);
    const backPath = safeBack(ws, str(f, 'back', 300));
    const ids = list(f, 'ids').slice(0, 500);
    const updates = readLessonUpdates(f, ids);
    if (!updates) return back(c, backPath, 'money_invalid');
    await saveLessons(db, ws.id, updates);
    const bulk = str(f, 'bulk');
    if (bulk === 'attended') await markAttended(db, ws.id, ids);
    if (bulk === 'paid') await markPaid(db, ws.id, ids);
    return back(c, backPath, 'lessons_saved');
  });
}

