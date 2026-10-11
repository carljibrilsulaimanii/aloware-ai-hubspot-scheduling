/**
 * booking-relay-action.test.mjs -- offline checks for src/booking-relay-action.js
 * -------------------------------------------------------------------------------
 * Author:  Jibril Sulaiman (with Claude Code)
 *
 * Run:     npm test   (Node 20, no install)
 *
 * What it does:
 *   Stubs fetch and checks the v3 submission the action sends: the right URL, the
 *   objectTypeId on every field, "+" emails intact, full names split, phones normalised,
 *   empty values left out, bad input refused without a call, and HubSpot errors reported,
 *   not thrown.
 *
 * Why it exists:
 *   A wrong field name or an empty value here fails silently in HubSpot: the form accepts
 *   the submission and the booking workflow gets a contact without a date.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const action = require('../src/booking-relay-action.js');
const T = action.__test;

let calls = [];
let reply = { ok: true, status: 200, text: async () => '{"inlineMessage":"Thanks"}' };
globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return reply; };

const run = (inputFields) => new Promise((resolve) => action.main({ inputFields }, (r) => resolve(r.outputFields)));
const sent = () => JSON.parse(calls[calls.length - 1].opts.body);
const field = (name) => (sent().fields.find(f => f.name === name) || {}).value;

/* happy path, new contact with a "+" email */
calls = [];
let out = await run({
  email: ' Alex+Test5@Example.com ', full_name: ' Alex   Morgan ', phone: '(555) 010-0123',
  preferred_date: '2026-10-14', preferred_period: 'Morning', timezone: 'America/New_York',
});
assert.equal(out.submitted, true);
assert.equal(out.reason, 'submitted');
assert.equal(calls.length, 1);
assert.equal(calls[0].url, 'https://api.hsforms.com/submissions/v3/integration/submit/REPLACE_WITH_PORTAL_ID/REPLACE_WITH_FORM_GUID');
assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
assert.ok(sent().fields.every(f => f.objectTypeId === '0-1'));
assert.equal(field('email'), 'alex+test5@example.com', '"+" survives and email is lower-cased');
assert.equal(field('firstname'), 'Alex');
assert.equal(field('lastname'), 'Morgan');
assert.equal(field('full_name'), 'Alex Morgan');
assert.equal(field('phone'), '+15550100123');
assert.equal(field('aloai_preferred_date'), '2026-10-14');
assert.equal(field('aloai_preferred_period'), 'morning');
assert.equal(field('aloai_booking_timezone'), 'America/New_York');

/* empty optional values are not sent (they would blank the contact) */
calls = [];
out = await run({ email: 'a@example.com', preferred_date: '2026-10-15', preferred_period: 'evening' });
assert.equal(out.submitted, true);
assert.deepEqual(sent().fields.map(f => f.name).sort(), ['aloai_preferred_date', 'email']);

/* refusals: no call made */
calls = [];
out = await run({ email: 'not-an-email', preferred_date: '2026-10-15' });
assert.equal(out.reason, 'no_email');
out = await run({ email: 'a@example.com', preferred_date: 'Tuesday' });
assert.equal(out.reason, 'bad_date');
assert.equal(calls.length, 0);

/* HubSpot error is reported, not thrown */
reply = { ok: false, status: 400, text: async () => '{"status":"error","message":"bad field"}' };
out = await run({ email: 'a@example.com', preferred_date: '2026-10-15' });
assert.equal(out.submitted, false);
assert.equal(out.reason, 'submit_failed_400');

/* fetch throwing is caught */
globalThis.fetch = async () => { throw new Error('network down'); };
out = await run({ email: 'a@example.com', preferred_date: '2026-10-15' });
assert.equal(out.reason, 'error');

/* one-word name: first name only, no last name sent (never blanks an existing one) */
globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => '{}' }; };
calls = [];
out = await run({ email: 'a@example.com', full_name: 'Alex', preferred_date: '2026-10-15' });
assert.equal(field('firstname'), 'Alex');
assert.equal(field('lastname'), undefined);
assert.equal(field('full_name'), 'Alex');

/* old shape still works: first_name holding a full name is split too */
calls = [];
out = await run({ email: 'a@example.com', first_name: 'Ana de la Cruz', preferred_date: '2026-10-15' });
assert.equal(field('firstname'), 'Ana');
assert.equal(field('lastname'), 'de la Cruz');

/* helpers */
assert.deepEqual(T.splitName('  '), { first: '', last: '', full: '' });
assert.equal(T.normalizePhone('15550100123'), '+15550100123');
assert.equal(T.normalizePhone('+15550100123'), '+15550100123');
assert.equal(T.normalizePhone('5550100123'), '+15550100123');
assert.equal(T.normalizePhone('+44 20 7946 0958'), '+442079460958');
assert.equal(T.normalizePeriod('PM'), 'afternoon');
assert.equal(T.normalizePeriod('evening'), '');

console.log('booking-relay-action: all checks passed');
