/**
 * refresh-slots-action.test.mjs -- offline checks for src/refresh-slots-action.js
 * -------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman (with Claude Code)
 *
 * Run:     npm test   (Node 20, no install)
 *
 * What it does:
 *   Stubs axios, runs the refresh, and checks what lands on the cache record: the offer
 *   text, one table line per morning and afternoon, no busy blocks, no evenings, no past
 *   times, an empty calendar, missing secrets and HubSpot errors. Then it loads
 *   src/booking-action.js and proves that for every table line, request_booking given that
 *   date and period books exactly the time the line shows.
 *
 * Why it exists:
 *   The agent copies the date and period from a line into request_booking. If the cache
 *   and the booking action disagree, a contact is booked at a different time than the one
 *   they were offered, silently.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';

const TZ = 'America/New_York';
const FROZEN_NOW = Date.UTC(2026, 9, 12, 12);      // Mon Oct 12 2026, 8:00 AM EDT
Date.now = () => FROZEN_NOW;

/* --------------------------------------------------------- axios stub ---- */

let availability = {};
let patched = null;
let getError = null;
let gotUrl = '';

const axiosStub = {
  async get(url) {
    gotUrl = url;
    if (getError) throw getError;
    return { data: availability };
  },
  async patch(url, body) {
    patched = { url, properties: body.properties };
    return { data: {} };
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'axios') return axiosStub;
  return load.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const action = require('../src/refresh-slots-action.js');
const booking = require('../src/booking-action.js');
const T = action.__test;

process.env.HUBSPOT_BOOKING_TOKEN = 'pat-test';
process.env.SLOT_CACHE_TYPE = '2-00000000';
process.env.SLOT_CACHE_ID = '9001';

/* ------------------------------------------------------------ fixtures --- */

// October 2026 is EDT (UTC-4) until Nov 1.
const et = (day, hour, min = 0) => Date.UTC(2026, 9, day, hour + 4, min);

const PAST      = et(12, 7);         // before "now"
const MON_930   = et(12, 9, 30);
const MON_1000  = et(12, 10);        // second morning slot, must not get its own line
const MON_1300  = et(12, 13);
const TUE_1400  = et(13, 14);
const TUE_1530  = et(13, 15, 30);
const WED_1100  = et(14, 11);
const WED_1800  = et(14, 18);        // evening, never offered
const THU_0900  = et(15, 9);
const BUSY      = et(16, 10);

const payload = (times, busy = []) => ({
  linkAvailability: {
    linkAvailabilityByDuration: {
      1800000: {
        meetingDurationMillis: 1800000,
        availabilities: times.map(t => ({ startMillisUtc: t, endMillisUtc: t + 1800000 })),
      },
    },
  },
  allUsersBusyTimes: [{ busyTimes: busy.map(t => ({ start: t, end: t + 3600000 })) }],
});
const ALL = [PAST, MON_930, MON_1000, MON_1300, TUE_1400, TUE_1530, WED_1100, WED_1800, THU_0900];

const run = (inputFields = {}) => new Promise((resolve) => action.main({ inputFields }, resolve));
const reset = (times = ALL, busy = [BUSY]) => {
  availability = payload(times, busy);
  patched = null;
  getError = null;
};

let out;

/* ---------------------------------------------------------- happy path --- */

reset();
out = (await run({ timezone: TZ })).outputFields;
assert.equal(out.refresh_status, 'ok');
assert.match(patched.url, /\/crm\/v3\/objects\/2-00000000\/9001$/);
assert.match(gotUrl, /availability-page\/your-team%2Fai-booked-call$/);

const p = patched.properties;
assert.equal(
  p.slot_table,
  [
    'Mon Oct 12 at 9:30 AM EDT = 2026-10-12 morning',
    'Mon Oct 12 at 1:00 PM EDT = 2026-10-12 afternoon',
    'Tue Oct 13 at 2:00 PM EDT = 2026-10-13 afternoon',
    'Wed Oct 14 at 11:00 AM EDT = 2026-10-14 morning',
    'Thu Oct 15 at 9:00 AM EDT = 2026-10-15 morning',
  ].join('\n'),
  'one line per day and period, first opening only, no evening, no past, no busy'
);
assert.equal(p.slot_table_count, '5');
assert.equal(out.slot_table_count, 5);

assert.equal(
  p.slot_offer_text,
  'I have Mon Oct 12 at 9:30 AM EDT, Tue Oct 13 at 2:00 PM EDT, or Wed Oct 14 at 11:00 AM EDT. Which works best for you?'
);
assert.equal(p.slot_count, '3');
assert.match(p.slot_refreshed_at, /^\d{4}-\d{2}-\d{2}T/);

// Every offered time is also a table line, so the agent can find its date and period.
for (const label of p.slot_offer_text.replace(/^I have |\. Which works best for you\?$/g, '').split(/, or |, /)) {
  assert.ok(p.slot_table.split('\n').some(l => l.startsWith(label + ' = ')), 'offered time missing from table: ' + label);
}

/* ------------------- the booking action books exactly the time each line shows */

const openForBooking = ALL.filter(t => t > FROZEN_NOW).sort((a, b) => a - b);
for (const line of p.slot_table.split('\n')) {
  const [label, rest] = line.split(' = ');
  const [date, period] = rest.split(' ');
  const booked = booking.__test.chooseSlot(openForBooking, date, period, TZ);
  assert.equal(T.shortLabel(booked, TZ), label, 'request_booking(' + date + ', ' + period + ') books a different time');
}

// Same calendar in both files.
const bookingSrc = fs.readFileSync(new URL('../src/booking-action.js', import.meta.url), 'utf8');
assert.equal(bookingSrc.match(/const MEETING_SLUG = '([^']+)'/)[1], T.MEETING_SLUG, 'MEETING_SLUG must match booking-action.js');

/* ------------------------------------------------------- empty calendar --- */

reset([], []);
out = (await run()).outputFields;
assert.equal(out.refresh_status, 'ok');
assert.equal(patched.properties.slot_table, 'NONE');
assert.equal(patched.properties.slot_count, '0');
assert.match(patched.properties.slot_offer_text, /reach out to you directly/);

/* -------------------------------------------- errors never fail a workflow --- */

reset();
getError = Object.assign(new Error('boom'), { response: { data: { message: 'rate limited' } } });
out = (await run()).outputFields;
assert.equal(out.refresh_status, 'error');
assert.match(out.error_detail, /rate limited/);
assert.equal(patched, null, 'nothing written when availability fails');

delete process.env.HUBSPOT_BOOKING_TOKEN;
reset();
out = (await run()).outputFields;
assert.equal(out.refresh_status, 'error');
assert.match(out.error_detail, /HUBSPOT_BOOKING_TOKEN/);
process.env.HUBSPOT_BOOKING_TOKEN = 'pat-test';

// Without the override secrets, the built-in object and record ids are used.
delete process.env.SLOT_CACHE_TYPE;
delete process.env.SLOT_CACHE_ID;
reset();
await run();
assert.match(patched.url, /\/crm\/v3\/objects\/REPLACE_WITH_TYPE_ID\/REPLACE_WITH_RECORD_ID$/);
process.env.SLOT_CACHE_TYPE = '2-00000000';
process.env.SLOT_CACHE_ID = '9001';

/* ----------------------------------------------------------- timezones --- */

assert.equal(T.resolveTimezone('america_slash_chicago'), 'America/Chicago');
assert.equal(T.resolveTimezone('not a zone'), 'America/New_York');
reset();
await run({ timezone: 'america_slash_chicago' });
assert.match(patched.properties.slot_table.split('\n')[0], /^Mon Oct 12 at 8:30 AM CDT = 2026-10-12 morning$/);

console.log('refresh-slots-action: all checks passed');
