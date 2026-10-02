import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import { dispatchPending } from '../src/services/notifications.ts';
import { MemoryPushSender } from '../src/services/push.ts';
import { getOffering } from '../src/services/offerings.ts';
import { createSlot } from '../src/services/slots.ts';
import { updateWorkspace } from '../src/services/workspaces.ts';
import { freshDb, futureDate, setupWorkspace } from './helpers.ts';

const ORIGIN = 'http://localhost:3000';

async function setup() {
  const db = await freshDb();
  const mailer = new MemoryMailer();
  const config = loadConfig({ APP_URL: ORIGIN });
  const push = new MemoryPushSender();
  const app = createApp(() => ({ db, config, mailer, push, limiter: new RateLimiter(), kick: () => void dispatchPending(db, mailer, { push }) }));
  return { db, mailer, app, push };
}

/** Kleiner Browser-Ersatz mit Cookie-Speicher. */
function client(app: ReturnType<typeof createApp>) {
  let cookie = '';
  const req = async (path: string, init: { method?: string; form?: Record<string, string | string[]>; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      body = p.toString();
    }
    if (init.origin !== null && (init.method ?? 'GET') !== 'GET') headers.origin = init.origin ?? ORIGIN;
    const res = await app.request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /sw_session=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? `sw_session=${m[1]}` : '';
    }
    return res;
  };
  return { req };
}

/** Registriert ein Konto (Vorname, Nachname, E-Mail, Passwort) und bestätigt es über den Link aus der E-Mail. */
async function login(app: ReturnType<typeof createApp>, mailer: MemoryMailer, email: string, name = 'Test Person', password = 'test-passwort-1', teacher = true) {
  const c = client(app);
  const [first, ...rest] = name.split(' ');
  const r1 = await c.req('/register', { method: 'POST', form: { first_name: first, last_name: rest.join(' ') || 'Person', email, password, password2: password } });
  assert.equal(r1.status, 200);
  const mail = mailer.sent.at(-1)!;
  assert.equal(mail.to, email);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
  // GET verbraucht das Token nicht (Schutz vor Link-Vorschauen).
  assert.equal((await c.req(`/auth/verify?token=${token}`)).status, 200);
  const r2 = await c.req('/auth/verify', { method: 'POST', form: { token } });
  assert.equal(r2.status, 303);
  // Token ist nur einmal gültig.
  assert.equal((await c.req(`/auth/verify?token=${token}`)).status, 400);
  // Neue Konten sind Schüler:innen; die meisten Tests brauchen eine Lehrkraft (Arbeitsbereich anlegen).
  if (teacher) await c.req('/profile/account-type', { method: 'POST', form: { type: 'teacher' } });
  return c;
}

test('Anmeldung per Link legt Konto an und schützt private Seiten', async () => {
  const { app, mailer } = await setup();
  const anon = client(app);
  const r = await anon.req('/dashboard');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location')!, /^\/login\?next=/);
  const c = await login(app, mailer, 'neu@example.com', 'Neu');
  const d = await c.req('/dashboard');
  assert.equal(d.status, 200);
  assert.match(await d.text(), /Hallo Neu/);
});

test('CSRF: Formular von fremder Herkunft wird abgewiesen', async () => {
  const { app } = await setup();
  const c = client(app);
  const r = await c.req('/login', { method: 'POST', form: { email: 'x@example.com' }, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('Fremder Arbeitsbereich ist per URL nicht erreichbar (404)', async () => {
  const { app, mailer, db } = await setup();
  const { wsId } = await setupWorkspace(db);
  const c = await login(app, mailer, 'fremd@example.com');
  for (const path of [`/w/${wsId}`, `/w/${wsId}/bookings`, `/w/${wsId}/members`, `/w/${wsId}/book`, `/w/${wsId}/slots`]) {
    assert.equal((await c.req(path)).status, 404, path);
  }
  assert.equal((await c.req(`/w/${wsId}/settings/delete`, { method: 'POST', form: { confirm_name: 'Testbereich' } })).status, 404);
});

test('Öffentliche Seite zeigt nur öffentliche freie Slots und keine Personendaten', async () => {
  const { app, mailer, db } = await setup();
  const { wsId, ws, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  await updateWorkspace(db, wsId, { name: ws.name, kind: 'personal', timezone: ws.timezone, description: '', publicEnabled: true });
  const off = (await getOffering(db, wsId, offeringId))!;
  const base = { kind: 'fixed' as const, durationMin: 60, bufferMin: 0, capacity: 1, location: null, onlineInfo: 'https://video.example/geheim', confirmationMode: null, status: 'published' as const, preference: 'normal' as const, visibility: 'inherit' as const, audience: { groupIds: [], membershipIds: [] } };
  const day = futureDate();
  const slotA = await createSlot(db, wsId, off, 'Europe/Berlin', day, '10:00', base);
  await createSlot(db, wsId, off, 'Europe/Berlin', day, '12:00', { ...base, visibility: 'internal' });
  const token = (await db.get<{ public_token: string }>(`SELECT public_token FROM workspaces WHERE id = ?`, [wsId]))!.public_token;

  const booker = await login(app, mailer, 'kunde@example.com', 'Kundin Geheim');
  const b = await booker.req(`/p/${token}/slots/${slotA}/book`, { method: 'POST', form: { note: '' } });
  assert.equal(b.status, 303);
  assert.match(b.headers.get('location')!, /booked_confirmed/);

  const anon = client(app);
  const page = await (await anon.req(`/p/${token}?view=list`)).text();
  assert.doesNotMatch(page, /Kundin Geheim|kunde@example\.com/);
  assert.doesNotMatch(page, /12:00/, 'interner Slot nicht öffentlich');
  assert.doesNotMatch(page, /10:00–11:00/, 'gebuchter Slot nicht mehr frei');
  assert.doesNotMatch(page, /video\.example/, 'Online-Info nur für Bestätigte');
  // Falscher Token → 404, deaktivierte Seite → 404.
  assert.equal((await anon.req('/p/falsch')).status, 404);
  await updateWorkspace(db, wsId, { name: ws.name, kind: 'personal', timezone: ws.timezone, description: '', publicEnabled: false });
  assert.equal((await anon.req(`/p/${token}`)).status, 404);
});

test('Einladung: Link allein reicht nicht, Annahme nur mit passender bestätigter Adresse', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'chefin@example.com', 'Chefin');
  const created = await owner.req('/workspaces', { method: 'POST', form: { name: 'Schule Nord', kind: 'organization', timezone: 'Europe/Berlin', description: '' } });
  const wsId = /\/w\/([^/]+)\//.exec(created.headers.get('location')!)![1];
  const inv = await owner.req(`/w/${wsId}/invitations`, { method: 'POST', form: { email: 'schueler@example.com', role: 'member', group_id: '', offering_id: '' } });
  assert.equal(inv.status, 200);
  const mail = mailer.sent.at(-1)!;
  assert.equal(mail.to, 'schueler@example.com');
  const link = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)![1];

  // Eine andere angemeldete Person kann die Einladung nicht annehmen.
  const other = await login(app, mailer, 'andere@example.com');
  await other.req(`/invite/${link}`, { method: 'POST' });
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?`, [wsId]))!.n, 1);

  const invitee = await login(app, mailer, 'schueler@example.com', 'Schüler');
  const acc = await invitee.req(`/invite/${link}`, { method: 'POST' });
  assert.equal(acc.status, 303);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?`, [wsId]))!.n, 2);
  // Mitglied ohne Verwaltungsrechte kommt nicht in die Verwaltung.
  assert.equal((await invitee.req(`/w/${wsId}/members`)).status, 404);
  assert.equal((await invitee.req(`/w/${wsId}/book`)).status, 200);
  // Einladungslink ist danach verbraucht.
  assert.equal((await invitee.req(`/invite/${link}`)).status, 404);
});

test('Ohne E-Mail-Versand wird kein Versand behauptet', async () => {
  const db = await freshDb();
  const config = loadConfig({ APP_URL: ORIGIN });
  const { createMailer } = await import('../src/mail/mailer.ts');
  const app = createApp(() => ({ db, config, mailer: createMailer(config), push: new MemoryPushSender(), limiter: new RateLimiter(), kick: () => {} }));
  const c = client(app);
  const r = await c.req('/password/forgot', { method: 'POST', form: { email: 'a@example.com' } });
  const text = await r.text();
  assert.match(text, /nicht eingerichtet/);
  assert.doesNotMatch(text, /Prüfe dein Postfach/);
});

test('Fehlgeschlagener Versand ändert den Buchungsstatus nicht', async () => {
  const { db, mailer } = await setup();
  const { wsId, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '10:00', { kind: 'fixed', durationMin: 60, bufferMin: 0, capacity: 1, location: null, onlineInfo: null, confirmationMode: null, status: 'published', preference: 'normal', visibility: 'inherit', audience: { groupIds: [], membershipIds: [] } });
  const { requestBooking } = await import('../src/services/bookings.ts');
  const { makeUser } = await import('./helpers.ts');
  const u = await makeUser(db, 'k@example.com');
  const r = await requestBooking(db, ORIGIN, { workspaceId: wsId, slotId, userId: u.id, membershipId: null, note: '' });
  assert.ok(r.ok);
  mailer.failNext = true;
  await dispatchPending(db, mailer);
  assert.equal((await db.get<{ status: string }>(`SELECT status FROM bookings WHERE id = ?`, [r.bookingId]))!.status, 'confirmed');
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed'`))!.n, 1);
});

test('Alle Verwaltungs- und Buchungsseiten laden ohne Fehler', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'chef@example.com', 'Chef');
  const created = await owner.req('/workspaces', { method: 'POST', form: { name: 'Bereich', kind: 'personal', timezone: 'Europe/Berlin', description: '' } });
  const wsId = /\/w\/([^/]+)\//.exec(created.headers.get('location')!)![1];
  const off = await owner.req(`/w/${wsId}/offerings`, {
    method: 'POST',
    form: { name: 'Beratung', duration_min: '45', buffer_min: '15', default_capacity: '1', confirmation_mode: 'manual', visibility: 'public', cancel_cutoff_hours: '24', min_notice_hours: '0' },
  });
  assert.equal(off.status, 303);
  const offeringId = /offerings\/([^?]+)/.exec(off.headers.get('location')!)![1];
  const day = futureDate(5);
  const single = await owner.req(`/w/${wsId}/slots`, { method: 'POST', form: { offering_id: offeringId, kind: 'window', date: day, time: '16:00', end_time: '19:00', status: 'published', visibility: 'inherit', capacity: '1' } });
  assert.equal(single.status, 303, 'Zeitfenster angelegt');
  const series = await owner.req(`/w/${wsId}/slots/series`, {
    method: 'POST',
    form: { offering_id: offeringId, kind: 'fixed', from: futureDate(8), to: futureDate(14), window_start: '09:00', window_end: '12:00', duration: '45', weekday: '1', status: 'published', visibility: 'inherit', capacity: '1' },
  });
  assert.equal(series.status, 303);
  assert.match(series.headers.get('location')!, /n=3/);
  const slotId = (await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? LIMIT 1`, [wsId]))!.id;
  const groupRes = await owner.req(`/w/${wsId}/groups`, { method: 'POST', form: { name: 'Kurs A' } });
  const groupPath = groupRes.headers.get('location')!.split('?')[0];
  const month = futureDate(5).slice(0, 7);
  for (const path of [
    `/w/${wsId}`,
    `/w/${wsId}/settings`,
    `/w/${wsId}/members`,
    `/w/${wsId}/groups`,
    groupPath,
    `/w/${wsId}/offerings`,
    `/w/${wsId}/offerings/new`,
    `/w/${wsId}/offerings/${offeringId}`,
    `/w/${wsId}/slots`,
    `/w/${wsId}/slots?view=calendar&month=${month}`,
    `/w/${wsId}/slots?view=calendar&day=${day}`,
    `/w/${wsId}/slots/new`,
    `/w/${wsId}/slots/${slotId}`,
    `/w/${wsId}/bookings`,
    `/w/${wsId}/bookings?status=awaiting_me`,
    `/w/${wsId}/notifications`,
    `/w/${wsId}/book`,
    `/w/${wsId}/book?view=calendar&month=${month}`,
    `/w/${wsId}/o/${offeringId}`,
    '/bookings',
    '/profile',
    '/profile/export',
    '/datenschutz',
  ]) {
    const r = await owner.req(path);
    assert.equal(r.status, 200, path);
  }
  // Wunschzeit im Zeitfenster buchen (eigenes Angebot, öffentlich).
  const book = await owner.req(`/w/${wsId}/slots/${(await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? AND kind = 'window'`, [wsId]))!.id}/book`, { method: 'POST', form: { time: '16:45', note: '' } });
  assert.match(book.headers.get('location')!, /booked_requested/);
});

test('Plattform-Verwaltung nur für freigeschaltete Admin-Adressen', async () => {
  const db = await freshDb();
  const mailer = new MemoryMailer();
  const config = loadConfig({ APP_URL: ORIGIN, ADMIN_EMAILS: 'Chef@Example.com' });
  const app = createApp(() => ({ db, config, mailer, push: new MemoryPushSender(), limiter: new RateLimiter(), kick: () => {} }));
  const other = await login(app, mailer, 'nutzer@example.com');
  assert.equal((await other.req('/admin')).status, 404);
  const admin = await login(app, mailer, 'chef@example.com', 'Chef');
  const page = await admin.req('/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Plattform-Verwaltung/);
  const t = await admin.req('/admin/test-mail', { method: 'POST' });
  assert.match(t.headers.get('location')!, /test=ok/);
  assert.equal(mailer.sent.at(-1)!.to, 'chef@example.com');
});

test('Passwort: nach E-Mail-Anmeldung festlegen, danach mit Passwort anmelden', async () => {
  const { app, mailer } = await setup();
  const c = await login(app, mailer, 'pw@example.com', 'Paula');
  // Zu kurz → abgelehnt
  const weak = await c.req('/profile/password', { method: 'POST', form: { new_password: 'kurz', new_password2: 'kurz' } });
  assert.match(weak.headers.get('location')!, /password_weak/);
  const ok = await c.req('/profile/password', { method: 'POST', form: { new_password: 'sehr-geheim-123', new_password2: 'sehr-geheim-123' } });
  assert.match(ok.headers.get('location')!, /password_saved/);

  const fresh = client(app);
  const wrong = await fresh.req('/login', { method: 'POST', form: { email: 'pw@example.com', password: 'falsch-falsch', mode: 'password' } });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /stimmen nicht/);
  // Unbekanntes Konto: gleiche Meldung
  const unknown = await fresh.req('/login', { method: 'POST', form: { email: 'gibtsnicht@example.com', password: 'egal-egal-egal', mode: 'password' } });
  assert.match(await unknown.text(), /stimmen nicht/);
  const good = await fresh.req('/login', { method: 'POST', form: { email: 'PW@example.com', password: 'sehr-geheim-123', mode: 'password' } });
  assert.equal(good.status, 303);
  assert.equal((await fresh.req('/dashboard')).status, 200);
  // Ändern verlangt das aktuelle Passwort
  const noCurrent = await fresh.req('/profile/password', { method: 'POST', form: { current_password: 'falsch', new_password: 'neues-passwort-1', new_password2: 'neues-passwort-1' } });
  assert.match(noCurrent.headers.get('location')!, /password_wrong/);
});

test('Passwort: Sperre nach zu vielen Fehlversuchen', async () => {
  const { app, mailer } = await setup();
  const c = await login(app, mailer, 'lock@example.com');
  await c.req('/profile/password', { method: 'POST', form: { new_password: 'richtiges-pw-1', new_password2: 'richtiges-pw-1' } });
  const x = client(app);
  for (let i = 0; i < 8; i++) await x.req('/login', { method: 'POST', form: { email: 'lock@example.com', password: 'falsch-' + i, mode: 'password' } });
  const locked = await x.req('/login', { method: 'POST', form: { email: 'lock@example.com', password: 'richtiges-pw-1', mode: 'password' } });
  assert.match(await locked.text(), /gesperrt/);
});

test('Passwort vergessen: Link per E-Mail, neues Passwort ohne das alte', async () => {
  const { app, mailer } = await setup();
  await login(app, mailer, 'vergessen@example.com', 'Vera Gesslich', 'altes-passwort-1');
  const x = client(app);
  const r = await x.req('/password/forgot', { method: 'POST', form: { email: 'vergessen@example.com' } });
  assert.equal(r.status, 200);
  assert.match(mailer.sent.at(-1)!.subject, /Neues Passwort/);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1];
  const v = await x.req('/auth/verify', { method: 'POST', form: { token } });
  assert.equal(v.headers.get('location'), '/profile?reset=1');
  const page = await (await x.req('/profile?reset=1')).text();
  assert.doesNotMatch(page, /current_password/);
  const ok = await x.req('/profile/password', { method: 'POST', form: { new_password: 'neues-passwort-2', new_password2: 'neues-passwort-2' } });
  assert.match(ok.headers.get('location')!, /password_saved/);
  const y = client(app);
  assert.equal((await y.req('/login', { method: 'POST', form: { email: 'vergessen@example.com', password: 'altes-passwort-1' } })).status, 400);
  const good = await y.req('/login', { method: 'POST', form: { email: 'vergessen@example.com', password: 'neues-passwort-2' } });
  assert.equal(good.status, 303);
  // Mit Passwort angemeldet: Ändern braucht weiterhin das aktuelle Passwort.
  const no = await y.req('/profile/password', { method: 'POST', form: { new_password: 'drittes-passwort', new_password2: 'drittes-passwort' } });
  assert.match(no.headers.get('location')!, /password_wrong/);
  // Unbekannte Adresse: gleiche Antwort, aber keine E-Mail.
  const before = mailer.sent.length;
  const unknown = await client(app).req('/password/forgot', { method: 'POST', form: { email: 'niemand@example.com' } });
  assert.match(await unknown.text(), /Prüfe dein Postfach/);
  assert.equal(mailer.sent.length, before);
});

test('Registrierung: Bestätigung nötig, Name Pflicht, bestehendes Konto wird nicht überschrieben', async () => {
  const { app, mailer, db } = await setup();
  const c = client(app);
  const bad = await c.req('/register', { method: 'POST', form: { first_name: 'Nur', last_name: '', email: 'neu@example.com', password: 'langes-passwort', password2: 'langes-passwort' } });
  assert.equal(bad.status, 400);
  const r = await c.req('/register', { method: 'POST', form: { first_name: 'Nina', last_name: 'Neu', email: 'Neu@Example.com', password: 'langes-passwort', password2: 'langes-passwort' } });
  assert.match(await r.text(), /Prüfe dein Postfach/);
  assert.match(mailer.sent.at(-1)!.subject, /bestätige/);
  // Vor der Bestätigung keine Anmeldung.
  const early = await client(app).req('/login', { method: 'POST', form: { email: 'neu@example.com', password: 'langes-passwort' } });
  assert.match(await early.text(), /noch nicht bestätigt/);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1];
  await c.req('/auth/verify', { method: 'POST', form: { token } });
  const u = (await db.get<{ first_name: string; last_name: string; display_name: string }>(`SELECT first_name, last_name, display_name FROM users WHERE email = 'neu@example.com'`))!;
  assert.deepEqual({ ...u }, { first_name: 'Nina', last_name: 'Neu', display_name: 'Nina Neu' });
  assert.match(await (await c.req('/dashboard')).text(), /Hallo Nina Neu/);
  // Erneute Registrierung mit derselben Adresse ändert nichts, schickt nur einen Hinweis.
  await client(app).req('/register', { method: 'POST', form: { first_name: 'Fremd', last_name: 'Person', email: 'neu@example.com', password: 'anderes-passwort', password2: 'anderes-passwort' } });
  assert.match(mailer.sent.at(-1)!.subject, /schon ein Konto/);
  assert.equal((await client(app).req('/login', { method: 'POST', form: { email: 'neu@example.com', password: 'langes-passwort' } })).status, 303);
  // Die alte Anmeldung per Link gibt es nicht mehr.
  const link = await client(app).req('/login', { method: 'POST', form: { email: 'neu@example.com', mode: 'link' } });
  assert.equal(link.status, 400);
});

test('Schülerübersicht: nur für Verwaltende, Abhaken, Preise, Zahlungen und CSV', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'lehrer@example.com', 'Lehrer');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Musik', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const off = await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Stunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal' } });
  const offId = /offerings\/([^?]+)/.exec(off.headers.get('location')!)![1];
  const student = await login(app, mailer, 'kind@example.com', 'Kind Muster');
  const studentId = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'kind@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-kind', ?, ?, 'member', ?)`, [wsId, studentId, new Date().toISOString()]);
  // Mitglieder sehen die Abrechnung nicht.
  assert.equal((await student.req(`/w/${wsId}/students`)).status, 404);
  assert.equal((await student.req(`/w/${wsId}/students/export.csv`)).status, 404);

  // Standardpreis 40 € pro 60 Minuten → 45 Minuten = 30 €.
  await owner.req(`/w/${wsId}/students/settings`, { method: 'POST', form: { default_price: '40', price_unit: 'hour' } });
  assert.match((await owner.req(`/w/${wsId}/students/settings`, { method: 'POST', form: { default_price: 'abc', price_unit: 'hour' } })).headers.get('location')!, /money_invalid/);
  const add = async (date: string) =>
    owner.req(`/w/${wsId}/students/${studentId}/lessons`, { method: 'POST', form: { offering_id: offId, date, time: '15:00', duration: '' } });
  assert.match((await add('2026-01-05')).headers.get('location')!, /lesson_added/);
  assert.match((await add('2026-01-12')).headers.get('location')!, /lesson_added/);
  // Doppelt zur selben Zeit geht nicht.
  assert.doesNotMatch((await add('2026-01-12')).headers.get('location')!, /lesson_added/);

  const ids = (await db.all<{ id: string }>(`SELECT id FROM bookings WHERE user_id = ? ORDER BY starts_at`, [studentId])).map((r) => r.id);
  const page = await (await owner.req(`/w/${wsId}/students/${studentId}?month=2026-01`)).text();
  assert.match(page, /30,00/);
  const save = await owner.req(`/w/${wsId}/lessons`, {
    method: 'POST',
    form: { back: `/w/${wsId}/students/${studentId}?month=2026-01`, ids: ids[0], [`att_${ids[0]}`]: 'attended', [`price_${ids[0]}`]: '30,00', [`paid_${ids[0]}`]: '30' },
  });
  assert.match(save.headers.get('location')!, new RegExp(`/w/${wsId}/students/${studentId}\\?month=2026-01&msg=lessons_saved`));
  // Zweiten Termin per Sammelaktion abhaken; danach Preis erhöhen – der festgeschriebene Preis bleibt.
  const p2 = new URLSearchParams({ back: `/w/${wsId}/students`, bulk: 'attended' });
  p2.append('ids', ids[1]);
  await owner.req(`/w/${wsId}/lessons`, { method: 'POST', form: Object.fromEntries(p2) });
  await owner.req(`/w/${wsId}/students/${studentId}/rate`, { method: 'POST', form: { price: '80' } });
  const rows = await db.all<{ attendance: string; price_cents: number; paid_cents: number }>(`SELECT attendance, price_cents, paid_cents FROM bookings WHERE user_id = ? ORDER BY starts_at`, [studentId]);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { attendance: 'attended', price_cents: 3000, paid_cents: 3000 },
    { attendance: 'attended', price_cents: 3000, paid_cents: 0 },
  ]);
  const overview = await (await owner.req(`/w/${wsId}/students?year=2026`)).text();
  assert.match(overview, /60,00\s*€/); // berechnet
  assert.match(overview, /individuell/);
  const csv = await (await owner.req(`/w/${wsId}/students/export.csv?month=2026-01`)).text();
  assert.match(csv, /2026-01-05;15:00;15:45;45;Kind Muster;kind@example.com;Stunde;;fest;Stattgefunden;30,00;30,00;30,00/);
  // Fremde Rücksprungziele werden ignoriert.
  const evil = await owner.req(`/w/${wsId}/lessons`, { method: 'POST', form: { back: 'https://evil.example/', ids: ids[1], [`att_${ids[1]}`]: 'attended', [`price_${ids[1]}`]: '30', [`paid_${ids[1]}`]: '' } });
  assert.match(evil.headers.get('location')!, new RegExp(`^/w/${wsId}/students\\?msg=`));
});

test('Push-Abo: nur angemeldet, gleiche Herkunft und bekannte Push-Dienste', async () => {
  const { app, mailer, db } = await setup();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
  const post = (body: unknown, cookie = '', origin = ORIGIN) =>
    app.request(`${ORIGIN}/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) });
  assert.equal((await post(sub)).status, 401);
  // Anmelden und das Sitzungscookie übernehmen.
  await app.request(`${ORIGIN}/register`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'first_name=Push&last_name=Test&email=push%40example.com&password=push-passwort-1&password2=push-passwort-1',
  });
  const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1];
  const v = await app.request(`${ORIGIN}/auth/verify`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
  const cookie = /sw_session=[^;]+/.exec(v.headers.get('set-cookie') ?? '')![0];
  const page = await (await app.request(`${ORIGIN}/profile`, { headers: { cookie } })).text();
  assert.match(page, /data-push-key="BMemoryTestKey"/);
  assert.match(page, /rel="manifest"/);
  assert.equal((await post(sub, cookie, 'https://evil.example')).status, 403);
  assert.equal((await post({ ...sub, endpoint: 'https://evil.example/x' }, cookie)).status, 400);
  assert.equal((await post(sub, cookie)).status, 200);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions`))!.n, 1);
  const profile = await (await app.request(`${ORIGIN}/profile`, { headers: { cookie } })).text();
  assert.match(profile, /Geräte mit Push/);
});

test('Kalender-Abo (iCalendar) und Schnittstelle für den Familienplaner', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'lehrerin@example.com', 'Lea Lehrer');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Klavier, Neuss', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Klavierstunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal', location: 'Raum 1' } })).headers.get('location')!)![1];
  const kid = await login(app, mailer, 'kind2@example.com', 'Karl Klein', 'karls-passwort');
  const kidId = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'kind2@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-karl', ?, ?, 'member', ?)`, [wsId, kidId, new Date().toISOString()]);
  const date = futureDate(5);
  await owner.req(`/w/${wsId}/students/${kidId}/lessons`, { method: 'POST', form: { offering_id: offId, date, time: '16:30', duration: '' } });

  // Abo-Link des Kindes aus dem Profil.
  const profile = await (await kid.req('/profile')).text();
  const feedUrl = /value="(http:\/\/localhost:3000\/cal\/[A-Za-z0-9_-]+\.ics)"/.exec(profile)![1];
  assert.match(profile, /webcal:\/\/localhost:3000\/cal\//);
  const feedPath = feedUrl.replace(ORIGIN, '');
  const ics = await (await app.request(`${ORIGIN}${feedPath}`)).text();
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Klavierstunde \(Klavier\\, Neuss\)/);
  assert.match(ics, /LOCATION:Raum 1/);
  assert.match(ics, /STATUS:CONFIRMED/);
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), 'Zeilen höchstens 75 Byte');
  // Lehrerin sieht die Buchung mit Namen; nur-Arbeitsbereich-Abo funktioniert nur für Verwaltende.
  const ownerFeed = /value="(http:\/\/localhost:3000\/cal\/[A-Za-z0-9_-]+\.ics)"/.exec(await (await owner.req('/profile')).text())![1].replace(ORIGIN, '');
  assert.match(await (await app.request(`${ORIGIN}${ownerFeed}?ws=${wsId}`)).text(), /SUMMARY:Karl Klein · Klavierstunde/);
  assert.equal((await app.request(`${ORIGIN}${feedPath}?ws=${wsId}`)).status, 404);
  assert.equal((await app.request(`${ORIGIN}/cal/falsch.ics`)).status, 404);
  // Download und einzelner Termin.
  const dl = await kid.req('/calendar.ics');
  assert.match(dl.headers.get('content-disposition')!, /attachment/);
  const bookingId = (await db.get<{ id: string }>(`SELECT id FROM bookings WHERE user_id = ?`, [kidId]))!.id;
  assert.match(await (await kid.req(`/bookings/${bookingId}/ics`)).text(), /BEGIN:VEVENT/);
  // Neuer Link macht den alten ungültig.
  await kid.req('/profile/calendar/rotate', { method: 'POST', form: {} });
  assert.equal((await app.request(`${ORIGIN}${feedPath}`)).status, 404);

  // Familienplaner: Anmeldung per API, Termine im Format von Orchester-Orga.
  const api = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    app.request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  assert.equal((await api('/api/login', { method: 'POST', body: { email: 'kind2@example.com', password: 'falsch-falsch' } })).status, 401);
  const loginRes = await api('/api/login', { method: 'POST', body: { email: 'kind2@example.com', password: 'karls-passwort', app: 'Familienplaner' } });
  assert.equal(loginRes.status, 200);
  const { token, name } = (await loginRes.json()) as { token: string; name: string };
  assert.equal(name, 'Karl Klein');
  const termine = ((await (await api('/api/me/termine?tage_zurueck=0', { token })).json()) as { termine: Record<string, string>[] }).termine;
  assert.equal(termine.length, 1);
  assert.equal(termine[0].titel, 'Klavierstunde');
  assert.equal(termine[0].verein_name, 'Klavier, Neuss');
  assert.equal(termine[0].beginn, `${date}T16:30`);
  assert.equal(termine[0].ende, `${date}T17:15`);
  assert.equal(termine[0].meine_rueckmeldung, 'zusage');
  assert.match(await (await kid.req('/profile')).text(), /Verbundene Apps[\s\S]*Familienplaner/);
  await api('/api/logout', { method: 'POST', token });
  assert.equal((await api('/api/me/termine', { token })).status, 401);
  assert.equal((await api('/api/me/termine')).status, 401);
});

test('Slots einfach anlegen: jede Woche für 4 Wochen; feste wöchentliche Stunde für Schüler:in', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'wochen@example.com', 'Wanda Woche');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Geige', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Geigenstunde', duration_min: '30', confirmation_mode: 'manual', visibility: 'internal' } })).headers.get('location')!)![1];
  const form = await (await owner.req(`/w/${wsId}/slots/new`)).text();
  assert.match(form, /Jede Woche/);
  assert.match(form, /data-slot-preview/);
  const day = futureDate(3);
  const r = await owner.req(`/w/${wsId}/slots/series`, { method: 'POST', form: { offering_id: offId, from: day, window_start: '15:00', window_end: '16:00', repeat: 'weekly', weeks: '4' } });
  assert.match(r.headers.get('location')!, /msg=slots_created&n=8/);
  // Einmalig: nur der eine Tag.
  const once = await owner.req(`/w/${wsId}/slots/series`, { method: 'POST', form: { offering_id: offId, from: day, window_start: '17:00', window_end: '17:30', repeat: 'once' } });
  assert.match(once.headers.get('location')!, /n=1/);
  // Kalender bietet „Woche wiederholen“ an.
  assert.match(await (await owner.req(`/w/${wsId}/calendar?week=${day}`)).text(), /Woche übernehmen/);

  // Feste Stunde für eine Schülerin: jede Woche, 4 Termine, nur eine Bestätigungs-Mail.
  await login(app, mailer, 'fiona@example.com', 'Fiona Fest');
  const fid = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'fiona@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-fiona', ?, ?, 'member', ?)`, [wsId, fid, new Date().toISOString()]);
  const before = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ?`, [fid]))!.n;
  const add = await owner.req(`/w/${wsId}/students/${fid}/lessons`, { method: 'POST', form: { offering_id: offId, date: futureDate(4), time: '18:00', duration: '', repeat: 'weekly', count: '4' } });
  assert.match(add.headers.get('location')!, /msg=lessons_added&n=4&k=0/);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed'`, [fid]))!.n, 4);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ?`, [fid]))!.n - before, 1);

  // Verschieben durch die Lehrkraft: standardmäßig direkt (bleibt bestätigt, Schülerin wird informiert), optional nur Vorschlag.
  const [b1, b2] = await db.all<{ id: string }>(`SELECT id FROM bookings WHERE user_id = ? ORDER BY starts_at LIMIT 2`, [fid]);
  assert.match(await (await owner.req(`/w/${wsId}/bookings`)).text(), /Nur vorschlagen/);
  assert.match((await owner.req(`/w/${wsId}/bookings/${b1.id}/propose`, { method: 'POST', form: { date: futureDate(4), time: '19:00', duration: '30', mode: 'direct' } })).headers.get('location')!, /msg=booking_moved/);
  assert.equal((await db.get<{ s: string; p: string | null }>(`SELECT status AS s, proposed_by AS p FROM bookings WHERE id = ?`, [b1.id]))!.p, null);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_user_id = ? AND template = 'booking_moved'`, [fid]))!.n, 1);
  assert.match((await owner.req(`/w/${wsId}/bookings/${b2.id}/propose`, { method: 'POST', form: { date: futureDate(11), time: '19:00', duration: '30', mode: 'propose' } })).headers.get('location')!, /msg=proposal_sent/);
  assert.equal((await db.get<{ p: string | null }>(`SELECT proposed_by AS p FROM bookings WHERE id = ?`, [b2.id]))!.p, 'provider');
});

test('Freies Zeitfenster: Lehrkraft gibt von–bis frei, Schüler:innen wählen ihre Startzeit', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'fenster@example.com', 'Frieda Fenster');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Cello', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Cellostunde', duration_min: '45', confirmation_mode: 'auto', visibility: 'internal' } })).headers.get('location')!)![1];
  assert.match(await (await owner.req(`/w/${wsId}/slots/new`)).text(), /Freies Zeitfenster/);
  const day = futureDate(5);
  const r = await owner.req(`/w/${wsId}/slots/series`, { method: 'POST', form: { offering_id: offId, kind: 'window', from: day, window_start: '16:00', window_end: '18:00', repeat: 'weekly', weeks: '3' } });
  assert.match(r.headers.get('location')!, /msg=windows_created&n=3/);
  const slotId = (await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? AND kind = 'window' ORDER BY starts_at LIMIT 1`, [wsId]))!.id;

  const kid = await login(app, mailer, 'wahl@example.com', 'Willi Wahl');
  const kidId = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'wahl@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-willi', ?, ?, 'member', ?)`, [wsId, kidId, new Date().toISOString()]);
  // Im Wochenkalender führt das Zeitfenster direkt zur Zeitauswahl.
  const week = await (await kid.req(`/w/${wsId}/book?week=${day}`)).text();
  assert.match(week, new RegExp(`/w/${wsId}/slots/${slotId}/book`));
  assert.match(week, /Zeit selbst wählen/);
  const page = await (await kid.req(`/w/${wsId}/slots/${slotId}/book`)).text();
  assert.match(page, /<option value="16:00">16:00 – 16:45 Uhr<\/option>/);
  assert.match(page, /<option value="17:15">17:15 – 18:00 Uhr<\/option>/);
  assert.doesNotMatch(page, /value="17:30"/); // 17:30 + 45 Min. passt nicht mehr ins Fenster
  const booked = await kid.req(`/w/${wsId}/slots/${slotId}/book`, { method: 'POST', form: { time: '16:30' } });
  assert.match(booked.headers.get('location')!, /booked_confirmed/);
  // Für andere sind Zeiten, die sich mit 16:30–17:15 überschneiden, weg.
  const other = await login(app, mailer, 'zweite@example.com', 'Zora Zweit');
  const oid = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'zweite@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-zora', ?, ?, 'member', ?)`, [wsId, oid, new Date().toISOString()]);
  const page2 = await (await other.req(`/w/${wsId}/slots/${slotId}/book`)).text();
  assert.doesNotMatch(page2, /value="16:00"|value="16:15"|value="16:30"|value="17:00"/);
  assert.match(page2, /value="17:15"/);
  // „Woche wiederholen“ übernimmt auch Zeitfenster.
  assert.match(await (await owner.req(`/w/${wsId}/calendar?week=${day}`)).text(), /Woche übernehmen/);
});

test('Meine Termine: Lehrkraft sieht ihre Unterrichtstermine (bestätigt und angefragt)', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'lehrer3@example.com', 'Lars Lehrer');
  // Ohne Arbeitsbereich: normale leere Seite.
  assert.match(await (await owner.req('/bookings')).text(), /Keine anstehenden Termine/);
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Flöte', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Flötenstunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal' } })).headers.get('location')!)![1];
  await login(app, mailer, 'paula@example.com', 'Paula Pfeife');
  const pid = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'paula@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-paula', ?, ?, 'member', ?)`, [wsId, pid, new Date().toISOString()]);
  await owner.req(`/w/${wsId}/students/${pid}/lessons`, { method: 'POST', form: { offering_id: offId, date: futureDate(2), time: '15:00', duration: '', repeat: 'weekly', count: '3' } });
  const page = await (await owner.req('/bookings')).text();
  assert.match(page, /Meine Unterrichtstermine/);
  assert.equal((page.match(/Paula Pfeife<\/strong> · Flötenstunde/g) ?? []).length, 3);
  assert.match(page, /bestätigt/);
  assert.match(await (await owner.req('/dashboard')).text(), /Paula Pfeife/);
});

test('Kontoart: Neue Konten sind Schüler:innen, erst als Lehrkraft lassen sich Arbeitsbereiche anlegen', async () => {
  const { app, mailer, db } = await setup();
  const c = await login(app, mailer, 'neuling@example.com', 'Nele Neu', 'neu-passwort-1', false);
  const dash = await (await c.req('/dashboard')).text();
  assert.doesNotMatch(dash, /Neuer Arbeitsbereich/);
  assert.match(dash, /Noch bei keiner Lehrkraft/);
  assert.equal((await c.req('/workspaces/new')).status, 403);
  const blocked = await c.req('/workspaces', { method: 'POST', form: { name: 'Heimlich', kind: 'personal', timezone: 'Europe/Berlin', description: '' } });
  assert.equal(blocked.status, 403);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM workspaces`))!.n, 0);
  assert.match(await (await c.req('/profile')).text(), /Ich nutze TE-Slotwise als/);
  // Auf Lehrkraft umstellen → direkt zum Anlegen.
  const sw = await c.req('/profile/account-type', { method: 'POST', form: { type: 'teacher' } });
  assert.match(sw.headers.get('location')!, /^\/workspaces\/new\?msg=now_teacher/);
  assert.match(await (await c.req('/dashboard')).text(), /Neuer Arbeitsbereich/);
  const ws = await c.req('/workspaces', { method: 'POST', form: { name: 'Mein Unterricht', kind: 'personal', timezone: 'Europe/Berlin', description: '' } });
  assert.equal(ws.status, 303);
  // Mit eigenem Arbeitsbereich geht es nicht zurück zu Schüler:in.
  const back = await c.req('/profile/account-type', { method: 'POST', form: { type: 'student' } });
  assert.match(back.headers.get('location')!, /still_owner/);
  assert.equal((await db.get<{ account_type: string }>(`SELECT account_type FROM users WHERE email = 'neuling@example.com'`))!.account_type, 'teacher');
});

test('Slot bearbeiten mit Von–Bis, löschen einzeln, als Serie und über die Liste', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'loesch@example.com', 'Lotte Lösch');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Harfe', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Harfenstunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal' } })).headers.get('location')!)![1];
  await owner.req(`/w/${wsId}/slots/series`, { method: 'POST', form: { offering_id: offId, kind: 'fixed', from: futureDate(3), window_start: '16:00', window_end: '16:45', repeat: 'weekly', weeks: '5' } });
  const ids = (await db.all<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? ORDER BY starts_at`, [wsId])).map((r) => r.id);
  assert.equal(ids.length, 5);
  const edit = await (await owner.req(`/w/${wsId}/slots/${ids[0]}`)).text();
  assert.match(edit, /name="end_time" required step="300" value="16:45"/);
  assert.match(edit, /Diesen Slot löschen/);
  assert.match(edit, /alle folgenden der Serie löschen \(5\)/);
  // Fester Termin → Zeitfenster 16:00–19:00 über Von–Bis.
  await owner.req(`/w/${wsId}/slots/${ids[0]}`, { method: 'POST', form: { kind: 'window', date: futureDate(3), time: '16:00', end_time: '19:00', capacity: '1', status: 'published', visibility: 'inherit', preference: 'normal', buffer_min: '0' } });
  const s0 = (await db.get<{ kind: string; starts_at: string; ends_at: string }>(`SELECT kind, starts_at, ends_at FROM slots WHERE id = ?`, [ids[0]]))!;
  assert.equal(s0.kind, 'window');
  assert.equal((Date.parse(s0.ends_at) - Date.parse(s0.starts_at)) / 60000, 180);
  // Einzeln löschen.
  const del = await owner.req(`/w/${wsId}/slots/${ids[0]}/delete`, { method: 'POST', form: { scope: 'one' } });
  assert.match(del.headers.get('location')!, /msg=slots_deleted&n=1&k=0/);
  // Über die Liste mit dem Knopf „Ausgewählte löschen“ (Auswahlfeld steht auf „Veröffentlichen“).
  await owner.req(`/w/${wsId}/slots/bulk`, { method: 'POST', form: { action: 'publish', delete: '1', ids: ids[1] } });
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM slots WHERE id = ?`, [ids[1]]))!.n, 0);
  // Rest der Serie ab Slot 3.
  await owner.req(`/w/${wsId}/slots/${ids[2]}/delete`, { method: 'POST', form: { scope: 'following' } });
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM slots WHERE workspace_id = ?`, [wsId]))!.n, 0);
});

test('Gruppen als Instrumente: Wahl beim Buchen, Pflege auf der Schülerseite, Anschrift und Geburtstag', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'musik@example.com', 'Mia Musik');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Musikschule', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Einzelstunde', duration_min: '45', confirmation_mode: 'auto', visibility: 'internal' } })).headers.get('location')!)![1];
  const gid = async (name: string) => /groups\/([^?]+)/.exec((await owner.req(`/w/${wsId}/groups`, { method: 'POST', form: { name } })).headers.get('location')!)![1];
  const klavier = await gid('Klavier');
  const gitarre = await gid('Gitarre');
  await gid('Geige');
  const kid = await login(app, mailer, 'tom@example.com', 'Tom Ton', 'tom-passwort-1', false);
  const kidId = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'tom@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-tom', ?, ?, 'member', ?)`, [wsId, kidId, new Date().toISOString()]);

  // Lehrkraft ordnet Tom Klavier und Gitarre zu.
  const page = await (await owner.req(`/w/${wsId}/students/${kidId}`)).text();
  assert.match(page, /Gruppen speichern/);
  await owner.req(`/w/${wsId}/students/${kidId}/groups`, { method: 'POST', form: { groups: [klavier, gitarre] } });
  const groups = (await db.all<{ name: string }>(`SELECT g.name FROM group_members gm JOIN ws_groups g ON g.id = gm.group_id WHERE gm.membership_id = 'm-tom' ORDER BY g.name`)).map((g) => g.name);
  assert.deepEqual(groups, ['Gitarre', 'Klavier']);

  // Anschrift und Geburtstag: Lehrkraft pflegt, Tom sieht und ändert dieselben Daten.
  await owner.req(`/w/${wsId}/students/${kidId}/contact`, { method: 'POST', form: { street: 'Hauptstr. 1', zip: '41460', city: 'Neuss', birth_date: '2014-05-03', phone: '0123', billing_name: 'Tina Ton' } });
  assert.match(await (await kid.req('/profile')).text(), /value="Hauptstr. 1"/);
  await kid.req('/profile/contact', { method: 'POST', form: { street: 'Nebenweg 2', zip: '41460', city: 'Neuss', birth_date: '2014-05-03', phone: '', billing_name: 'Tina Ton' } });
  assert.match(await (await owner.req(`/w/${wsId}/students/${kidId}`)).text(), /value="Nebenweg 2"/);
  assert.match((await kid.req('/profile/contact', { method: 'POST', form: { birth_date: '2999-01-01' } })).headers.get('location')!, /bad_birth_date/);
  const list = await (await owner.req(`/w/${wsId}/students/list.csv`)).text();
  assert.match(list, /Tom Ton;tom@example.com;Gitarre, Klavier;Nebenweg 2;41460;Neuss;2014-05-03;;Tina Ton/);

  // Beim Buchen fragt die App, wofür – und speichert die Wahl.
  const slotId = await (async () => {
    await owner.req(`/w/${wsId}/slots/series`, { method: 'POST', form: { offering_id: offId, kind: 'fixed', from: futureDate(4), window_start: '15:00', window_end: '15:45', repeat: 'once' } });
    return (await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ?`, [wsId]))!.id;
  })();
  const bookPage = await (await kid.req(`/w/${wsId}/slots/${slotId}/book`)).text();
  assert.match(bookPage, /Wofür\? \(z\. B\. Instrument\)/);
  assert.match(bookPage, /<option value="[^"]+">Gitarre<\/option>/);
  assert.doesNotMatch(bookPage, />Geige</);
  await kid.req(`/w/${wsId}/slots/${slotId}/book`, { method: 'POST', form: { group_id: gitarre } });
  assert.equal((await db.get<{ group_id: string }>(`SELECT group_id FROM bookings WHERE user_id = ?`, [kidId]))!.group_id, gitarre);
  // Lehrkraft sieht die Gruppe in Buchungen, Meine Termine und im Kalender-Abo.
  assert.match(await (await owner.req(`/w/${wsId}/bookings`)).text(), /badge-group">Gitarre/);
  assert.match(await (await owner.req('/bookings')).text(), /badge-group">Gitarre/);
  assert.match(await (await owner.req('/calendar.ics')).text(), /SUMMARY:Tom Ton · Einzelstunde – Gitarre/);
  // Fremde Gruppe wird nicht übernommen: Nur eine Gruppe → automatisch diese.
  await owner.req(`/w/${wsId}/students/${kidId}/groups`, { method: 'POST', form: { groups: klavier } });
  await owner.req(`/w/${wsId}/students/${kidId}/lessons`, { method: 'POST', form: { offering_id: offId, date: futureDate(6), time: '15:00', duration: '', repeat: 'once', group_id: gitarre } });
  const last = (await db.get<{ group_id: string }>(`SELECT group_id FROM bookings WHERE user_id = ? ORDER BY starts_at DESC LIMIT 1`, [kidId]))!;
  assert.equal(last.group_id, klavier);
});

test('Kalender: Tag-, Wochen- und Monatsansicht', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'ansicht@example.com', 'Anna Ansicht');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Bratsche', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Stunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal' } })).headers.get('location')!)![1];
  await login(app, mailer, 'ben@example.com', 'Ben Bogen');
  const bid = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'ben@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-ben', ?, ?, 'member', ?)`, [wsId, bid, new Date().toISOString()]);
  const day = futureDate(3);
  await owner.req(`/w/${wsId}/students/${bid}/lessons`, { method: 'POST', form: { offering_id: offId, date: day, time: '16:30', duration: '', repeat: 'once' } });
  await owner.req(`/w/${wsId}/slots/series`, { method: 'POST', form: { offering_id: offId, kind: 'fixed', from: day, window_start: '18:00', window_end: '19:30', repeat: 'once' } });
  const dayView = await (await owner.req(`/w/${wsId}/calendar?view=day&day=${day}`)).text();
  assert.match(dayView, /week-grid is-day/);
  assert.match(dayView, /Ben Bogen/);
  assert.match(dayView, /aria-current="true">Tag</);
  const month = await (await owner.req(`/w/${wsId}/calendar?view=month&month=${day.slice(0, 7)}`)).text();
  assert.match(month, /class="agenda"/);
  assert.match(month, /16:30<\/span> Ben Bogen/);
  assert.match(month, /2 frei/);
  assert.match(month, new RegExp(`view=day&amp;day=${day}`));
  // Woche bleibt Standard und bietet „Woche wiederholen“; Monat nicht.
  assert.match(await (await owner.req(`/w/${wsId}/calendar?week=${day}`)).text(), /Woche wiederholen/);
  assert.doesNotMatch(month, /Woche wiederholen/);
});

test('Schüler:in ohne App: nur Name und Instrument, feste Stunden sofort bestätigt, keine E-Mails, später übernehmbar', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'ohneapp@example.com', 'Olga Orgel');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Orgel', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const offId = /offerings\/([^?]+)/.exec((await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Orgelstunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal' } })).headers.get('location')!)![1];
  assert.match(await (await owner.req(`/w/${wsId}/students`)).text(), /Schüler:in ohne App eintragen/);

  // Ohne Vorname geht es nicht.
  assert.match((await owner.req(`/w/${wsId}/students/new`, { method: 'POST', form: { first_name: '', last_name: 'X' } })).headers.get('location')!, /name_required/);
  const r = await owner.req(`/w/${wsId}/students/new`, { method: 'POST', form: { first_name: 'Paul', last_name: 'Pfeife', new_group: 'Orgel' } });
  assert.equal(r.status, 303);
  const pid = /students\/([^?]+)\?msg=student_created/.exec(r.headers.get('location')!)![1];
  const sent = mailer.sent.length;
  const notes = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications`))!.n;

  // Instrument als Gruppe angelegt und zugeordnet; zweite Person mit derselben Gruppe legt keine neue an.
  await owner.req(`/w/${wsId}/students/new`, { method: 'POST', form: { first_name: 'Pia', last_name: 'Pfeife', new_group: 'orgel' } });
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ws_groups WHERE workspace_id = ?`, [wsId]))!.n, 1);

  // Feste wöchentliche Stunde: sofort bestätigt, keine Benachrichtigung.
  const add = await owner.req(`/w/${wsId}/students/${pid}/lessons`, { method: 'POST', form: { offering_id: offId, date: futureDate(3), time: '17:00', duration: '', repeat: 'weekly', count: '4' } });
  assert.match(add.headers.get('location')!, /n=4&k=0/);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'confirmed'`, [pid]))!.n, 4);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications`))!.n, notes);
  assert.equal(mailer.sent.length, sent);

  // Übersicht, Detailseite, Kalender: Name und Instrument, keine Platzhalter-Adresse.
  const overview = await (await owner.req(`/w/${wsId}/students`)).text();
  assert.match(overview, /Paul Pfeife<\/strong><\/a> <span class="badge badge-muted"[^>]*>ohne App/);
  assert.match(overview, /badge-group">Orgel/);
  assert.doesNotMatch(overview, /ohne-app\.invalid/);
  const detail = await (await owner.req(`/w/${wsId}/students/${pid}`)).text();
  assert.match(detail, /Name &amp; E-Mail/);
  assert.doesNotMatch(detail, /ohne-app\.invalid/);
  assert.doesNotMatch(await (await owner.req(`/w/${wsId}/bookings`)).text(), /ohne-app\.invalid/);
  assert.doesNotMatch(await (await owner.req(`/w/${wsId}/members`)).text(), /ohne-app\.invalid/);
  assert.match(await (await owner.req('/calendar.ics')).text(), /SUMMARY:Paul Pfeife · Orgelstunde – Orgel/);
  for (const path of ['/dashboard', `/w/${wsId}`, `/w/${wsId}/calendar`, '/bookings', `/w/${wsId}/calendar?view=month`, `/w/${wsId}/students/check`, `/w/${wsId}/groups`]) {
    const res = await owner.req(path);
    assert.equal(res.status, 200, path);
  }
  assert.match(await (await owner.req(`/w/${wsId}/students/list.csv`)).text(), /Paul Pfeife;;Orgel/);

  // Verschieben: bei Schüler:innen ohne App sofort gültig und bestätigt – kein „Wartet auf Buchende“.
  const first = (await db.get<{ id: string; starts_at: string }>(`SELECT id, starts_at FROM bookings WHERE user_id = ? ORDER BY starts_at LIMIT 1`, [pid]))!;
  const bookingsPage = await (await owner.req(`/w/${wsId}/bookings`)).text();
  assert.doesNotMatch(bookingsPage, /Nur vorschlagen/);
  const moved = await owner.req(`/w/${wsId}/bookings/${first.id}/propose`, { method: 'POST', form: { date: futureDate(3), time: '18:15', duration: '45', note: '', mode: 'propose' } });
  assert.match(moved.headers.get('location')!, /msg=booking_moved/);
  const after = (await db.get<{ status: string; starts_at: string; proposed_by: string | null }>(`SELECT status, starts_at, proposed_by FROM bookings WHERE id = ?`, [first.id]))!;
  assert.equal(after.status, 'confirmed');
  assert.equal(after.proposed_by, null);
  assert.notEqual(after.starts_at, first.starts_at);
  assert.equal(mailer.sent.length, sent);
  // Ein schon offener eigener Vorschlag lässt sich direkt übernehmen.
  await db.run(`UPDATE bookings SET proposed_starts_at = ?, proposed_ends_at = ?, proposed_by = 'provider' WHERE id = ?`, [
    new Date(Date.parse(after.starts_at) + 3600_000).toISOString(),
    new Date(Date.parse(after.starts_at) + 3600_000 + 45 * 60_000).toISOString(),
    first.id,
  ]);
  assert.match(await (await owner.req(`/w/${wsId}/bookings`)).text(), /Vorschlag direkt übernehmen/);
  assert.match((await owner.req(`/w/${wsId}/bookings/${first.id}/apply-proposal`, { method: 'POST', form: {} })).headers.get('location')!, /msg=booking_moved/);
  assert.equal((await db.get<{ p: string | null }>(`SELECT proposed_by AS p FROM bookings WHERE id = ?`, [first.id]))!.p, null);

  // Platzhalter-Adressen lassen sich weder registrieren noch anmelden.
  const placeholder = (await db.get<{ email: string }>(`SELECT email FROM users WHERE id = ?`, [pid]))!.email;
  const anon = client(app);
  await anon.req('/register', { method: 'POST', form: { first_name: 'X', last_name: 'Y', email: placeholder, password: 'egal-passwort-1', password2: 'egal-passwort-1' } });
  assert.equal((await db.get<{ h: string | null }>(`SELECT password_hash AS h FROM users WHERE id = ?`, [pid]))!.h, null);

  // E-Mail nachtragen: vergebene Adresse wird abgelehnt, freie übernommen; Registrierung übernimmt das Konto.
  assert.match((await owner.req(`/w/${wsId}/students/${pid}/offline`, { method: 'POST', form: { first_name: 'Paul', last_name: 'Pfeife', email: 'ohneapp@example.com' } })).headers.get('location')!, /email_taken/);
  assert.match((await owner.req(`/w/${wsId}/students/${pid}/offline`, { method: 'POST', form: { first_name: 'Paul', last_name: 'Pfeife', email: 'paul@example.com' } })).headers.get('location')!, /msg=saved/);
  const paul = await login(app, mailer, 'paul@example.com', 'Paul Pfeife', 'paul-passwort-1', false);
  assert.equal((await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'paul@example.com'`))!.id, pid);
  assert.match(await (await paul.req('/bookings')).text(), /Orgelstunde/);
  // Danach ist es ein normales Konto – nicht mehr als „ohne App“ änderbar.
  assert.equal((await owner.req(`/w/${wsId}/students/${pid}/offline`, { method: 'POST', form: { first_name: 'X', email: '' } })).status, 404);
});
