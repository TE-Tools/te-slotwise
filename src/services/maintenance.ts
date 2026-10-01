import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { nowIso } from '../ids.ts';
import type { Mailer } from '../mail/mailer.ts';
import { purgeExpired } from './auth.ts';
import { dispatchPending } from './notifications.ts';

/**
 * Regelmäßige Aufgaben (Node: Takt in server.ts, Cloudflare: Cron-Trigger in worker.ts):
 * ausstehende/fehlgeschlagene Mails versenden und Daten nach den Aufbewahrungsfristen löschen.
 */
export async function runMaintenance(db: Db, mailer: Mailer, config: Config, now = Date.now()) {
  await dispatchPending(db, mailer, { includeFailed: true });
  await purgeExpired(db, now);
  if (config.retentionNotificationDays > 0) {
    await db.run(`DELETE FROM notifications WHERE created_at < ? AND status <> 'pending'`, [nowIso(now - config.retentionNotificationDays * 86_400_000)]);
  }
  if (config.retentionBookingDays > 0) {
    // Buchungen (samt Verlauf) lange nach Terminende entfernen; Slots ohne Buchungen bleiben als Historie.
    await db.run(`DELETE FROM bookings WHERE ends_at < ?`, [nowIso(now - config.retentionBookingDays * 86_400_000)]);
  }
  // Konten, die gelöscht wurden und keine Buchungen mehr haben, endgültig entfernen.
  await db.run(`DELETE FROM users WHERE deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = users.id)`);
}
