// E-Mail-Texte. Nutzlasten enthalten nur nicht-geheime Angaben; geheime Links
// (Anmeldung, Einladung) werden nur beim Versand übergeben und nie gespeichert.

export type Template =
  | 'login_link'
  | 'invitation'
  | 'booking_requested_booker'
  | 'booking_confirmed'
  | 'booking_declined'
  | 'booking_cancelled'
  | 'provider_new_request'
  | 'provider_new_booking'
  | 'provider_withdrawn'
  | 'provider_cancelled_by_booker'
  | 'provider_cancel_requested'
  | 'proposal_to_booker'
  | 'proposal_to_provider'
  | 'proposal_accepted'
  | 'proposal_rejected';

export interface Payload {
  workspaceName?: string;
  offeringName?: string;
  when?: string; // bereits formatierter Zeitraum inkl. Zeitzone
  newWhen?: string; // vorgeschlagene neue Zeit
  bookerName?: string;
  link?: string; // nur für nicht-geheime Links (z. B. "Meine Buchungen")
  note?: string;
}

export const TEMPLATE_LABELS: Record<Template, string> = {
  login_link: 'Anmeldelink',
  invitation: 'Einladung',
  booking_requested_booker: 'Anfrage eingegangen (Buchende)',
  booking_confirmed: 'Buchung bestätigt',
  booking_declined: 'Anfrage abgelehnt',
  booking_cancelled: 'Buchung abgesagt',
  provider_new_request: 'Neue Anfrage (Anbieter)',
  provider_new_booking: 'Neue Buchung (Anbieter)',
  provider_withdrawn: 'Anfrage zurückgezogen (Anbieter)',
  provider_cancelled_by_booker: 'Absage durch Buchende (Anbieter)',
  provider_cancel_requested: 'Absage angefragt (Anbieter)',
  proposal_to_booker: 'Neue Zeit vorgeschlagen (an Buchende)',
  proposal_to_provider: 'Neue Zeit gewünscht (an Anbieter)',
  proposal_accepted: 'Zeitvorschlag angenommen',
  proposal_rejected: 'Zeitvorschlag abgelehnt',
};

const footer = '\n\n— TE-Slotwise\nDiese Nachricht wurde automatisch erstellt.';

export function render(template: Template, p: Payload, secretLink?: string): { subject: string; text: string } {
  const ws = p.workspaceName ?? '';
  const what = `${p.offeringName ?? 'Termin'}${p.when ? `\n${p.when}` : ''}`;
  const more = p.link ? `\n\nDetails: ${p.link}` : '';
  switch (template) {
    case 'login_link':
      return {
        subject: 'Dein Anmeldelink für TE-Slotwise',
        text: `Hallo,\n\nmit diesem Link meldest du dich bei TE-Slotwise an. Er ist 15 Minuten gültig und nur einmal verwendbar:\n\n${secretLink}\n\nFalls du keine Anmeldung angefordert hast, kannst du diese Nachricht ignorieren.${footer}`,
      };
    case 'invitation':
      return {
        subject: `Einladung zu „${ws}“`,
        text: `Hallo,\n\ndu wurdest zu „${ws}“ auf TE-Slotwise eingeladen${p.offeringName ? ` (Angebot: ${p.offeringName})` : ''}.\n\nEinladung ansehen und annehmen:\n${secretLink}\n\nDie Einladung ist 7 Tage gültig. Falls du damit nichts anfangen kannst, ignoriere diese Nachricht einfach.${footer}`,
      };
    case 'booking_requested_booker':
      return {
        subject: `Anfrage eingegangen: ${p.offeringName}`,
        text: `Hallo,\n\ndeine Anfrage bei „${ws}“ ist eingegangen und wartet auf Bestätigung:\n\n${what}${more}${footer}`,
      };
    case 'booking_confirmed':
      return {
        subject: `Bestätigt: ${p.offeringName}`,
        text: `Hallo,\n\ndein Termin bei „${ws}“ ist bestätigt:\n\n${what}${more}${footer}`,
      };
    case 'booking_declined':
      return {
        subject: `Abgelehnt: ${p.offeringName}`,
        text: `Hallo,\n\nleider konnte deine Anfrage bei „${ws}“ nicht angenommen werden:\n\n${what}${p.note ? `\n\nHinweis: ${p.note}` : ''}${more}${footer}`,
      };
    case 'booking_cancelled':
      return {
        subject: `Abgesagt: ${p.offeringName}`,
        text: `Hallo,\n\nfolgender Termin bei „${ws}“ wurde abgesagt:\n\n${what}${p.note ? `\n\nHinweis: ${p.note}` : ''}${more}${footer}`,
      };
    case 'provider_new_request':
      return {
        subject: `Neue Anfrage: ${p.offeringName}`,
        text: `Hallo,\n\n${p.bookerName} hat in „${ws}“ einen Termin angefragt:\n\n${what}\n\nBitte bestätigen oder ablehnen.${more}${footer}`,
      };
    case 'provider_new_booking':
      return {
        subject: `Neue Buchung: ${p.offeringName}`,
        text: `Hallo,\n\n${p.bookerName} hat in „${ws}“ gebucht (automatisch bestätigt):\n\n${what}${more}${footer}`,
      };
    case 'provider_withdrawn':
      return {
        subject: `Anfrage zurückgezogen: ${p.offeringName}`,
        text: `Hallo,\n\n${p.bookerName} hat die Anfrage in „${ws}“ zurückgezogen:\n\n${what}${more}${footer}`,
      };
    case 'provider_cancelled_by_booker':
      return {
        subject: `Abgesagt durch Buchende: ${p.offeringName}`,
        text: `Hallo,\n\n${p.bookerName} hat folgenden Termin in „${ws}“ abgesagt:\n\n${what}${more}${footer}`,
      };
    case 'provider_cancel_requested':
      return {
        subject: `Absage angefragt: ${p.offeringName}`,
        text: `Hallo,\n\n${p.bookerName} bittet in „${ws}“ um Absage dieses Termins:\n\n${what}\n\nDie Buchung bleibt bestätigt, bis du sie absagst.${more}${footer}`,
      };
    case 'proposal_to_booker':
      return {
        subject: `Neuer Zeitvorschlag: ${p.offeringName}`,
        text: `Hallo,\n\n„${ws}“ schlägt für deinen Termin eine andere Zeit vor.\n\nBisher: ${p.when}\nNeu: ${p.newWhen}${p.note ? `\n\nHinweis: ${p.note}` : ''}\n\nBitte bestätige oder lehne den Vorschlag ab. Erst wenn du zustimmst, gilt die neue Zeit.${more}${footer}`,
      };
    case 'proposal_to_provider':
      return {
        subject: `Zeitänderung gewünscht: ${p.offeringName}`,
        text: `Hallo,\n\n${p.bookerName} wünscht in „${ws}“ eine andere Zeit.\n\nBisher: ${p.when}\nNeu: ${p.newWhen}${p.note ? `\n\nHinweis: ${p.note}` : ''}\n\nBitte bestätigen oder ablehnen.${more}${footer}`,
      };
    case 'proposal_accepted':
      return {
        subject: `Zeit bestätigt: ${p.offeringName}`,
        text: `Hallo,\n\nder Zeitvorschlag in „${ws}“ wurde angenommen. Der Termin ist jetzt fest:\n\n${p.offeringName}\n${p.newWhen}${more}${footer}`,
      };
    case 'proposal_rejected':
      return {
        subject: `Zeitvorschlag abgelehnt: ${p.offeringName}`,
        text: `Hallo,\n\nder Zeitvorschlag in „${ws}“ (${p.newWhen}) wurde abgelehnt. Es gilt weiterhin:\n\n${what}${more}${footer}`,
      };
  }
}
