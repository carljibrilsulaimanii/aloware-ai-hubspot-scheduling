/**
 * booking-action.js -- HubSpot workflow custom code action: book a meeting
 * ------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-08-19 (sanitized for publication 2026-09-28)
 *
 * Deploy:  HubSpot > Automation > Workflows > your contact-based workflow with a
 *          "When a webhook is received" trigger > Custom code action, Node.js 20.x.
 *          Paste the whole file. It does NOT belong in Design Manager, a page, or
 *          anywhere a browser can load it -- it runs with a private service key.
 *
 * What it does:
 *   An Aloware AloAI agent calls a Custom Function, which POSTs to the workflow's
 *   webhook trigger. This action reads live openings on a HubSpot meeting link,
 *   picks the one closest to what the contact asked for, and books it through the
 *   Meetings API. It returns a booking_status to branch on and a sentence that is
 *   safe to text back to the contact on every branch.
 *
 * Why it exists:
 *   Booking through the native meeting link keeps HubSpot's round robin, invites,
 *   reminders and the link's "Meeting type" stamp -- so deal automation keyed on
 *   the meeting type keeps working with no third-party scheduler to integrate.
 *
 * THE CALENDAR OWNER'S RULES WIN. HubSpot applies the meeting link's own settings
 * -- availability window, working hours, duration options, buffer time, minimum
 * notice, booking window, start time increment, and every connected calendar's
 * busy blocks -- before the availability endpoint responds. This action offers
 * only what came back. It deliberately adds no scheduling rules of its own: a
 * hardcoded lead time here would silently override a rep who set their minimum
 * notice to fifteen minutes, and a hardcoded duration would book the wrong length
 * of meeting. Both are read from the link instead.
 *
 * The only filtering applied is the contact's stated preference, which is a
 * request, not a rule -- and it never expands what HubSpot offered, only picks
 * from within it.
 *
 * Secrets (custom code action > Secrets). Either name is accepted:
 *   HUBSPOT_BOOKING_TOKEN, HUBSPOT_TOKEN
 *
 * The meeting link slug is the MEETING_SLUG constant below -- not a secret, since
 * it is visible in the public booking URL. An env var of the same name wins if set.
 *
 * Service key scopes:
 *   scheduler.meetings.meeting-link.read   read links and availability
 *   crm.objects.contacts.write             REQUIRED TO BOOK. With only the read
 *     scope the book endpoint returns 403, not a payload error. The endpoint
 *     accepts any of several write scopes; contacts write is the apt one, since
 *     booking creates or updates the contact.
 *
 * Input fields (map every one as String; README Step 8c has the full table):
 *   first_name        from the webhook payload
 *   last_name, email  from the enrolled contact record
 *   phone             the contact record's Phone Number property
 *   phone_agent       optional fallback: a number the agent captured, used only
 *                     when the contact record has none
 *   preferred_date    "YYYY-MM-DD"  (agent normalizes this -- extraction, not math)
 *   preferred_period  morning | afternoon | evening | any
 *   timezone          the contact's IP Timezone property. HubSpot's slug form
 *                     (america_slash_new_york) is converted automatically
 *   timezone_agent    optional fallback: an IANA name the agent captured
 *   duration_ms       optional; only if the link offers several and you want one
 *   consent_type_id   optional; only if the page requires a consent response
 *   consented         optional; true ONLY if the contact actually opted in
 *   extra_form_fields optional; { fieldName: value } for any other required field
 *
 * The scheduling page's required fields are not optional for the API either.
 * Whatever the link asks for must be listed in FORM_FIELDS below.
 *
 * The meeting's activity type is NOT set here. The meeting link carries a
 * "Meeting type" setting -- point it at your AI-booking type and HubSpot stamps
 * every booking made through that link, API or public page alike.
 *
 * Output fields (branch the workflow on booking_status):
 *   booking_status      booked | not_scheduled | slot_taken | no_availability |
 *                       needs_email | needs_phone | error
 *                       not_scheduled = HubSpot returned 200 but booked nothing
 *                       (offline booking). Treat as a failure needing a human.
 *   confirmation_text   ready to send as the SMS body, every branch
 *   booking_label       human time that was actually booked
 *   booked_start_ms     epoch millis, if a later action needs the record
 *   booked_duration_ms  the link's own duration, as booked
 *   alternatives_text   times to offer when nothing matched the preference
 *   payload_shape       which body shape HubSpot accepted
 *   calendar_event_id   present only on a real booking
 *   booked_contact_id   the contact HubSpot booked or created
 *   error_detail        diagnostics, on failure branches
 */

const axios = require('axios');

const HS         = 'https://api.hubapi.com';
// HubSpot moved to date-based versioning; /2026-03/ is current and /v3/ is
// legacy. scripts/probe.* checks both against your portal -- flip this if v3 is
// the one that answers.
const SCHEDULER  = '/scheduler/2026-03/meetings/meeting-links';

// The meeting link to book against: everything after meetings.hubspot.com/.
// Not a secret -- it is in the public booking URL.
const MEETING_SLUG = 'your-team/ai-booked-call';
const DEFAULT_TZ = 'America/New_York';
const MAX_ALTS   = 3;

// Local-hour windows for the contact's stated preference, end-exclusive.
// These narrow HubSpot's offer; they never widen it.
const PERIODS = {
  morning:   [0, 12],
  afternoon: [12, 17],
  evening:   [17, 24],
  any:       [0, 24],
};

/**
 * The extra form fields YOUR link carries, beyond first name / last name / email.
 * Mirror the link's own config, which the probe's step 3 prints as
 * formFields: [{ name, isRequired }].
 *
 * Get this wrong in either direction and bookings fail:
 *   - a required field we don't send is rejected with "required form field <name>
 *     does not have a corresponding value", which the contact hears as a calendar
 *     problem when the fix is to ask them for it;
 *   - a field the form does NOT have can be rejected outright, since HubSpot no
 *     longer accepts submitted fields that aren't on the form.
 *
 * A link that asks for name and email only leaves this empty. Uncomment the row
 * if your link also requires a phone number.
 */
const FORM_FIELDS = [
  // { name: 'phone', required: true },
];

const REQUIRED_FORM_FIELDS = FORM_FIELDS.filter(f => f.required).map(f => f.name);

const ASK_FOR = {
  phone: "What's the best phone number for you? I need it to confirm the booking.",
};

// Subtrees that describe when someone is NOT free. Never harvest starts here.
const BUSY_KEY = /busy|unavailable|blocked|conflict|exclu/i;

exports.main = async (event, callback) => {
  const input = event.inputFields || {};
  // Prefer the contact's own timezone so offered times and the confirmation are
  // stated in THEIR local hours, not the office's.
  const tz    = resolveTimezone(input.timezone, input.timezone_agent);
  // HubSpot exposes each selected secret under its own name, so accept either
  // rather than forcing a rename. A missing token otherwise shows up as an
  // unexplained 401.
  const token = process.env.HUBSPOT_BOOKING_TOKEN || process.env.HUBSPOT_TOKEN;
  const slug  = process.env.MEETING_SLUG || MEETING_SLUG;

  try {
    if (!token) {
      return callback({
        outputFields: {
          booking_status: 'error',
          error_detail:
            'No service key found. Select the secret in this action and make sure its ' +
            'name is one of: HUBSPOT_BOOKING_TOKEN, HUBSPOT_TOKEN.',
          confirmation_text:
            'I ran into a problem reaching the calendar. Someone from the team will ' +
            'follow up with you shortly.',
        },
      });
    }

    const { firstName, lastName, email } = normalizeNames(input);

    if (!email) {
      return callback({
        outputFields: {
          booking_status: 'needs_email',
          confirmation_text:
            "I just need an email address to send the calendar invite to -- what's the best one?",
        },
      });
    }

    // Ask for a missing required field instead of failing the booking on it.
    const formFields = buildFormFields(input);
    const missing = REQUIRED_FORM_FIELDS.find(
      name => !formFields.some(f => f.name === name && f.value)
    );

    if (missing) {
      return callback({
        outputFields: {
          booking_status: 'needs_' + missing,
          error_detail: 'The link requires "' + missing + '" and no value was supplied.',
          confirmation_text: ASK_FOR[missing] ||
            'I need one more detail before I can lock that in -- one moment.',
        },
      });
    }

    const { openings, duration } = await fetchOpenings({
      slug, tz, token, preferredDuration: Number(input.duration_ms) || null,
    });

    if (!openings.length) {
      return callback({
        outputFields: {
          booking_status: 'no_availability',
          confirmation_text:
            "I couldn't find anything open on the calendar in the next couple of weeks. " +
            'Someone from the team will reach out to you directly.',
        },
      });
    }

    const choice = chooseSlot(openings, input.preferred_date, input.preferred_period, tz);

    if (!choice) {
      return callback({
        outputFields: {
          booking_status: 'slot_taken',
          ...offer(openings, tz),
        },
      });
    }

    // The meeting link's own "Meeting type" setting stamps hs_activity_type on
    // the booking, so nothing here has to label the meeting afterwards.
    const { data, shape } = await book({
      slug, tz, token, startMs: choice, duration, firstName, lastName, email,
      formFields,
      consent: buildConsent(input),
    });

    // An "offline booking" returns HTTP 200 and books NOTHING: isOffline true with
    // an empty calendarEventId leaves a contact behind but no meeting engagement
    // and no calendar event -- nothing on any calendar, nothing in the CRM
    // timeline. It happens when the rep the round robin picked has no reachable
    // calendar.
    //
    // So this is a FAILURE, not a caveat. Telling the contact they are all set
    // would be promising a meeting that does not exist anywhere.
    const scheduled = !(data && data.isOffline) && !!(data && data.calendarEventId);

    if (!scheduled) {
      return callback({
        outputFields: {
          booking_status: 'not_scheduled',
          booked_start_ms: choice,
          booking_label: label(choice, tz),
          payload_shape: shape,
          booked_contact_id: (data && data.contactId) || '',
          error_detail:
            'Offline booking: HubSpot accepted the request but created no meeting ' +
            'and no calendar event. The assigned rep has no connected calendar.',
          confirmation_text:
            'Let me get that confirmed for you -- someone from the team will follow ' +
            'up shortly to lock in the time.',
        },
      });
    }

    return callback({
      outputFields: {
        booking_status: 'booked',
        booking_label: label(choice, tz),           // long form, for the CRM record
        booked_start_ms: choice,
        booked_duration_ms: duration,
        payload_shape: shape,
        booked_contact_id: (data && data.contactId) || '',
        calendar_event_id: data.calendarEventId,
        confirmation_text:                          // short form, fits one SMS
          "You're all set for " + shortLabel(choice, tz) + '. Invite headed to ' + email + '.',
      },
    });
  } catch (err) {
    if (!isSlotConflict(err)) {
      return callback({
        outputFields: {
          booking_status: 'error',
          error_detail: detail(err),
          confirmation_text:
            'I ran into a problem reaching the calendar. Someone from the team will ' +
            'follow up with you shortly.',
        },
      });
    }

    // The slot went between our read and our write. Come back with what is
    // actually left rather than promising a follow-up the workflow has to make.
    try {
      const { openings } = await fetchOpenings({ slug, tz, token });
      if (openings.length) {
        const { alternatives_text } = offer(openings, tz);
        return callback({
          outputFields: {
            booking_status: 'slot_taken',
            alternatives_text,
            error_detail: detail(err),
            confirmation_text:
              'That time was just taken. I do have ' + alternatives_text + '. Any of those work?',
          },
        });
      }
    } catch (_) {
      // Fall through to the generic line below.
    }

    return callback({
      outputFields: {
        booking_status: 'slot_taken',
        error_detail: detail(err),
        confirmation_text:
          'That time was just taken. Someone from the team will follow up with you shortly.',
      },
    });
  }
};

/** The three alternatives and the sentence offering them, shared by both paths. */
function offer(openings, tz) {
  const picks = spreadAcrossDays(openings, MAX_ALTS, tz);
  // Zone named once at the end, not on all three -- they are the same zone.
  const listed = humanList(picks.map(t => shortLabel(t, tz, false))) + ' ' + zone(picks[0], tz);

  return {
    alternatives_text: listed,
    confirmation_text: "I don't have anything open then. I do have " + listed + '. Any of those work?',
  };
}

/* --------------------------------------------------------------- hubspot */

async function fetchOpenings({ slug, tz, token, preferredDuration = null }) {
  const res = await axios.get(
    HS + SCHEDULER + '/book/availability-page/' + encodeURIComponent(slug),
    {
      params: { timezone: tz },
      headers: { Authorization: 'Bearer ' + token },
      timeout: 8000,
    }
  );

  const { starts, duration } = readAvailability(res.data, preferredDuration);
  const now = Date.now();

  return {
    // No minimum-lead filter here on purpose -- that is the link's "minimum
    // notice time" setting and HubSpot has already applied it. Dropping slots
    // that are merely in the past guards against a stale payload, nothing more.
    openings: starts.filter(t => t > now).sort((a, b) => a - b),
    duration,
  };
}

/**
 * ONE payload shape: epoch milliseconds for both startTime and duration.
 *
 * Verified against a live portal. The shape the 2026-03 reference documents --
 * ISO 8601 start, duration in minutes -- is rejected with
 *   VALIDATION_ERROR / MeetingsBookingSchedulingError.MEETING_DURATION_NOT_VALID
 * because the link only accepts its own duration in millis. Do not re-add it as a
 * fallback: a second attempt overwrites the first attempt's error, so a real
 * failure gets reported as a bogus duration complaint instead.
 */
const PAYLOAD_SHAPE = 'legacy-millis';

async function book({ slug, tz, token, startMs, duration, firstName, lastName, email,
                      formFields, consent }) {
  const base = {
    slug,
    firstName, lastName, email,
    startTime: startMs,
    duration,                 // the link's own duration, never a guess
    timezone: tz,
    locale: 'en-us',
    guestEmails: [],
    likelyAvailableUserIds: [],
    formFields,               // extra required registration fields, e.g. phone
    legalConsentResponses: consent,
  };

  const res = await axios.post(HS + SCHEDULER + '/book', base, {
    params: { timezone: tz },
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    timeout: 7000,
  });

  return { data: res.data, shape: PAYLOAD_SHAPE };
}

/**
 * Extra registration fields the scheduling page requires beyond name and email.
 * A missing required field fails the booking outright, so anything listed in
 * FORM_FIELDS travels here.
 */
function buildFormFields(input) {
  const fields = [];

  // Only send what the link actually has a field for. The contact record is the
  // primary source: the trigger only enrolls contacts that already exist, and
  // Aloware syncs their number in. The agent's capture is the fallback.
  if (FORM_FIELDS.some(f => f.name === 'phone')) {
    const phone = normalizePhone(input.phone || input.phone_agent);
    if (phone) fields.push({ name: 'phone', value: phone });
  }

  // Anything else the form demands, passed through as { fieldName: value }.
  const extra = input.extra_form_fields || {};
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') {
      fields.push({ name, value: String(value) });
    }
  }

  return fields;
}

/**
 * Stored numbers come in every format a CRM has ever seen -- "(555) 010-0199",
 * "+1 555-010-0142". Normalize the US cases to E.164 so the phone form field gets
 * something it reliably accepts, but pass anything unrecognized through untouched
 * rather than mangling an international number into nonsense.
 */
function normalizePhone(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';

  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (value.startsWith('+')) return '+' + digits;

  return value;
}

/**
 * Marketing consent is never assumed. It is only sent when the workflow passes a
 * consent type id AND an explicit opt-in the agent actually captured -- inventing
 * a "true" here would be fabricating consent the contact never gave.
 *
 * If your link has consent enabled but NOT required (an optional opt-in checkbox
 * with implicit processing consent), a booking succeeds with an empty array. The
 * probe's step 3 prints the link's legalConsentOptions and their ids.
 */
function buildConsent(input) {
  if (!input.consent_type_id) return [];

  return [{
    communicationTypeId: String(input.consent_type_id),
    consented: input.consented === true || input.consented === 'true',
  }];
}

/**
 * A 400 can mean two very different things: the slot went, or the request is
 * misconfigured. Telling a prospect "that time was just taken" when the real
 * problem is a bad duration or a missing form field sends them round a loop that
 * can never succeed -- and hides the fault from us. So classify.
 */
const CONFIG_FAULT = /DURATION|FORM|CONSENT|EMAIL|SLUG|LINK_NOT|PERMISSION|SCOPE/i;

function isSlotConflict(err) {
  const res = err && err.response;
  if (!res) return false;
  if (res.status === 409) return true;
  if (res.status !== 400) return false;

  const body = res.data || {};
  const signature = String(body.subCategory || '') + ' ' + String(body.message || '');
  return !CONFIG_FAULT.test(signature);      // a 400 we cannot explain: assume the slot
}

const detail = (err) =>
  String((err && err.response && JSON.stringify(err.response.data)) ||
         (err && err.message) || err).slice(0, 500);

/* ---------------------------------------------------------- availability */

/**
 * Read bookable starts and the meeting's duration out of the payload.
 *
 * The response is keyed by duration -- linkAvailability.linkAvailabilityByDuration
 * -- because a link can offer several lengths. Take that structure when it is
 * there, so the booking is written with the length the owner configured.
 */
function readAvailability(payload, preferredDuration) {
  const byDuration = findByDuration(payload);

  if (byDuration) {
    const offered = Object.keys(byDuration)
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const duration = offered.includes(preferredDuration) ? preferredDuration : offered[0];

    if (duration) {
      return { duration, starts: collectStarts(byDuration[String(duration)]) };
    }
  }

  // Shape moved between API versions. Fall back to a scoped walk, and say so by
  // returning whatever duration was asked for rather than inventing one.
  return { duration: preferredDuration, starts: collectStarts(payload) };
}

/** Breadth-first search for the duration-keyed availability map. */
function findByDuration(root) {
  const queue = [root];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;

    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }

    for (const [key, value] of Object.entries(node)) {
      if (/^linkAvailabilityByDuration$/i.test(key) && value && typeof value === 'object') {
        return value;
      }
      queue.push(value);
    }
  }

  return null;
}

/**
 * Collect epoch start times, refusing any subtree that describes busy or blocked
 * periods. Those carry start times too, and offering one would book a contact
 * straight into a rep's existing meeting.
 */
function collectStarts(node) {
  const out = new Set();

  (function walk(n) {
    if (!n || typeof n !== 'object') return;

    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }

    for (const [key, value] of Object.entries(n)) {
      if (BUSY_KEY.test(key)) continue;

      if (/^start(MillisUtc|Time|Millis)?$/i.test(key) && typeof value === 'number' && value > 1e12) {
        out.add(value);
      } else {
        walk(value);
      }
    }
  })(node);

  return [...out].sort((a, b) => a - b);
}

/* ---------------------------------------------------------------- choose */

/**
 * Preference is a hint, not a filter. Walk outward from what they asked for
 * rather than failing because their exact window is full:
 *   1. the day they asked for, in the period they asked for
 *   2. the day they asked for, any time
 *   3. the next day that has something in that period
 *   4. nothing -- caller offers alternatives instead
 */
function chooseSlot(openings, preferredDate, preferredPeriod, tz) {
  const period = PERIODS[String(preferredPeriod || 'any').toLowerCase()] || PERIODS.any;
  const inPeriod = (t) => {
    const h = localHour(t, tz);
    return h >= period[0] && h < period[1];
  };

  if (!preferredDate) {
    return openings.find(inPeriod) || openings[0] || null;
  }

  const onDay = openings.filter(t => dateKey(t, tz) === preferredDate);
  const exact = onDay.find(inPeriod);
  if (exact) return exact;
  if (onDay.length) return onDay[0];

  const later = openings.filter(t => dateKey(t, tz) >= preferredDate);
  return later.find(inPeriod) || later[0] || null;
}

/* ------------------------------------------------------------- timezone */

/**
 * HubSpot stores the IP Timezone contact property as a slug, not an IANA name:
 *   america_slash_new_york                    -> America/New_York
 *   america_slash_chicago                     -> America/Chicago
 *   america_slash_indiana_slash_indianapolis  -> America/Indiana/Indianapolis
 *
 * Handing the slug straight to Intl.DateTimeFormat throws a RangeError, which
 * would fail every booking for a contact whose timezone HubSpot knows.
 */
function ianaFromHubSpot(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (!value.includes('_slash_')) return value;       // already an IANA name

  return value
    .split('_slash_')
    .map(segment => segment
      .split('_')
      .map(word => (word ? word[0].toUpperCase() + word.slice(1) : word))
      .join('_'))
    .join('/');
}

/** Only Intl can say whether a zone name is real. Ask it rather than guessing. */
function isUsableZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The contact's own timezone first, then whatever the agent captured, then the
 * office default. A contact's IP Timezone can be stale or missing, and a bad
 * value must never take a booking down with it.
 */
function resolveTimezone(...candidates) {
  for (const raw of candidates) {
    const tz = ianaFromHubSpot(raw);
    if (isUsableZone(tz)) return tz;
  }
  return DEFAULT_TZ;
}

/* ----------------------------------------------------------------- utils */

/** Offer alternatives on different days rather than three slots the same morning. */
function spreadAcrossDays(times, max, tz) {
  const picked = [];
  const days = new Set();

  for (const t of times) {
    const day = dateKey(t, tz);
    if (days.has(day)) continue;
    days.add(day);
    picked.push(t);
    if (picked.length === max) return picked;
  }

  for (const t of times) {
    if (picked.length === max) break;
    if (!picked.includes(t)) picked.push(t);
  }

  return picked.sort((a, b) => a - b);
}

// en-CA formats as YYYY-MM-DD, which compares correctly as a string.
const dateKey = (ms, tz) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));

const localHour = (ms, tz) =>
  Number(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hourCycle: 'h23',
  }).format(new Date(ms)));

/** Long form -- for the CRM record and anything the agent speaks aloud. */
const label = (ms, tz) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(ms));

/** Short form -- "Tue Sep 8 at 2:00 PM EDT". SMS is capped at 160 characters. */
function shortLabel(ms, tz, withZone = true) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).formatToParts(new Date(ms));

  const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
  const base = get('weekday') + ' ' + get('month') + ' ' + get('day') +
               ' at ' + get('hour') + ':' + get('minute') + ' ' + get('dayPeriod');

  return withZone ? base + ' ' + get('timeZoneName') : base;
}

/** "EDT" / "EST" -- correct for the given instant, not assumed. */
const zone = (ms, tz) =>
  (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find(p => p.type === 'timeZoneName') || {}).value || '';

const humanList = (items) =>
  items.length <= 1
    ? (items[0] || '')
    : items.slice(0, -1).join(', ') + ', or ' + items[items.length - 1];

function normalizeNames(input) {
  let firstName = String(input.first_name || '').trim();
  let lastName  = String(input.last_name || '').trim();

  if (!lastName && firstName.includes(' ')) {
    const parts = firstName.split(/\s+/);
    firstName = parts.shift();
    lastName = parts.join(' ');
  }

  return {
    firstName,
    lastName: lastName || '-',            // HubSpot rejects an empty last name
    email: String(input.email || '').trim().toLowerCase(),
  };
}

// Exposed for local tests; the workflow only ever calls exports.main.
exports.__test = {
  readAvailability, collectStarts, findByDuration, spreadAcrossDays, chooseSlot,
  dateKey, localHour, label, shortLabel, humanList, normalizeNames,
  buildFormFields, buildConsent, isSlotConflict, ianaFromHubSpot, isUsableZone,
  resolveTimezone, PAYLOAD_SHAPE, REQUIRED_FORM_FIELDS, FORM_FIELDS, normalizePhone,
};
