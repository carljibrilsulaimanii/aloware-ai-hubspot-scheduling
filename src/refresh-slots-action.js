/**
 * refresh-slots-action.js -- HubSpot workflow custom code action: warm the slot cache
 * ---------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman
 * Created: 2026-08-19 (sanitized for publication 2026-09-28)
 *
 * Deploy:  HubSpot > Automation > Workflows > a custom code action (Node.js 20.x)
 *          in the refresh workflow, and optionally as the last step of the booking
 *          workflow's "booked" branch. Never in a page or anywhere a browser loads.
 *          OPTIONAL -- only needed for the "agent reads real times out loud" upgrade.
 *
 * What it does:
 *   Reads the meeting link's live availability, picks the next three openings on
 *   three different days, and writes them to ONE CRM record as a finished sentence
 *   plus a date and period per slot.
 *
 * Why it exists:
 *   A webhook-triggered workflow runs asynchronously and cannot hand data back to
 *   the agent -- the trigger returns 202 with only its own id. So the agent cannot
 *   ask HubSpot what is free and hear an answer in the same breath. Instead this
 *   action pre-computes the openings, and the agent READS that record
 *   synchronously straight from the CRM API, with nothing in between.
 *
 * What the agent gets is a finished sentence plus, for each slot, the date and
 * period to hand straight back to request_booking. It never parses a time, never
 * converts a zone, never does arithmetic. It reads, then copies.
 *
 * Run this from:
 *   - a scheduled workflow ("Based on a schedule" enrollment)
 *   - the last step of the booking workflow, to re-warm after a slot is taken
 *   - a webhook the agent fires when a booking conversation opens
 *
 * Staleness is survivable by design: booking re-reads live availability, so an
 * offer that has gone stale degrades to "that just got taken, here is what's
 * left" rather than a double booking.
 *
 * Secrets: the service key, under HUBSPOT_BOOKING_TOKEN or HUBSPOT_TOKEN.
 * Scopes:  scheduler.meetings.meeting-link.read, plus read+write on the cache object.
 *
 * Env / input:
 *   SLOT_CACHE_TYPE   object type of the cache record, e.g. a custom object id
 *   SLOT_CACHE_ID     the single cache record's id
 *   timezone          optional; the zone the labels are written in
 */

const axios = require('axios');

const HS        = 'https://api.hubapi.com';
const SCHEDULER = '/scheduler/2026-03/meetings/meeting-links';

// Must match booking-action.js, or the agent offers times it cannot then book.
const MEETING_SLUG = 'your-team/ai-booked-call';
const DEFAULT_TZ   = 'America/New_York';
const SLOTS        = 3;

// Subtrees describing when someone is NOT free. Never harvest starts here.
const BUSY_KEY = /busy|unavailable|blocked|conflict|exclu/i;

// Same windows request_booking uses, so a slot offered as "morning" is still
// morning when the booking action re-derives it.
const PERIODS = [
  ['morning',   0, 12],
  ['afternoon', 12, 17],
  ['evening',   17, 24],
];

exports.main = async (event, callback) => {
  const input = event.inputFields || {};
  const tz    = resolveTimezone(input.timezone);

  const token = process.env.HUBSPOT_BOOKING_TOKEN || process.env.HUBSPOT_TOKEN;
  const slug  = process.env.MEETING_SLUG || MEETING_SLUG;

  const cacheType = process.env.SLOT_CACHE_TYPE;
  const cacheId   = process.env.SLOT_CACHE_ID;

  if (!token || !cacheType || !cacheId) {
    return callback({
      outputFields: {
        refresh_status: 'error',
        error_detail:
          'Missing configuration. Needs the service key secret plus SLOT_CACHE_TYPE ' +
          'and SLOT_CACHE_ID.',
      },
    });
  }

  try {
    const res = await axios.get(
      HS + SCHEDULER + '/book/availability-page/' + encodeURIComponent(slug),
      { params: { timezone: tz }, headers: auth(token), timeout: 8000 }
    );

    // No invented lead time: minimum notice is the link's setting and HubSpot has
    // already applied it. Only drop what is genuinely in the past.
    const now   = Date.now();
    const open  = collectStarts(readByDuration(res.data)).filter(t => t > now).sort((a, b) => a - b);
    const picks = spreadAcrossDays(open, SLOTS, tz);

    await axios.patch(
      HS + '/crm/v3/objects/' + cacheType + '/' + cacheId,
      { properties: buildProperties(picks, tz) },
      { headers: auth(token), timeout: 8000 }
    );

    return callback({
      outputFields: {
        refresh_status: 'ok',
        slot_count: picks.length,
        slot_offer_text: offerText(picks, tz),
      },
    });
  } catch (err) {
    // Never fail the workflow over a stale cache. The booking action re-checks
    // live availability and is the real source of truth.
    return callback({
      outputFields: {
        refresh_status: 'error',
        error_detail: String(
          (err && err.response && JSON.stringify(err.response.data)) ||
          (err && err.message) || err
        ).slice(0, 500),
      },
    });
  }
};

const auth = (token) => ({ Authorization: 'Bearer ' + token });

/* ------------------------------------------------------------ properties */

/**
 * Flat properties, not JSON. The agent reads these as plain strings through a
 * single GET, and hands slot_N_date and slot_N_period straight back to
 * request_booking -- copied, never derived.
 */
function buildProperties(picks, tz) {
  const properties = {
    slot_offer_text: offerText(picks, tz),
    slot_count: String(picks.length),
    slot_refreshed_at: new Date().toISOString(),
  };

  for (let i = 0; i < SLOTS; i++) {
    const n = 'slot_' + (i + 1) + '_';
    const t = picks[i];

    properties[n + 'label']  = t ? shortLabel(t, tz) : '';
    properties[n + 'date']   = t ? dateKey(t, tz) : '';
    properties[n + 'period'] = t ? periodOf(t, tz) : '';
  }

  return properties;
}

/** The sentence the agent says. Written once here so the agent never composes it. */
function offerText(picks, tz) {
  if (!picks.length) {
    return "I don't have anything open in the next couple of weeks. " +
           'Let me have someone from the team reach out to you directly.';
  }

  return 'I have ' + humanList(picks.map(t => shortLabel(t, tz))) + '. Which works best?';
}

const periodOf = (ms, tz) => {
  const h = localHour(ms, tz);
  const found = PERIODS.find(([, from, to]) => h >= from && h < to);
  return found ? found[0] : 'any';
};

/* ---------------------------------------------------------- availability */

/** The duration-keyed availability map, wherever HubSpot has nested it. */
function readByDuration(root) {
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
        const shortest = Object.keys(value)
          .map(Number)
          .filter(n => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b)[0];
        return shortest ? value[String(shortest)] : value;
      }
      queue.push(value);
    }
  }

  return root;
}

/**
 * Collect epoch starts, refusing busy subtrees. The payload carries the reps'
 * busy blocks alongside their openings and both have start times; offering one
 * would put a contact straight into an existing meeting.
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

  return [...out];
}

/** Offer three different days rather than three slots the same morning. */
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

/* ----------------------------------------------------------------- utils */

/** HubSpot stores IP Timezone as a slug, not an IANA name. */
function ianaFromHubSpot(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (!value.includes('_slash_')) return value;

  return value
    .split('_slash_')
    .map(seg => seg.split('_').map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join('_'))
    .join('/');
}

function isUsableZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

function resolveTimezone(...candidates) {
  for (const raw of candidates) {
    const tz = ianaFromHubSpot(raw);
    if (isUsableZone(tz)) return tz;
  }
  return DEFAULT_TZ;
}

const dateKey = (ms, tz) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));

const localHour = (ms, tz) =>
  Number(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hourCycle: 'h23',
  }).format(new Date(ms)));

/** "Tue Sep 8 at 2:00 PM EDT" -- short enough to say, and to fit one SMS. */
function shortLabel(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).formatToParts(new Date(ms));

  const get = (type) => (parts.find(p => p.type === type) || {}).value || '';

  return get('weekday') + ' ' + get('month') + ' ' + get('day') +
         ' at ' + get('hour') + ':' + get('minute') + ' ' + get('dayPeriod') +
         ' ' + get('timeZoneName');
}

const humanList = (items) =>
  items.length <= 1
    ? (items[0] || '')
    : items.slice(0, -1).join(', ') + ', or ' + items[items.length - 1];

// Exposed for local tests; the workflow only ever calls exports.main.
exports.__test = {
  buildProperties, offerText, periodOf, readByDuration, collectStarts,
  spreadAcrossDays, dateKey, localHour, shortLabel, humanList, resolveTimezone,
};
