/**
 * demo.mjs -- walk the booking action through every scenario and print what it does
 * ----------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-08-19 (sanitized for publication 2026-09-28)
 *
 * Deploy:  Nowhere. Local only -- `npm run demo`. No network: HubSpot is stubbed.
 *
 * What it does:
 *   Feeds src/booking-action.js a realistic week of openings and prints, for each
 *   scenario, what the agent sent, which HubSpot calls were made, the
 *   booking_status, and the exact sentence the contact would receive.
 *
 * Why it exists:
 *   So anyone evaluating the design can see every branch's behavior -- and every
 *   reply's length against the SMS limit -- before touching a real portal.
 */
import Module from 'node:module';
import { createRequire } from 'node:module';

const TZ = 'America/New_York';

// Freeze "now" so the September fixtures stay in the future.
Date.now = () => Date.UTC(2026, 8, 1, 12);

let availability = {};
let bookFails = null;
let calls = [];

const axiosStub = {
  async get(url, cfg) {
    calls.push(`GET  ${short(url)}?timezone=${cfg.params.timezone}`);
    if (availability === 'unreachable') throw new Error('ETIMEDOUT');
    return { data: availability };
  },
  async post(url, body) {
    calls.push(`POST ${short(url)}  startTime=${body.startTime}  email=${body.email}`);
    if (bookFails) throw bookFails;
    return { data: { calendarEventId: 'evt_8f2c', contactId: 311, isOffline: false } };
  },
};
const short = (u) => u.replace('https://api.hubapi.com/scheduler/2026-03/meetings/meeting-links', '...');

const load = Module._load;
Module._load = (req, ...rest) => (req === 'axios' ? axiosStub : load.call(Module, req, ...rest));

const action = createRequire(import.meta.url)('../src/booking-action.js');
process.env.HUBSPOT_BOOKING_TOKEN = 'pat-demo';
process.env.MEETING_SLUG = 'acme/ai-booked-call';

// A realistic week: Tue has 9am/2pm/4pm, Wed has 10am, Thu has 3pm.
const et = (day, hour) => Date.UTC(2026, 8, day, hour + 4);
const OPEN = [et(8, 9), et(8, 14), et(8, 16), et(9, 10), et(10, 15)];

// Wed 1pm is a rep's existing meeting -- a busy block, not an opening.
const BUSY = et(9, 13);
const payload = (times, duration = 1800000) => ({
  linkAvailability: {
    linkAvailabilityByDuration: {
      [duration]: { availabilities: times.map(t => ({ startMillisUtc: t, endMillisUtc: t + duration })) },
    },
  },
  allUsersBusyTimes: [{ busyTimes: [{ start: BUSY, end: BUSY + 3600000 }] }],
  duration,
});

const run = (f) => new Promise((r) => action.main({ inputFields: f }, r));

async function scenario(title, fields, setup = {}) {
  availability = setup.availability !== undefined ? setup.availability : payload(OPEN);
  bookFails = setup.bookFails || null;
  calls = [];

  const { outputFields: o } = await run(fields);

  console.log('\n\x1b[1m' + title + '\x1b[0m');
  console.log('  agent sends    ' + JSON.stringify(fields));
  calls.forEach(c => console.log('  calls          ' + c));
  console.log('  \x1b[36mbooking_status\x1b[0m ' + o.booking_status);
  if (o.booking_label) console.log('  booking_label  ' + o.booking_label +
    '  \x1b[2m(' + (o.booked_duration_ms / 60000) + ' min, from the link)\x1b[0m');
  console.log('  says           "' + o.confirmation_text + '"  \x1b[2m(' +
    o.confirmation_text.length + ' chars)\x1b[0m');
  if (o.error_detail) console.log('  error_detail   ' + o.error_detail);
}

console.log('Link: acme/ai-booked-call  Open: Tue 9a/2p/4p, Wed 10a, Thu 3p ET  Busy: Wed 1p');

await scenario('0 -- a 45-minute link books 45 minutes, not an assumed 30',
  { first_name: 'Duration Check', email: 'd@example.com', timezone: TZ },
  { availability: payload([et(8, 11)], 2700000) });

await scenario('1 -- asks for Tuesday afternoon, gets it',
  { first_name: 'Alex Morgan', email: 'alex@example.com',
    preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ });

await scenario('2 -- asks for Wednesday afternoon; only 10am is free, so it takes that',
  { first_name: 'Sam', email: 'sam@example.com',
    preferred_date: '2026-09-09', preferred_period: 'afternoon', timezone: TZ });

await scenario('3 -- asks for Monday, which is full; rolls forward to the next afternoon',
  { first_name: 'Casey', email: 'casey@example.com',
    preferred_date: '2026-09-07', preferred_period: 'afternoon', timezone: TZ });

await scenario('4 -- no preference given at all',
  { first_name: 'Taylor Brooks', email: 'taylor@example.com', timezone: TZ });

await scenario('5 -- wants December; nothing that far out, so it offers real times instead',
  { first_name: 'Riley', email: 'riley@example.com',
    preferred_date: '2026-12-01', timezone: TZ });

await scenario('6 -- no email yet, so it asks before touching the calendar',
  { first_name: 'Jordan', preferred_date: '2026-09-08', timezone: TZ });

await scenario('7 -- someone grabbed the slot between the read and the write',
  { first_name: 'Morgan', email: 'morgan@example.com',
    preferred_date: '2026-09-08', preferred_period: 'afternoon', timezone: TZ },
  { bookFails: Object.assign(new Error('conflict'), { response: { status: 409 } }) });

await scenario('8 -- calendar is completely full',
  { first_name: 'Drew', email: 'drew@example.com', timezone: TZ },
  { availability: payload([]) });

await scenario('9 -- HubSpot is down',
  { first_name: 'Jamie', email: 'jamie@example.com', timezone: TZ },
  { availability: 'unreachable' });

console.log('\nEvery branch returns a booking_status to branch on and a sentence safe to send.\n');
