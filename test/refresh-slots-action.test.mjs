/**
 * refresh-slots-action.test.mjs -- offline checks for src/refresh-slots-action.js
 * -------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-08-19 (sanitized for publication 2026-09-28)
 *
 * Deploy:  Nowhere. Local only -- run with `npm test` or
 *          `node test/refresh-slots-action.test.mjs`. Needs Node 20, no install.
 *
 * What it does:
 *   Stubs axios, runs the cache refresh, and checks what lands on the cache
 *   record: the finished sentence, per-slot date and period, no busy blocks,
 *   cleared slots on an empty calendar, and errors that never fail a workflow.
 *
 * Why it exists:
 *   The agent copies these values verbatim into request_booking. If a period or
 *   date here disagrees with what the booking action re-derives, the contact is
 *   booked into a different slot than the one they picked -- silently.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

const TZ = 'America/New_York';

// Freeze "now" so the September fixtures stay in the future forever.
const FROZEN_NOW = Date.UTC(2026, 8, 1, 12);      // 1 Sep 2026, 8:00 AM EDT
Date.now = () => FROZEN_NOW;

/* --------------------------------------------------------- axios stub ---- */

let availability = {};
let patched = null;
let getError = null;
let patchError = null;

const axiosStub = {
  async get() {
    if (getError) throw getError;
    return { data: availability };
  },
  async patch(url, body) {
    if (patchError) throw patchError;
    patched = { url, properties: body.properties };
    return { data: {} };
  },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'axios') return axiosStub;
  return load.call(this, request, ...rest);
};

const action = createRequire(import.meta.url)('../src/refresh-slots-action.js');
const T = action.__test;

process.env.HUBSPOT_BOOKING_TOKEN = 'pat-test';
process.env.SLOT_CACHE_TYPE = 'p00000000_ai_booking_cache';
process.env.SLOT_CACHE_ID = '9001';

/* ------------------------------------------------------------ fixtures --- */

// September 2026 is EDT (UTC-4).
const et = (day, hour, min = 0) => Date.UTC(2026, 8, day, hour + 4, min);

const SEP8_9AM  = et(8, 9);
const SEP8_2PM  = et(8, 14);
const SEP9_10AM = et(9, 10);
const SEP10_3PM = et(10, 15);
const BUSY      = et(11, 13);

// Mirrors the live 2026-03 response, including the busy branch that carries
// start times of its own.
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

const run = (inputFields = {}) =>
  new Promise((resolve) => action.main({ inputFields }, resolve));

const reset = () => {
  availability = payload([SEP8_9AM, SEP8_2PM, SEP9_10AM, SEP10_3PM], [BUSY]);
  patched = null;
  getError = null;
  patchError = null;
};

let out;

/* -------------------------------------------- the agent reads, not parses */

reset();
out = (await run({ timezone: TZ })).outputFields;

assert.equal(out.refresh_status, 'ok');
assert.equal(out.slot_count, 3);
assert.match(patched.url, /p00000000_ai_booking_cache\/9001$/);

const p = patched.properties;

// A finished sentence, so the agent never composes one.
assert.equal(
  p.slot_offer_text,
  'I have Tue Sep 8 at 9:00 AM EDT, Wed Sep 9 at 10:00 AM EDT, or Thu Sep 10 at 3:00 PM EDT. Which works best?'
);

// Each slot carries what request_booking wants, so the agent copies rather than
// deriving a date from a spoken label.
assert.equal(p.slot_1_label, 'Tue Sep 8 at 9:00 AM EDT');
assert.equal(p.slot_1_date, '2026-09-08');
assert.equal(p.slot_1_period, 'morning');

assert.equal(p.slot_2_date, '2026-09-09');
assert.equal(p.slot_2_period, 'morning');

assert.equal(p.slot_3_date, '2026-09-10');
assert.equal(p.slot_3_period, 'afternoon');

assert.match(p.slot_refreshed_at, /^\d{4}-\d{2}-\d{2}T/);

/* --------------------------------- busy blocks are never offered as slots */

assert.ok(!Object.values(p).includes(T.shortLabel(BUSY, TZ)), 'a busy block must never be offered');
assert.deepEqual(
  T.collectStarts(T.readByDuration(payload([SEP8_9AM], [BUSY]))),
  [SEP8_9AM],
  'only real openings survive the walk'
);

/* ------------------------------------- offers land on three distinct days */

const sameDay = [et(8, 9), et(8, 10), et(8, 11), et(9, 9), et(10, 9)];
assert.deepEqual(
  T.spreadAcrossDays(sameDay, 3, TZ).map(t => T.dateKey(t, TZ)),
  ['2026-09-08', '2026-09-09', '2026-09-10']
);

/* ---------------------- periods match what request_booking will re-derive */

assert.equal(T.periodOf(et(8, 9), TZ), 'morning');
assert.equal(T.periodOf(et(8, 12), TZ), 'afternoon', 'noon is afternoon, matching the booking action');
assert.equal(T.periodOf(et(8, 16), TZ), 'afternoon');
assert.equal(T.periodOf(et(8, 18), TZ), 'evening');

/* ------------------------------------------- an empty calendar still says so */

reset();
availability = payload([]);
out = (await run({ timezone: TZ })).outputFields;
assert.equal(out.slot_count, 0);
assert.match(patched.properties.slot_offer_text, /don't have anything open/);
assert.equal(patched.properties.slot_1_label, '', 'stale slots are cleared, not left behind');
assert.equal(patched.properties.slot_1_date, '');

/* ------------------------------------------ HubSpot's timezone slug form */

reset();
await run({ timezone: 'america_slash_chicago' });
assert.match(patched.properties.slot_offer_text, /CDT/, 'converts the slug rather than throwing');

reset();
await run({ timezone: 'nonsense_value' });
assert.match(patched.properties.slot_offer_text, /EDT/, 'falls back rather than failing');

/* ------------------------------- a stale cache must never break a workflow */

reset();
getError = new Error('ETIMEDOUT');
out = (await run({ timezone: TZ })).outputFields;
assert.equal(out.refresh_status, 'error');
assert.match(out.error_detail, /ETIMEDOUT/);

reset();
patchError = Object.assign(new Error('403'), {
  response: { status: 403, data: { message: 'missing scope' } },
});
out = (await run({ timezone: TZ })).outputFields;
assert.equal(out.refresh_status, 'error');
assert.match(out.error_detail, /missing scope/, 'says what to fix');

/* ------------------------------------------------ configuration is checked */

const savedType = process.env.SLOT_CACHE_TYPE;
delete process.env.SLOT_CACHE_TYPE;
reset();
out = (await run({ timezone: TZ })).outputFields;
assert.equal(out.refresh_status, 'error');
assert.match(out.error_detail, /SLOT_CACHE_TYPE/, 'names the missing setting');
process.env.SLOT_CACHE_TYPE = savedType;

console.log('refresh-slots-action: all checks passed');
