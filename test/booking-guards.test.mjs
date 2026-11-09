/**
 * booking-guards.test.mjs -- offline checks for the booking guards in src/booking-action.js
 * -----------------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 *
 * Deploy:  Nowhere. Local only -- run with `npm test` or `node test/booking-guards.test.mjs`.
 *
 * What it does:
 *   Runs the guards against a stubbed HubSpot: an upcoming meeting, a recent rep text
 *   (including one past the first page of messages), the agent's own replies, a team
 *   blast, an owner who is not on the round robin, a missing conversations.read scope,
 *   and the ordinary path. Date.now is frozen so the fixtures never go stale.
 *
 * Why it exists:
 *   The guards must stop a booking when the team is already working the contact, and
 *   must not stop an ordinary one. A first version read the thread's last-message time,
 *   which moves every time the agent replies, so it handed back every ordinary booking.
 */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';

// Frozen "now": Mon Oct 12 2026, 11:00 PM EDT (Oct 13 03:00 UTC).
const NOW = Date.UTC(2026, 9, 13, 3, 0);
Date.now = () => NOW;

const HOUR = 3600000;
const MIN = 60000;
const SLOT = Date.UTC(2026, 9, 13, 19, 0);       // Tue Oct 13, 3:00 PM EDT
const iso = (ms) => new Date(ms).toISOString();

// What the stubbed conversations API holds: threads, and each thread's messages
// (newest first, as the live API returns them), optionally split into pages.
let threads = [];            // [{ id, originalChannelId, latestMessageSentTimestamp }]
let messages = {};           // threadId -> [page1, page2, ...] of message arrays
let threadsError = null;     // thrown by the threads call
let messageCalls = [];       // thread ids whose messages were read
let booked = 0;

const AGENT = (ago, text = 'Of course!') => msg(ago, 'OUTGOING', 'X-unknown', text);
const REP   = (ago, actor = 'A-1000001') => msg(ago, 'OUTGOING', actor, 'Hi, Jordan here');
const LEAD  = (ago) => msg(ago, 'INCOMING', 'V-111', 'Yes');
function msg(ago, direction, actorId, text) {
  return { type: 'MESSAGE', direction, createdAt: iso(NOW - ago), text, senders: [{ actorId }] };
}
const thread = (id, latestAgo, channel = T.ALOWARE_SMS_CHANNEL_ID) =>
  ({ id, originalChannelId: channel, latestMessageSentTimestamp: iso(NOW - latestAgo) });

const axiosStub = {
  async get(url, opts = {}) {
    if (url.includes('/conversations/v3/conversations/threads/')) {
      const id = url.split('/threads/')[1].split('/')[0];
      messageCalls.push(id);
      const pages = messages[id] || [[]];
      const n = Number((opts.params && opts.params.after) || 0);
      const next = n + 1 < pages.length ? { next: { after: String(n + 1) } } : undefined;
      return { data: { results: pages[n] || [], paging: next } };
    }
    if (url.includes('/conversations/')) {
      if (threadsError) throw threadsError;
      return { data: { results: threads } };
    }
    // Booking info: a link with no form fields.
    if (/\/book\/(?!availability-page)/.test(url)) {
      return { data: { customParams: { formFields: [] } } };
    }
    // Availability: one 30-minute slot.
    return { data: { linkAvailability: { linkAvailabilityByDuration: {
      '1800000': { availabilities: [{ startMillisUtc: SLOT, endMillisUtc: SLOT + 1800000 }] },
    } } } };
  },
  async post() {
    booked++;
    return { data: { calendarEventId: 'evt_1', contactId: 1, isOffline: false } };
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

// Test ids for the config sets at the top of booking-action.js: a rep owner on the
// round robin, and a shared team user whose blasts are not a rep chat.
T.ROUND_ROBIN_OWNER_IDS.add('1000000001');
T.NOT_A_REP_ACTOR_IDS.add('A-1000099');

const base = {
  first_name: 'Test', last_name: 'Person', email: 'test@example.com', phone: '5550100123',
  timezone: 'america_slash_new_york', preferred_date: '2026-10-13', preferred_period: 'afternoon',
  contact_id: '111', owner_id: '1000000001',
};

const run = (input) => new Promise(resolve =>
  action.main({ inputFields: { ...base, ...input } }, r => resolve(r.outputFields)));

const reset = () => { threads = []; messages = {}; threadsError = null; messageCalls = []; booked = 0; };
let passed = 0;
const check = async (name, fn) => { reset(); await fn(); passed++; console.log('ok  ', name); };

/* The rep already booked the contact a call for tomorrow evening. */
await check('upcoming meeting stops the booking', async () => {
  const out = await run({ next_activity: '2026-10-13T22:00:00Z' });
  assert.equal(out.booking_status, 'handed_to_owner');
  assert.equal(out.confirmation_text, T.HANDOFF_TEXT);
  assert.match(out.error_detail, /upcoming activity/);
  assert.equal(booked, 0);
});

/* HubSpot can hand the date over as epoch millis in a string. */
await check('upcoming activity as epoch millis', async () => {
  const out = await run({ next_activity: String(Date.UTC(2026, 9, 14, 14, 0)) });
  assert.equal(out.booking_status, 'handed_to_owner');
  assert.equal(booked, 0);
});

/* Live rep conversation: a rep texted 13 minutes ago, the agent has replied since. */
await check('recent rep text stops the booking', async () => {
  threads = [thread('t1', 1 * MIN)];
  messages.t1 = [[AGENT(1 * MIN), LEAD(2 * MIN), REP(13 * MIN), LEAD(20 * MIN)]];
  const out = await run({});
  assert.equal(out.booking_status, 'handed_to_owner');
  assert.match(out.error_detail, /13 minutes ago/);
  assert.equal(booked, 0);
});

/* Only the agent (X-unknown) and the contact in the last 12 hours. A guard that reads
   the thread's last-message time blocks these as "0 minutes". */
await check("the agent's own replies do not block", async () => {
  threads = [thread('t1', 0)];
  messages.t1 = [[AGENT(0, 'Got it, I put in the request!'), LEAD(1 * MIN), AGENT(3 * MIN),
                  LEAD(5 * MIN), REP(5 * 24 * HOUR)]];
  const out = await run({});
  assert.equal(out.booking_status, 'booked');
  assert.match(out.checks_note, /no rep text in the last 12 h/);
  assert.equal(booked, 1);
});

/* A team blast sent as a shared team user is not a rep chat. */
await check('team blast user does not block', async () => {
  threads = [thread('t1', 30 * MIN)];
  messages.t1 = [[REP(30 * MIN, 'A-1000099')]];
  const out = await run({});
  assert.equal(out.booking_status, 'booked');
  assert.equal(booked, 1);
});

/* A rep text older than 12 hours, and a recent message on another channel, do not block.
   A thread whose last message is outside the window is not even opened. */
await check('old rep text and other channels do not block', async () => {
  threads = [thread('old', 13 * HOUR), thread('form', 1 * MIN, '1003')];
  messages.old = [[REP(13 * HOUR)]];
  messages.form = [[REP(1 * MIN)]];
  const out = await run({});
  assert.equal(out.booking_status, 'booked');
  assert.deepEqual(messageCalls, [], 'no thread inside the window on the SMS channel');
  assert.equal(booked, 1);
});

/* A rep text on the second page (a long agent exchange first) is still found. */
await check('rep text past the first page still blocks', async () => {
  threads = [thread('t1', 0)];
  messages.t1 = [[AGENT(0), LEAD(1 * MIN), AGENT(2 * MIN)], [LEAD(3 * MIN), REP(40 * MIN)]];
  const out = await run({});
  assert.equal(out.booking_status, 'handed_to_owner');
  assert.match(out.error_detail, /40 minutes ago/);
  assert.equal(booked, 0);
});

/* Owned by a rep who is not on the round robin. */
await check('owner not on round robin stops the booking', async () => {
  const out = await run({ owner_id: '99999999' });
  assert.equal(out.booking_status, 'handed_to_owner');
  assert.match(out.error_detail, /owner id 99999999\) is not on the round robin/);
  assert.equal(booked, 0);
});

/* No owner at all: the round robin decides, as before. */
await check('no owner books normally', async () => {
  const out = await run({ owner_id: '' });
  assert.equal(out.booking_status, 'booked');
  assert.equal(booked, 1);
});

/* Missing scope: the rep check is skipped and the booking goes ahead, with a note. */
await check('missing conversations scope fails open', async () => {
  threadsError = Object.assign(new Error('403'), { response: { status: 403 } });
  const out = await run({});
  assert.equal(out.booking_status, 'booked');
  assert.match(out.checks_note, /lacks conversations\.read/);
  assert.equal(booked, 1);
});

/* A past activity does not block. */
await check('past activity does not block', async () => {
  const out = await run({ next_activity: '2026-10-01T15:00:00Z' });
  assert.equal(out.booking_status, 'booked');
  assert.equal(booked, 1);
});

/* The ordinary case still books, and the confirmation is unchanged. */
await check('normal booking still books', async () => {
  const out = await run({});
  assert.equal(out.booking_status, 'booked');
  assert.match(out.confirmation_text, /^You're all set for Tue Oct 13 at 3:00 PM EDT\./);
  assert.equal(booked, 1);
});

/* isRepText: only outgoing messages from a person count. */
await check('isRepText tells reps from bots, blasts and the contact', async () => {
  assert.equal(T.isRepText(REP(0)), true);
  assert.equal(T.isRepText(AGENT(0)), false, 'agent / workflows / short code');
  assert.equal(T.isRepText(REP(0, 'A-1000099')), false, 'team blasts');
  assert.equal(T.isRepText(LEAD(0)), false, 'the contact');
  assert.equal(T.isRepText({ ...REP(0), type: 'COMMENT' }), false, 'internal comments');
});

console.log(`\nguards: ${passed} checks passed`);
