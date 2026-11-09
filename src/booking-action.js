/**
 * booking-action.js -- HubSpot workflow custom code action: book a meeting
 * ------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 *
 * Deploy:  HubSpot > Automation > Workflows > your booking workflow > Custom code
 *          action, Node.js 20.x. Paste the whole file. It does NOT belong in Design
 *          Manager, a page, or anywhere a browser can load it -- it runs with a
 *          private service key.
 *
 * What it does:
 *   An Aloware AloAI agent calls a Custom Function, which starts the workflow (a
 *   webhook trigger, or the form trigger in README section 7). This action reads
 *   live openings on a HubSpot meeting link, picks the one that matches what the
 *   contact asked for, and books it through the Meetings API -- unless the team is
 *   already working the contact. It returns a booking_status to branch on and a
 *   sentence that is safe to text back to the contact on every branch.
 *
 * Why it exists:
 *   Booking through the native meeting link keeps HubSpot's round robin, invites,
 *   reminders and the link's "Meeting type" stamp. The guards exist because an
 *   agent on a line reps also text from will otherwise book contacts mid-conversation,
 *   onto the wrong rep, or on top of a call that is already set.
 *
 * GUARDS (checked before anything is booked). If any one is true the action books
 * nothing, returns booking_status "handed_to_owner" with the reason in error_detail,
 * and the workflow creates a task for the contact owner:
 *   1. The contact has an upcoming activity (notes_next_activity_date in the future):
 *      a meeting, a scheduled call or a task a rep set. Someone already has a plan.
 *   2. A rep texted the contact from the HubSpot inbox's Aloware SMS channel in the
 *      last REP_ACTIVE_HOURS hours. That channel also carries the agent's replies,
 *      workflow texts and blasts (sender X-unknown), so only OUTGOING messages from
 *      a person (sender A-<user id>, minus any shared team user you list) count.
 *      Needs the conversations.read scope on the service key; without it this guard
 *      is skipped (fails open) and checks_note says so.
 *   3. The contact has an owner who is not on the round robin. "Prioritize contact
 *      owner" can only route to link members, so the call would go to someone else.
 *
 * THE CALENDAR OWNER'S RULES WIN. HubSpot applies the meeting link's own
 * settings -- availability window, working hours, duration options, buffer time,
 * minimum notice, booking window, start time increment, and every connected
 * calendar's busy blocks -- before the availability endpoint responds. This
 * action offers only what came back. The only rules it adds are AGENT_HOURS (off
 * by default: every day, every hour) and the preference below, which never expands
 * what HubSpot offered, only picks from within it.
 *
 * Secrets (custom code action > Secrets). Any of these names is accepted:
 *   HUBSPOT_BOOKING_TOKEN, HUBSPOT_TOKEN.
 *
 * The meeting link slug is the MEETING_SLUG constant below -- not a secret, since
 * it is visible in the public booking URL. An env var of the same name wins if set.
 *
 * Service key scopes:
 *   conversations.read                     guard 2 (recent rep texts); optional,
 *     the guard is skipped without it
 *   scheduler.meetings.meeting-link.read   read links, availability and form fields
 *   crm.objects.contacts.write             REQUIRED TO BOOK. With only the read
 *     scope the book endpoint returns 403, not a payload error.
 *
 * Input fields (map every one as String; README Step 8c has the full table):
 *   contact_id        hs_object_id             guard 2
 *   owner_id          hubspot_owner_id         guard 3
 *   next_activity     notes_next_activity_date guard 1
 *   first_name, last_name, email
 *   phone             the contact record's Phone Number property
 *   phone_agent       optional fallback: a number the agent captured, used only
 *                     when the contact record has none
 *   preferred_date    "YYYY-MM-DD"  (agent normalizes this -- extraction, not math)
 *   preferred_period  morning | afternoon | evening | any, or an exact time "18:00"
 *   timezone          the contact's IP Timezone property. HubSpot's slug form
 *                     (america_slash_new_york) is converted automatically
 *   timezone_agent    optional fallback: an IANA name the agent captured
 *   duration_ms       optional; only if the link offers several and you want one
 *   consent_type_id   optional; only if the page requires a consent response
 *   consented         optional; true ONLY if the contact actually opted in
 *   extra_form_fields optional; { fieldName: value } for any other required field
 *
 * Form fields follow the link's own form, read live on every run. The book
 * endpoint rejects a field the form does not have ("formFields contains invalid
 * name(s)") and a required one left out ("required form field ... does not have a
 * corresponding value"). So `phone` is sent only when the link's form has a phone
 * field, and the contact is asked for it only when that field is required.
 *
 * The meeting's activity type is NOT set here. The meeting link carries a
 * "Meeting type" setting -- point it at your AI-booking meeting type and HubSpot
 * stamps every booking made through that link, API or public page alike.
 *
 * Output fields (branch the workflow on booking_status):
 *   booking_status      booked | handed_to_owner | not_scheduled | slot_taken |
 *                       no_availability | needs_email | needs_phone | error
 *                       handed_to_owner = a guard stopped the booking; create a
 *                       task for the contact owner with error_detail as the reason.
 *                       not_scheduled = HubSpot returned 200 but booked nothing
 *                       (offline booking). Treat as a failure needing a human.
 *   checks_note         what the guards saw, on every outcome that ran them
 *   confirmation_text   ready to send as the SMS body, every branch
 *   booking_label       human time that was actually booked
 *   booked_start_ms     epoch millis, if a later action needs the record
 *   booked_duration_ms  the link's own duration, as booked
 *   alternatives_text   times to offer when nothing matched the preference
 *   payload_shape       which body shape HubSpot accepted
 *   calendar_event_id   present only on a real booking
 *   booked_contact_id   the contact HubSpot booked or created
 */

const axios = require('axios');

const HS         = 'https://api.hubapi.com';
// HubSpot moved to date-based versioning; /2026-03/ is current and /v3/ is
// legacy. probe.sh checks both against this portal -- flip if v3 is the one
// that answers.
const SCHEDULER  = '/scheduler/2026-03/meetings/meeting-links';

// The meeting link to book against: the part of the booking URL after
// meetings.hubspot.com/. Not a secret -- it is in the public booking URL.
const MEETING_SLUG = 'your-team/ai-booked-call';
const DEFAULT_TZ = 'America/New_York';
const MAX_ALTS   = 3;

// Owner ids of the reps on the round robin (Meetings > your link > Team members).
// Keep in step with the link: a rep added there but not here gets their own
// contacts handed back as tasks instead of booked. Find the ids with
// GET /crm/v3/owners: the "id" field, not "userId" (README Step 6).
const ROUND_ROBIN_OWNER_IDS = new Set([
  'REPLACE_WITH_OWNER_ID_1',
  'REPLACE_WITH_OWNER_ID_2',
]);

// When the agent may book, in the contact's own time zone. Off by default: every
// day, every hour the link offers, which is whenever a rep's calendar is free. To
// keep bookings to, say, weekdays 9 to 5, set days to Mon-Fri, from 9 and to 17.
// Worth doing if your link is open 24/7 and reps don't block nights on their
// calendars: a free calendar at 3 AM is a bookable 3 AM.
const AGENT_HOURS = {
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  from: 0,
  to: 24,
};

// When the exact day and period they asked for is full, the fallback picks the first
// opening that day or the next. On a 24/7 calendar that would be 12 AM, so the
// fallback prefers openings from this hour on and uses overnight ones only when
// nothing else is left. A time the person asks for directly is never affected.
const FALLBACK_FROM_HOUR = 9;

// Alternatives the texts offer when the requested time is not open: local hours
// from..to (end-exclusive). Openings outside this band are offered only if nothing
// inside it is left. A time the person names exactly is still booked at any hour.
const OFFER_HOURS = { from: 9, to: 21 };

// A rep text this recent means the rep is working the contact. Long enough to cover
// an evening of texting before an overnight agent schedule starts.
const REP_ACTIVE_HOURS = 12;

// The HubSpot inbox channel that mirrors Aloware texts (SMS - Sales inbox).
const ALOWARE_SMS_CHANNEL_ID = 'REPLACE_WITH_CHANNEL_ID';

// Senders on that channel that are people but not a rep working the contact, for
// example a shared team user that team-wide blasts go out as: 'A-<user id>'.
const NOT_A_REP_ACTOR_IDS = new Set([]);

// One line for every guard outcome. It follows the agent's "I put in the request" reply.
const HANDOFF_TEXT =
  "Thanks! I see you're already working with one of our advisors, so they'll " +
  'confirm a time with you directly.';

// Local-hour windows for the contact's stated preference, end-exclusive.
// These narrow HubSpot's offer; they never widen it. Morning starts at 9 AM so a
// "morning" request on a 24/7 calendar does not land at midnight or 6 AM.
// preferred_period can also be an exact time, "18:00" (see parseExactTime): that
// books that time only.
const PERIODS = {
  morning:   [9, 12],
  afternoon: [12, 17],
  evening:   [17, 24],
  any:       [0, 24],
};

/**
 * What to ask for when the link's form requires a field the contact record lacks.
 * Required fields are checked BEFORE the booking call: a missing one is rejected
 * with "required form field <name> does not have a corresponding value", which the
 * contact would hear as "I ran into a problem reaching the calendar" -- useless to
 * them, when the fix is simply to ask for the number.
 */
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
  // HubSpot exposes each selected secret under its own name, so accept whichever
  // one this workflow has rather than forcing a rename. A missing token otherwise
  // shows up as an unexplained 401.
  const token = process.env.HUBSPOT_BOOKING_TOKEN
             || process.env.HUBSPOT_TOKEN;
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

    // Guards first: if the team is already working this contact, book nothing.
    const guard = await checkGuards(input, token, Date.now());
    if (guard.stop) {
      return callback({
        outputFields: {
          booking_status: 'handed_to_owner',
          error_detail: guard.reason,
          checks_note: guard.note,
          confirmation_text: HANDOFF_TEXT,
        },
      });
    }
    let checksNote = guard.note;

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

    // Send only the fields the link's form has; ask for a missing required one
    // instead of failing the booking on it.
    const linkFields = await fetchLinkFormFields({ slug, tz, token });
    if (!linkFields) checksNote += '; link form unreadable, sent no form fields';
    const formFields = buildFormFields(input, linkFields);
    const missing = (linkFields || [])
      .filter(f => f.isRequired)
      .map(f => f.name)
      .find(name => !formFields.some(f => f.name === name && f.value));

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
          ...offer(openings, tz, {
            date: input.preferred_date,
            minutes: parseExactTime(input.preferred_period),
          }),
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

    // An "offline booking" returns HTTP 200 and books NOTHING. Verified against a
    // live portal: isOffline true came back with an empty calendarEventId, and the
    // portal ended up with a contact but no meeting engagement and no calendar
    // event -- nothing on any calendar, nothing in the CRM timeline. It happens
    // when the rep the round robin picked has no reachable calendar.
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
        checks_note: checksNote,
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

/* ---------------------------------------------------------------- guards */

/**
 * Returns { stop, reason, note }. stop is true when the team is already working the
 * contact. note always says what each guard saw, so a run can be audited later.
 */
async function checkGuards(input, token, now) {
  const notes = [];

  const next = toMillis(input.next_activity);
  if (next && next > now) {
    const when = new Date(next).toISOString();
    return {
      stop: true,
      reason: 'The contact already has an upcoming activity (meeting, call or task) on ' +
              when + '. Check it before booking anything new.',
      note: 'next_activity ' + when,
    };
  }
  notes.push('next_activity ' + (next ? 'past' : 'none'));

  const rep = await lastRepText(input.contact_id, token, now);
  notes.push(rep.note);
  if (rep.active) {
    return {
      stop: true,
      reason: 'A rep texted this contact ' + rep.minutesAgo + ' minutes ago, so a rep is ' +
              'working them. The agent did not book.',
      note: notes.join('; '),
    };
  }

  const owner = String(input.owner_id || '').trim();
  if (owner && !ROUND_ROBIN_OWNER_IDS.has(owner)) {
    return {
      stop: true,
      reason: 'The contact owner (owner id ' + owner + ') is not on the round robin, so ' +
              'the call would have gone to another rep. Book it with the owner.',
      note: notes.concat('owner ' + owner + ' not on round robin').join('; '),
    };
  }
  notes.push('owner ' + (owner ? owner + ' on round robin' : 'none'));

  return { stop: false, reason: '', note: notes.join('; ') };
}

/**
 * Most recent text a rep sent the contact on the Aloware SMS channel, within the
 * last REP_ACTIVE_HOURS. Reads the messages themselves: the thread's
 * latestMessageSentTimestamp also moves on the agent's replies, workflow texts and
 * blasts, which would make every request look like a live rep chat.
 *
 * Only threads with any message inside the window are opened (at most 3, newest
 * first, in parallel), and each is paged newest first until the window ends, so a
 * run costs a few calls and stays well inside the 20-second action limit.
 *
 * Fails open: any error (most likely a missing conversations.read scope) skips the
 * guard rather than blocking every booking, and the note records why.
 */
async function lastRepText(contactId, token, now) {
  const id = String(contactId || '').trim();
  if (!id) return { active: false, note: 'rep check skipped: no contact id' };

  const headers = { Authorization: 'Bearer ' + token };
  const since = now - REP_ACTIVE_HOURS * 3600000;

  try {
    const res = await axios.get(HS + '/conversations/v3/conversations/threads', {
      params: { associatedContactId: id, limit: 50 },
      headers,
      timeout: 5000,
    });

    const recent = ((res.data && res.data.results) || [])
      .filter(t => String(t.originalChannelId) === ALOWARE_SMS_CHANNEL_ID &&
                   toMillis(t.latestMessageSentTimestamp) >= since)
      .sort((a, b) => toMillis(b.latestMessageSentTimestamp) - toMillis(a.latestMessageSentTimestamp))
      .slice(0, 3);

    const lasts = await Promise.all(recent.map(t => lastRepTextInThread(t.id, headers, since)));
    const last = Math.max(0, ...lasts);

    if (!last) {
      return { active: false, note: 'no rep text in the last ' + REP_ACTIVE_HOURS + ' h' };
    }

    const minutesAgo = Math.round((now - last) / 60000);
    return { active: true, minutesAgo, note: 'last rep text ' + minutesAgo + ' min ago' };
  } catch (err) {
    const status = err && err.response && err.response.status;
    return {
      active: false,
      note: 'rep check skipped: ' + (status === 401 || status === 403
        ? 'service key lacks conversations.read'
        : String((err && err.message) || err).slice(0, 80)),
    };
  }
}

/**
 * Newest rep text in one thread at or after `since`, or 0. Messages come newest
 * first (checked against the live API); paging stops at the first
 * message older than `since`, and after 3 pages of 100.
 */
async function lastRepTextInThread(threadId, headers, since) {
  let after;
  for (let page = 0; page < 3; page++) {
    const res = await axios.get(
      HS + '/conversations/v3/conversations/threads/' + encodeURIComponent(threadId) + '/messages',
      { params: { limit: 100, sort: '-createdAt', ...(after ? { after } : {}) }, headers, timeout: 5000 }
    );
    const results = (res.data && res.data.results) || [];
    for (const msg of results) {
      const at = toMillis(msg.createdAt);
      if (at && at < since) return 0;              // past the window, nothing newer left
      if (isRepText(msg)) return at;
    }
    after = res.data && res.data.paging && res.data.paging.next && res.data.paging.next.after;
    if (!after) return 0;
  }
  return 0;
}

/**
 * A text a rep sent: an outgoing message whose sender is a HubSpot user
 * (actor id A-<user id>), not a shared team user. The agent, the workflows and the
 * shortcode blasts all appear as X-unknown; the contact appears as V-<contact id>.
 */
function isRepText(msg) {
  if (!msg || msg.type !== 'MESSAGE' || msg.direction !== 'OUTGOING') return false;
  return (msg.senders || []).some(s => {
    const actor = String((s && s.actorId) || '');
    return /^A-\d+$/.test(actor) && !NOT_A_REP_ACTOR_IDS.has(actor);
  });
}

/** HubSpot dates arrive as epoch millis (number or string) or ISO strings. */
function toMillis(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The three alternatives and the sentence offering them, shared by both paths.
 * Only openings between OFFER_HOURS.from and .to (contact time) are offered, unless
 * nothing in that band is left. When the person named an exact time (target.minutes),
 * the three closest to that day and time are offered; otherwise one per day.
 */
function offer(openings, tz, target = {}) {
  const daytime = openings.filter(t => {
    const h = localHour(t, tz);
    return h >= OFFER_HOURS.from && h < OFFER_HOURS.to;
  });
  const pool = daytime.length ? daytime : openings;

  let picks;
  if (target.minutes != null && /^\d{4}-\d{2}-\d{2}$/.test(String(target.date || ''))) {
    const wantDay = Date.parse(target.date + 'T00:00:00Z') / 864e5;
    const distance = (t) => {
      const day = Date.parse(dateKey(t, tz) + 'T00:00:00Z') / 864e5;
      return Math.abs(day - wantDay) * 1440 + Math.abs(localMinutes(t, tz) - target.minutes);
    };
    picks = [...pool].sort((a, b) => distance(a) - distance(b) || a - b)
      .slice(0, MAX_ALTS).sort((a, b) => a - b);
  } else {
    picks = spreadAcrossDays(pool, MAX_ALTS, tz);
  }

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
    // that are merely in the past guards against a stale payload. AGENT_HOURS is
    // the one dial for narrowing what the agent may book.
    openings: starts.filter(t => t > now && inAgentHours(t, tz)).sort((a, b) => a - b),
    duration,
  };
}

/**
 * The link's form fields, as [{ name, isRequired }], read from the booking-info
 * endpoint (customParams.formFields). [] means the form asks for nothing beyond
 * name and email. null means the read failed or
 * the payload had no form list: the caller then sends no form fields, which is
 * right for a link with no fields and fails loudly (a task) if a field is ever required.
 */
async function fetchLinkFormFields({ slug, tz, token }) {
  try {
    const res = await axios.get(HS + SCHEDULER + '/book/' + encodeURIComponent(slug), {
      params: { timezone: tz },
      headers: { Authorization: 'Bearer ' + token },
      timeout: 5000,
    });
    const list = res.data && res.data.customParams && res.data.customParams.formFields;
    if (!Array.isArray(list)) return null;
    return list
      .filter(f => f && f.name)
      .map(f => ({ name: String(f.name), isRequired: f.isRequired === true }));
  } catch (_) {
    return null;
  }
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
 * Registration fields to send beyond name and email: only those the link's form
 * actually has (linkFields from fetchLinkFormFields). Sending a field the form does
 * not have fails the booking with "formFields contains invalid name(s)" -- easy to
 * hit when you switch the agent to a link whose form differs from the old one.
 * With no readable form (null) nothing is sent.
 */
function buildFormFields(input, linkFields) {
  const onForm = new Set((linkFields || []).map(f => f.name));
  const fields = [];

  // The contact record first: the trigger only enrolls contacts that already
  // exist, Aloware syncs their number in, and 561k contacts carry `phone` against
  // 4.3k carrying `mobilephone`. The agent's own capture is the fallback for a
  // record that somehow has no number.
  const phone = normalizePhone(input.phone || input.phone_agent);
  if (phone) fields.push({ name: 'phone', value: phone });

  // Anything else the form demands, passed through as { fieldName: value }.
  const extra = input.extra_form_fields || {};
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') {
      fields.push({ name, value: String(value) });
    }
  }

  return fields.filter(f => onForm.has(f.name));
}

/**
 * Stored numbers come in every format the portal has ever seen -- "(555) 010-0199",
 * "+1 555-010-0142". Normalize the US cases to E.164 so the phonenumber form field
 * gets something it reliably accepts, but pass anything unrecognized through
 * untouched rather than mangling an international number into nonsense.
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
 * Check your own link: if its consent checkbox is optional and processing consent
 * is implicit, a booking succeeds with an empty array.
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
  // An exact time ("18:00") books that opening on that day, or nothing. Never a
  // different time the person did not agree to.
  const exactMinutes = parseExactTime(preferredPeriod);
  if (exactMinutes != null) {
    if (!preferredDate) return null;
    return openings.find(t =>
      dateKey(t, tz) === preferredDate && localMinutes(t, tz) === exactMinutes) || null;
  }

  const period = PERIODS[String(preferredPeriod || 'any').toLowerCase()] || PERIODS.any;
  const inPeriod = (t) => {
    const h = localHour(t, tz);
    return h >= period[0] && h < period[1];
  };

  // Fallbacks prefer a daytime-or-evening opening over an overnight one.
  const firstAwake = (list) =>
    list.find(t => localHour(t, tz) >= FALLBACK_FROM_HOUR) || list[0] || null;

  if (!preferredDate) {
    return openings.find(inPeriod) || firstAwake(openings);
  }

  const onDay = openings.filter(t => dateKey(t, tz) === preferredDate);
  const exact = onDay.find(inPeriod);
  if (exact) return exact;
  if (onDay.length) return firstAwake(onDay);

  const later = openings.filter(t => dateKey(t, tz) >= preferredDate);
  return later.find(inPeriod) || firstAwake(later);
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

const localWeekday = (ms, tz) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(ms));

/** Minutes after local midnight, e.g. 6:30 PM -> 1110. */
function localMinutes(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => Number((parts.find(p => p.type === type) || {}).value || 0);
  return get('hour') * 60 + get('minute');
}

/**
 * An exact time in preferred_period, as the relay sends it: "18:00" (24-hour, also
 * "9:30"). Returns minutes after midnight, or null for a period word or anything else.
 */
function parseExactTime(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when the opening is on an AGENT_HOURS day between .from and .to, contact time. */
function inAgentHours(ms, tz) {
  const h = localHour(ms, tz);
  return AGENT_HOURS.days.includes(localWeekday(ms, tz)) &&
    h >= AGENT_HOURS.from && h < AGENT_HOURS.to;
}

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
  resolveTimezone, PAYLOAD_SHAPE, normalizePhone, fetchLinkFormFields,
  checkGuards, lastRepText, isRepText, toMillis, ROUND_ROBIN_OWNER_IDS, HANDOFF_TEXT,
  inAgentHours, localWeekday, AGENT_HOURS, FALLBACK_FROM_HOUR, OFFER_HOURS,
  parseExactTime, localMinutes, offer, ALOWARE_SMS_CHANNEL_ID, NOT_A_REP_ACTOR_IDS,
};
