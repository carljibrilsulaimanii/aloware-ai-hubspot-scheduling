/**
 * booking-action.test.mjs -- offline checks for src/booking-action.js
 * -------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 *
 * Deploy:  Nowhere. Local only -- run with `npm test` or
 *          `node test/booking-action.test.mjs`. Needs Node 20, no install.
 *
 * What it does:
 *   Stubs axios so the action runs end to end against a fake HubSpot, then
 *   asserts every branch: booked, offline booking, slot taken, config faults,
 *   missing email/phone, the link's live form fields, timezone slugs, consent,
 *   24/7 hours, exact times, and the 160-char SMS ceiling.
 *
 * Why it exists:
 *   Every fault below was invisible from outside the workflow when it happened
 *   for real. The clock is frozen so the fixtures never drift into the past and
 *   start failing on their own.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

const TZ = 'America/New_York';

// Freeze "now" at Tue Sep 1 2026, 10:00 AM EDT, so the fixtures stay in the future forever.
const FROZEN_NOW = Date.UTC(2026, 8, 1, 14, 0);
Date.now = () => FROZEN_NOW;

/* --------------------------------------------------------- axios stub ---- */

let availability = {};
let bookResponse = { calendarEventId: 'evt_test_1', contactId: 311, isOffline: false };
let bookError = null;          // thrown for every attempt
let bookErrorOnce = null;      // thrown only for the first shape
let captured = null;
let attempts = [];

// Nothing here should ever PATCH: the meeting link's own "Meeting type" setting
// stamps the activity type, so the action has no reason to write to the CRM.
let patchCalls = 0;

// The link's form, as the booking-info endpoint returns it (customParams.formFields).
// Default [] = a link with no form fields. 'unreachable' throws.
let linkFormFields = [];

const axiosStub = {
  async get(url) {
    // Booking info (form fields) is /book/<slug>; availability is /book/availability-page/<slug>.
    if (/\/book\/(?!availability-page)/.test(url)) {
      if (linkFormFields === 'unreachable') throw new Error('ETIMEDOUT');
      return { data: { linkId: '1', customParams: { formFields: linkFormFields } } };
    }
    if (availability === 'unreachable') throw new Error('ETIMEDOUT');
    return { data: availability };
  },
  async post(url, body) {
    attempts.push(body);
    captured = body;
    if (bookError) throw bookError;
    if (bookErrorOnce && attempts.length === 1) throw bookErrorOnce;
    return { data: bookResponse };
  },
  async patch() {
    patchCalls++;
    return { data: {} };
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'axios') return axiosStub;
  return load.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const action = require('../src/booking-action.js');
const T = action.__test;

process.env.HUBSPOT_BOOKING_TOKEN = 'pat-test';
process.env.MEETING_SLUG = 'acme/ai-booked-call';

/* ------------------------------------------------------------ fixtures --- */

// September 2026 is EDT (UTC-4).
const et = (day, hour, min = 0) => Date.UTC(2026, 8, day, hour + 4, min);

const SEP8_9AM  = et(8, 9);
const SEP8_2PM  = et(8, 14);
const SEP8_4PM  = et(8, 16);
const SEP9_10AM = et(9, 10);
const SEP10_3PM = et(10, 15);

const MIN30 = 30 * 60 * 1000;
const MIN45 = 45 * 60 * 1000;

const all = [SEP8_9AM, SEP8_2PM, SEP8_4PM, SEP9_10AM, SEP10_3PM];

// Mirrors the real payload: duration-keyed availability PLUS busy blocks that
// carry start times of their own.
const availabilityPayload = (times, { duration = MIN30, busy = [] } = {}) => ({
  linkAvailability: {
    linkAvailabilityByDuration: {
      [duration]: {
        meetingDurationMillis: duration,   // present in the real response
        availabilities: times.map(t => ({ startMillisUtc: t, endMillisUtc: t + duration })),
      },
    },
  },
  allUsersBusyTimes: [{ busyTimes: busy.map(t => ({ start: t, end: t + 3600000 })) }],
  duration,          // must NOT be harvested as a start time
  slotCount: times.length,
});

const DEFAULT_PHONE = '5550100123';

/**
 * The action reads the link's form on every run. A link with no form fields is the
 * default here. withPhoneField(true) switches the stub to a link whose form requires
 * a phone number, so both stay covered;
 * getting this wrong in either direction breaks every booking.
 */
const PHONE_FIELD = { name: 'phone', label: 'Phone Number', fieldType: 'phonenumber',
                      type: 'string', isCustom: false, isRequired: true };
const withPhoneField = (on) => { linkFormFields = on ? [PHONE_FIELD] : []; };

const run = (inputFields) =>
  new Promise((resolve) =>
    action.main({ inputFields: { phone: DEFAULT_PHONE, ...inputFields } }, resolve));

const runBare = (inputFields) =>
  new Promise((resolve) => action.main({ inputFields }, resolve));

const reset = () => {
  availability = availabilityPayload(all);
  bookError = null;
  bookErrorOnce = null;
  captured = null;
  attempts = [];
  patchCalls = 0;
  bookResponse = { calendarEventId: 'evt_test_1', contactId: 311, isOffline: false };
};

let out;

/* ---------------------------- verbatim shape of the real 2026-03 response - */

// Shape copied from a live availability GET. The duration
// key is in MILLISECONDS, the bucket repeats it as meetingDurationMillis, and
// slots are 15 minutes apart on a 30-minute meeting.
const REAL = {
  linkAvailability: {
    linkAvailabilityByDuration: {
      '1800000': {
        meetingDurationMillis: 1800000,
        availabilities: [
          { startMillisUtc: 1787159700000, endMillisUtc: 1787161500000 },
          { startMillisUtc: 1787160600000, endMillisUtc: 1787162400000 },
          { startMillisUtc: 1787161500000, endMillisUtc: 1787163300000 },
          { startMillisUtc: 1787230800000, endMillisUtc: 1787232600000 },
        ],
      },
    },
  },
};

const realRead = T.readAvailability(REAL, null);
assert.equal(realRead.duration, 1800000, 'duration key is millis, read as-is');
assert.deepEqual(realRead.starts,
  [1787159700000, 1787160600000, 1787161500000, 1787230800000],
  'every offered slot, in order');
assert.ok(!realRead.starts.includes(1800000), 'meetingDurationMillis is not a slot');
assert.equal(T.shortLabel(1787159700000, TZ), 'Wed Aug 19 at 1:15 PM EDT',
  'renders the same wall-clock time the booking page shows');

/* ------------------------------- owner's rules are HubSpot's to enforce -- */

// A busy block is not an opening. Harvesting one would book a contact straight
// into a rep's existing meeting.
const BUSY = et(11, 13);
const read = T.readAvailability(availabilityPayload([SEP8_9AM, SEP8_2PM], { busy: [BUSY] }), null);

assert.deepEqual(read.starts, [SEP8_9AM, SEP8_2PM], 'only real openings');
assert.ok(!read.starts.includes(BUSY), 'busy times must never be offered');
assert.equal(read.duration, MIN30, 'duration comes from the link, not a constant');
assert.ok(!read.starts.includes(MIN30), 'duration is not a start time');

// A link configured for 45 minutes books 45 minutes.
assert.equal(T.readAvailability(availabilityPayload([SEP8_9AM], { duration: MIN45 }), null).duration, MIN45);

// When a link offers several lengths, an explicit request picks one.
const multi = {
  linkAvailability: {
    linkAvailabilityByDuration: {
      [MIN30]: { availabilities: [{ startMillisUtc: SEP8_9AM }] },
      [MIN45]: { availabilities: [{ startMillisUtc: SEP8_2PM }] },
    },
  },
};
assert.equal(T.readAvailability(multi, MIN45).duration, MIN45, 'honors the requested length');
assert.deepEqual(T.readAvailability(multi, MIN45).starts, [SEP8_2PM]);
assert.equal(T.readAvailability(multi, null).duration, MIN30, 'defaults to the shortest offered');
assert.equal(T.readAvailability(multi, 999).duration, MIN30, 'ignores a length not on offer');

// Minimum notice belongs to the link. A slot ten minutes out is offered if
// HubSpot offered it -- this action adds no lead time of its own.
const SOON = Date.now() + 10 * 60 * 1000;
availability = availabilityPayload([SOON]);
out = (await run({ first_name: 'Soon', email: 's@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'booked', 'no invented minimum notice');
assert.equal(captured.startTime, SOON, 'epoch millis -- the shape the API accepts');

// A start time already in the past is dropped as stale, which is not a rule.
availability = availabilityPayload([Date.now() - 60 * 60 * 1000]);
out = (await run({ first_name: 'Past', email: 'p@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'no_availability');

/* --------------------------- a missing secret says so, not 401 ----------- */

const savedKey = process.env.HUBSPOT_BOOKING_TOKEN;
delete process.env.HUBSPOT_BOOKING_TOKEN;
reset();
out = (await run({ first_name: 'NoKey', email: 'n@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'error');
assert.match(out.error_detail, /HUBSPOT_BOOKING_TOKEN/, 'names the secret to look for');
process.env.HUBSPOT_BOOKING_TOKEN = savedKey;

/* ------------------------------- HubSpot's timezone slugs, not IANA ------- */

// Real IP Timezone values as HubSpot stores them.
assert.equal(T.ianaFromHubSpot('america_slash_new_york'), 'America/New_York');
assert.equal(T.ianaFromHubSpot('america_slash_chicago'), 'America/Chicago');
assert.equal(T.ianaFromHubSpot('america_slash_los_angeles'), 'America/Los_Angeles');
assert.equal(T.ianaFromHubSpot('america_slash_detroit'), 'America/Detroit');
assert.equal(
  T.ianaFromHubSpot('america_slash_indiana_slash_indianapolis'),
  'America/Indiana/Indianapolis',
  'three-segment zones survive the conversion'
);
assert.equal(T.ianaFromHubSpot('America/New_York'), 'America/New_York', 'IANA passes through');
assert.equal(T.ianaFromHubSpot(''), '');
assert.equal(T.ianaFromHubSpot(null), '');

// Every converted value must be one Intl actually accepts -- the whole point.
for (const slug of ['america_slash_new_york', 'america_slash_chicago',
                    'america_slash_los_angeles', 'america_slash_detroit',
                    'america_slash_indiana_slash_indianapolis']) {
  assert.ok(T.isUsableZone(T.ianaFromHubSpot(slug)), `${slug} must convert to a real zone`);
}
assert.equal(T.isUsableZone('america_slash_new_york'), false, 'the raw slug is NOT usable');
assert.equal(T.isUsableZone('Mars/Olympus_Mons'), false);
assert.equal(T.isUsableZone(''), false);

// Preference order: contact's own zone, then the agent's, then the office.
assert.equal(T.resolveTimezone('america_slash_chicago', 'America/New_York'), 'America/Chicago');
assert.equal(T.resolveTimezone('', 'America/Denver'), 'America/Denver', 'falls back to the agent');
assert.equal(T.resolveTimezone('', ''), TZ, 'falls back to Eastern');
assert.equal(T.resolveTimezone('garbage_value', 'America/Denver'), 'America/Denver',
  'a bad IP Timezone must not take the booking down');
assert.equal(T.resolveTimezone('garbage', 'also_garbage'), TZ);

// End to end: a Chicago contact is told the time in Chicago, not Eastern.
reset();
out = (await run({
  first_name: 'Chicago', email: 'c@example.com', phone: '5550100123',
  timezone: 'america_slash_chicago',
  preferred_date: '2026-09-08', preferred_period: 'afternoon',
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.match(out.confirmation_text, /CDT/, 'stated in the contact own zone');
assert.doesNotMatch(out.confirmation_text, /EDT/);

/* ------------------------------------------------------------- helpers --- */

assert.equal(T.dateKey(SEP8_9AM, TZ), '2026-09-08');
assert.equal(T.localHour(SEP8_9AM, TZ), 9);
assert.equal(T.localHour(SEP8_2PM, TZ), 14);

assert.equal(T.humanList(['a', 'b', 'c']), 'a, b, or c');
assert.equal(T.humanList(['a']), 'a');
assert.equal(T.humanList([]), '');

assert.equal(T.shortLabel(SEP8_2PM, TZ), 'Tue Sep 8 at 2:00 PM EDT');
assert.equal(T.shortLabel(SEP8_2PM, TZ, false), 'Tue Sep 8 at 2:00 PM');

assert.deepEqual(
  T.normalizeNames({ first_name: 'Jordan Rivera', email: ' Jordan@Example.com ' }),
  { firstName: 'Jordan', lastName: 'Rivera', email: 'jordan@example.com' }
);
assert.equal(T.normalizeNames({ first_name: 'Cher' }).lastName, '-', 'HubSpot rejects empty last name');

/* ------------------------------------------- preference walks outward ---- */

assert.equal(T.chooseSlot(all, '2026-09-08', 'afternoon', TZ), SEP8_2PM, 'exact day + period wins');
assert.equal(T.chooseSlot(all, '2026-09-09', 'afternoon', TZ), SEP9_10AM, 'same day beats same period');
assert.equal(T.chooseSlot(all, '2026-09-07', 'afternoon', TZ), SEP8_2PM, 'rolls forward');
assert.equal(T.chooseSlot(all, null, 'morning', TZ), SEP8_9AM, 'earliest in the period');
assert.equal(T.chooseSlot(all, '2026-12-01', 'any', TZ), null, 'nothing left -> offer alternatives');

assert.deepEqual(
  T.spreadAcrossDays(all, 3, TZ), [SEP8_9AM, SEP9_10AM, SEP10_3PM],
  'alternatives land on three different days'
);

/* --------------------------------------------------------- end to end ---- */

reset();

// 1. Happy path.
out = (await run({
  first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.com',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;

assert.equal(out.booking_status, 'booked');
assert.equal(out.booked_start_ms, SEP8_2PM);
assert.equal(out.booked_duration_ms, MIN30);
assert.match(out.confirmation_text, /^You're all set for Tue Sep 8 at 2:00 PM EDT\./, 'SMS short form');
assert.equal(out.booking_label, 'Tuesday, September 8 at 2:00 PM EDT', 'CRM long form');
assert.equal(captured.startTime, SEP8_2PM,
  'books the exact epoch HubSpot offered, never a re-derived one');
assert.equal(captured.duration, MIN30, "books the link's own duration, in millis");
assert.equal(captured.slug, 'acme/ai-booked-call');
assert.equal(captured.email, 'alex@example.com');
assert.equal(patchCalls, 0, 'the link stamps the activity type; the action writes nothing to the CRM');

/* ------------- a link with no phone field sends none and asks for none --- */

// A link with no phone field rejects a booking that sends one anyway, with
// "formFields contains invalid name(s)".
withPhoneField(false);
reset();
out = (await run({
  first_name: 'NoField', email: 'nf@example.com', phone: '(555) 010-0199',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'booked', 'a phone on the record is not a reason to fail');
assert.deepEqual(captured.formFields, [], 'sends no phone to a form without a phone field');

// No phone at all on a form that does not ask for one: still books, never asks.
reset();
out = (await runBare({ first_name: 'NoPhoneOk', email: 'npo@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'booked');

// The form can't be read: send nothing and say so, rather than guess.
reset();
linkFormFields = 'unreachable';
out = (await run({ first_name: 'Unread', email: 'u@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'booked');
assert.deepEqual(captured.formFields, []);
assert.match(out.checks_note, /link form unreadable/);
withPhoneField(false);

/* ------------------ a missing required field is a question, not a crash -- */

withPhoneField(true);

// A phone-required link rejects a booking without one with
// "required form field phone does not have a corresponding value", which the
// contact would hear as a calendar problem. Ask them instead.
reset();
out = (await runBare({
  first_name: 'NoPhone', email: 'np@example.com',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'needs_phone');
assert.match(out.confirmation_text, /phone number/i, 'asks for the number');
assert.doesNotMatch(out.confirmation_text, /problem reaching/, 'not a generic failure');
assert.equal(captured, null, 'never calls the booking API without it');

// Typical stored formats, normalized to what the form accepts.
assert.equal(T.normalizePhone('(555) 010-0199'), '+15550100199');
assert.equal(T.normalizePhone('+1 555-010-0142'), '+15550100142');
assert.equal(T.normalizePhone('5550100123'), '+15550100123');
assert.equal(T.normalizePhone(' 1-555-010-0123 '), '+15550100123');
assert.equal(T.normalizePhone('+44 20 7946 0958'), '+442079460958', 'international kept');
assert.equal(T.normalizePhone('ext 401'), 'ext 401', 'unrecognized passes through, not mangled');
assert.equal(T.normalizePhone(''), '');
assert.equal(T.normalizePhone(null), '');

// The contact record is the primary source.
reset();
out = (await runBare({
  first_name: 'FromRecord', email: 'fr@example.com', phone: '(555) 010-0199',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.deepEqual(captured.formFields, [{ name: 'phone', value: '+15550100199' }]);

// The agent's capture only fills in when the record has none.
reset();
await runBare({
  first_name: 'Fallback', email: 'b@example.com', phone_agent: '5550100177', timezone: TZ,
});
assert.equal(captured.formFields[0].value, '+15550100177');

reset();
await runBare({
  first_name: 'Both', email: 'b@example.com',
  phone: '5550100123', phone_agent: '5550100177', timezone: TZ,
});
assert.equal(captured.formFields[0].value, '+15550100123', 'record wins');

/* ------------------------------- required registration fields ------------ */

// A link whose form requires a phone number: omit it and HubSpot rejects
// the booking, so it has to travel as a form field.
reset();
out = (await run({
  first_name: 'Alex', email: 'alex@example.com', phone: '(555) 010-0123',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.deepEqual(captured.formFields, [{ name: 'phone', value: '+15550100123' }]);

// Anything else the form has passes through the same way; a field the form does not
// have is dropped (HubSpot rejects it).
reset();
linkFormFields = [PHONE_FIELD, { name: 'company', isRequired: false }, { name: 'blank', isRequired: false }];
await run({
  first_name: 'Alex', email: 'r@example.com', phone: '5550100123', timezone: TZ,
  extra_form_fields: { company: 'Acme Co', blank: '', notOnForm: 'x' },
});
assert.deepEqual(captured.formFields, [
  { name: 'phone', value: '+15550100123' },
  { name: 'company', value: 'Acme Co' },
], 'empty values and fields not on the form are dropped');
withPhoneField(true);

assert.deepEqual(T.buildFormFields({}, []), [], 'nothing to send is an empty array');
assert.deepEqual(T.buildFormFields({ phone: '5550100123' }, []), [], 'no phone field, no phone');
assert.deepEqual(T.buildFormFields({ phone: '5550100123' }, null), [], 'unreadable form, nothing sent');

/* -------------------------------------- consent is never fabricated ------ */

// No consent id configured -> send nothing rather than inventing a response.
reset();
await run({ first_name: 'A', email: 'a@example.com', timezone: TZ });
assert.deepEqual(captured.legalConsentResponses, []);

// Configured but not opted in -> recorded as false, not true.
assert.deepEqual(
  T.buildConsent({ consent_type_id: '7' }),
  [{ communicationTypeId: '7', consented: false }],
  'silence is not consent'
);
assert.deepEqual(
  T.buildConsent({ consent_type_id: '7', consented: true }),
  [{ communicationTypeId: '7', consented: true }]
);
assert.equal(T.buildConsent({ consented: true }).length, 0, 'no id, nothing to answer');

/* ---------------------- one payload shape, and only one attempt ---------- */

// Exactly one POST. A retry in a different shape would overwrite the real error
// with a bogus duration complaint -- which is what happened against a live portal.
reset();
await run({
  first_name: 'Shape', email: 's@example.com',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
});
assert.equal(attempts.length, 1, 'never retries in another shape');
assert.equal(attempts[0].startTime, SEP8_2PM, 'epoch millis start');
assert.equal(attempts[0].duration, MIN30, 'duration in millis, as the link wants');

/* ------------------- a misconfiguration is not a taken slot -------------- */

const hsError = (status, body) =>
  Object.assign(new Error('http ' + status), { response: { status, data: body } });

// A real rejection seen live. Reporting this as slot_taken would send
// the contact round a loop that can never succeed.
assert.equal(T.isSlotConflict(hsError(400, {
  message: 'Duration is not accepted by link',
  category: 'VALIDATION_ERROR',
  subCategory: 'MeetingsBookingSchedulingError.MEETING_DURATION_NOT_VALID',
})), false, 'a duration fault is a config error, not a full calendar');

assert.equal(T.isSlotConflict(hsError(409, {})), true, 'a 409 is always a conflict');
assert.equal(T.isSlotConflict(hsError(400, {
  subCategory: 'MeetingsBookingSchedulingError.MEETING_TIME_NOT_AVAILABLE',
})), true, 'an unavailable time is a conflict');
assert.equal(T.isSlotConflict(hsError(400, { message: 'Missing required form field' })),
  false, 'a form fault is a config error');
assert.equal(T.isSlotConflict(hsError(401, {})), false);
assert.equal(T.isSlotConflict(new Error('ETIMEDOUT')), false, 'no response is not a conflict');

// End to end: a config fault surfaces as error with the real message intact.
reset();
bookError = hsError(400, {
  message: 'Duration is not accepted by link',
  category: 'VALIDATION_ERROR',
  subCategory: 'MeetingsBookingSchedulingError.MEETING_DURATION_NOT_VALID',
});
out = (await run({
  first_name: 'Config', email: 'c@example.com',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'error', 'not slot_taken');
assert.match(out.error_detail, /MEETING_DURATION_NOT_VALID/, 'keeps the diagnosis');
assert.doesNotMatch(out.confirmation_text, /just taken/, 'does not blame the calendar');
bookError = null;

// 2. No email -> ask, without touching the calendar. Email is checked before the
// form fields, so a contact missing both is asked for the email first.
out = (await runBare({ first_name: 'Alex', preferred_date: '2026-09-08' })).outputFields;
assert.equal(out.booking_status, 'needs_email', 'email question comes first');
assert.match(out.confirmation_text, /email address/i);

// 3. Preference impossible -> offer real alternatives.
out = (await run({
  first_name: 'Taylor Brooks', email: 't@example.com',
  preferred_date: '2026-12-01', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'slot_taken');
assert.match(out.alternatives_text, /^Tue Sep 8.*Wed Sep 9.*or Thu Sep 10 at 3:00 PM EDT$/);

// 4. Slot grabbed between read and write -> come back with what is left.
bookError = Object.assign(new Error('conflict'), { response: { status: 409 } });
out = (await run({
  first_name: 'Sam', email: 'n@example.com',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'slot_taken');
assert.match(out.confirmation_text, /just taken\. I do have Tue Sep 8/, 'offers times, not a promise');
assert.ok(out.alternatives_text, 'same output shape as the other slot_taken branch');
bookError = null;

// 5. Empty calendar.
availability = availabilityPayload([]);
out = (await run({ first_name: 'Casey', email: 'm@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'no_availability');

// 6. HubSpot unreachable -> graceful hand-off, workflow still branches.
availability = 'unreachable';
out = (await run({ first_name: 'Riley', email: 'a@example.com', timezone: TZ })).outputFields;
assert.equal(out.booking_status, 'error');
assert.match(out.confirmation_text, /follow up with you shortly/);

/* --------------------------- the silent failure: an offline booking ------- */

// HTTP 200, meeting created, contact notified -- and no calendar event, because
// the assigned rep's calendar is unreachable. Seen for real when the round robin
// handed the slot to a rep whose calendar connection had dropped.
reset();
bookResponse = {
  calendarEventId: '',          // empty, not missing
  contactId: '100000000001',
  isOffline: true,
  start: '2026-09-08T18:00:00Z',
  duration: 1800000,
};
out = (await run({
  first_name: 'Offline', email: 'o@example.com', phone: '5550100123',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;

// Verified live: an offline booking left a contact behind and
// NO meeting engagement and NO calendar event. Nothing was scheduled anywhere, so
// promising the contact a time would be a lie.
assert.equal(out.booking_status, 'not_scheduled', 'not "booked" -- nothing exists');
assert.doesNotMatch(out.confirmation_text, /all set|you're booked/i,
  'must not promise a meeting that does not exist');
assert.match(out.confirmation_text, /follow up/i, 'hands off to a human instead');
assert.match(out.error_detail, /no connected calendar/);
assert.equal(out.booked_contact_id, '100000000001');

// A healthy booking says so, and carries no warning to branch on.
reset();
out = (await run({
  first_name: 'Healthy', email: 'h@example.com', phone: '5550100123',
  preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.equal(out.calendar_event_id, 'evt_test_1');
assert.match(out.confirmation_text, /all set/);

// isOffline false but an empty event id is still not synced.
reset();
bookResponse = { calendarEventId: '', contactId: 311, isOffline: false };
out = (await run({
  first_name: 'Edge', email: 'e@example.com', phone: '5550100123', timezone: TZ,
})).outputFields;
assert.equal(out.booking_status, 'not_scheduled',
  'no event id means nothing was scheduled, whatever isOffline says');

/* -------------------------------------------- message length ceiling ----- */

// Aloware caps a single SMS at 160 characters. Nothing here sends SMS directly,
// but confirmation_text is what lands in a task body or an Aloware sequence
// field, so keep every branch inside the ceiling.
const SMS_MAX = 160;
withPhoneField(false);
reset();

for (const [name, fields] of [
  ['booked', { first_name: 'Alex', last_name: 'Morgan', email: 'alex.morgan@somewhatlongdomain.com',
               preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ }],
  ['alternatives', { first_name: 'Taylor', email: 'taylor@example.com',
                     preferred_date: '2026-12-01', timezone: TZ }],
  ['needs_email', { first_name: 'Alex', email: '' }],
]) {
  const text = (await run(fields)).outputFields.confirmation_text;
  assert.ok(text.length <= SMS_MAX,
    `${name} branch is ${text.length} chars, over ${SMS_MAX}: ${text}`);
}

/* ------------- AGENT_HOURS: 24/7, with a 9 AM fallback ------------------------ */
// A link open 24/7, so night and weekend slots really come back.

const SEP5_SAT_10AM = et(5, 10);           // Saturday
const SEP8_MIDNIGHT = et(8, 0);            // Tuesday 12:00 AM
const SEP8_8PM      = et(8, 20);           // Tuesday 8:00 PM
assert.equal(T.inAgentHours(SEP5_SAT_10AM, TZ), true, 'weekends are open');
assert.equal(T.inAgentHours(SEP8_MIDNIGHT, TZ), true, 'midnight is open');
assert.equal(T.inAgentHours(SEP8_8PM, TZ), true, 'evenings are open');
assert.equal(T.FALLBACK_FROM_HOUR, 9);

// A "morning" request never lands at midnight: morning starts at 9 AM.
reset();
availability = availabilityPayload([SEP8_MIDNIGHT, SEP8_9AM, SEP8_8PM]);
out = (await run({
  first_name: 'Early', email: 'e@example.com', phone: '5550100123', timezone: TZ,
  preferred_date: '2026-09-08', preferred_period: 'morning',
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.equal(captured.startTime, SEP8_9AM, 'midnight is not a morning call');

// "Evening" books the evening slot now that evenings are open.
reset();
availability = availabilityPayload([SEP8_MIDNIGHT, SEP8_9AM, SEP8_8PM]);
out = (await run({
  first_name: 'Night', email: 'n2@example.com', phone: '5550100123', timezone: TZ,
  preferred_date: '2026-09-08', preferred_period: 'evening',
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.equal(captured.startTime, SEP8_8PM);

// Period full: the fallback skips the overnight slot for the 8 PM one.
reset();
availability = availabilityPayload([SEP8_MIDNIGHT, SEP8_8PM]);
out = (await run({
  first_name: 'Fallback', email: 'f@example.com', phone: '5550100123', timezone: TZ,
  preferred_date: '2026-09-08', preferred_period: 'morning',
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.equal(captured.startTime, SEP8_8PM, 'fallback prefers 9 AM onward over 12 AM');

// Weekend: a Saturday request books Saturday.
reset();
availability = availabilityPayload([SEP5_SAT_10AM]);
out = (await run({
  first_name: 'Weekend', email: 'w@example.com', phone: '5550100123', timezone: TZ,
  preferred_date: '2026-09-05', preferred_period: 'morning',
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.equal(captured.startTime, SEP5_SAT_10AM, 'weekends can be booked');

/* ---------- exact times ----------------------------------------------------------- */

assert.equal(T.parseExactTime('18:00'), 1080);
assert.equal(T.parseExactTime('9:30'), 570);
assert.equal(T.parseExactTime('evening'), null);
assert.equal(T.parseExactTime('25:00'), null);
assert.equal(T.parseExactTime(''), null);

const SEP8_6PM  = et(8, 18);
const SEP8_7PM  = et(8, 19);
const SEP9_6PM  = et(9, 18);

// "18:00" books 6 PM, not the first opening of the day.
reset();
availability = availabilityPayload([SEP8_9AM, SEP8_2PM, SEP8_6PM, SEP8_8PM]);
out = (await run({
  first_name: 'Exact', email: 'x@example.com', phone: '5550100123', timezone: TZ,
  preferred_date: '2026-09-08', preferred_period: '18:00',
})).outputFields;
assert.equal(out.booking_status, 'booked');
assert.equal(captured.startTime, SEP8_6PM, 'exact time booked');

// "18:00" not open: nothing is booked, and the closest times are offered instead.
reset();
availability = availabilityPayload([SEP8_MIDNIGHT, SEP8_9AM, SEP8_7PM, SEP8_8PM, SEP9_6PM]);
out = (await run({
  first_name: 'Taken', email: 't@example.com', phone: '5550100123', timezone: TZ,
  preferred_date: '2026-09-08', preferred_period: '18:00',
})).outputFields;
assert.equal(out.booking_status, 'slot_taken', 'never books a time they did not agree to');
assert.equal(captured, null, 'nothing booked');
assert.match(out.confirmation_text, /7:00 PM/);
assert.match(out.confirmation_text, /8:00 PM/);
assert.doesNotMatch(out.confirmation_text, /12:00 AM/, 'no midnight alternatives');

// Plain alternatives stay between 9 AM and 9 PM when anything there is open.
const alts = T.offer([SEP8_MIDNIGHT, et(9, 6), SEP9_10AM, SEP10_3PM, et(10, 23)], TZ);
assert.doesNotMatch(alts.confirmation_text, /12:00 AM|6:00 AM|11:00 PM/);

console.log('all checks passed');
