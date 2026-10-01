import type { Config, MailMode } from '../config.ts';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/** Ein Versandkanal. Weitere Kanäle (SMS, Push …) implementieren dieselbe Schnittstelle. */
export interface Mailer {
  readonly mode: MailMode;
  send(mail: OutgoingMail): Promise<void>;
}

class NoMailer implements Mailer {
  readonly mode = 'none' as const;
  async send(): Promise<void> {
    throw new Error('Kein E-Mail-Versand eingerichtet.');
  }
}

class ConsoleMailer implements Mailer {
  readonly mode = 'console' as const;
  async send(mail: OutgoingMail) {
    console.log(`\n--- E-Mail (nur Konsole, nicht versendet) ---\nAn: ${mail.to}\nBetreff: ${mail.subject}\n\n${mail.text}\n---------------------------------------------\n`);
  }
}

/** Versand über die HTTP-Schnittstelle von Resend (funktioniert auf Cloudflare und Node). */
class ResendMailer implements Mailer {
  readonly mode = 'resend' as const;
  private key: string;
  private from: string;
  constructor(key: string, from: string) {
    this.key = key;
    this.from = from;
  }
  async send(mail: OutgoingMail) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Wählt den Versandweg. SMTP gibt es nur unter Node; dafür reicht server.ts eine Fabrik herein,
 * damit nodemailer nicht im Cloudflare-Paket landet.
 */
export function createMailer(config: Config, smtp?: (url: string, from: string) => Mailer): Mailer {
  if (config.mailMode === 'resend' && config.resendApiKey) return new ResendMailer(config.resendApiKey, config.mailFrom);
  if (config.mailMode === 'smtp' && config.smtpUrl && smtp) return smtp(config.smtpUrl, config.mailFrom);
  if (config.mailMode === 'console') return new ConsoleMailer();
  return new NoMailer();
}

/** Für Tests: merkt sich alle Mails. */
export class MemoryMailer implements Mailer {
  readonly mode = 'smtp' as const;
  sent: OutgoingMail[] = [];
  failNext = false;
  async send(mail: OutgoingMail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Testfehler beim Versand');
    }
    this.sent.push(mail);
  }
}
