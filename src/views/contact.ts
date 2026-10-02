import { html } from 'hono/html';
import type { H } from './ui.ts';

/** Eingabefelder für Anschrift, Geburtstag, Telefon und Rechnungsempfänger (Profil und Schülerseite). */
export function contactFields(v: { address_street: string; address_zip: string; address_city: string; birth_date: string | null; phone: string; billing_name: string }): H {
  return html`<div class="grid-form">
    <label class="span-all">Straße und Hausnummer <input name="street" maxlength="200" autocomplete="street-address" value="${v.address_street}"></label>
    <label>PLZ <input name="zip" maxlength="20" inputmode="numeric" autocomplete="postal-code" value="${v.address_zip}"></label>
    <label>Ort <input name="city" maxlength="120" autocomplete="address-level2" value="${v.address_city}"></label>
    <label>Geburtstag <input type="date" name="birth_date" min="1900-01-01" value="${v.birth_date ?? ''}" autocomplete="bday"></label>
    <label>Telefon <input type="tel" name="phone" maxlength="40" autocomplete="tel" value="${v.phone}"></label>
    <label class="span-all">Rechnung an (falls abweichend, z. B. Eltern) <input name="billing_name" maxlength="160" value="${v.billing_name}" placeholder="z. B. Maria Muster"></label>
  </div>`;
}
