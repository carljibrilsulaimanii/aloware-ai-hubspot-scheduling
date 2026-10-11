/**
 * booking-relay-action.js -- HubSpot workflow custom code: turn the AI agent's booking
 * request into a submission of your booking form
 * ---------------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman (with Claude Code)
 *
 * Deploy:  HubSpot > Automation > Workflows > "AI Booking — Relay" (a workflow that is NOT
 *          tied to any CRM record, started by "Webhook event is received"; needs Data Hub
 *          Professional) > custom code action, Node.js 20.x. The Aloware request_booking
 *          custom function posts its normal flat JSON to that webhook. Never in a page or a
 *          browser.
 *
 * What it does:
 *   Reads the webhook values the agent sends (email, full_name, phone, preferred_date,
 *   preferred_period, timezone) and submits your "AI Booking Contact Creation" form with
 *   HubSpot's v3 Forms API. The submission creates the contact (or updates it by email) and
 *   starts "AI Booking — Book Meeting", which books the call and texts the result back.
 *
 * Why it exists:
 *   A contact webhook trigger only enrolls a contact HubSpot already has, so anyone who gives
 *   the agent a new email is told "submitted" and nothing happens. A form submission has no
 *   such limit, but Aloware cannot call the form itself: its custom functions always send a
 *   flat JSON body (the v2 form endpoint reads no fields from JSON, and the v3 endpoint needs
 *   a nested "fields" array), and it rejects {variables} inside a URL. A record-less workflow
 *   can start from a webhook, so this action does the one thing Aloware can't: build the v3
 *   submission.
 *
 * Inputs ("Property to include in code", each mapped from the webhook event):
 *   email (required), full_name, phone, preferred_date (YYYY-MM-DD, required),
 *   preferred_period (morning | afternoon), timezone (IANA, e.g. America/New_York)
 *   full_name is split here: the first word is First Name, the rest is Last Name. A one-word
 *   name sends no Last Name, so an existing contact's last name is never blanked.
 *   first_name is still read as a fallback for anything posting the old shape.
 * Secrets: none. The v3 Forms submit endpoint needs no key.
 * Outputs: submitted (true/false), reason, email.
 *
 * On error it does not throw: a failed submission returns submitted = false with the reason
 * and logs HubSpot's response body, so the run history shows why.
 */

const PORTAL_ID = 'REPLACE_WITH_PORTAL_ID';   // the number in any HubSpot URL
const FORM_GUID = 'REPLACE_WITH_FORM_GUID';   // your AI Booking Contact Creation form

const SUBMIT_URL =
  `https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_GUID}`;

exports.main = async (event, callback) => {
  const input = (event && event.inputFields) || {};
  const out = { submitted: false, reason: '', email: '' };

  try {
    const email = clean(input.email).toLowerCase();
    const date = clean(input.preferred_date);
    out.email = email;

    if (!looksLikeEmail(email)) {
      out.reason = 'no_email';
      console.log('No usable email in the webhook; the form needs one to find the contact.');
      return callback({ outputFields: out });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      out.reason = 'bad_date';
      console.log(`preferred_date "${date}" is not YYYY-MM-DD; nothing submitted.`);
      return callback({ outputFields: out });
    }

    const name = splitName(input.full_name || input.first_name);
    const fields = buildFields({
      email,
      firstname: name.first,
      lastname: name.last,
      full_name: name.full,
      phone: normalizePhone(input.phone),
      aloai_preferred_date: date,
      aloai_preferred_period: normalizePeriod(input.preferred_period),
      aloai_booking_timezone: clean(input.timezone),
    });

    const res = await fetch(SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields,
        context: { pageUri: 'aloware://ai-agent/request_booking', pageName: 'AI agent booking (Aloware)' },
      }),
    });
    const body = await res.text();

    if (!res.ok) {
      out.reason = `submit_failed_${res.status}`;
      console.error(`Form submission failed: ${res.status} ${body}`);
      return callback({ outputFields: out });
    }

    out.submitted = true;
    out.reason = 'submitted';
    console.log(`Submitted the booking form for ${email} (${date} ${fields.find(f => f.name === 'aloai_preferred_period')?.value || ''}).`);
  } catch (err) {
    out.reason = 'error';
    console.error('Form submission errored:', err && err.message);
  }

  return callback({ outputFields: out });
};

/* ------------------------------------------------------------------ helpers */

const clean = (v) => String(v == null ? '' : v).trim();

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** Only send values we have: an empty field would overwrite a good one on the contact. */
function buildFields(values) {
  return Object.entries(values)
    .filter(([, value]) => value)
    .map(([name, value]) => ({ objectTypeId: '0-1', name, value }));
}

/** "Ana  de la Cruz" -> first "Ana", last "de la Cruz". One word -> first only. */
function splitName(raw) {
  const full = clean(raw).replace(/\s+/g, ' ');
  if (!full) return { first: '', last: '', full: '' };
  const [first, ...rest] = full.split(' ');
  return { first, last: rest.join(' '), full };
}

/** US numbers to +1XXXXXXXXXX; anything else passed through as given (digits and a leading +). */
function normalizePhone(raw) {
  const s = clean(raw);
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return s.startsWith('+') ? '+' + digits : digits;
}

/** The booking code understands morning or afternoon only; anything else is left out. */
function normalizePeriod(raw) {
  const s = clean(raw).toLowerCase();
  if (s.startsWith('morn') || s === 'am') return 'morning';
  if (s.startsWith('after') || s === 'pm') return 'afternoon';
  return '';
}

// Exposed for the local test only; the workflow calls exports.main.
exports.__test = { buildFields, splitName, normalizePhone, normalizePeriod, looksLikeEmail, SUBMIT_URL };
