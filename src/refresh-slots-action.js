/**
 * refresh-slots-action.js -- HubSpot workflow custom code action: keep the agent's list of
 * open appointment times fresh
 * -----------------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman (with Claude Code)
 *
 * Deploy:  HubSpot > Automation > Workflows > "AI Booking — Refresh Slots" > custom code
 *          action (Node.js 20.x), on a schedule, and optionally as the last action of the
 *          `booked` branch of "AI Booking — Book Meeting". Never in a page or a browser.
 *
 * What it does:
 *   Reads the meeting link's live availability and writes ONE record of your cache custom
 *   object with:
 *     slot_offer_text   a finished text offering the next 3 openings on 3 different days
 *     slot_table        one line per morning and afternoon that has an opening, for every
 *                       day the link shows (about two weeks), e.g.
 *                       "Tue Oct 13 at 1:00 PM EDT = 2026-10-13 afternoon"
 *     slot_count, slot_table_count, slot_refreshed_at
 *
 * Why it exists:
 *   People text ranges: "any afternoon next week", "Tuesday or Wednesday morning",
 *   "after the 15th". The agent cannot see the calendar, and the webhook workflow cannot
 *   hand data back to it mid-conversation. So this action pre-computes the openings and
 *   the agent reads the record straight from the CRM API (the get_available_times custom
 *   function), picks up to three lines inside the person's range, and offers them word
 *   for word.
 *
 *   Each line is the FIRST opening in that morning or afternoon. That is exactly the slot
 *   booking-action.js chooseSlot books when given that date and period, so the time the
 *   agent offers is the time that gets booked. If it was taken in the meantime, booking
 *   re-reads live availability and texts three fresh times back (slot_taken) instead of
 *   double booking.
 *
 * Secrets: HUBSPOT_BOOKING_TOKEN (the same secret booking-action.js uses). Put your cache
 *          object's type id and record id in SLOT_CACHE_TYPE / SLOT_CACHE_ID below, or
 *          create secrets with those names to override them.
 * Scopes:  scheduler.meetings.meeting-link.read, plus crm.objects.custom.read and
 *          crm.objects.custom.write for the cache object.
 * Outputs: refresh_status (ok | error), slot_count, slot_table_count, slot_offer_text,
 *          error_detail.
 */

const axios = require('axios');

const HS        = 'https://api.hubapi.com';
const SCHEDULER = '/scheduler/2026-03/meetings/meeting-links';

// MUST be the same slug as MEETING_SLUG in booking-action.js, or the agent offers times
// that request_booking then books on a different calendar. Change both together.
const MEETING_SLUG = 'your-team/ai-booked-call';
const DEFAULT_TZ   = 'America/New_York';
const OFFER_SLOTS  = 3;

// Your cache custom object's type id and its one record's id. These are ids, not
// secrets; SLOT_CACHE_TYPE / SLOT_CACHE_ID secrets override them if set.
const SLOT_CACHE_TYPE = 'REPLACE_WITH_TYPE_ID';   // e.g. 2-12345678
const SLOT_CACHE_ID   = 'REPLACE_WITH_RECORD_ID'; // e.g. 12345678901

// The agent only ever offers morning or afternoon (its instructions forbid evening), and these
// windows match booking-action.js PERIODS exactly.
const PERIODS = [
  ['morning',   0, 12],
  ['afternoon', 12, 17],
];

// Subtrees describing when someone is NOT free. Never harvest start times there.
const BUSY_KEY = /busy|unavailable|blocked|conflict|exclu/i;

exports.main = async (event, callback) => {
  const input = (event && event.inputFields) || {};
  const tz    = resolveTimezone(input.timezone);

  const token     = process.env.HUBSPOT_BOOKING_TOKEN
                 || process.env.HUBSPOT_TOKEN;
  const slug      = process.env.MEETING_SLUG || MEETING_SLUG;
  const cacheType = process.env.SLOT_CACHE_TYPE || SLOT_CACHE_TYPE;
  const cacheId   = process.env.SLOT_CACHE_ID || SLOT_CACHE_ID;

  if (!token || !cacheType || !cacheId) {
    return callback({
      outputFields: {
        refresh_status: 'error',
        error_detail: 'Missing the HUBSPOT_BOOKING_TOKEN secret (or the cache object/record id).',
      },
    });
  }

  try {
    const res = await axios.get(
      HS + SCHEDULER + '/book/availability-page/' + encodeURIComponent(slug),
      { params: { timezone: tz }, headers: auth(token), timeout: 8000 }
    );

    // Minimum notice is the link's own setting and HubSpot already applied it. Only drop
    // starts that are genuinely in the past.
    const now   = Date.now();
    const open  = collectStarts(readByDuration(res.data)).filter(t => t > now).sort((a, b) => a - b);
    const table = firstPerPeriod(open, tz);
    const picks = spreadAcrossDays(table.map(r => r.ms), OFFER_SLOTS, tz);

    const properties = buildProperties(picks, table, tz);
    await axios.patch(
      HS + '/crm/v3/objects/' + cacheType + '/' + cacheId,
      { properties },
      { headers: auth(token), timeout: 8000 }
    );

    return callback({
      outputFields: {
        refresh_status: 'ok',
        slot_count: picks.length,
        slot_table_count: table.length,
        slot_offer_text: properties.slot_offer_text,
      },
    });
  } catch (err) {
    // Never fail the workflow over a stale list. Booking re-checks live availability.
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

/** Flat text properties. The agent reads them through one GET and copies, never derives. */
function buildProperties(picks, table, tz) {
  return {
    slot_offer_text: offerText(picks, tz),
    slot_table: tableText(table),
    slot_count: String(picks.length),
    slot_table_count: String(table.length),
    slot_refreshed_at: new Date().toISOString(),
  };
}

/** The ready-to-send text for "what times do you have?". */
function offerText(picks, tz) {
  if (!picks.length) {
    return "I don't have anything open on the calendar right now. " +
           'Someone from the team will reach out to you directly.';
  }
  return 'I have ' + humanList(picks.map(t => shortLabel(t, tz))) + '. Which works best for you?';
}

/** One line per day and period: "<label> = <YYYY-MM-DD> <period>". */
function tableText(table) {
  if (!table.length) return 'NONE';
  return table.map(r => r.label + ' = ' + r.date + ' ' + r.period).join('\n');
}

/**
 * The first opening in each morning and afternoon of each day, in time order. That is
 * the slot booking-action.js books for (date, period), so offer and booking agree.
 * Openings outside both windows (evenings) are skipped.
 */
function firstPerPeriod(times, tz) {
  const seen = new Set();
  const rows = [];
  for (const ms of times) {
    const period = periodOf(ms, tz);
    if (!period) continue;
    const date = dateKey(ms, tz);
    const key = date + ' ' + period;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ms, date, period, label: shortLabel(ms, tz) });
  }
  return rows;
}

function periodOf(ms, tz) {
  const h = localHour(ms, tz);
  const found = PERIODS.find(([, from, to]) => h >= from && h < to);
  return found ? found[0] : '';
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
 * Collect epoch start times, refusing busy subtrees. The payload carries the reps' busy
 * blocks next to their openings and both have start times. A duration value such as
 * meetingDurationMillis is below 1e12 and is ignored.
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

/* ----------------------------------------------------------------- utils */

/** HubSpot stores IP Timezone as a slug (america_slash_new_york), not an IANA name. */
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

/** "Tue Oct 13 at 1:00 PM EDT": short enough for one text. */
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

// Exposed for the local test only; the workflow calls exports.main.
exports.__test = {
  buildProperties, offerText, tableText, firstPerPeriod, periodOf, spreadAcrossDays,
  readByDuration, collectStarts, dateKey, localHour, shortLabel, humanList, resolveTimezone,
  MEETING_SLUG,
};
