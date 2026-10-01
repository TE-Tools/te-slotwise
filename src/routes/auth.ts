import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { safeNextPath } from '../authz.ts';
import { clientIp, readForm, str, type AppEnv, type Ctx } from '../context.ts';
import {
  consumeLoginToken,
  createLoginToken,
  destroySession,
  normalizeEmail,
  peekLoginToken,
  recentLoginTokenCount,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../services/auth.ts';
import { sendSecret } from '../services/notifications.ts';
import { errorBox, flash } from '../views/ui.ts';
import { render } from './common.ts';

function loginForm(next: string | null, email = '', error?: string) {
  return html`<section class="card narrow">
    <h1>Anmelden oder registrieren</h1>
    <p class="lead">Gib deine E-Mail-Adresse ein. Du bekommst einen Anmeldelink – ein Passwort brauchst du nicht. Ein Konto wird beim ersten Anmelden automatisch angelegt.</p>
    ${errorBox(error)}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${next ?? ''}">
      <div class="field">
        <label for="email">E-Mail-Adresse</label>
        <input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${email}">
      </div>
      <button class="btn" type="submit">Anmeldelink anfordern</button>
    </form>
  </section>`;
}

/**
 * Startet die Anmeldung per E-Mail-Link (auch für die Registrierung und für Einladungen).
 * Die Antwort ist unabhängig davon, ob ein Konto existiert.
 */
export async function startLogin(c: Ctx, email: string, next: string | null, shownEmail = email) {
  const { db, config, mailer, limiter } = c.get('deps');
  const ip = clientIp(c, config.trustProxy);
  if (!limiter.take(`login-ip:${ip}`, 10, 15 * 60_000) || await recentLoginTokenCount(db, email, Date.now() - 15 * 60_000) >= 5) {
    return render(c, { title: 'Anmelden', body: loginForm(next, shownEmail === email ? email : '', 'Zu viele Anmeldeversuche. Bitte warte 15 Minuten.') }, 429);
  }

  if (mailer.mode === 'none' && !config.devLoginLinks) {
    return render(
      c,
      {
        title: 'Anmelden',
        body: loginForm(next, email, 'Der E-Mail-Versand ist auf diesem Server noch nicht eingerichtet. Eine Anmeldung ist deshalb derzeit nicht möglich. Bitte wende dich an den Betreiber.'),
      },
      500,
    );
  }

  const token = await createLoginToken(db, email, next);
  const link = `${config.appUrl}/auth/verify?token=${encodeURIComponent(token)}`;

  if (mailer.mode === 'none' && config.devLoginLinks) {
    return render(c, {
      title: 'Anmeldelink',
      body: html`<section class="card narrow">
        <h1>Entwicklungsmodus</h1>
        <div class="flash flash-info" role="status">Es ist kein E-Mail-Versand eingerichtet. Es wurde <strong>keine</strong> E-Mail verschickt. Weil <code>DEV_LOGIN_LINKS=1</code> gesetzt ist, steht der Anmeldelink hier:</div>
        <p><a class="btn" href="${link}">Mit ${shownEmail} anmelden</a></p>
      </section>`,
    });
  }

  const result = await sendSecret(db, mailer, null, { userId: null, email }, 'login_link', {}, link);
  if (result === 'failed') {
    return render(c, { title: 'Anmelden', body: loginForm(next, email, 'Die E-Mail konnte gerade nicht versendet werden. Bitte versuche es in einigen Minuten erneut.') }, 500);
  }
  return render(c, {
    title: 'Postfach prüfen',
    body: html`<section class="card narrow">
      <h1>Prüfe dein Postfach</h1>
      <p>Wir haben einen Anmeldelink an <strong>${shownEmail}</strong> geschickt. Er ist 15 Minuten gültig.</p>
      ${result === 'logged' ? html`<p class="flash flash-info">Entwicklungsmodus: Die E-Mail wurde nicht versendet, sondern in der Serverkonsole ausgegeben.</p>` : ''}
      <p class="muted">Keine E-Mail erhalten? Schau im Spam-Ordner nach oder <a href="/login">fordere einen neuen Link an</a>.</p>
    </section>`,
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
    if (!email) return render(c, { title: 'Anmelden', body: loginForm(next, str(f, 'email', 300), 'Bitte eine gültige E-Mail-Adresse eingeben.') }, 400);

    return startLogin(c, email, next);
  });

  // Der Link aus der E-Mail führt zuerst auf eine Bestätigungsseite. So verbrauchen
  // automatische Link-Vorschauen von Mailprogrammen das Token nicht.
  app.get('/auth/verify', async (c) => {
    const token = c.req.query('token') ?? '';
    const row = token ? await peekLoginToken(c.get('deps').db, token) : undefined;
    if (!row) {
      return render(
        c,
        {
          title: 'Link ungültig',
          body: html`<section class="card narrow"><h1>Link ungültig oder abgelaufen</h1><p>Anmeldelinks gelten 15 Minuten und nur einmal.</p><p><a class="btn" href="/login">Neuen Link anfordern</a></p></section>`,
        },
        400,
      );
    }
    return render(c, {
      title: 'Anmeldung bestätigen',
      body: html`<section class="card narrow">
        <h1>Anmeldung bestätigen</h1>
        <p>Anmelden als <strong>${row.email}</strong>?</p>
        <form method="post" action="/auth/verify"><input type="hidden" name="token" value="${token}"><button class="btn" type="submit" autofocus>Jetzt anmelden</button></form>
      </section>`,
    });
  });

  app.post('/auth/verify', async (c) => {
    const { db, config } = c.get('deps');
    const f = await readForm(c);
    const result = await consumeLoginToken(db, str(f, 'token', 200));
    if (!result) return c.redirect('/auth/verify?token=invalid', 303);
    setCookie(c, SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    const next = safeNextPath(result.nextPath) ?? '/dashboard';
    if (!result.user.display_name) return c.redirect(`/profile?setup=1&next=${encodeURIComponent(next)}`, 303);
    return c.redirect(next, 303);
  });

  app.post('/logout', async (c) => {
    await destroySession(c.get('deps').db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login?msg=logged_out', 303);
  });
}
