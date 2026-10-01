import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { html } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Deps } from './context.ts';
import { registerAccountRoutes } from './routes/account.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBookRoutes } from './routes/book.ts';
import { registerPlatformRoutes } from './routes/platform.ts';
import { render } from './routes/common.ts';
import { SESSION_COOKIE, userForSession } from './services/auth.ts';

/**
 * Baut die Anwendung. `getDeps` liefert pro Anfrage Datenbank, Konfiguration usw. – unter Node
 * immer dieselben, auf Cloudflare aus den Bindungen der jeweiligen Anfrage.
 * `before` erlaubt plattformspezifische Middleware (z. B. statische Dateien unter Node).
 */
export function createApp(getDeps: (c: Context) => Deps, before?: (app: Hono<AppEnv>) => void) {
  const app = new Hono<AppEnv>();
  before?.(app);

  app.use('*', async (c, next) => {
    const deps = getDeps(c);
    c.set('deps', deps);
    c.set('user', await userForSession(deps.db, getCookie(c, SESSION_COOKIE)));
    await next();
  });

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // Inline-Stilattribute nur für die Positionierung im Wochenkalender (keine Skripte).
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: 'same-origin',
    }),
  );
  // Formulare dürfen nur von der eigenen Seite abgeschickt werden (Schutz vor CSRF).
  app.use('*', csrf({ origin: (origin, c) => origin === (c as Context<AppEnv>).get('deps').config.appOrigin }));

  app.get('/healthz', (c) => c.text('ok'));

  registerAuthRoutes(app);
  registerAccountRoutes(app);
  registerBookRoutes(app);
  registerAdminRoutes(app);
  registerPlatformRoutes(app);

  const notFoundPage = (c: Parameters<typeof render>[0]) =>
    render(
      c,
      {
        title: 'Nicht gefunden',
        body: html`<section class="card narrow"><h1>Nicht gefunden</h1><p>Diese Seite gibt es nicht, oder du hast keinen Zugriff darauf.</p><p><a href="/">Zur Startseite</a></p></section>`,
      },
      404,
    );

  app.notFound((c) => notFoundPage(c));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.status === 404) return notFoundPage(c);
      return err.getResponse();
    }
    console.error(err);
    return render(
      c,
      { title: 'Fehler', body: html`<section class="card narrow"><h1>Etwas ist schiefgelaufen</h1><p>Bitte versuche es erneut. Falls der Fehler bleibt, wende dich an den Betreiber.</p></section>` },
      500,
    );
  });

  return app;
}
