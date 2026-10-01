export type MailMode = 'smtp' | 'resend' | 'console' | 'none';

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
  const mailMode: MailMode = resendApiKey ? 'resend' : smtpUrl ? 'smtp' : env.MAIL_TRANSPORT === 'console' ? 'console' : 'none';
  return {
    appUrl,
    appOrigin: url.origin,
    port: Number(env.PORT || 3000),
    databasePath: env.DATABASE_PATH || './data/slotwise.db',
    mailMode,
    smtpUrl,
    resendApiKey,
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
