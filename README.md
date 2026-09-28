<!--
  README.md -- Aloware AI appointment scheduling via HubSpot
  Author:  Jibril Sulaiman
  Created: 2026-09-28 (from a production build first shipped 2026-08-19)
  What:    Entry point for the guide: what the integration does, how it fits
           together, and where each piece is deployed.
  Why:     The build spans two vendors' UIs and one API with undocumented
           behavior; this is the one place the whole picture lives.
-->

# Aloware AI appointment scheduling via HubSpot

Let an **Aloware AloAI agent** (SMS or voice) book appointments straight into
**HubSpot Meetings**. You don't need a third-party scheduler or middleware server,
and nothing runs outside HubSpot.

The contact tells the bot *"Tuesday afternoon works."* A few seconds later the
meeting is on a rep's calendar through your normal HubSpot round-robin link. It's
stamped with your meeting type, and the contact has a confirmation text and a
calendar invite.

```
Contact ──SMS/voice──▶ AloAI agent ──Custom Function (POST)──▶ HubSpot workflow
                                                                   │  webhook trigger
                                                                   ▼
                                                           Custom code action
                                                        (src/booking-action.js)
                                                                   │  Meetings API
                                                                   ▼
                                                  Round-robin meeting link books it
                                                                   │
                                   ┌───────────────────────────────┴──────────────┐
                                   ▼                                              ▼
                     Meeting stamped with your type               booking_status branches
                     + invite + HubSpot reminders            (text the reply, task a human)
```

---

## Contents

- [Why this design](#why-this-design)
- [What you need](#what-you-need)
- [What's in the repo](#whats-in-the-repo)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Workflow outputs and branching](#workflow-outputs-and-branching)
- [Optional: let the agent offer real times](#optional-let-the-agent-offer-real-times)
- [Things the docs won't tell you](#things-the-docs-wont-tell-you)
- [Known limitations](#known-limitations)
- [Testing locally](#testing-locally)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

Detailed guides:

| Doc | Covers |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Step-by-step build, phase by phase, with a pass check at the end of each |
| [docs/ALOWARE-AGENT.md](docs/ALOWARE-AGENT.md) | The Custom Function config and agent prompts for SMS and voice |
| [docs/API-NOTES.md](docs/API-NOTES.md) | HubSpot Scheduler API behavior verified against a live portal |

---

## Why this design

**The meeting type is what matters.** Many HubSpot portals drive deal stages,
sequences and reporting off the meeting's *Call and meeting type*
(`hs_activity_type`). Most AI booking tools write to their own calendar and then
sync a meeting back. That means another integration to build and maintain, and
the meeting type often doesn't come through.

A HubSpot meeting link has its own **Meeting type** setting. Every booking made
through that link gets stamped with it, whether it came from the public page or
the API. So if the bot books *through the link*, attribution needs no code at all.

Booking through the native link also keeps everything that already works:

- round robin, and "prioritize contact owner" if you use it
- the confirmation email and calendar invite
- cancel and reschedule links
- any reminder sequences already tied to meetings
- `hs_meeting_source = INTEGRATION` on API bookings, so bot bookings can be
  separated from people booking the page by hand

**It runs entirely inside HubSpot.** Everything runs in a HubSpot workflow, so
there's no server to host, patch or pay for.

Alternatives considered and rejected: moving booking to Cal.com, or buying a
dedicated AI booking product. Both mean a new calendar system and an integration
that has to write meeting types back into HubSpot.

## What you need

| Requirement | Why |
|---|---|
| **HubSpot Data Hub (formerly Operations Hub) Professional** or higher | Custom code actions *and* "When a webhook is received" triggers both need it. Sales/Service Enterprise seats alone don't prove you have it, so check that **Custom code** appears in a workflow's action list. |
| **HubSpot Sales Hub** with Meetings | For a round-robin scheduling page |
| **Aloware** with **AloAI agents** and **Custom Functions** | The agent calls the workflow through a Custom Function. Check that the agent type you want (Text, inbound voice, outbound voice) is enabled on your account, because some plans don't include all of them. |
| A HubSpot **service key** (private app) | Scopes: `scheduler.meetings.meeting-link.read` and `crm.objects.contacts.write` |
| Connected calendars for **every** rep in the pool | A rep with a disconnected calendar makes bookings silently vanish (see [below](#things-the-docs-wont-tell-you)) |
| Node.js 20 (local only) | For the tests and demo. HubSpot runs the action on its own Node 20 runtime. |

## What's in the repo

```
src/
  booking-action.js          HubSpot custom code action: reads availability, books, returns a status
  refresh-slots-action.js    Optional: pre-computes 3 openings onto a CRM record for the agent to read
test/
  booking-action.test.mjs    Offline tests with HubSpot stubbed; every branch
  refresh-slots-action.test.mjs
examples/
  demo.mjs                   Prints what the action does in 10 scenarios, with no network
scripts/
  probe.ps1                  Checks your real portal before you build (PowerShell)
  probe.sh                   Same probe for bash
docs/
  SETUP.md                   The build, step by step
  ALOWARE-AGENT.md           Custom Function fields, variables and prompts
  API-NOTES.md               Verified Scheduler API behavior
```

`src/*.js` are what you paste into HubSpot. Everything else is for local testing
or reference.

## How it works

1. **The agent collects the basics.** It needs first name, email, a day
   (`preferred_date`, normalized to `YYYY-MM-DD`) and a rough time of day
   (`preferred_period`: `morning`, `afternoon` or `evening`). It doesn't pick an
   exact time, because it can't see the calendar.
2. **It calls the Custom Function `request_booking`**, which POSTs JSON to the
   workflow's webhook trigger URL.
3. **The workflow enrolls the matching contact** (matched on email) and runs the
   custom code action.
4. **The action reads live availability** from the meeting link. HubSpot has
   already applied the link's own rules: working hours, minimum notice, buffer,
   booking window, duration, and every rep's busy blocks. The action adds no
   scheduling rules of its own.
5. **It picks the opening closest to the request**, working outward:
   - the requested day in the requested period
   - then the requested day at any time
   - then the next day with something in that period
   - then it offers three alternatives on three different days.
6. **It books through the Meetings API** using the link's own duration, in the
   payload shape the live API actually accepts (see [API notes](docs/API-NOTES.md)).
7. **It returns `booking_status` and `confirmation_text`.** The workflow branches
   on the status. Every branch already has a sentence under 160 characters that's
   ready to text back.

The contact's timezone comes from their HubSpot **IP Timezone** property, with
the agent's capture and then the office default as fallbacks. That way a Chicago
contact hears Chicago times and "afternoon" means *their* afternoon.

## Quick start

Full detail is in [docs/SETUP.md](docs/SETUP.md). The short version:

1. **Check your portal.** Create a service key, then run the probe:
   ```powershell
   .\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call
   ```
   You want `/scheduler/2026-03/` to return 200, and every pool member to read
   `calendar OK`.
2. **Build the meeting link.** Make a round-robin scheduling page and set its
   **Meeting type** to a value like `AI Booked Call`. If that option doesn't exist
   yet, add it to the *Call and meeting type* property first.
3. **Set the slug.** Change `MEETING_SLUG` at the top of
   `src/booking-action.js`. If the link requires fields beyond name and email,
   add them to `FORM_FIELDS`.
4. **Build the workflow.** It's contact-based, with the trigger **When a webhook
   is received**, matched on email. Add a Custom code action (Node.js 20.x), paste
   in `src/booking-action.js`, add the secret `HUBSPOT_BOOKING_TOKEN`, map the
   inputs **as String**, and declare the outputs.
5. **Branch on `booking_status`.** See the table below.
6. **Set up the agent.** Add the Custom Function `request_booking` pointing at the
   trigger URL, plus the prompt from
   [docs/ALOWARE-AGENT.md](docs/ALOWARE-AGENT.md).
7. **Test from a real phone,** including the failure paths
   ([SETUP.md, Phase 5](docs/SETUP.md#phase-5--test-before-anyone-real-touches-it)).

## Workflow outputs and branching

| `booking_status` | Meaning | Suggested workflow action |
|---|---|---|
| `booked` | A real meeting exists, with a calendar event | Aloware: **Disenroll from all sequences**, so a booked lead stops getting chased. Optionally set a reporting property. |
| `not_scheduled` | HubSpot returned 200 **but booked nothing**. The assigned rep's calendar is offline. | **Urgent task** for a human. The contact was told someone will follow up. Don't disenroll. |
| `slot_taken` | Nothing matched, or the slot went between read and write. `alternatives_text` holds three real times. | Aloware: **Send SMS** with `confirmation_text` (it already offers the alternatives) |
| `no_availability` | The link has no openings at all | Task for the sales team |
| `needs_email` | No email on the contact or from the agent | Aloware: **Send SMS** with `confirmation_text` (it asks for one) |
| `needs_phone` | Only happens when the link requires a phone and neither source had one | Same as `needs_email` |
| `error` | Scope, token, network, or a misconfiguration | Task with `error_detail` in the body |

Other outputs, all to be declared in the action: `confirmation_text`,
`booking_label`, `booked_start_ms`, `booked_duration_ms`, `alternatives_text`,
`calendar_event_id`, `booked_contact_id`, `payload_shape`, `error_detail`.

Aloware installs native actions into the HubSpot workflow editor (Send SMS/MMS,
Enroll to sequence, Disenroll from all sequences, Add to power dialer). Use those
for the branches. You don't need any code to call Aloware's API.

## Optional: let the agent offer real times

Without this upgrade, the agent can only ask *"which day suits you?"* When someone
reasonably asks *"well, what's available?"*, it has nothing to say.

The agent can't ask the workflow, because a webhook trigger returns `202` with no
data. Instead, `src/refresh-slots-action.js` pre-computes the next three openings
onto **one CRM record**: a finished sentence plus a date and period per slot. A
second Custom Function, `get_available_times`, reads that record synchronously
from the CRM API. The agent reads the sentence aloud and copies the chosen slot's
date and period back into `request_booking`, so it never does any time math.

Stale offers are safe. `request_booking` always re-reads live availability, so a
slot that's gone comes back as `slot_taken` with fresh alternatives, not a double
booking. Setup is in [SETUP.md, Phase 4B](docs/SETUP.md#phase-4b--optional-the-agent-offers-real-times).

## Things the docs won't tell you

Each of these was found against a live portal. Details are in
[docs/API-NOTES.md](docs/API-NOTES.md).

- **Booking needs a write scope.** With only
  `scheduler.meetings.meeting-link.read`, the book endpoint returns **403**, and it
  looks like the endpoint is broken. Add `crm.objects.contacts.write`.
- **`startTime` and `duration` are both epoch milliseconds.** The documented
  2026-03 shape (ISO 8601 plus minutes) returns
  `400 MEETING_DURATION_NOT_VALID`.
- **Don't retry in a second payload shape.** The retry's error overwrites the real
  one, so you end up debugging a fake duration problem.
- **The slug must be URL-encoded.** Round-robin slugs contain a `/` (becomes `%2F`).
- **An "offline booking" is a silent failure.** If the round robin picks a rep
  whose calendar is disconnected, HubSpot treats them as free at all hours and
  returns **HTTP 200** with `isOffline: true` and an empty `calendarEventId`. It
  creates no meeting and no calendar event. The action reports this as
  `not_scheduled`, never as `booked`.
- **The webhook trigger silently ignores unknown contacts.** Posting an email that
  matches no contact returns the same `202` as a successful enrollment, and
  nothing shows in the workflow history.
- **IP Timezone is a slug, not an IANA name.** `america_slash_new_york` throws a
  `RangeError` in `Intl`. The action converts and validates it.
- **Map `preferred_date` as String, not Date.** A Date-typed mapping reformats it,
  and the comparison silently fails. The contact then gets the next open slot
  instead of the day they asked for.
- **HubSpot rejects an empty last name.** The action splits a full name or sends
  `-`.
- **Form fields must match the link exactly.** A missing required field is
  rejected, and so is a field the form doesn't have.
- **API bookings on a Phone Call link may still carry a Google Meet URL** if the
  scheduling page has a videoconference link attached. Remove it from the page if
  you don't want it.

## Known limitations

- **First-time callers can't book on voice.** By default Aloware doesn't create
  HubSpot contacts for unknown inbound numbers, so the webhook has no contact to
  match. HubSpot Meetings also needs an email, and collecting one by voice is
  unreliable. SMS doesn't have this problem, because people type their email
  accurately.
- **The agent never states a confirmed time on the first reply.** It can't know
  which slot was booked until the action returns. The confirmation arrives a few
  seconds later as a follow-up text.
- **No weighted round robin.** It follows whatever the meeting link does.
- **Custom code limits:** 20 seconds and 128 MB per run. A booking takes about
  0.7 s and about 100 MB, which leaves room but not much for extra calls.

## Testing locally

No install needed, just Node 20:

```bash
npm test
```

```bash
npm run demo
```

The tests stub `axios` and freeze the clock, so they run offline and don't go
stale as their sample dates pass. They cover busy-block exclusion, the link's own
duration, timezone slugs, the offline-booking failure, conflict vs.
misconfiguration, consent handling, phone normalization, and the 160-character
SMS ceiling on every reply.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent calls the function, nothing happens in HubSpot | No contact matched the webhook payload | Confirm the contact exists and its email is in the payload |
| `error` with 401 in `error_detail` | Wrong or truncated key | Re-copy the full key into the secret |
| `error` with 403 | Missing write scope | Add `crm.objects.contacts.write` |
| `not_scheduled` | A pool member's calendar is disconnected | Run the probe. Reconnect the calendar or remove the rep. |
| Meeting type is blank | The link's Meeting type isn't set | Set it on the scheduling page's Overview step |
| Books the wrong day | `preferred_date` mapped as Date | Re-map it as String |
| Always the same rep | Prioritize contact owner is on | Turn it off, or accept it |
| Agent states a time that doesn't match the invite | The prompt's "never state a confirmed time" rule is missing | Restore it ([ALOWARE-AGENT.md](docs/ALOWARE-AGENT.md)) |

To roll back, turn the workflow off. The agent's call is still accepted but books
nothing, so there's no half-finished state to clean up.

## Security notes

- The booking service key lives only in HubSpot's workflow **Secrets**. Never put
  it in an Aloware header.
- The optional `get_available_times` function *does* put a key in an Aloware
  header. Give it a **separate, read-only key** scoped to the cache object. If it
  leaks, someone learns when your team is free, not your CRM.
- Consent is never assumed. The action only sends a consent response when the
  workflow passes a consent type id **and** an opt-in the contact actually gave.
- The meeting link slug isn't a secret, since it's in the public booking URL.

---

Built by [Jibril Sulaiman](https://github.com/jbrillionaire). Other integration
guides are in the same account.
