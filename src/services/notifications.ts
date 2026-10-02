import type { Db } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import type { Mailer } from '../mail/mailer.ts';
import { render, type Payload, type Template } from '../mail/templates.ts';
import { isOfflineEmail } from '../offline.ts';
import { pushToUser, type PushMessage, type PushSender } from './push.ts';

// Benachrichtigungen laufen über eine Outbox-Tabelle: Fachliche Änderungen (z. B. Buchung)
// legen in derselben Transaktion eine Zeile "pending" an. Der Versand passiert danach
// und ändert nur den Versandstatus – nie den Buchungsstatus.

export interface Recipient {
  userId: string | null;
  email: string;
}

export const MAX_AUTO_ATTEMPTS = 3;

export async function enqueue(db: Db, workspaceId: string | null, to: Recipient, template: Template, payload: Payload) {
  // Schüler:innen ohne App haben nur eine Platzhalter-Adresse – nichts zu verschicken.
  if (isOfflineEmail(to.email)) return;
  const now = nowIso();
  // Push zusätzlich zur E-Mail, wenn die Person auf einem Gerät Push eingeschaltet hat.
  // Wer Push hat und E-Mails abbestellt hat, bekommt nur Push.
  const prefs = to.userId
    ? await db.get<{ devices: number; notify_email: number }>(
        `SELECT (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = u.id) AS devices, u.notify_email FROM users u WHERE u.id = ?`,
        [to.userId],
      )
    : undefined;
  const channels = prefs?.devices ? (prefs.notify_email ? ['email', 'push'] : ['push']) : ['email'];
  for (const channel of channels) {
    await db.run(
      `INSERT INTO notifications (id, workspace_id, recipient_user_id, recipient_email, channel, template, payload, retryable, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
      [newId(), workspaceId, to.userId, to.email, channel, template, JSON.stringify(payload), now, now],
    );
  }
}

/** Kurztext für Push aus derselben Vorlage wie die E-Mail. */
export function pushMessage(template: Template, p: Payload, appOrigin?: string): PushMessage {
  const { subject } = render(template, p);
  const when = p.newWhen ?? p.when;
  const who = template.startsWith('provider_') || template === 'proposal_to_provider' ? (p.bookerName ? `${p.bookerName} · ` : '') : '';
  let url = '/bookings';
  try {
    if (p.link) {
      const u = new URL(p.link);
      if (!appOrigin || u.origin === appOrigin) url = u.pathname + u.search;
    }
  } catch {
    // ungültiger Link – Standardseite
  }
  return { title: subject, body: `${who}${p.workspaceName ?? ''}${when ? `\n${when}` : ''}`, url, tag: template };
}

async function deliverPush(db: Db, push: PushSender, row: { id: string; recipient_user_id: string | null; template: Template; payload: string }) {
  const r = row.recipient_user_id ? await pushToUser(db, push, row.recipient_user_id, pushMessage(row.template, JSON.parse(row.payload))) : { devices: 0, delivered: 0, errors: [] };
  const status = r.delivered ? 'sent' : r.devices && r.errors.length ? 'failed' : 'not_configured';
  const error = r.delivered ? (r.errors.length ? `Nicht erreicht: ${r.errors.join(', ')}` : null) : r.devices ? `Kein Gerät erreicht (${r.errors.join(', ')})` : 'Push auf keinem Gerät mehr aktiv.';
  await db.run(`UPDATE notifications SET status = ?, attempts = attempts + 1, last_error = ?, sent_at = ?, updated_at = ? WHERE id = ?`, [
    status,
    error,
    r.delivered ? nowIso() : null,
    nowIso(),
    row.id,
  ]);
  return status;
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

/**
 * Versendet alle offenen Benachrichtigungen (und automatisch erneut: fehlgeschlagene mit wenigen Versuchen).
 * Push-Einträge nur, wenn ein Push-Versand übergeben wird; sonst bleiben sie für später liegen.
 */
export async function dispatchPending(db: Db, mailer: Mailer, opts: { includeFailed?: boolean; push?: PushSender } = {}) {
  const rows = await db.all<{ id: string; recipient_email: string; recipient_user_id: string | null; channel: string; template: Template; payload: string }>(
    `SELECT id, recipient_email, recipient_user_id, channel, template, payload FROM notifications
     WHERE retryable = 1 AND (status = 'pending' ${opts.includeFailed ? `OR (status = 'failed' AND attempts < ${MAX_AUTO_ATTEMPTS})` : ''})
       ${opts.push ? '' : `AND channel = 'email'`}
     ORDER BY created_at LIMIT 100`,
  );
  for (const r of rows) {
    if (r.channel === 'push') {
      await deliverPush(db, opts.push!, r);
      continue;
    }
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
     WHERE id = ? AND workspace_id = ? AND channel = 'email' AND status IN ('failed', 'not_configured')`,
    [id, workspaceId],
  );
  if (!row || !row.retryable) return null;
  const { subject, text } = render(row.template, JSON.parse(row.payload));
  return await deliver(db, mailer, row.id, { to: row.recipient_email, subject, text });
}
