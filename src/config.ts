export type MailMode = 'brevo' | 'emailjs' | 'smtp' | 'resend' | 'console' | 'none';

export interface EmailJsConfig {
  serviceId: string;
  templateId: string;
  publicKey: string;
  privateKey: string;
}

export type Env = Record<string, string | undefined>;

export interface Operator {
  name: string;
  address: string;
  email: string;
  phone: string;
}

export interface Config {
  appUrl: string;
  appOrigin: string;
  port: number;
  databasePath: string;
  mailMode: MailMode;
  smtpUrl: string | null;
  resendApiKey: string | null;
  /** Brevo (früher Sendinblue): API-Schlüssel; Absender ist MAIL_FROM (dort bestätigte Adresse). */
  brevoApiKey: string | null;
  /** EmailJS (z. B. mit verbundenem Outlook-Konto). Nur gesetzt, wenn alle vier Werte vorhanden sind. */
  emailjs: EmailJsConfig | null;
  /** E-Mail-Adressen mit Zugriff auf die Plattform-Verwaltung (/admin). */
  adminEmails: string[];
  mailFrom: string;
  devLoginLinks: boolean;
  cookieSecure: boolean;
  trustProxy: boolean;
  production: boolean;
  /** Angaben für Impressum und Datenschutz (Umgebungsvariablen OPERATOR_*). */
  operator: Operator;
  /** Versandprotokolle werden nach so vielen Tagen gelöscht. */
  retentionNotificationDays: number;
  /** Buchungen werden so viele Tage nach Terminende gelöscht (0 = nie). */
  retentionBookingDays: number;
}

export function loadConfig(env: Env): Config {
  const appUrl = (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const url = new URL(appUrl);
  const production = env.NODE_ENV === 'production';
  const smtpUrl = env.SMTP_URL?.trim() || null;
  const resendApiKey = env.RESEND_API_KEY?.trim() || null;
  const emailjs =
    env.EMAILJS_SERVICE_ID && env.EMAILJS_TEMPLATE_ID && env.EMAILJS_PUBLIC_KEY && env.EMAILJS_PRIVATE_KEY
      ? { serviceId: env.EMAILJS_SERVICE_ID.trim(), templateId: env.EMAILJS_TEMPLATE_ID.trim(), publicKey: env.EMAILJS_PUBLIC_KEY.trim(), privateKey: env.EMAILJS_PRIVATE_KEY.trim() }
      : null;
  const brevoApiKey = env.BREVO_API_KEY?.trim() || null;
  const mailMode: MailMode = brevoApiKey ? 'brevo' : emailjs ? 'emailjs' : resendApiKey ? 'resend' : smtpUrl ? 'smtp' : env.MAIL_TRANSPORT === 'console' ? 'console' : 'none';
  return {
    appUrl,
    appOrigin: url.origin,
    port: Number(env.PORT || 3000),
    databasePath: env.DATABASE_PATH || './data/slotwise.db',
    mailMode,
    smtpUrl,
    resendApiKey,
    brevoApiKey,
    emailjs,
    adminEmails: (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    mailFrom: env.MAIL_FROM || 'TE-Slotwise <noreply@localhost>',
    // Anmeldelinks auf der Seite anzeigen ist nur lokal erlaubt.
    devLoginLinks: !production && env.DEV_LOGIN_LINKS === '1' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname),
    cookieSecure: url.protocol === 'https:',
    trustProxy: env.TRUST_PROXY === '1',
    production,
    operator: {
      name: env.OPERATOR_NAME?.trim() || '',
      address: env.OPERATOR_ADDRESS?.trim() || '',
      email: env.OPERATOR_EMAIL?.trim() || '',
      phone: env.OPERATOR_PHONE?.trim() || '',
    },
    retentionNotificationDays: Number(env.RETENTION_NOTIFICATION_DAYS || 180),
    retentionBookingDays: Number(env.RETENTION_BOOKING_DAYS || 0),
  };
}
