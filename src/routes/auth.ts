import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { safeNextPath } from '../authz.ts';
import { clientIp, readForm, str, type AppEnv, type Ctx } from '../context.ts';
import type { Template } from '../mail/templates.ts';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../password.ts';
import {
  consumeLoginToken,
  createLoginToken,
  destroySession,
  loginWithPassword,
  normalizeEmail,
  peekLoginToken,
  recentLoginTokenCount,
  registerUser,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  userByEmail,
} from '../services/auth.ts';
import { sendSecret } from '../services/notifications.ts';
import { errorBox, flash, type H } from '../views/ui.ts';
import { render } from './common.ts';

// Anmeldung mit E-Mail und Passwort. Registrierung mit Vorname, Nachname, E-Mail und Passwort;
// die E-Mail-Adresse wird einmal per Link bestätigt. Links per E-Mail gibt es sonst nur für
// „Passwort vergessen“ – eine Anmeldung allein per Link gibt es nicht mehr.

const REGISTER_LINK_TTL_MS = 24 * 3600_000;

const nextField = (next: string | null) => html`<input type="hidden" name="next" value="${next ?? ''}">`;
const withNext = (path: string, next: string | null) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

function loginForm(next: string | null, email = '', error?: string | H) {
  return html`<section class="card narrow">
    <h1>Anmelden</h1>
    ${typeof error === 'string' ? errorBox(error) : (error ?? '')}
    <form method="post" action="/login" class="stack">
      ${nextField(next)}
      <div class="field">
        <label for="email">E-Mail-Adresse</label>
        <input id="email" name="email" type="email" autocomplete="username" required maxlength="254" value="${email}">
      </div>
      <div class="field">
        <label for="password">Passwort</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200">
      </div>
      <button class="btn" type="submit">Anmelden</button>
      <p><a href="${withNext('/password/forgot', next)}">Passwort vergessen?</a></p>
    </form>
    <div class="divider"><span>Neu hier?</span></div>
    <p><a class="btn btn-secondary btn-block" href="${withNext('/register', next)}">Konto erstellen</a></p>
    <p class="hint">Du hast dich bisher nur per E-Mail-Link angemeldet? Lege einmalig über „Passwort vergessen?“ ein Passwort fest.</p>
  </section>`;
}

interface RegisterValues {
  first_name?: string;
  last_name?: string;
  email?: string;
}

function registerForm(next: string | null, v: RegisterValues = {}, error?: string) {
  return html`<section class="card narrow">
    <h1>Konto erstellen</h1>
    <p class="lead">Mit deinem Konto buchst du Termine, siehst deine Termine im Kalender und bekommst Benachrichtigungen.</p>
    ${errorBox(error)}
    <form method="post" action="/register" class="stack">
      ${nextField(next)}
      <div class="grid-form">
        <label>Vorname <input name="first_name" required maxlength="60" autocomplete="given-name" value="${v.first_name ?? ''}"></label>
        <label>Nachname <input name="last_name" required maxlength="60" autocomplete="family-name" value="${v.last_name ?? ''}"></label>
      </div>
      <div class="field"><label for="r-email">E-Mail-Adresse</label>
        <input id="r-email" name="email" type="email" autocomplete="email" required maxlength="254" value="${v.email ?? ''}"></div>
      <div class="field"><label for="r-pw">Passwort (mindestens ${MIN_PASSWORD_LENGTH} Zeichen)</label>
        <input id="r-pw" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="200"></div>
      <div class="field"><label for="r-pw2">Passwort wiederholen</label>
        <input id="r-pw2" name="password2" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="200"></div>
      <p class="hint">Dein Name ist nur für Anbieter sichtbar, bei denen du buchst oder Mitglied bist – nie öffentlich. Mehr in den <a href="/datenschutz">Datenschutzhinweisen</a>.</p>
      <button class="btn" type="submit">Registrieren</button>
    </form>
    <p class="muted">Schon ein Konto? <a href="${withNext('/login', next)}">Anmelden</a></p>
  </section>`;
}

function forgotForm(next: string | null, email = '', error?: string) {
  return html`<section class="card narrow">
    <h1>Passwort vergessen</h1>
    <p class="lead">Gib deine E-Mail-Adresse ein. Du bekommst einen Link, mit dem du ein neues Passwort festlegst.</p>
    ${errorBox(error)}
    <form method="post" action="/password/forgot" class="stack">
      ${nextField(next)}
      <div class="field"><label for="f-email">E-Mail-Adresse</label>
        <input id="f-email" name="email" type="email" autocomplete="email" required maxlength="254" value="${email}"></div>
      <button class="btn" type="submit">Link senden</button>
    </form>
    <p class="muted"><a href="${withNext('/login', next)}">Zurück zur Anmeldung</a></p>
  </section>`;
}

/**
 * Verschickt einen Link (Bestätigung, Passwort zurücksetzen) – mit Missbrauchsbremse pro IP und Adresse.
 * Antwortet für alle Adressen gleich, damit niemand herausfinden kann, wer ein Konto hat.
 */
async function sendLink(
  c: Ctx,
  o: { email: string; send: { template: Template; next: string | null; ttlMs?: number; name?: string } | null; form: (error: string) => H; title: string },
) {
  const { db, config, mailer, limiter } = c.get('deps');
  const ip = clientIp(c, config.trustProxy);
  if (!limiter.take(`mail-ip:${ip}`, 10, 15 * 60_000) || (await recentLoginTokenCount(db, o.email, Date.now() - 15 * 60_000)) >= 5) {
    return render(c, { title: o.title, body: o.form('Zu viele Versuche. Bitte warte 15 Minuten.') }, 429);
  }
  if (mailer.mode === 'none' && !config.devLoginLinks) {
    return render(c, { title: o.title, body: o.form('Der E-Mail-Versand ist auf diesem Server noch nicht eingerichtet. Bitte wende dich an den Betreiber.') }, 500);
  }
  let devLink = '';
  let failed = false;
  if (o.send) {
    const token = await createLoginToken(db, o.email, o.send.next, Date.now(), o.send.ttlMs);
    const link = `${config.appUrl}/auth/verify?token=${encodeURIComponent(token)}`;
    if (mailer.mode === 'none') devLink = link;
    else failed = (await sendSecret(db, mailer, null, { userId: null, email: o.email }, o.send.template, { bookerName: o.send.name }, link)) === 'failed';
  }
  if (failed) return render(c, { title: o.title, body: o.form('Die E-Mail konnte gerade nicht versendet werden. Bitte versuche es in einigen Minuten erneut.') }, 500);
  return render(c, {
    title: 'Postfach prüfen',
    body: html`<section class="card narrow">
      <h1>Prüfe dein Postfach</h1>
      <p>Falls die Angaben passen, ist eine E-Mail an <strong>${o.email}</strong> unterwegs. Klicke auf den Link darin.</p>
      <p class="muted">Keine E-Mail erhalten? Schau im Spam-Ordner nach und versuche es nach ein paar Minuten erneut.</p>
      ${devLink
        ? html`<div class="flash flash-info" role="status">Entwicklungsmodus: Es ist kein E-Mail-Versand eingerichtet, es wurde <strong>keine</strong> E-Mail verschickt. Der Link:</div><p><a class="btn" href="${devLink}">Link öffnen</a></p>`
        : !o.send && c.get('deps').config.devLoginLinks && c.get('deps').mailer.mode === 'none'
          ? html`<p class="muted">Entwicklungsmodus: Für diese Adresse wurde kein Link erzeugt.</p>`
          : ''}
    </section>`,
  });
}

export function setSessionCookie(c: Ctx, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.get('deps').config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function registerAuthRoutes(app: Hono<AppEnv>) {
  app.get('/login', async (c) => {
    if (c.get('user')) return c.redirect(safeNextPath(c.req.query('next')) ?? '/dashboard');
    return render(c, { title: 'Anmelden', body: [flash(c.req.query('msg')), loginForm(safeNextPath(c.req.query('next')))] });
  });

  app.post('/login', async (c) => {
    const f = await readForm(c);
    const next = safeNextPath(str(f, 'next'));
    const email = normalizeEmail(str(f, 'email', 300));
    const password = typeof f.password === 'string' ? f.password.slice(0, 200) : '';
    if (!email || !password) return render(c, { title: 'Anmelden', body: loginForm(next, str(f, 'email', 300), 'Bitte E-Mail-Adresse und Passwort eingeben.') }, 400);
    const { db, config, limiter } = c.get('deps');
    if (!limiter.take(`pw-ip:${clientIp(c, config.trustProxy)}`, 20, 15 * 60_000)) {
      return render(c, { title: 'Anmelden', body: loginForm(next, email, 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten.') }, 429);
    }
    const result = await loginWithPassword(db, email, password);
    if (!result.ok) {
      const msg =
        result.reason === 'locked'
          ? errorBox('Zu viele Fehlversuche – das Konto ist für 15 Minuten gesperrt. Über „Passwort vergessen?“ kommst du sofort wieder hinein.')
          : result.reason === 'unverified'
            ? html`<div class="flash flash-error" role="alert">Deine E-Mail-Adresse ist noch nicht bestätigt. Bitte klicke auf den Link in der Bestätigungs-E-Mail.
                <form method="post" action="/register/resend" class="inline">${nextField(next)}<input type="hidden" name="email" value="${email}"><button class="linklike" type="submit">Bestätigungs-E-Mail erneut senden</button></form></div>`
            : errorBox('E-Mail-Adresse oder Passwort stimmen nicht.');
      return render(c, { title: 'Anmelden', body: loginForm(next, email, msg) }, 400);
    }
    setSessionCookie(c, result.sessionToken);
    return c.redirect(next ?? '/dashboard', 303);
  });

  // ---------- Registrierung ----------

  app.get('/register', async (c) => {
    if (c.get('user')) return c.redirect(safeNextPath(c.req.query('next')) ?? '/dashboard');
    return render(c, { title: 'Konto erstellen', body: registerForm(safeNextPath(c.req.query('next'))) });
  });

  app.post('/register', async (c) => {
    const f = await readForm(c);
    const next = safeNextPath(str(f, 'next'));
    const v = { first_name: str(f, 'first_name', 60), last_name: str(f, 'last_name', 60), email: str(f, 'email', 300) };
    const fail = (msg: string) => render(c, { title: 'Konto erstellen', body: registerForm(next, v, msg) }, 400);
    const email = normalizeEmail(v.email);
    if (!v.first_name || !v.last_name) return fail('Bitte Vor- und Nachnamen angeben.');
    if (!email) return fail('Bitte eine gültige E-Mail-Adresse eingeben.');
    const pw = typeof f.password === 'string' ? f.password : '';
    const problem = passwordProblem(pw);
    if (problem) return fail(problem);
    if (pw !== f.password2) return fail('Die beiden Passwörter stimmen nicht überein.');
    const { db, config, limiter } = c.get('deps');
    if (!limiter.take(`register-ip:${clientIp(c, config.trustProxy)}`, 10, 3600_000)) return fail('Zu viele Registrierungen in kurzer Zeit. Bitte später erneut versuchen.');
    const r = await registerUser(db, { email, firstName: v.first_name, lastName: v.last_name, password: pw });
    return sendLink(c, {
      email,
      title: 'Konto erstellen',
      form: (e) => registerForm(next, v, e),
      send:
        r === 'exists'
          ? { template: 'account_exists', next: '/profile?reset=1' }
          : { template: 'register_confirm', next: next ?? '/dashboard', ttlMs: REGISTER_LINK_TTL_MS, name: v.first_name },
    });
  });

  app.post('/register/resend', async (c) => {
    const f = await readForm(c);
    const next = safeNextPath(str(f, 'next'));
    const email = normalizeEmail(str(f, 'email', 300));
    if (!email) return c.redirect('/login', 303);
    const user = await userByEmail(c.get('deps').db, email);
    return sendLink(c, {
      email,
      title: 'Anmelden',
      form: (e) => loginForm(next, email, e),
      send: user && !user.email_verified_at ? { template: 'register_confirm', next: next ?? '/dashboard', ttlMs: REGISTER_LINK_TTL_MS, name: user.first_name } : null,
    });
  });

  // ---------- Passwort vergessen ----------

  app.get('/password/forgot', async (c) => render(c, { title: 'Passwort vergessen', body: forgotForm(safeNextPath(c.req.query('next'))) }));

  app.post('/password/forgot', async (c) => {
    const f = await readForm(c);
    const next = safeNextPath(str(f, 'next'));
    const email = normalizeEmail(str(f, 'email', 300));
    if (!email) return render(c, { title: 'Passwort vergessen', body: forgotForm(next, str(f, 'email', 300), 'Bitte eine gültige E-Mail-Adresse eingeben.') }, 400);
    const user = await userByEmail(c.get('deps').db, email);
    return sendLink(c, {
      email,
      title: 'Passwort vergessen',
      form: (e) => forgotForm(next, email, e),
      send: user ? { template: 'password_reset', next: `/profile?reset=1${next ? `&next=${encodeURIComponent(next)}` : ''}` } : null,
    });
  });

  // ---------- Link aus der E-Mail ----------

  // Der Link führt zuerst auf eine Bestätigungsseite. So verbrauchen
  // automatische Link-Vorschauen von Mailprogrammen das Token nicht.
  app.get('/auth/verify', async (c) => {
    const token = c.req.query('token') ?? '';
    const row = token ? await peekLoginToken(c.get('deps').db, token) : undefined;
    if (!row) {
      return render(
        c,
        {
          title: 'Link ungültig',
          body: html`<section class="card narrow"><h1>Link ungültig oder abgelaufen</h1><p>Der Link wurde schon verwendet oder ist abgelaufen.</p>
            <p><a class="btn" href="/login">Zur Anmeldung</a> <a class="btn btn-secondary" href="/password/forgot">Neuen Link anfordern</a></p></section>`,
        },
        400,
      );
    }
    const reset = (row.next_path ?? '').startsWith('/profile?reset=1');
    return render(c, {
      title: reset ? 'Neues Passwort' : 'E-Mail bestätigen',
      body: html`<section class="card narrow">
        <h1>${reset ? 'Neues Passwort festlegen' : 'E-Mail-Adresse bestätigen'}</h1>
        <p>${reset ? 'Weiter als' : 'Konto bestätigen für'} <strong>${row.email}</strong>?</p>
        <form method="post" action="/auth/verify"><input type="hidden" name="token" value="${token}"><button class="btn" type="submit" autofocus>${reset ? 'Weiter' : 'Bestätigen'}</button></form>
      </section>`,
    });
  });

  app.post('/auth/verify', async (c) => {
    const { db } = c.get('deps');
    const f = await readForm(c);
    const result = await consumeLoginToken(db, str(f, 'token', 200));
    if (!result) return c.redirect('/auth/verify?token=invalid', 303);
    setSessionCookie(c, result.sessionToken);
    const next = safeNextPath(result.nextPath) ?? '/dashboard';
    if (!result.user.first_name || !result.user.last_name) return c.redirect(`/profile?setup=1&next=${encodeURIComponent(next)}`, 303);
    return c.redirect(next, 303);
  });

  app.post('/logout', async (c) => {
    await destroySession(c.get('deps').db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login?msg=logged_out', 303);
  });
}
