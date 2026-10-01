// Einstieg für den Betrieb mit Node (lokale Entwicklung oder eigener Server).
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { Deps } from './context.ts';
import { openNodeDb } from './db-node.ts';
import { createMailer } from './mail/mailer.ts';
import { SmtpMailer } from './mail/smtp.ts';
import { RateLimiter } from './ratelimit.ts';
import { runMaintenance } from './services/maintenance.ts';
import { dispatchPending } from './services/notifications.ts';

const config = loadConfig(process.env);
const db = await openNodeDb(config.databasePath);
const mailer = createMailer(config, (url, from) => new SmtpMailer(url, from));
const deps: Deps = { db, config, mailer, limiter: new RateLimiter(), kick: () => void dispatchPending(db, mailer).catch((e) => console.error(e)) };

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = createApp(
  () => deps,
  (a) => a.use('/static/*', serveStatic({ root: relative(process.cwd(), publicDir) || '.' })),
);

// Regelmäßige Aufgaben: Mails nachversenden, Aufbewahrungsfristen.
const maintain = () => runMaintenance(db, mailer, config).catch((e) => console.error('Wartung:', e));
void maintain();
const timer = setInterval(maintain, 5 * 60_000);
timer.unref();

const mailInfo = {
  smtp: 'SMTP eingerichtet',
  resend: 'Resend eingerichtet',
  emailjs: 'EmailJS eingerichtet',
  brevo: 'Brevo eingerichtet',
  console: 'nur Konsole (Entwicklung) – es werden keine E-Mails verschickt',
  none: 'NICHT eingerichtet – es werden keine E-Mails verschickt',
}[config.mailMode];

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`TE-Slotwise läuft auf ${config.appUrl} (Port ${info.port})`);
  console.log(`Datenbank: ${config.databasePath}`);
  console.log(`E-Mail-Versand: ${mailInfo}`);
  if (config.devLoginLinks) console.log('Achtung: DEV_LOGIN_LINKS aktiv – Anmeldelinks werden auf der Seite angezeigt. Nur lokal verwenden!');
});

const shutdown = () => {
  clearInterval(timer);
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
