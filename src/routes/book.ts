import type { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { OFFERING_VISIBLE_SQL } from '../authz.ts';
import { notFound, readForm, requireUser, requireWs, str, type AppEnv, type Ctx } from '../context.ts';
import { requestBooking } from '../services/bookings.ts';
import { busyTimes, listVisibleSlots, occupiedTimes, type VisibleSlotRow } from '../services/slots.ts';
import { getWorkspaceByPublicToken, myGroups, type BookedDisplay, type Workspace } from '../services/workspaces.ts';
import { parseWeek, weekCalendar, weekRange, type WeekItem } from '../views/week.ts';
import { durationLabel, formatDate, formatTime, localDate, localTime, zoneLabel } from '../time.ts';
import { monthCalendar, monthRange, parseMonth } from '../views/calendar.ts';
import { emptyState, flash, pageHeader, shareBox, type H } from '../views/ui.ts';
import { back, render } from './common.ts';

interface ViewCtx {
  ws: Workspace;
  /** Anzeige belegter Termine laut Einstellung (öffentlich bzw. für Mitglieder). */
  bookedDisplay: BookedDisplay;
  base: string; // z. B. /w/:id/book oder /p/:token
  bookAction: (slotId: string) => string;
  /** Seite zum Buchen eines einzelnen Slots (Klick im Wochenkalender). */
  slotPage: (slotId: string) => string;
  loggedIn: boolean;
  loginHref: string;
}

/** Freie Startzeiten in einem Zeitfenster (15-Minuten-Raster, ohne Überschneidung mit festen Buchungen, nicht in der Vergangenheit). */
export function freeStarts(s: Pick<VisibleSlotRow, 'starts_at' | 'ends_at' | 'timezone' | 'duration_min'>, busy: { starts_at: string; ends_at: string }[], now = Date.now()) {
  const start = Date.parse(s.starts_at);
  const end = Date.parse(s.ends_at);
  const dur = s.duration_min * 60_000;
  const out: { time: string; until: string }[] = [];
  for (let t = start; t + dur <= end; t += 15 * 60_000) {
    if (t <= now) continue;
    if (busy.some((b) => Date.parse(b.starts_at) < t + dur && Date.parse(b.ends_at) > t)) continue;
    out.push({ time: localTime(t, s.timezone), until: localTime(t + dur, s.timezone) });
  }
  return out;
}

function slotItem(s: VisibleSlotRow, v: ViewCtx, busy: { starts_at: string; ends_at: string }[]): H {
  const start = Date.parse(s.starts_at);
  const end = Date.parse(s.ends_at);
  const tz = s.timezone;
  const verb = s.mode === 'auto' ? 'Buchen' : 'Anfragen';
  const mine = s.my_status
    ? html`<p class="flash flash-ok">${s.my_status === 'confirmed' ? 'Von dir gebucht.' : 'Von dir angefragt.'} <a href="/bookings">Zu meinen Terminen</a></p>`
    : '';
  const note = html`<details class="note-field"><summary>Nachricht hinzufügen (optional)</summary><label class="sr-only" for="note-${s.id}">Nachricht</label><textarea id="note-${s.id}" name="note" maxlength="1000" rows="2"></textarea></details>`;

  let action: H | '' = '';
  if (!s.my_status) {
    if (!v.loggedIn) action = html`<a class="btn" href="${v.loginHref}">Anmelden, um zu ${s.mode === 'auto' ? 'buchen' : 'anfragen'}</a>`;
    else if (s.kind === 'window') {
      // Freie Startzeiten im Viertelstunden-Raster; schon fest vergebene Zeiten fallen weg.
      const free = freeStarts(s, busy);
      action = free.length
        ? html`<form method="post" action="${v.bookAction(s.id)}" class="stack">
            <div class="field"><label for="t-${s.id}">Deine Startzeit (${durationLabel(s.duration_min)})</label>
              <select id="t-${s.id}" name="time" required>${free.map((t) => html`<option value="${t.time}">${t.time} – ${t.until} Uhr</option>`)}</select>
              <span class="hint">Freie Zeiten zwischen ${localTime(start, tz)} und ${localTime(end, tz)} Uhr.</span></div>
            ${note}
            <button class="btn" type="submit">${verb}</button>
          </form>`
        : html`<p class="muted">In diesem Zeitfenster ist keine Zeit mehr frei.</p>`;
    } else {
      action = html`<form method="post" action="${v.bookAction(s.id)}" class="stack">${note}<button class="btn" type="submit">${verb}</button></form>`;
    }
  }

  return html`<li class="slot card ${s.preference === 'reluctant' ? 'slot-reluctant' : ''}" id="s-${s.id}">
    <div class="slot-time">
      <span class="slot-clock">${formatTime(start, tz)}–${formatTime(end, tz)}</span>
      <span class="muted">${zoneLabel(start, tz)}</span>
    </div>
    <div class="slot-body">
      ${s.preference === 'reluctant' ? html`<p><span class="badge badge-reluctant">Nur auf Anfrage – eher ungern</span></p>` : ''}
      <p><strong>${s.offering_name}</strong> ${s.kind === 'window' ? html`<span class="badge badge-window">Freies Zeitfenster</span>` : html`<span class="muted">· ${durationLabel(Math.round((end - start) / 60000))}</span>`}</p>
      ${s.location ? html`<p class="muted">Ort: ${s.location}</p>` : ''}
      ${s.capacity > 1 && s.kind === 'fixed' ? html`<p class="muted">Noch ${Math.max(0, s.capacity - s.taken)} von ${s.capacity} Plätzen frei</p>` : ''}
      ${s.kind === 'window' && busy.length
        ? html`<p class="muted">Bereits vergeben: ${busy.map((b, i) => html`${i ? ', ' : ''}${formatTime(Date.parse(b.starts_at), tz)}–${formatTime(Date.parse(b.ends_at), tz)}`)}</p>`
        : ''}
      <p class="hint">${s.mode === 'auto' ? 'Wird sofort bestätigt, wenn die Zeit frei ist.' : 'Wird nach Prüfung durch die Anbieterseite bestätigt.'}</p>
      ${mine}${action}
    </div>
  </li>`;
}

/** Gemeinsame Ansicht für Mitglieder und öffentliche Besucher. Liefert nur erlaubte Slots. */
async function slotsView(c: Ctx, v: ViewCtx, membershipId: string | null, userId: string | null, offeringId?: string) {
  const { db } = c.get('deps');
  const tz = v.ws.timezone;
  const now = Date.now();
  const today = localDate(now, tz);
  const rawView = c.req.query('view');
  const view = rawView === 'calendar' ? 'calendar' : rawView === 'list' ? 'list' : 'week';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('day') ?? '') ? c.req.query('day')! : null;
  const month = parseMonth(c.req.query('month'), day ?? today);

  const all = await listVisibleSlots(db, v.ws.id, membershipId, userId, { offeringId }, now);
  const busy = await busyTimes(db, v.ws.id, all.filter((s) => s.kind === 'window').map((s) => s.id));
  const q = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(view !== 'week' ? { view } : {}), ...extra });
    return `${c.req.path}?${p}`;
  };

  const toggle = html`<div class="segmented" role="group" aria-label="Ansicht">
    <a href="${c.req.path}" ${view === 'week' ? raw('aria-current="true"') : ''}>Woche</a>
    <a href="${c.req.path}?view=list" ${view === 'list' ? raw('aria-current="true"') : ''}>Liste</a>
    <a href="${c.req.path}?view=calendar" ${view === 'calendar' ? raw('aria-current="true"') : ''}>Monat</a>
  </div>`;

  let shown = day ? all.filter((s) => localDate(Date.parse(s.starts_at), s.timezone) === day) : all;
  let calendar: H | '' = '';
  if (view === 'week') {
    const weekStart = parseWeek(c.req.query('week'), day ?? today);
    const [fromIso, toIso] = weekRange(weekStart, tz);
    const items: WeekItem[] = [];
    for (const sl of all) {
      if (sl.my_status === 'confirmed') continue; // erscheint unten als eigener fester Termin
      const d = localDate(Date.parse(sl.starts_at), sl.timezone);
      items.push({
        start: Date.parse(sl.starts_at),
        end: Date.parse(sl.ends_at),
        title: sl.my_status ? 'Deine Anfrage' : sl.offering_name,
        detail: sl.kind === 'window' ? 'Zeit selbst wählen' : sl.preference === 'reluctant' ? 'eher ungern, nur Anfrage' : sl.mode === 'auto' ? 'sofort buchbar' : 'auf Anfrage',
        href: !sl.my_status ? v.slotPage(sl.id) : '/bookings',
        kind: sl.my_status ? 'mine' : sl.preference === 'reluctant' ? 'reluctant' : 'free',
        background: sl.kind === 'window' && !sl.my_status,
      });
    }
    if (v.bookedDisplay !== 'hidden' || userId) {
      for (const o of await occupiedTimes(db, v.ws.id, membershipId, userId, fromIso, toIso)) {
        if (!o.mine && v.bookedDisplay === 'hidden') continue;
        items.push({
          start: Date.parse(o.starts_at),
          end: Date.parse(o.ends_at),
          title: o.mine ? 'Dein Termin' : v.bookedDisplay === 'names' && o.first_name ? o.first_name : 'Belegt',
          href: o.mine ? '/bookings' : undefined,
          kind: o.mine ? 'mine' : 'confirmed',
        });
      }
    }
    calendar = weekCalendar({
      weekStart,
      tz,
      items,
      hrefFor: (w) => q({ week: w }),
      legend: [
        { kind: 'free', label: 'Frei' },
        { kind: 'reluctant', label: 'Nur auf Anfrage (eher ungern)' },
        ...(v.bookedDisplay !== 'hidden' ? [{ kind: 'confirmed' as const, label: 'Belegt' }] : []),
        ...(userId ? [{ kind: 'mine' as const, label: 'Deine Termine' }] : []),
        { kind: 'blocked', label: 'Nicht verfügbar' },
      ],
    });
    shown = day ? shown : [];
  } else if (view === 'calendar') {
    const [mFrom, mTo] = monthRange(month);
    const counts = new Map<string, number>();
    for (const s of all) {
      const d = localDate(Date.parse(s.starts_at), s.timezone);
      if (d >= mFrom && d < mTo) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    calendar = monthCalendar({
      month,
      today,
      counts,
      countLabel: (n) => (n === 1 ? '1 freier Termin' : `${n} freie Termine`),
      dayHref: (d) => q({ month, day: d }),
      monthHref: (m) => q({ month: m }),
      selected: day,
    });
    shown = day ? all.filter((s) => localDate(Date.parse(s.starts_at), s.timezone) === day) : [];
  }

  const byDay = new Map<string, VisibleSlotRow[]>();
  for (const s of shown) {
    const d = localDate(Date.parse(s.starts_at), s.timezone);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }

  const list = byDay.size
    ? html`${[...byDay].map(
        ([, items]) => html`<section class="day-group"><h3>${formatDate(Date.parse(items[0].starts_at), items[0].timezone, true)}</h3>
          <ul class="slots">${items.map((s) => slotItem(s, v, busy.get(s.id) ?? []))}</ul></section>`,
      )}`
    : view !== 'list' && !day
      ? html`<p class="muted">${view === 'week' ? 'Auf einen grünen oder gelben Termin tippen, um ihn zu buchen.' : 'Wähle einen markierten Tag, um die freien Termine zu sehen.'}</p>`
      : emptyState('Gerade keine freien Termine', 'Sobald neue Termine freigegeben werden, erscheinen sie hier.');

  return html`<div class="toolbar">${toggle}<p class="muted">Alle Zeiten in ${tz}.</p></div>${calendar}${list}`;
}

function bookResultMsg(r: Awaited<ReturnType<typeof requestBooking>>) {
  if (r.ok) return r.status === 'confirmed' ? 'booked_confirmed' : 'booked_requested';
  return { not_found: 'book_not_found', too_late: 'book_too_late', full: 'book_full', already_booked: 'book_already', bad_time: 'bad_time' }[r.code];
}

export function registerBookRoutes(app: Hono<AppEnv>) {
  // ---------- Mitglieder ----------

  app.get('/w/:wid/book', async (c) => {
    const { user, ws } = await requireWs(c, 'book');
    const { db } = c.get('deps');
    const groups = await myGroups(db, ws.id, ws.membership_id);
    const offerings = await db.all<{ id: string; name: string; description: string }>(
      `SELECT o.id, o.name, o.description FROM offerings o WHERE o.workspace_id = @ws AND o.archived_at IS NULL AND ${OFFERING_VISIBLE_SQL} ORDER BY o.name`,
      { ws: ws.id, mid: ws.membership_id },
    );
    return render(c, {
      title: `Termine – ${ws.name}`,
      ws,
      section: 'book',
      body: [
        flash(c.req.query('msg')),
        pageHeader('Termine buchen', ws.description || undefined),
        groups.length ? html`<p class="muted">Deine Gruppen: ${groups.map((g, i) => html`${i ? ', ' : ''}${g.name}`)}</p>` : '',
        offerings.length
          ? html`<p class="muted">Angebote für dich: ${offerings.map((o, i) => html`${i ? ' · ' : ''}<a href="/w/${ws.id}/o/${o.id}">${o.name}</a>`)}</p>`
          : '',
        slotsView(
          c,
          { ws, bookedDisplay: ws.show_booked_members, base: `/w/${ws.id}/book`, bookAction: (id) => `/w/${ws.id}/slots/${id}/book`, slotPage: (id) => `/w/${ws.id}/slots/${id}/book`, loggedIn: true, loginHref: '/login' },
          ws.membership_id,
          user.id,
        ),
      ],
    });
  });

  // Geschützter Angebotslink: nur mit Anmeldung und passender Berechtigung.
  app.get('/w/:wid/o/:oid', async (c) => {
    const { user, ws } = await requireWs(c, 'book');
    const { db, config } = c.get('deps');
    const offering = await db.get<{ id: string; name: string; description: string; location: string; duration_min: number }>(
      `SELECT o.id, o.name, o.description, o.location, o.duration_min FROM offerings o
       WHERE o.id = @oid AND o.workspace_id = @ws AND o.archived_at IS NULL AND ${OFFERING_VISIBLE_SQL}`,
      { oid: c.req.param('oid'), ws: ws.id, mid: ws.membership_id },
    );
    if (!offering) notFound();
    return render(c, {
      title: offering.name,
      ws,
      section: 'book',
      body: [
        flash(c.req.query('msg')),
        pageHeader(offering.name, offering.description || undefined),
        offering.location ? html`<p class="muted">Ort: ${offering.location}</p>` : '',
        slotsView(
          c,
          { ws, bookedDisplay: ws.show_booked_members, base: c.req.path, bookAction: (id) => `/w/${ws.id}/slots/${id}/book?back=${encodeURIComponent(c.req.path)}`, slotPage: (id) => `/w/${ws.id}/slots/${id}/book`, loggedIn: true, loginHref: '/login' },
          ws.membership_id,
          user.id,
          offering.id,
        ),
        html`<details class="card"><summary>Diesen Link teilen</summary>${shareBox(`${config.appUrl}/w/${ws.id}/o/${offering.id}`, offering.name, 'Nur berechtigte Personen sehen nach der Anmeldung die Termine.')}</details>`,
      ],
    });
  });

  /** Ein einzelner Termin zum Buchen – Ziel beim Klick im Wochenkalender. */
  const slotPageBody = async (c: Ctx, v: ViewCtx, membershipId: string | null, userId: string | null, backHref: string) => {
    const { db } = c.get('deps');
    const slot = (await listVisibleSlots(db, v.ws.id, membershipId, userId)).find((x) => x.id === c.req.param('sid'));
    if (!slot) {
      return [
        flash(c.req.query('msg')),
        emptyState('Dieser Termin ist nicht mehr frei', 'Er wurde inzwischen gebucht oder zurückgezogen.', html`<a class="btn" href="${backHref}">Andere Termine ansehen</a>`),
      ];
    }
    return [
      flash(c.req.query('msg')),
      pageHeader(slot.mode === 'auto' ? 'Termin buchen' : 'Termin anfragen', `${formatDate(Date.parse(slot.starts_at), slot.timezone, true)} · ${v.ws.name}`),
      html`<ul class="slots">${slotItem(slot, v, slot.kind === 'window' ? ((await busyTimes(db, v.ws.id, [slot.id])).get(slot.id) ?? []) : [])}</ul><p><a href="${backHref}">← Zurück zum Kalender</a></p>`,
    ];
  };

  app.get('/w/:wid/slots/:sid/book', async (c) => {
    const { user, ws } = await requireWs(c, 'book');
    const v: ViewCtx = { ws, bookedDisplay: ws.show_booked_members, base: `/w/${ws.id}/book`, bookAction: (id) => `/w/${ws.id}/slots/${id}/book`, slotPage: (id) => `/w/${ws.id}/slots/${id}/book`, loggedIn: true, loginHref: '/login' };
    return render(c, { title: 'Termin buchen', ws, section: 'book', body: await slotPageBody(c, v, ws.membership_id, user.id, `/w/${ws.id}/book`) });
  });

  app.post('/w/:wid/slots/:sid/book', async (c) => {
    const { user, ws } = await requireWs(c, 'book');
    const { db, config, limiter, kick } = c.get('deps');
    const backTo = c.req.query('back')?.startsWith(`/w/${ws.id}/`) ? c.req.query('back')! : `/w/${ws.id}/book`;
    if (!limiter.take(`book:${user.id}`, 20, 10 * 60_000)) return back(c, backTo, 'book_rate');
    const f = await readForm(c);
    const r = await requestBooking(db, config.appUrl, {
      workspaceId: ws.id,
      slotId: c.req.param('sid'),
      userId: user.id,
      membershipId: ws.membership_id,
      note: str(f, 'note', 1000),
      time: str(f, 'time', 5) || undefined,
    });
    kick();
    return back(c, r.ok ? '/bookings' : backTo, bookResultMsg(r));
  });

  // ---------- Öffentlich ----------

  const publicWs = async (c: Ctx) => {
    const ws = await getWorkspaceByPublicToken(c.get('deps').db, c.req.param('token') ?? '');
    if (!ws) notFound();
    return ws;
  };

  app.get('/p/:token', async (c) => {
    const ws = await publicWs(c);
    const user = c.get('user');
    const { config } = c.get('deps');
    const path = c.req.path;
    // Auch angemeldete Mitglieder sehen hier nur öffentliche Slots (membershipId = null).
    return render(c, {
      title: ws.name,
      body: [
        flash(c.req.query('msg')),
        pageHeader(ws.name, ws.description || 'Freie Termine'),
        slotsView(
          c,
          { ws, bookedDisplay: ws.show_booked_public, base: path, bookAction: (id) => `${path}/slots/${id}/book`, slotPage: (id) => `${path}/slots/${id}/book`, loggedIn: !!user, loginHref: `/login?next=${encodeURIComponent(path)}` },
          null,
          user?.id ?? null,
        ),
        html`<details class="card"><summary>Seite teilen</summary>${shareBox(`${config.appUrl}${path}`, ws.name)}</details>`,
      ],
    });
  });

  app.get('/p/:token/slots/:sid/book', async (c) => {
    const ws = await publicWs(c);
    const user = c.get('user');
    const path = `/p/${c.req.param('token')}`;
    const v: ViewCtx = { ws, bookedDisplay: ws.show_booked_public, base: path, bookAction: (id) => `${path}/slots/${id}/book`, slotPage: (id) => `${path}/slots/${id}/book`, loggedIn: !!user, loginHref: `/login?next=${encodeURIComponent(c.req.path)}` };
    return render(c, { title: 'Termin buchen', body: await slotPageBody(c, v, null, user?.id ?? null, path) });
  });

  app.post('/p/:token/slots/:sid/book', async (c) => {
    const ws = await publicWs(c);
    const user = c.get('user');
    const path = `/p/${c.req.param('token')}`;
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(path)}`, 303);
    requireUser(c);
    const { db, config, limiter, kick } = c.get('deps');
    if (!limiter.take(`book:${user.id}`, 20, 10 * 60_000)) return back(c, path, 'book_rate');
    const f = await readForm(c);
    const r = await requestBooking(db, config.appUrl, {
      workspaceId: ws.id,
      slotId: c.req.param('sid'),
      userId: user.id,
      membershipId: null,
      note: str(f, 'note', 1000),
      time: str(f, 'time', 5) || undefined,
    });
    kick();
    return back(c, r.ok ? '/bookings' : path, bookResultMsg(r));
  });
}

