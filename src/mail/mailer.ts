import type { Config, EmailJsConfig, MailMode } from '../config.ts';

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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Klartext in einfaches HTML (Zeilenumbrüche, anklickbare Links). */
export function textToHtml(text: string) {
  return escapeHtml(text)
    .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\n/g, '<br>');
}

/**
 * Versand über EmailJS (https://www.emailjs.com) – z. B. über ein dort verbundenes Outlook-Konto.
 * Die EmailJS-Vorlage braucht: Betreff {{subject}}, Inhalt {{{message_html}}}, Empfänger {{to_email}}.
 */
class EmailJsMailer implements Mailer {
  readonly mode = 'emailjs' as const;
  private cfg: EmailJsConfig;
  constructor(cfg: EmailJsConfig) {
    this.cfg = cfg;
  }
  async send(mail: OutgoingMail) {
    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: this.cfg.serviceId,
        template_id: this.cfg.templateId,
        user_id: this.cfg.publicKey,
        accessToken: this.cfg.privateKey,
        template_params: {
          to_email: mail.to,
          subject: mail.subject,
          message: mail.text,
          message_html: textToHtml(mail.text),
          from_name: 'TE-Slotwise',
        },
      }),
    });
    if (!res.ok) throw new Error(`EmailJS antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** "Name <adresse@x.de>" in Name und Adresse zerlegen. */
export function parseFrom(from: string): { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim() || 'TE-Slotwise', email: m[2].trim() } : { name: 'TE-Slotwise', email: from.trim() };
}

/** Versand über Brevo (https://www.brevo.com) – kostenloser Tarif, Absender = bestätigte Adresse. */
class BrevoMailer implements Mailer {
  readonly mode = 'brevo' as const;
  private key: string;
  private from: { name: string; email: string };
  constructor(key: string, from: string) {
    this.key = key;
    this.from = parseFrom(from);
  }
  async send(mail: OutgoingMail) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: mail.to }],
        subject: mail.subject,
        textContent: mail.text,
        htmlContent: `<div style="font-family:sans-serif;font-size:15px;line-height:1.5">${textToHtml(mail.text)}</div>`,
      }),
    });
    if (!res.ok) throw new Error(`Brevo antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  if (config.mailMode === 'brevo' && config.brevoApiKey) return new BrevoMailer(config.brevoApiKey, config.mailFrom);
  if (config.mailMode === 'emailjs' && config.emailjs) return new EmailJsMailer(config.emailjs);
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
