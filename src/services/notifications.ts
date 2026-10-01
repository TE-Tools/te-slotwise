import type { Db } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import type { Mailer } from '../mail/mailer.ts';
import { render, type Payload, type Template } from '../mail/templates.ts';

// Benachrichtigungen laufen über eine Outbox-Tabelle: Fachliche Änderungen (z. B. Buchung)
// legen in derselben Transaktion eine Zeile "pending" an. Der Versand passiert danach
// und ändert nur den Versandstatus – nie den Buchungsstatus.

export interface Recipient {
  userId: string | null;
  email: string;
}

export const MAX_AUTO_ATTEMPTS = 3;

export async function enqueue(db: Db, workspaceId: string | null, to: Recipient, template: Template, payload: Payload) {
  const now = nowIso();
  await db.run(
    `INSERT INTO notifications (id, workspace_id, recipient_user_id, recipient_email, template, payload, retryable, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
    [newId(), workspaceId, to.userId, to.email, template, JSON.stringify(payload), now, now],
  );
}

async function deliver(db: Db, mailer: Mailer, id: string, mail: { to: string; subject: string; text: string }) {
  if (mailer.mode === 'none') {
    await db.run(`UPDATE notifications SET status = 'not_configured', last_error = ?, updated_at = ? WHERE id = ?`, [
      'Kein E-Mail-Versand eingerichtet – nichts versendet.',
      nowIso(),
      id,
    ]);
    return 'not_configured' as const;
  }
  try {
    await mailer.send(mail);
    const status = mailer.mode === 'console' ? 'logged' : 'sent';
    await db.run(`UPDATE notifications SET status = ?, attempts = attempts + 1, last_error = NULL, sent_at = ?, updated_at = ? WHERE id = ?`, [
      status,
      nowIso(),
      nowIso(),
      id,
    ]);
    return status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.run(`UPDATE notifications SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`, [
      msg.slice(0, 500),
      nowIso(),
      id,
    ]);
    console.error(`[Benachrichtigung ${id}] Versand fehlgeschlagen: ${msg}`);
    return 'failed' as const;
  }
}

/** Versendet alle offenen Benachrichtigungen (und automatisch erneut: fehlgeschlagene mit wenigen Versuchen). */
export async function dispatchPending(db: Db, mailer: Mailer, opts: { includeFailed?: boolean } = {}) {
  const rows = await db.all<{ id: string; recipient_email: string; template: Template; payload: string }>(
    `SELECT id, recipient_email, template, payload FROM notifications
     WHERE retryable = 1 AND (status = 'pending' ${opts.includeFailed ? `OR (status = 'failed' AND attempts < ${MAX_AUTO_ATTEMPTS})` : ''})
     ORDER BY created_at LIMIT 100`,
  );
  for (const r of rows) {
    const { subject, text } = render(r.template, JSON.parse(r.payload));
    await deliver(db, mailer, r.id, { to: r.recipient_email, subject, text });
  }
  return rows.length;
}

/**
 * Sofortversand einer Mail mit geheimem Link (Anmeldung, Einladung).
 * Protokolliert wird ohne den Link; solche Einträge sind nicht automatisch wiederholbar.
 */
export async function sendSecret(
  db: Db,
  mailer: Mailer,
  workspaceId: string | null,
  to: Recipient,
  template: Template,
  payload: Payload,
  secretLink: string,
) {
  const id = newId();
  const now = nowIso();
  await db.run(
    `INSERT INTO notifications (id, workspace_id, recipient_user_id, recipient_email, template, payload, retryable, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)`,
    [id, workspaceId, to.userId, to.email, template, JSON.stringify(payload), now, now],
  );
  const { subject, text } = render(template, payload, secretLink);
  return await deliver(db, mailer, id, { to: to.email, subject, text });
}

/** Manueller Neuversand einer fehlgeschlagenen Benachrichtigung aus dem Verwaltungsbereich. */
export async function retryNotification(db: Db, mailer: Mailer, workspaceId: string, id: string) {
  const row = await db.get<{ id: string; recipient_email: string; template: Template; payload: string; retryable: number }>(
    `SELECT id, recipient_email, template, payload, retryable FROM notifications
     WHERE id = ? AND workspace_id = ? AND status IN ('failed', 'not_configured')`,
    [id, workspaceId],
  );
  if (!row || !row.retryable) return null;
  const { subject, text } = render(row.template, JSON.parse(row.payload));
  return await deliver(db, mailer, row.id, { to: row.recipient_email, subject, text });
}
