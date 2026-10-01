// Nur für den Node-Betrieb (eigener Server). Auf Cloudflare wird Resend verwendet.
import nodemailer from 'nodemailer';
import type { Mailer, OutgoingMail } from './mailer.ts';

export class SmtpMailer implements Mailer {
  readonly mode = 'smtp' as const;
  private transport: ReturnType<typeof nodemailer.createTransport>;
  private from: string;
  constructor(url: string, from: string) {
    this.transport = nodemailer.createTransport(url);
    this.from = from;
  }
  async send(mail: OutgoingMail) {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}
