<!--
  docs/SETUP.md -- build runbook for Aloware AI -> HubSpot Meetings booking
  Author:  Jibril Sulaiman
  Created: 2026-09-28 (from a production runbook dated 2026-08-19)
  What:    The build in order, each phase ending in a pass check.
  Why:     Each phase depends on the one above it; skipping a check turns a
           twenty-minute fix into a silent production failure.
-->

# Setup runbook

Follow this top to bottom. It's about four hours of work, plus two more if you do
the optional Phase 4B. Each phase ends with a **Pass** check, and you shouldn't
start the next phase until that check passes.

| Phase | Produces | Time |
|---|---|---|
| [0 · Gate checks](#phase-0--gate-checks) | Go or no-go | 20 min |
| [1 · Meeting link](#phase-1--the-meeting-link) | A bookable round-robin link | 45 min |
| [2 · Service key](#phase-2--service-key-and-the-real-gate) | A key, and proof the write works | 20 min |
| [3 · Workflow](#phase-3--the-workflow) | Webhook URL and the booking action | 60 min |
| [4 · Agent](#phase-4--the-aloware-agent) | The Custom Function and its prompt | 45 min |
| [4B · Real times](#phase-4b--optional-the-agent-offers-real-times) | Optional: the agent offers openings | 2 hrs |
| [5 · Test](#phase-5--test-before-anyone-real-touches-it) | A real booking, end to end | 45 min |

---

## Phase 0 · Gate checks

Phase 0 is there so you find a blocker in twenty minutes rather than halfway
through the build.

**0.1 Custom code actions exist.** Open any workflow, click **+**, and scroll the
action list.
**Pass:** **Custom code** is listed. If it isn't, stop. Custom code and webhook
triggers are both Data Hub Professional features, and nothing here works without
them.

**0.2 Custom Functions exist in Aloware.** Open an AloAI agent and look for a
**Custom Functions** tab.
**Pass:** the tab exists and **+ Add Function** is clickable. While you're there,
check which agent types you can create. Text and outbound voice agents can be
disabled on some accounts. The workflow doesn't care which type calls it, but
your plan should.

> **Fallback if Custom Functions are missing:** the agent's *Update Contact
> Field* action can write a property that syncs to HubSpot, and the workflow can
> trigger on that property changing. It's slower and less direct, but it works.

**0.3 The Scheduler API answers.** This needs the key from Phase 2, so either
create the key now or come back to this step.

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx
```

**Pass:** `/scheduler/2026-03/...` returns **200**. If only `/v3/` answers,
change `SCHEDULER` at the top of both `src/*.js` files.

---

## Phase 1 · The meeting link

**1.1 Create a round-robin scheduling page.** Go to **Sales → Meetings → Create
scheduling page → Round robin**. Name it whatever you like, because attribution
comes from the meeting type, not the name.

On the **Overview** step, set **Meeting type** to your AI-booking type (for
example `AI Booked Call`). If it isn't listed, add the option under **Settings →
Properties → Call and meeting type** (`hs_activity_type`) first. This setting is
all the attribution there is: every booking through the link gets that type, and
no code has to label it.

Also on Overview:
- **Location:** Phone Call (or whatever you actually use)
- Leave **cancel and reschedule links on**, because they feed no-show and
  reschedule handling.
- If you don't want video, **remove any videoconference link**. Otherwise API
  bookings arrive with a Meet or Zoom URL even on a phone call.

Then add **Team members** to the round-robin pool. Choose them deliberately
rather than adding everyone.

> **Every rep in the pool needs a connected calendar.** A rep whose calendar is
> unreachable comes back as `isOffline: true` with no busy times. HubSpot then
> believes they're free at every hour and hands them slots it can't verify. Any
> booking that lands on them returns HTTP 200 and **creates nothing**. The
> probe's step 3 lists each member's calendar state, so re-run it whenever the
> pool changes.

**1.2 Set the scheduling rules.** HubSpot enforces all of these before the action
ever sees a slot, so the code has no matching settings to keep in sync.

| Setting | Consider |
|---|---|
| Duration | Pick **one** length. Several work, but then the agent has to choose, and it doesn't need that decision. |
| Availability | Your team's real working hours |
| Minimum notice | This decides how soon the bot can book. The code adds no lead time of its own. |
| Buffer time | Applied automatically between meetings |
| Booking window | How far ahead the bot can offer |
| Prioritize contact owner | Decide this deliberately. When it's on, a contact who already has an owner goes to that owner, not the round robin. |

**1.3 Check the required form fields.** Every required field on the page must be
sent in the API request, or HubSpot rejects the booking. Every field you add here
is another thing the bot has to collect, so add nothing it can't reliably get in
a text conversation.

Mirror the form in `FORM_FIELDS` at the top of `src/booking-action.js`:

```js
const FORM_FIELDS = [
  { name: 'phone', required: true },   // only if your page requires a phone
];
```

Get this wrong in either direction and bookings fail: a missing required field is
rejected, and so is a field the form doesn't have. For any other custom field,
pass it through `extra_form_fields`.

**1.4 Record the slug.** The slug is everything after `meetings.hubspot.com/`,
for example `your-team/ai-booked-call`. Put it in `MEETING_SLUG` in both
`src/*.js` files.

**1.5 Book one by hand.** Open the public link and book as if you were a lead.
**Pass:** the contact shows a Meeting, the confirmation email arrives, and the
invite lands on the assigned rep's calendar.

---

## Phase 2 · Service key and the real gate

**2.1 Create the service key.** Go to **Settings → Integrations → Service Keys →
Create** (older portals call these *Private apps*). Give it two scopes:

| Scope | Why |
|---|---|
| `scheduler.meetings.meeting-link.read` | List links, read availability and the form definition |
| `crm.objects.contacts.write` | **Required to book.** Booking creates or updates the contact. |

> **Read-only isn't enough.** With just the read scope, the book endpoint returns
> **403** on every payload. That looks like a broken endpoint, but it's only a
> missing permission.

Copy the key. HubSpot shows it only once.

**2.2 Prove the booking write works.** First do the read-only pass, then book one
real test slot using a start time that step 4 prints:

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call
```

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call -Book -StartMs 1788890400000 -Email you@yourdomain.com
```

The probe sends both documented payload shapes. **Expect the millisecond shape
to succeed and the ISO shape to fail with 400.** `src/booking-action.js` is
pinned to milliseconds.

**Pass:** the response carries a non-empty `calendarEventId`, and the probe
contact now has a Meeting.

If both shapes fail, the bot can't write bookings on your portal. Fall back to
the agent texting the meeting link, so the contact books with one tap and Phases
3–5 aren't needed.

**2.3 Check consent.** Step 3 of the probe prints the page's
`legalConsentOptions`. If consent is *required*, each option has a
`communicationTypeId` that the booking must answer. The action sends an empty
consent array unless the workflow passes `consent_type_id` **and** a
`consented: true` that the agent actually captured. Never default it to true.

**2.4 Clean up and check the stamp.** Open the test meeting and confirm the
following:
- `hs_activity_type` is your AI-booking type. This proves the link setting
  reaches API bookings.
- `hs_meeting_source` is `INTEGRATION`. This is a second way to tell bot bookings
  apart.
- `hs_meeting_outcome` is `SCHEDULED`.

Then delete the test meeting and the probe contact.

---

## Phase 3 · The workflow

**3.1 Create the workflow.** Go to **Automation → Workflows → Create →
Contact-based**. For the trigger, choose **When a webhook is received**.

> **Unknown contacts fail silently.** The trigger enrolls an *existing* contact
> matched from the payload. Posting an email that matches nobody returns the same
> `202 Accepted` as a real enrollment, with nothing in the workflow history. The
> Aloware → HubSpot contact sync is what makes this rare.

**3.2 Define the incoming fields.** Send one sample POST so HubSpot learns the
shape (use `-WebhookUrl` on the probe, or any HTTP client), then declare each
field. The content type is `application/json`.

```json
{
  "email":            "lead@example.com",
  "first_name":       "Alex",
  "last_name":        "Morgan",
  "phone":            "+15550100123",
  "preferred_date":   "2026-09-08",
  "preferred_period": "afternoon",
  "timezone":         "America/New_York"
}
```

**Map every field as String, especially `preferred_date`.** If it's typed as a
Date, HubSpot reformats it, the action's comparison against `2026-09-08` silently
fails, and the contact gets the next open slot instead of the day they chose.

At the **Match** step, match on **email**. Then copy the trigger URL. That's the
endpoint the agent calls.

**3.3 Add the custom code action.** Choose **Custom code**, language **Node.js
20.x**, and paste in all of `src/booking-action.js`.

- **Secrets:** add your Phase 2 key as `HUBSPOT_BOOKING_TOKEN`.
- **Properties to include in code:** map each webhook field to the matching input
  name: `first_name`, `last_name`, `email`, `phone`, `preferred_date`,
  `preferred_period`.
- **Timezone takes two inputs.** Map the enrolled contact's **IP Timezone**
  property to `timezone`, and the webhook's own `timezone` field to
  `timezone_agent`. The action uses the contact's timezone first, then the
  agent's, then Eastern.
- **Data outputs:** declare every one, or later actions can't see them.

| Output | Type |
|---|---|
| `booking_status` | String (always present) |
| `confirmation_text` | String (always present) |
| `booking_label` | String |
| `booked_start_ms` | Number |
| `booked_duration_ms` | Number |
| `alternatives_text` | String |
| `calendar_event_id` | String |
| `booked_contact_id` | String |
| `payload_shape` | String |
| `error_detail` | String |

**Pass:** use **Test action** against a real contact. It should return
`booking_status: booked`, a real `calendar_event_id`, and a sensible
`booking_label`. Expect a runtime of roughly 0.7 s and roughly 100 MB of memory.

**3.4 Branch on `booking_status`.** Add an if/then branch. Every branch already
has its sentence in `confirmation_text`, so nothing in the workflow has to write
a message.

| Value | Actions |
|---|---|
| `booked` | Aloware **Disenroll from all sequences**. Optionally set a reporting property. |
| `not_scheduled` | **Urgent task.** Nothing was booked, and the contact was told a human will follow up. Don't disenroll. |
| `slot_taken` | Aloware **Send SMS** with `confirmation_text` |
| `no_availability` | Task for the sales team |
| `needs_email` / `needs_phone` | Aloware **Send SMS** with `confirmation_text` |
| `error` | Task with `error_detail` in the body |

---

## Phase 4 · The Aloware agent

The full field list and prompts are in [ALOWARE-AGENT.md](ALOWARE-AGENT.md). In
summary:

1. **AloAI agent → Custom Functions → + Add Function:** name it `request_booking`,
   use POST to the Phase 3 trigger URL with `Content-Type: application/json`, and
   turn on both *Respond during execution* and *Respond after execution*.
2. Declare the variables `first_name`, `last_name`, `email`, `phone`,
   `preferred_date`, `preferred_period` and `timezone`.
3. Paste the booking instructions into the agent's prompt.
4. Attach the function to the agent, triggered when the contact has agreed to a
   day.

**Pass:** the Aloware test console fires the function, and the workflow shows a
new enrollment within a few seconds.

> **Proving it on inbound voice first** is a good idea if SMS agents aren't
> enabled yet. Make a blank inbound voice agent, not a Booking template, since
> those come pre-wired to Cal.com and Calendly. Build the same Custom Function
> and call it from a phone whose number is already on a HubSpot contact that has
> an email. The Custom Function carries over to the text agent unchanged. Delete
> the test agent afterwards.

---

## Phase 4B · Optional: the agent offers real times

**4B.1 Create the cache record.** Create a custom object with a single record
(any object works, as long as you know its type id and record id). Availability
is the same for everyone on a round-robin link, so one row serves every
conversation.

| Property | Type | Holds |
|---|---|---|
| `slot_offer_text` | Single-line text | The sentence the agent reads aloud, word for word |
| `slot_1_label` … `slot_3_label` | Single-line text | `Tue Sep 8 at 9:00 AM EDT` |
| `slot_1_date` … `slot_3_date` | Single-line text | `2026-09-08`. **Text, not Date**, for the same reason as 3.2. |
| `slot_1_period` … `slot_3_period` | Single-line text | `morning` / `afternoon` / `evening` |
| `slot_count` | Single-line text | How many slots are on offer |
| `slot_refreshed_at` | Single-line text | ISO timestamp of the last refresh |

**4B.2 Build the refresh workflow.** Add one custom code action with
`src/refresh-slots-action.js`, the `HUBSPOT_BOOKING_TOKEN` secret, and secrets
`SLOT_CACHE_TYPE` and `SLOT_CACHE_ID`. The key also needs read and write access
on the cache object. Trigger it three ways, because each covers a different gap:

- **On a schedule**, at least daily
- **After every booking**, on the `booked` branch, so the slot just taken stops
  being offered
- **When a booking conversation opens**, through its own webhook, fired by the
  agent before it asks anything

**Pass:** `refresh_status: ok`, and the record holds a sentence you'd be happy to
hear read aloud.

**4B.3 Give the agent a separate read-only key.** This key sits in an Aloware
header, outside HubSpot, so scope it to *read* on the cache object only.

**4B.4 Add the `get_available_times` function** and its prompt. See
[ALOWARE-AGENT.md](ALOWARE-AGENT.md#optional-get_available_times).

---

## Phase 5 · Test before anyone real touches it

**5.1 Happy path from a real phone.** Ask for a call on a day and time you know
is open.
**Pass:** the workflow enrolled the contact, the action returned `booked`, the
meeting is on the contact with your meeting type, and the invite reached the
rep's calendar.

**5.2 The failure paths:**

| Try | Expect |
|---|---|
| A day and time that are fully booked | `slot_taken` with three real alternatives |
| Booking without giving an email | `needs_email`, and the agent asks for one |
| A date months ahead | `slot_taken` with alternatives, not silence |
| A phone number that isn't in HubSpot | Find out now whether the workflow enrolls at all (see 3.1) |
| A pool rep with a disconnected calendar | `not_scheduled` and a task, never a false "you're all set" |

**5.3 Confirm the follow-up sequence stops.** Enroll a test contact in a nurture
sequence, book through the bot, and confirm the Aloware disenroll fired. A booked
lead who keeps getting chased is the failure this build most needs to prevent.

**5.4 Watch the first day.** Check the workflow history filtered to failures, the
task queue fed by the `error` and `not_scheduled` branches, and a spot check of
AI-booked meetings against what each contact actually asked for.

**To roll back,** turn the workflow off. The agent's call is still accepted but
books nothing, so there's no half-finished state to clean up.
