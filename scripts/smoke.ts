// Rauchtest gegen einen laufenden Server mit Entwicklungs-Anmeldelinks, z. B.:
//   npx wrangler pages dev --port 8788 --binding NODE_ENV=development --binding DEV_LOGIN_LINKS=1 --binding APP_URL=http://localhost:8788
//   node scripts/smoke.ts http://localhost:8788
const BASE = process.argv[2] ?? 'http://localhost:8788';

class Client {
  cookie = '';
  async req(path: string, form?: Record<string, string | string[]>) {
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      body = p.toString();
    }
    const res = await fetch(BASE + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    const m = set && /sw_session=([^;]*)/.exec(set);
    if (m) this.cookie = m[1] ? `sw_session=${m[1]}` : '';
    return res;
  }
  async login(email: string, name: string) {
    const [first, ...rest] = name.split(' ');
    const html = await (await this.req('/register', { first_name: first, last_name: rest.join(' ') || 'Test', email, password: 'rauchtest-start-1', password2: 'rauchtest-start-1', next: '' })).text();
    const token = /verify\?token=([A-Za-z0-9_-]+)/.exec(html)?.[1];
    if (!token) throw new Error('Kein Dev-Bestätigungslink: ' + html.slice(0, 300));
    await this.req('/auth/verify', { token });
  }
}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error('FEHLER: ' + msg);
  console.log('✔ ' + msg);
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const loc = (r: Response) => r.headers.get('location') ?? '';

// --- Anbieter richtet ein ---
const owner = new Client();
await owner.login(`chef-${Date.now()}@example.test`, 'Chefin Test');
check(/now_teacher/.test(loc(await owner.req('/profile/account-type', { type: 'teacher' }))), 'Auf Lehrkraft umgestellt');
const ws = await owner.req('/workspaces', { name: 'Rauchtest', kind: 'personal', timezone: 'Europe/Berlin', description: 'Test' });
const wsId = /\/w\/([^/]+)\//.exec(loc(ws))?.[1];
check(wsId, 'Arbeitsbereich angelegt');
const off = await owner.req(`/w/${wsId}/offerings`, { name: 'Stunde', duration_min: '60', buffer_min: '0', default_capacity: '1', confirmation_mode: 'manual', visibility: 'public', cancel_cutoff_hours: '24', min_notice_hours: '0', allow_self_cancel: '1' });
const offId = /offerings\/([^?]+)/.exec(loc(off))?.[1];
check(offId, 'Angebot angelegt');
const simple = await owner.req(`/w/${wsId}/slots/series`, { offering_id: offId!, from: day(3), to: '', window_start: '14:00', window_end: '17:00', status: 'published', visibility: 'inherit', capacity: '1', preference: 'normal' });
check(/n=3/.test(loc(simple)), 'Einfaches Formular: 14–17 Uhr ergibt 3 Slots');
const yellow = await owner.req(`/w/${wsId}/slots/series`, { offering_id: offId!, from: day(4), to: '', window_start: '10:00', window_end: '11:00', status: 'published', visibility: 'inherit', capacity: '1', preference: 'reluctant' });
check(/n=1/.test(loc(yellow)), 'Gelber Slot angelegt');
const ser = await owner.req(`/w/${wsId}/slots/series`, { offering_id: offId!, from: day(7), to: day(13), window_start: '09:00', window_end: '11:00', weekday: ['1', '3'], status: 'published', visibility: 'inherit', capacity: '1', preference: 'normal' });
check(/n=4/.test(loc(ser)), 'Serie über zwei Wochen: 4 Slots');
const prefill = await owner.req(`/w/${wsId}/slots/new?date=${day(6)}&from=09:00`);
check(prefill.status === 200 && (await prefill.text()).includes('value="09:00"'), 'Klick im Kalender füllt die Uhrzeit vor');
await owner.req(`/w/${wsId}/settings`, { name: 'Rauchtest', kind: 'personal', timezone: 'Europe/Berlin', description: '', public_enabled: '1', show_booked_public: 'names', show_booked_members: 'names' });
const token = /\/p\/([A-Za-z0-9_-]+)/.exec(await (await owner.req(`/w/${wsId}/settings`)).text())?.[1];
check(token, 'Öffentlicher Link aktiv');

// --- Kunde bucht über den Wochenkalender ---
const kunde = new Client();
const kundeEmail = `kunde-${Date.now()}@example.test`;
await kunde.login(kundeEmail, 'Karla Kunde');
const week = await (await kunde.req(`/p/${token}?week=${day(3)}`)).text();
const slotIds = [...week.matchAll(/href="\/p\/[^/]+\/slots\/([A-Za-z0-9_-]+)\/book"/g)].map((m) => m[1]);
check(slotIds.length >= 3 && week.includes('ev-free'), 'Wochenansicht (Standard) verlinkt grüne Slots direkt');
const slotPage = await kunde.req(`/p/${token}/slots/${slotIds[0]}/book`);
check(slotPage.status === 200 && (await slotPage.text()).includes('Termin anfragen'), 'Buchungsseite eines Slots');
const b1 = await kunde.req(`/p/${token}/slots/${slotIds[0]}/book`, { note: 'Hallo' });
check(/booked_requested/.test(loc(b1)), 'Slot angefragt');

const myPage = await (await kunde.req('/bookings')).text();
const bid = /\/bookings\/([A-Za-z0-9_-]+)\/propose-slot/.exec(myPage)?.[1];
const alt = /<option value="([A-Za-z0-9_-]+)">/.exec(myPage)?.[1];
check(bid && alt, 'Kunde sieht freie Alternativ-Termine');
check(!myPage.includes('type="time"'), 'Kunde kann keine freie Uhrzeit mehr eingeben');
const sw = await kunde.req(`/bookings/${bid}/propose-slot`, { slot_id: alt! });
check(/slot_switched/.test(loc(sw)), 'Kunde wechselt auf anderen vorgegebenen Termin');

// --- Anbieter bestätigt, verschiebt; Kunde stimmt zu ---
const conf = await owner.req(`/w/${wsId}/bookings/${bid}/confirm`, {});
check(/msg=confirmed/.test(loc(conf)), 'Anfrage bestätigt');
const prop = await owner.req(`/w/${wsId}/bookings/${bid}/propose`, { date: day(3), time: '17:30', duration: '60', note: '' });
check(/proposal_sent/.test(loc(prop)), 'Anbieter verschiebt frei');
const acc = await kunde.req(`/bookings/${bid}/proposal`, { accept: '1' });
check(/proposal_accepted/.test(loc(acc)), 'Kunde stimmt zu – Termin fest');

const anon = new Client();
const pubWeek = await (await anon.req(`/p/${token}?week=${day(3)}`)).text();
check(pubWeek.includes('ev-confirmed') && pubWeek.includes('Karla') && !pubWeek.includes('example.test'), 'Öffentlich: belegt mit Vorname, ohne E-Mail');
const pubWeek4 = await (await anon.req(`/p/${token}?week=${day(4)}`)).text();
check(pubWeek.includes('ev-reluctant') || pubWeek4.includes('ev-reluctant'), 'Gelber Slot sichtbar');

// --- Passwort ---
const pwSet = await kunde.req('/profile/password', { new_password: 'rauchtest-pw-123', new_password2: 'rauchtest-pw-123' });
check(/password_saved/.test(loc(pwSet)), 'Passwort geändert');
const pwClient = new Client();
const pwLogin = await pwClient.req('/login', { email: kundeEmail, password: 'rauchtest-pw-123' });
check(pwLogin.status === 303 && (await pwClient.req('/dashboard')).status === 200, 'Anmeldung mit Passwort');
const pwWrong = await new Client().req('/login', { email: kundeEmail, password: 'falsches-passwort' });
check(pwWrong.status === 400, 'Falsches Passwort abgewiesen');

// --- Seiten laden ---
const cal = await owner.req(`/w/${wsId}/calendar?week=${day(3)}`);
const calHtml = await cal.text();
check(cal.status === 200 && calHtml.includes('Karla Kunde') && calHtml.includes('week-cell'), 'Anbieter-Kalender mit klickbaren Stunden');
for (const p of [`/w/${wsId}`, `/w/${wsId}/slots`, `/w/${wsId}/slots/new`, `/w/${wsId}/members`, `/w/${wsId}/offerings`, `/w/${wsId}/notifications`, `/w/${wsId}/students`, `/w/${wsId}/students/check`, `/w/${wsId}/students?year=2026`, `/manifest.webmanifest`, `/sw.js`, '/calendar.ics', '/impressum', '/datenschutz', '/bookings', '/profile']) {
  const r = await owner.req(p);
  check(r.status === 200, `Seite ${p}`);
}
check((await anon.req('/static/app.css')).status === 200, 'Statische Dateien');
console.log('\nRauchtest bestanden.');
