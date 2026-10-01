import type { Hono } from 'hono';
import { clientIp, type AppEnv, type Ctx } from '../context.ts';
import { checkPassword, createApiToken, normalizeEmail, revokeApiToken, userForApiToken } from '../services/auth.ts';
import { calendarEntries, toTermin } from '../services/calendar.ts';

// Schnittstelle für andere TE-Apps (vor allem den Familienplaner). Gleiches Format wie Orchester-Orga
// und Vereinsleben, damit dort derselbe Adapter funktioniert:
//   POST /api/login   {email, password}  → {token, name}
//   GET  /api/me/termine?tage_zurueck=0  (Authorization: Bearer <token>) → {termine: [...]}
//   POST /api/logout  (Bearer)            → Zugang widerrufen
// Das Passwort wird nur zum Anmelden gebraucht; die App speichert danach nur das Token.
// Jede Person sieht die Verbindung im Profil und kann sie dort trennen.

const DAY = 86_400_000;

async function bearerUser(c: Ctx) {
  const auth = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(auth);
  return m ? await userForApiToken(c.get('deps').db, m[1]) : null;
}

export function registerApiRoutes(app: Hono<AppEnv>) {
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.post('/api/login', async (c) => {
    const { db, config, limiter } = c.get('deps');
    if (!limiter.take(`api-login:${clientIp(c, config.trustProxy)}`, 30, 15 * 60_000)) return c.json({ error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' }, 429);
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown; app?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password.slice(0, 200) : '';
    if (!email || !password) return c.json({ error: 'E-Mail und Passwort werden benötigt.' }, 400);
    const r = await checkPassword(db, email, password);
    if (!r.ok) {
      if (r.reason === 'locked') return c.json({ error: 'Zu viele Fehlversuche – Konto für 15 Minuten gesperrt.' }, 429);
      if (r.reason === 'unverified') return c.json({ error: 'E-Mail-Adresse bei TE-Slotwise noch nicht bestätigt.' }, 403);
      return c.json({ error: 'E-Mail oder Passwort falsch.' }, 401);
    }
    const label = typeof body?.app === 'string' && body.app.trim() ? body.app.trim().slice(0, 60) : /familien/i.test(c.req.header('user-agent') ?? '') ? 'Familienplaner' : 'Verbundene App';
    const token = await createApiToken(db, r.user.id, label);
    return c.json({ token, name: r.user.display_name, vorname: r.user.first_name, nachname: r.user.last_name, email: r.user.email });
  });

  app.get('/api/me', async (c) => {
    const user = await bearerUser(c);
    if (!user) return c.json({ error: 'Nicht angemeldet.' }, 401);
    return c.json({ name: user.display_name, vorname: user.first_name, nachname: user.last_name, email: user.email });
  });

  app.get('/api/me/termine', async (c) => {
    const user = await bearerUser(c);
    if (!user) return c.json({ error: 'Nicht angemeldet.' }, 401);
    const back = Math.min(365, Math.max(0, Number.parseInt(c.req.query('tage_zurueck') ?? '0', 10) || 0));
    const ahead = Math.min(730, Math.max(1, Number.parseInt(c.req.query('tage_voraus') ?? '365', 10) || 365));
    const now = Date.now();
    // Ohne Rückblick: alles, was noch nicht vorbei ist (ab Tagesbeginn).
    const from = new Date(now - back * DAY - (back ? 0 : DAY)).toISOString();
    const entries = await calendarEntries(c.get('deps').db, user.id, { fromIso: from, toIso: new Date(now + ahead * DAY).toISOString() });
    return c.json({ termine: entries.map(toTermin) });
  });

  app.post('/api/logout', async (c) => {
    const auth = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(c.req.header('authorization') ?? '');
    const user = await bearerUser(c);
    if (user && auth) await revokeApiToken(c.get('deps').db, user.id, auth[1]);
    return c.json({ ok: true });
  });
}
