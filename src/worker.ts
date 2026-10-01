// Einstieg für Cloudflare (Pages Functions, siehe functions/[[path]].ts).
// Statische Dateien aus public/ liefert Cloudflare direkt aus.
import { createApp } from './app.ts';
import { loadConfig, type Env } from './config.ts';
import { D1Db, type D1Database } from './db-d1.ts';
import { createMailer } from './mail/mailer.ts';
import { RateLimiter } from './ratelimit.ts';
import { runMaintenance } from './services/maintenance.ts';
import { dispatchPending } from './services/notifications.ts';
import { WebPushSender } from './services/push.ts';

export type Bindings = Env & { DB: D1Database };
export interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

// Pro Instanz; begrenzt Missbrauch nur grob (Anmeldelinks sind zusätzlich in der Datenbank begrenzt).
const limiter = new RateLimiter();

// Pages kennt keine Cron-Trigger: Wartung (Mails nachversenden, Löschfristen) läuft deshalb
// höchstens alle 10 Minuten im Hintergrund einer normalen Anfrage mit.
const MAINTENANCE_EVERY_MS = 10 * 60_000;
let lastMaintenance = 0;

function deps(env: Bindings, ctx: WaitUntil) {
  const config = loadConfig(env);
  const db = new D1Db(env.DB);
  const mailer = createMailer(config);
  const push = new WebPushSender(db, config.vapid.subject, config.vapid);
  if (Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
    lastMaintenance = Date.now();
    ctx.waitUntil(runMaintenance(db, mailer, config, push).catch((e) => console.error('Wartung:', e)));
  }
  return {
    db,
    config,
    mailer,
    limiter,
    push,
    kick: () => ctx.waitUntil(dispatchPending(db, mailer, { push }).catch((e) => console.error(e))),
  };
}

export const app = createApp((c) => deps(c.env as Bindings, c.executionCtx as WaitUntil));
