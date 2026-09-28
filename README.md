<!--
  README.md -- Aloware AI appointment scheduling via HubSpot
  Author:  Jibril Sulaiman
  Created: 2026-09-28 (from a production build first shipped 2026-08-19)
  What:    The complete guide: what the integration does, how it works, and
           every HubSpot and Aloware setup step, click by click.
  Why:     The build spans two vendors' UIs and one API with undocumented
           behavior. Each step ends in a check, because most failures here are
           silent -- HTTP 200 with nothing booked.
-->

# Aloware AI appointment scheduling via HubSpot

Let an **Aloware AloAI agent** book appointments by SMS or voice straight into
**HubSpot Meetings**. The booking goes onto a rep's real calendar through your
normal HubSpot round-robin meeting link. There's no third-party scheduler, no
middleware server, and nothing runs outside HubSpot.

**What the contact experiences:**

> **Contact:** Can I talk to someone Tuesday afternoon?
> **Agent:** Absolutely, I'm locking that in now. Your confirmation will be with you in a moment.
> **Agent:** You're all set for Tue Sep 8 at 2:00 PM EDT. Invite headed to alex@example.com.

**What lands in HubSpot:** a Meeting on the contact's timeline, owned by the rep
the round robin picked, and stamped with your **Call and meeting type**. The rep
gets a calendar event, the contact gets HubSpot's confirmation email and invite,
and any reminder sequences you already run on meetings fire as normal.

---

## Table of contents

1. [How it works](#1-how-it-works)
2. [Why book through HubSpot's own meeting link](#2-why-book-through-hubspots-own-meeting-link)
3. [Requirements](#3-requirements)
4. [What's in this repo](#4-whats-in-this-repo)
5. [Setup, step by step](#5-setup-step-by-step)
   - [Step 1: Check your HubSpot and Aloware plans](#step-1-check-your-hubspot-and-aloware-plans)
   - [Step 2: Add a HubSpot meeting type for AI bookings](#step-2-add-a-hubspot-meeting-type-for-ai-bookings)
   - [Step 3: Build the HubSpot round-robin meeting link](#step-3-build-the-hubspot-round-robin-meeting-link)
   - [Step 4: Create the HubSpot service key](#step-4-create-the-hubspot-service-key)
   - [Step 5: Probe your portal before writing anything](#step-5-probe-your-portal-before-writing-anything)
   - [Step 6: Configure the code for your link](#step-6-configure-the-code-for-your-link)
   - [Step 7: Build the HubSpot workflow and webhook trigger](#step-7-build-the-hubspot-workflow-and-webhook-trigger)
   - [Step 8: Add the custom code action](#step-8-add-the-custom-code-action)
   - [Step 9: Branch the workflow on the result](#step-9-branch-the-workflow-on-the-result)
   - [Step 10: Create the Aloware Custom Function](#step-10-create-the-aloware-custom-function)
   - [Step 11: Add the booking instructions to the agent](#step-11-add-the-booking-instructions-to-the-agent)
   - [Step 12: Test end to end](#step-12-test-end-to-end)
   - [Step 13: Go live and watch the first day](#step-13-go-live-and-watch-the-first-day)
6. [Optional: let the agent offer real times](#6-optional-let-the-agent-offer-real-times)
7. [Reference: inputs, outputs and settings](#7-reference-inputs-outputs-and-settings)
8. [HubSpot behavior the docs won't tell you](#8-hubspot-behavior-the-docs-wont-tell-you)
9. [Known limitations](#9-known-limitations)
10. [Troubleshooting](#10-troubleshooting)
11. [Testing locally](#11-testing-locally)
12. [Security](#12-security)

---

## 1. How it works

```
 Contact ──SMS / voice──▶ Aloware AloAI agent
                              │
                              │  Custom Function "request_booking"
                              │  POST { email, first_name, preferred_date, preferred_period, ... }
                              ▼
                   HubSpot workflow: "When a webhook is received"
                   (enrolls the existing contact, matched on email)
                              │
                              ▼
                   HubSpot custom code action  ── src/booking-action.js
                     1. GET  availability for the meeting link
                     2. pick the opening closest to the request
                     3. POST book, through the Meetings API
                              │
                              ▼
                   booking_status + confirmation_text
                              │
        ┌──────────────┬──────┴───────┬──────────────────┬─────────────────┐
        ▼              ▼              ▼                  ▼                 ▼
     booked      slot_taken     needs_email       not_scheduled          error
   stop chase    text the       text: ask for     urgent task:       task with
   sequence      alternatives   an email          nothing booked     error_detail
```

Step by step:

1. **The agent collects four things:** first name, email, a day, and a rough time
   of day. It converts the day to `YYYY-MM-DD` and the time to `morning`,
   `afternoon` or `evening`. It never picks an exact time, because it can't see
   the calendar.
2. **The agent calls the Custom Function `request_booking`**, which POSTs that
   JSON to a HubSpot workflow's webhook URL.
3. **HubSpot enrolls the matching contact** and runs the custom code action.
4. **The action reads live availability** for the meeting link. By this point
   HubSpot has already applied every rule on the link (working hours, minimum
   notice, buffer, booking window, duration) and every rep's busy blocks. The
   action adds no rules of its own.
5. **It picks the best match, working outward:**
   - the requested day in the requested period
   - then the requested day at any time
   - then the next day with something in that period
   - then it offers three alternatives on three different days.
6. **It books through the HubSpot Meetings API** using the link's own duration.
7. **It returns `booking_status`**, which the workflow branches on, and
   **`confirmation_text`**, a reply under 160 characters that's ready to text
   back on every branch.

Times are stated in the **contact's own timezone**, taken from HubSpot's IP
Timezone property, so a Chicago contact hears Central time.

---

## 2. Why book through HubSpot's own meeting link

**HubSpot meeting types drive automation.** Many portals move deals, start
sequences and report off a meeting's **Call and meeting type**
(`hs_activity_type`). An external AI scheduler books into *its own* calendar and
syncs a meeting back, which means another integration to build, and it often
loses the meeting type.

**A HubSpot meeting link stamps the type for you.** Every scheduling page has a
**Meeting type** setting, and every booking made through that page gets that
type, including bookings made by API. If the bot books *through the link*,
attribution needs no code at all.

**You also keep everything HubSpot already does:**

| You keep | Because it's the native link |
|---|---|
| Round robin, and "prioritize contact owner" if you use it | HubSpot assigns the rep |
| Confirmation email and calendar invite | HubSpot sends them |
| Cancel and reschedule links | They're in HubSpot's email |
| Meeting-based reminder sequences | The meeting is a normal HubSpot meeting |
| A way to separate bot bookings | `hs_meeting_source` is `INTEGRATION` for API bookings and `MEETINGS_PUBLIC` for the page |

**It runs entirely inside HubSpot.** The logic runs in a HubSpot workflow, so
there's no server to host, secure or pay for.

Alternatives considered and rejected: moving booking to Cal.com or Calendly, or
buying a dedicated AI booking product. Each one adds a second calendar system and
an integration that has to write meeting types back into HubSpot.

---

## 3. Requirements

| Requirement | Details |
|---|---|
| **HubSpot Data Hub Professional** or higher (formerly Operations Hub) | Custom code actions and "When a webhook is received" triggers both need it. Sales Hub or Service Hub Enterprise seats *don't* prove you have it. Step 1 shows how to check. |
| **HubSpot Sales Hub** with Meetings | Needed for a round-robin scheduling page |
| **HubSpot super admin**, or permission to edit workflows, properties and service keys | Needed to create the pieces below |
| **Aloware** with **AloAI agents** and **Custom Functions** | The agent reaches HubSpot through a Custom Function |
| The **Aloware ↔ HubSpot integration** installed | This syncs contacts, and it adds Aloware's actions to HubSpot workflows |
| **Connected calendars** for every rep in the round-robin pool | A disconnected calendar makes bookings silently vanish. See [section 8](#8-hubspot-behavior-the-docs-wont-tell-you). |
| **Node.js 20** on your computer | Optional. Only needed to run the tests and demo locally. |

**Time:** about four hours for Steps 1–13, plus about two hours for the optional
[section 6](#6-optional-let-the-agent-offer-real-times).

---

## 4. What's in this repo

```
src/
  booking-action.js           HubSpot custom code action: reads availability, books, returns a status
  refresh-slots-action.js     Optional: writes the next 3 openings to a CRM record the agent can read
test/
  booking-action.test.mjs     Offline tests with HubSpot stubbed; every branch
  refresh-slots-action.test.mjs
examples/
  demo.mjs                    Prints what the action does in 10 scenarios, with no network
scripts/
  probe.ps1                   Checks your real HubSpot portal before you build (Windows PowerShell)
  probe.sh                    Same probe for bash (macOS, Linux, Git Bash)
docs/
  API-NOTES.md                Verified HubSpot Scheduler API behavior, payload by payload
```

**You paste `src/booking-action.js` into HubSpot.** Everything else is for
checking, testing or reference.

---

## 5. Setup, step by step

Do the steps in order. Each one ends with a ✅ **check**, and you shouldn't move
on until it passes. Most failures in this build are silent (HTTP 200 with nothing
booked), so the checks are the only way you'll see them.

> HubSpot menus move occasionally. If a path below doesn't match your portal,
> search for the named setting with the search bar at the top of HubSpot.

### Step 1: Check your HubSpot and Aloware plans

*About 10 minutes. Stop here if either check fails.*

**1a. HubSpot has custom code actions.**
1. In HubSpot, go to **Automation → Workflows** and open any workflow, or create
   a blank one. You can delete it afterwards.
2. Click the **+** under the trigger to add an action.
3. In the action panel, open **Data ops**, or search for `code`.

✅ **Check:** **Custom code** is listed. If it isn't, your portal doesn't have
Data Hub Professional, and nothing in this guide will work.

**1b. Aloware has Custom Functions.**
1. In Aloware, go to **AloAi Agents** and open an agent, or create a blank one.
2. Look for the **Custom Functions** tab.

✅ **Check:** the tab exists and **+ Add Function** is clickable.

While you're in Aloware, also check which agent types you can create: **Text**,
**Voice → Inbound** and **Voice → Outbound**. Some accounts have text or outbound
voice disabled. The HubSpot side doesn't care which type calls it, but you should
know before planning an SMS bot.

> **No Custom Functions?** You can still do this more slowly. Have the agent use
> *Update Contact Field* to write a property that syncs to HubSpot, and trigger
> the workflow on that property changing instead of on a webhook.

### Step 2: Add a HubSpot meeting type for AI bookings

*About 5 minutes.*

This is the label every bot booking will carry. It's what your reports and deal
automation will key on.

1. Click the **Settings** gear (top right).
2. Go to **Objects → Activities**, then open the **Call and meeting types** tab.
   *In some portals this is under* **Data Management → Properties → Meeting
   properties → "Call and meeting type"**.
3. Click **Add type** (or **Add an option**) and name it, for example,
   **`AI Booked Call`**.
4. Save.

✅ **Check:** the new type appears in the list. The internal property behind it
is `hs_activity_type`.

> Don't reuse a call-direction property (inbound or outbound) for this. A booked
> meeting isn't a call in either direction.

### Step 3: Build the HubSpot round-robin meeting link

*About 30 minutes.*

**3a. Create the scheduling page.**
1. Go to **Sales → Meetings**. *In newer navigation this is* **Library →
   Meetings**.
2. Click **Create scheduling page → Round robin**.
3. Give it an internal name, for example `AI Booked Call`. The name doesn't
   affect attribution.

**3b. Overview step.**

| Setting | Set it to | Why |
|---|---|---|
| **Meeting type** | `AI Booked Call` (from Step 2) | **This is all the attribution there is.** Every booking through this link, including API bookings, gets this type. |
| **Location** | Phone Call, or whatever your reps actually use | It's stamped on `hs_meeting_location` |
| **Videoconference link** | **Remove it** unless you want video | Otherwise API bookings get a Google Meet or Zoom URL even for a phone call |
| **Cancel / reschedule links** | Leave **on** | Contacts can change the booking themselves |

**3c. Team members step.** Add the reps who should take these calls. Choose them
deliberately rather than adding everyone.

> ⚠️ **Every rep in the pool needs a connected calendar.** If a rep's calendar is
> disconnected, HubSpot treats them as free at every hour of every day. Any
> booking the round robin gives them returns **HTTP 200 and creates nothing**: no
> meeting and no calendar event. Step 5 checks every rep for this.

**3d. Scheduling step.** HubSpot enforces all of these *before* the code ever
sees a slot, so set them properly here. There's nothing matching to configure in
the code.

| Setting | Recommendation |
|---|---|
| **Duration** | Pick **one** length. The code reads it from the link and books that length. |
| **Availability** | Your team's real working hours, in their timezone |
| **Minimum notice time** | This decides how soon the bot can book. The code adds no lead time of its own. |
| **Buffer time** | Whatever gap you want between meetings |
| **Booking window** (how far ahead) | For example, 2 weeks. The bot can't offer anything beyond it. |
| **Start time increment** | For example, 15 or 30 minutes |
| **Prioritize contact owner** | **Decide this deliberately.** When it's on, a contact who already has an owner goes to that owner instead of the round robin. |

**3e. Form step.** Note every **required** field. Every one of them must be sent
in the API request, or HubSpot rejects the booking.

- First name, last name and email are always sent. You don't need to do anything
  for those.
- If the form requires **phone**, you'll switch that on in Step 6.
- Every other required field is something the bot has to collect. Add nothing it
  can't reliably get in a text conversation.

**3f. Privacy and consent.** If you turn on a consent checkbox, keep it
**optional** unless you have a reason not to. If consent is *required*, the bot
must capture a real yes or no for each consent type (see Step 8).

**3g. Save and copy the slug.** Save the page and copy its URL. The **slug** is
everything after `meetings.hubspot.com/`:

```
https://meetings.hubspot.com/your-team/ai-booked-call
                             └──────── slug ────────┘
```

**3h. Book one by hand.** Open the link in a private browser window and book it as
if you were a lead.

✅ **Check:** the contact shows a Meeting on its timeline, with **Call and meeting
type = AI Booked Call**. The confirmation email arrives, and the invite lands on
the assigned rep's calendar. Delete the test meeting afterwards.

### Step 4: Create the HubSpot service key

*About 5 minutes.*

1. Go to **Settings → Integrations → Service Keys → Create service key**.
   *Older portals call this* **Private Apps → Create a private app**.
2. Name it `AI Booking Bridge`.
3. Add exactly these scopes:

   | Scope | Why |
   |---|---|
   | `scheduler.meetings.meeting-link.read` | Read the link, its form and its availability |
   | `crm.objects.contacts.write` | **Required to book.** Booking creates or updates the contact. |

4. Create the key, then click **Show → Copy**. The key starts with `pat-`.

> ⚠️ **Read-only is not enough.** With only the read scope, the book endpoint
> returns **403**. That looks like a broken API, but it's only a missing scope.

✅ **Check:** you have the full key copied (roughly 45 characters, starting with
`pat-`). Keep it out of chat messages, email and Aloware. It only goes into
HubSpot's workflow Secrets.

### Step 5: Probe your portal before writing anything

*About 15 minutes.*

The probe asks your real portal the questions that decide whether this build will
work. Steps 1–4 of the probe only read. Step 5 of the probe writes a real test
booking, and only when you ask it to.

**Windows (PowerShell):**

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call
```

**macOS, Linux or Git Bash:**

```bash
HUBSPOT_TOKEN=pat-na1-xxxx MEETING_SLUG=your-team/ai-booked-call bash scripts/probe.sh
```

Read the output section by section:

| Probe section | What you want to see |
|---|---|
| **1. API version** | `/scheduler/2026-03/...` returns **HTTP 200**. A **401** means the key is wrong or truncated. A **403** means a scope is missing. |
| **2. Meeting links** | Your link appears in the list |
| **3. Form and pool** | Under *POOL MEMBERS*, **every rep reads `calendar OK`**. Also note the required `formFields` and any `legalConsentOptions` ids. |
| **4. Availability** | Start times appear, decoded into readable times, and they match what the public page shows |

Then write one real test booking. Take a start time from section 4 and use an
email address you control:

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call -Book -StartMs 1788890400000 -Email you@yourdomain.com
```

The probe sends both payload shapes that HubSpot's documentation describes.
**Expect the millisecond shape to succeed and the ISO shape to fail with
400.** That's normal, and the code uses the millisecond shape.

✅ **Check:** one response carries a non-empty `calendarEventId`. In HubSpot, open
the test contact's meeting and confirm the following:
- **Call and meeting type** is `AI Booked Call`. This proves the link stamps API
  bookings.
- `hs_meeting_source` is `INTEGRATION`.
- A rep was assigned, and the event is on their calendar.

Then **delete the test meeting and the test contact.**

> If the response shows `"isOffline": true` and an empty `calendarEventId`,
> nothing was booked. Section 3 of the probe will name the rep whose calendar is
> offline. Reconnect it, or remove that rep from the pool.

### Step 6: Configure the code for your link

*About 5 minutes.*

Open `src/booking-action.js` and change the settings near the top:

```js
// Everything after meetings.hubspot.com/
const MEETING_SLUG = 'your-team/ai-booked-call';

// Used only when neither the contact nor the agent supplies a valid timezone
const DEFAULT_TZ = 'America/New_York';

// Mirror your link's form (Step 3e / probe section 3).
// Name and email are always sent. List only EXTRA fields here.
const FORM_FIELDS = [
  // { name: 'phone', required: true },   // uncomment if your form requires phone
];
```

Also check the time-of-day windows. They're local hours, and the end hour is
excluded:

```js
const PERIODS = {
  morning:   [0, 12],
  afternoon: [12, 17],
  evening:   [17, 24],
  any:       [0, 24],
};
```

> ⚠️ **Match `FORM_FIELDS` to the form exactly.** A required field you don't send
> is rejected, and a field the form doesn't have can also be rejected. If
> `FORM_FIELDS` requires phone and no number is available, the action doesn't
> fail. It returns `needs_phone` and asks the contact for one.

If probe section 1 showed only `/v3/` answering, also change `SCHEDULER` to
`'/scheduler/v3/meetings/meeting-links'`.

✅ **Check:** if you have Node 20, run `npm test`. It should print
`all checks passed` twice.

### Step 7: Build the HubSpot workflow and webhook trigger

*About 20 minutes.*

**7a. Create the workflow.**
1. Go to **Automation → Workflows → Create workflow → From scratch**.
2. Choose **Contact-based**, and name it `AI Booking — Book Meeting`.

**7b. Set the trigger.**
1. Click **Set up triggers**.
2. Choose **When a webhook is received**.
3. HubSpot shows a **webhook URL** and waits for a sample event.

**7c. Send one sample event** so HubSpot learns the payload shape. Send the
**full** field set now, because fields missing from the sample can't be mapped
later.

PowerShell:

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call -WebhookUrl "<the webhook URL HubSpot shows>" -Email you@yourdomain.com
```

Or any HTTP client, as `POST` with `Content-Type: application/json`:

```json
{
  "email":            "you@yourdomain.com",
  "first_name":       "Alex",
  "last_name":        "Morgan",
  "phone":            "+15550100123",
  "preferred_date":   "2026-09-08",
  "preferred_period": "afternoon",
  "timezone":         "America/New_York"
}
```

**7d. Map the fields.** Once HubSpot shows the sample, declare each field.

> ⚠️ **Type every field as String, especially `preferred_date`.** If HubSpot
> types it as a Date, it reformats the value. The code compares it as the literal
> text `2026-09-08`, so a reformatted date silently fails to match, and the
> contact is booked on the next open day instead of the day they chose.

**7e. Match step.** Match the event to a contact on **Email**.

> ⚠️ **Unknown emails fail silently.** The trigger enrolls only an *existing*
> contact. If no contact has that email, HubSpot still returns the same
> `202 Accepted`, and nothing appears in the workflow history. The Aloware ↔
> HubSpot contact sync is what makes this rare.

**7f. Save the trigger and copy the webhook URL.** Aloware will call it in
Step 10.

✅ **Check:** the trigger shows your seven fields, and each is typed as String.

### Step 8: Add the custom code action

*About 20 minutes.*

1. Under the trigger, click **+ → Data ops → Custom code**.
2. **Language:** Node.js 20.x.
3. **Secrets:** click **Add secret**, name it **`HUBSPOT_BOOKING_TOKEN`**, and
   paste the Step 4 key as its value. Then select it for this action.
4. **Properties to include in code:** add each of the following. The name on the
   left must match exactly.

   | Input name | Value |
   |---|---|
   | `first_name` | Webhook field `first_name` |
   | `last_name` | Webhook field `last_name` |
   | `email` | Webhook field `email` |
   | `phone` | **Contact property** *Phone number*. The record is the primary source. |
   | `phone_agent` | Webhook field `phone`. Used only if the contact has no number. |
   | `preferred_date` | Webhook field `preferred_date` |
   | `preferred_period` | Webhook field `preferred_period` |
   | `timezone` | **Contact property** *IP Timezone* |
   | `timezone_agent` | Webhook field `timezone` |

   *Optional:* `consent_type_id` and `consented`. Map these only if your form
   *requires* consent and the agent actually asks for it. The code never
   invents consent.

5. **Code:** delete the sample code and paste in **all** of
   `src/booking-action.js`.
6. **Data outputs:** click **Add output** for each row below. Anything you don't
   declare is invisible to later steps.

   | Output | Type |
   |---|---|
   | `booking_status` | String |
   | `confirmation_text` | String |
   | `booking_label` | String |
   | `booked_start_ms` | Number |
   | `booked_duration_ms` | Number |
   | `alternatives_text` | String |
   | `calendar_event_id` | String |
   | `booked_contact_id` | String |
   | `payload_shape` | String |
   | `error_detail` | String |

7. **Test it.** Click **Test action**, choose a real contact that has an email,
   and fill the test inputs with a day that has openings.

✅ **Check:** the test returns `booking_status: booked`, a real
`calendar_event_id`, and a sensible `booking_label` such as
`Tuesday, September 8 at 2:00 PM EDT`. Expect a runtime of roughly 0.7 s and
roughly 100 MB of memory, well within HubSpot's 20 s and 128 MB limit. **Delete
the test meeting.**

### Step 9: Branch the workflow on the result

*About 20 minutes.*

1. Under the custom code action, click **+ → Branch**.
2. Choose **Based on one property or action output** (the wording varies), and
   select the custom code output **`booking_status`**.
3. Add one branch per value:

| `booking_status` | What happened | Actions to add |
|---|---|---|
| `booked` | A real meeting exists, with a calendar event | **Aloware → Disenroll from all sequences**, so a booked lead stops getting chased. Optionally, **Set property** for reporting. |
| `slot_taken` | Nothing matched the request, or the slot went mid-booking | **Aloware → Send SMS/MMS** with the body set to the output **`confirmation_text`**. It already offers three real times. |
| `needs_email` | No email address on file | **Aloware → Send SMS/MMS** with `confirmation_text`. It asks for the email. |
| `needs_phone` | Only happens if your form requires phone and none was found | **Aloware → Send SMS/MMS** with `confirmation_text` |
| `not_scheduled` | **HubSpot returned 200 but booked nothing.** The rep's calendar is offline. | **Create task**, due today and assigned to a manager: "Bot booking failed; call the contact and fix the calendar." **Don't** disenroll them. |
| `no_availability` | The link has no openings at all | **Create task** for the sales team |
| `error` | Token, scope, network or configuration problem | **Create task** with `error_detail` in the body |
| *(none of the above)* | Shouldn't happen | **Create task**, same as `error` |

The Aloware actions (**Send SMS/MMS**, **Enroll to sequence**, **Disenroll from
all sequences**, **Add to power dialer**) appear in the HubSpot workflow action
list once the Aloware integration is installed. You don't need any code to call
Aloware.

4. **Review and turn on** the workflow. Choose *don't* enroll existing contacts,
   because webhook workflows only enroll when an event arrives.

✅ **Check:** the workflow is **On**, and the branch shows all seven values.

### Step 10: Create the Aloware Custom Function

*About 15 minutes.*

1. In Aloware, open the AloAI agent and go to **Custom Functions → + Add Function**.
2. Fill in:

   | Field | Value |
   |---|---|
   | **Function Name** | `request_booking` |
   | **Description** *(255-char limit)* | `Use when the contact has agreed to a call and given a day and rough time. Submits the booking request. Do not use before they have chosen a day.` |
   | **Method** | `POST` |
   | **Endpoint URL** | The HubSpot webhook URL from Step 7f |
   | **Headers** | `Content-Type` → `application/json` |
   | **Respond during execution** | **On.** On voice this is essential, or the caller sits in silence. |
   | **Respond after execution** | **On** |

3. **Variables:** add each one.

   | Variable | Type | Required | Notes |
   |---|---|---|---|
   | `first_name` | string | Yes | |
   | `last_name` | string | No | The code splits a full name if this is empty |
   | `email` | string | Yes | HubSpot Meetings can't book without an email |
   | `phone` | string | No | The contact record's number is used first |
   | `preferred_date` | string | Yes | Exactly `YYYY-MM-DD` |
   | `preferred_period` | string | No | `morning`, `afternoon` or `evening` |
   | `timezone` | string | No | IANA name, e.g. `America/Chicago`. Used only if HubSpot has none. |

4. Save, then attach it in the agent's instructions with **Add action → Custom
   function → `request_booking`**, set to trigger once the contact has agreed to
   a day.

✅ **Check:** fire the function from Aloware's test console with a real contact's
email. Within a few seconds, the HubSpot workflow's **History** tab shows a new
enrollment, and the action output is `booked`.

### Step 11: Add the booking instructions to the agent

*About 15 minutes.*

Paste one of these into the part of the agent's prompt that handles booking.
**The "Never state a specific appointment time" paragraph is the most important
one.** The agent can't know which slot was booked until HubSpot answers, and
without that rule it will make a time up.

**SMS (text) agent:**

```text
When the contact wants to book a call:

1. Make sure you have their first name and email address. Ask for
   whichever is missing -- over text people type an email accurately,
   so there is no reason to skip it.
2. Ask which day works and roughly what time of day.
3. Convert their answer to a calendar date in YYYY-MM-DD format,
   using today's date to resolve "tomorrow", "next Tuesday" and the
   like. Map their answer to morning or afternoon.
4. Call request_booking with those values.
5. Tell them you are locking it in and the confirmation will arrive
   by text and email shortly.

Never state a specific appointment time as confirmed. You do not
know which slot was taken until the confirmation goes out. If they
press for the exact time, say the confirmation will state it.

Only offer times of day your calendar actually runs. If the team
works 9 to 5, never offer evening -- it can never be booked.

If they ask what times are available, say you do not have the
calendar in front of you, and that if they give you a day and rough
time you will book the closest opening and send the confirmation.
They can reschedule from that email if it does not suit.
```

**Inbound voice agent:**

```text
When the caller wants to book a call:

1. Ask which day works best, and whether morning or afternoon suits
   them better.
2. Convert their answer to a calendar date in YYYY-MM-DD format,
   using today's date to resolve "tomorrow", "next Tuesday" and the
   like. Map their time of day to morning, afternoon or evening.
3. Call request_booking with those values and their first name.
4. Tell them you are locking it in and the calendar invite will
   arrive by email shortly.

Never state a specific appointment time as confirmed. You do not
know which slot was taken until the invite goes out. If they press
for the exact time, say the invite will confirm it.

Do not try to collect an email address by voice. If you do not have
one already, say a team member will confirm the details shortly and
end the call politely.
```

On voice, the email comes from the HubSpot contact record, which is why the
voice prompt never asks for one. Spelling an email address aloud is where voice
agents reliably fail.

> **Testing on voice first?** If text agents aren't enabled yet, build a **blank**
> inbound voice agent (not a *Booking* template, since those come pre-wired to
> Cal.com and Calendly) and point it at a test line. The same Custom Function
> carries over to the text agent unchanged later.

✅ **Check:** in Aloware's test console, ask to book. The agent should ask for a
day, call `request_booking`, and say it's *locking it in*, **without** naming a
time.

### Step 12: Test end to end

*About 30 minutes.* Use a real phone and a real HubSpot contact whose number and
email you control.

**12a. The happy path.** Text the agent and ask for a call on a day you know is
open.

✅ **Check all of these:**
- [ ] The HubSpot workflow **History** shows the enrollment.
- [ ] The action output is `booked`.
- [ ] The Meeting is on the contact, with **Call and meeting type = AI Booked
      Call**.
- [ ] The invite is on the assigned rep's calendar.
- [ ] The contact received the confirmation text and HubSpot's email.
- [ ] The contact was **disenrolled** from Aloware sequences.

**12b. The failure paths.**

| Try | Expect |
|---|---|
| Ask for a day and time that are fully booked | `slot_taken`, and a text offering three real times |
| Book from a contact with no email (SMS) | `needs_email`, and the agent asks for one |
| Ask for a date months ahead | `slot_taken` with alternatives, not silence |
| Book from a phone number that isn't in HubSpot | Find out now: the workflow probably doesn't enroll at all (Step 7e) |
| Temporarily disconnect one pool rep's calendar | `not_scheduled` and an urgent task, **never** "you're all set" |
| Remove the secret from the action | `error`, and `error_detail` names `HUBSPOT_BOOKING_TOKEN` |

**12c. Clean up.** Delete the test meetings and test contacts, and remove any test
agent.

### Step 13: Go live and watch the first day

1. Attach the agent to its production number or campaign in Aloware.
2. During the first day, check:
   - the HubSpot workflow **History**, filtered to errors
   - the task queue fed by the `not_scheduled`, `no_availability` and `error`
     branches
   - a sample of `AI Booked Call` meetings, compared against what each contact
     actually asked for.
3. Build a report: **Meetings** where *Call and meeting type* is `AI Booked Call`,
   grouped by week and by owner.

**To roll back,** turn the workflow **Off**. Aloware's call is still accepted,
nothing is booked, and there's no half-finished state to clean up.

---

## 6. Optional: let the agent offer real times

Without this upgrade, the agent can only ask *"which day suits you?"* When someone
reasonably asks *"well, what's available?"*, it has nothing to say.

**Why a cache:** the webhook trigger returns `202` with no data, so the agent
can't get an answer back from the workflow. Instead, a second action pre-computes
the next three openings onto **one HubSpot record**. A second Custom Function
reads that record straight from the HubSpot CRM API, which *is* synchronous. The
agent reads the sentence aloud and copies the chosen slot's date and period into
`request_booking`, so it never does any time math.

**6a. Create the cache record in HubSpot.**
1. Go to **Settings → Objects → Custom Objects** and create an object, for
   example `AI Booking Cache`.
2. Add these properties, **all Single-line text**, including the dates:

   | Property | Example value |
   |---|---|
   | `slot_offer_text` | `I have Tue Sep 8 at 9:00 AM EDT, Wed Sep 9 at 10:00 AM EDT, or Thu Sep 10 at 3:00 PM EDT. Which works best?` |
   | `slot_1_label`, `slot_2_label`, `slot_3_label` | `Tue Sep 8 at 9:00 AM EDT` |
   | `slot_1_date`, `slot_2_date`, `slot_3_date` | `2026-09-08` (**text, not Date**, same reason as Step 7d) |
   | `slot_1_period`, `slot_2_period`, `slot_3_period` | `morning` |
   | `slot_count` | `3` |
   | `slot_refreshed_at` | `2026-09-01T12:00:00.000Z` |

3. Create **one** record. Note the object's **type id** (like `p12345678_ai_booking_cache`)
   and the record's **id**.

**6b. Give the booking key access.** Edit the Step 4 service key and add read
and write scopes for the custom object.

**6c. Build the refresh workflow.**
1. Create a workflow with a custom code action (Node.js 20.x), and paste in
   `src/refresh-slots-action.js`. Set `MEETING_SLUG` to the same slug as
   Step 6.
2. Add secrets **`HUBSPOT_BOOKING_TOKEN`**, **`SLOT_CACHE_TYPE`** (the type id)
   and **`SLOT_CACHE_ID`** (the record id).
3. Outputs: `refresh_status` (String), `slot_count` (Number), `slot_offer_text`
   (String), `error_detail` (String).
4. Trigger it all three ways, because each covers a different gap:
   - **On a schedule**, at least daily
   - **After every booking**: add the same action to the `booked` branch from
     Step 9
   - **When a conversation opens**: give it a webhook trigger, and have the agent
     call it before it asks any questions.

✅ **Check:** `refresh_status: ok`, and the cache record holds a sentence you'd be
happy to hear read aloud.

**6d. Create a separate read-only key** scoped to *read* on the cache object
only. It will sit in an Aloware header outside HubSpot, so if it leaks the worst
case is someone learning when your team is free.

**6e. Add the second Aloware Custom Function.**

| Field | Value |
|---|---|
| Name | `get_available_times` |
| Description | `Use when the caller asks what times are available, or before offering times. Returns the current openings.` |
| Method | `GET` |
| URL | `https://api.hubapi.com/crm/v3/objects/{type id}/{record id}` |
| Query parameter | `properties` → `slot_offer_text,slot_1_label,slot_1_date,slot_1_period,slot_2_label,slot_2_date,slot_2_period,slot_3_label,slot_3_date,slot_3_period` |
| Header | `Authorization` → `Bearer <read-only key from 6d>` |
| Parameters | None |
| Speak after execution | On |

**Response variables (JSONPath):**

```text
offer_text     $.properties.slot_offer_text
slot_1_label   $.properties.slot_1_label
slot_1_date    $.properties.slot_1_date
slot_1_period  $.properties.slot_1_period
slot_2_label   $.properties.slot_2_label
slot_2_date    $.properties.slot_2_date
slot_2_period  $.properties.slot_2_period
slot_3_label   $.properties.slot_3_label
slot_3_date    $.properties.slot_3_date
slot_3_period  $.properties.slot_3_period
```

**6f. Prompt addition:**

```text
When the contact wants to book, or asks what times are available:

1. Call get_available_times.
2. Read offer_text back to them exactly as written. Do not
   rephrase the times, convert them, or add any of your own.
3. When they pick one, call request_booking using the date and
   period belonging to the slot they chose -- slot_1_date and
   slot_1_period for the first, and so on.
4. If none of the three suit them, ask which day would, and call
   request_booking with that day instead.

Only ever offer the times get_available_times returned. If it
returns nothing, say you don't have the calendar in front of you
and ask which day suits them.
```

**Stale offers are safe.** `request_booking` always re-reads live availability
before it books, so a slot that was taken in the meantime comes back as
`slot_taken` with three fresh alternatives, never a double booking.

---

## 7. Reference: inputs, outputs and settings

### Inputs to `booking-action.js`

| Input | Required | Source | Notes |
|---|---|---|---|
| `email` | Yes | Webhook | Lowercased and trimmed. Missing → `needs_email`. |
| `first_name` | Yes | Webhook | If it holds a full name and `last_name` is empty, the name is split |
| `last_name` | No | Webhook | Sent as `-` if empty, because HubSpot rejects blank last names |
| `preferred_date` | No | Webhook | `YYYY-MM-DD`. If missing, the first opening in the preferred period is used. |
| `preferred_period` | No | Webhook | `morning`, `afternoon`, `evening` or `any` (default `any`) |
| `timezone` | No | Contact **IP Timezone** | HubSpot's slug form, like `america_slash_chicago`, is converted automatically |
| `timezone_agent` | No | Webhook | An IANA fallback |
| `phone` | If the form needs it | Contact **Phone number** | US numbers are normalized to E.164 |
| `phone_agent` | No | Webhook | Fallback only |
| `duration_ms` | No | — | Only if the link offers several lengths |
| `consent_type_id`, `consented` | Only if consent is required | — | Consent is recorded only if `consented` is literally true |
| `extra_form_fields` | No | — | `{ "fieldName": "value" }` for other required form fields |

### Outputs

| Output | When present | Example |
|---|---|---|
| `booking_status` | Always | `booked` |
| `confirmation_text` | Always | `You're all set for Tue Sep 8 at 2:00 PM EDT. Invite headed to alex@example.com.` |
| `booking_label` | `booked`, `not_scheduled` | `Tuesday, September 8 at 2:00 PM EDT` |
| `booked_start_ms` | `booked`, `not_scheduled` | `1788890400000` |
| `booked_duration_ms` | `booked` | `1800000` |
| `alternatives_text` | `slot_taken` | `Tue Sep 8 at 9:00 AM, Wed Sep 9 at 10:00 AM, or Thu Sep 10 at 3:00 PM EDT` |
| `calendar_event_id` | `booked` only | Proof a real event exists |
| `booked_contact_id` | `booked`, `not_scheduled` | The contact HubSpot booked |
| `payload_shape` | `booked`, `not_scheduled` | `legacy-millis` |
| `error_detail` | Failure branches | The raw HubSpot error, truncated to 500 characters |

### Code settings

| Setting | File | Default | Change it when |
|---|---|---|---|
| `MEETING_SLUG` | both `src` files | `your-team/ai-booked-call` | Always. It's your link. |
| `DEFAULT_TZ` | both | `America/New_York` | Your office isn't in US Eastern |
| `FORM_FIELDS` | `booking-action.js` | empty | Your form requires more than name and email |
| `PERIODS` | both | 0–12 / 12–17 / 17–24 | Your idea of "afternoon" differs. Keep both files the same. |
| `MAX_ALTS` / `SLOTS` | `booking-action.js` / `refresh-slots-action.js` | 3 | You want more or fewer alternatives |
| `SCHEDULER` | both | `/scheduler/2026-03/...` | The probe shows only `/v3/` answering |

A `MEETING_SLUG` secret on the action overrides the constant, if you'd rather not
edit code.

---

## 8. HubSpot behavior the docs won't tell you

All of these were verified against a live portal. There's more detail in
[docs/API-NOTES.md](docs/API-NOTES.md).

1. **Booking needs a write scope.** With only
   `scheduler.meetings.meeting-link.read`, the book endpoint returns **403**.
2. **`startTime` and `duration` are both epoch milliseconds.** The documented
   2026-03 shape (ISO 8601 plus minutes) returns
   `400 MEETING_DURATION_NOT_VALID`.
3. **Send one payload shape only.** A fallback retry overwrites the real error
   with a fake duration complaint.
4. **The slug must be URL-encoded in paths**, because round-robin slugs contain a
   `/`.
5. **An "offline booking" is HTTP 200 and books nothing.** If the chosen rep's
   calendar is disconnected, the response has `isOffline: true` and an empty
   `calendarEventId`. No meeting and no calendar event are created. The code
   reports it as `not_scheduled`.
6. **The webhook trigger ignores unknown contacts silently.** It returns the same
   `202`, and nothing appears in the history.
7. **The webhook trigger can't return data** to the caller. That's why the
   confirmation is a follow-up message, and why section 6 exists.
8. **IP Timezone is a slug, not an IANA name.** `america_slash_new_york` throws in
   JavaScript's `Intl` until it's converted.
9. **Date-typed webhook fields get reformatted.** Map everything as String.
10. **Empty last names are rejected.**
11. **Form fields must match the form exactly**, in both directions.
12. **Busy blocks carry start times too.** Code that grabs every `start` from the
    availability response will offer a rep's existing meeting as free.
13. **The link's Meeting type reaches API bookings**, so no code has to stamp
    `hs_activity_type`.
14. **API bookings get a video link** if one is attached to the page, even when
    the location is Phone Call.

---

## 9. Known limitations

- **First-time callers can't book on voice.** By default Aloware doesn't create
  HubSpot contacts for unknown inbound numbers, so there's nothing for the
  webhook to match. HubSpot Meetings also needs an email. SMS solves both
  problems, because the agent can collect the email.
- **The first reply never names a time.** The confirmation with the real time
  arrives a few seconds later.
- **The round robin is whatever the link does.** There's no weighting beyond what
  HubSpot offers.
- **One meeting link per workflow.** For several teams, duplicate the workflow
  and point each copy at its own slug.
- **HubSpot's limits:** custom code gets 20 seconds and 128 MB per run. A booking
  uses about 0.7 s.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent calls the function, nothing in the workflow history | No HubSpot contact has that email | Confirm the contact exists and the email is in the payload (Step 7e) |
| `error`, and `error_detail` names `HUBSPOT_BOOKING_TOKEN` | The secret isn't selected on the action | Step 8.3 |
| `error` with **401** | Key wrong or truncated | Re-copy the full key from **Show → Copy** |
| `error` with **403** | Missing write scope | Add `crm.objects.contacts.write` (Step 4) |
| `error` with `MEETING_DURATION_NOT_VALID` | Payload shape changed | Re-run the probe's booking test, then check `book()` in the code |
| `error` mentioning a *required form field* | `FORM_FIELDS` doesn't match the form | Step 6 |
| `not_scheduled` | A pool rep's calendar is disconnected | Run the probe. Reconnect the calendar or remove the rep. |
| Meeting has no Call and meeting type | The link's **Meeting type** isn't set | Step 3b |
| Booked on the wrong day | `preferred_date` mapped as Date | Re-map as String (Step 7d) |
| Times stated in the wrong timezone | IP Timezone not mapped to `timezone` | Step 8.4 |
| Always the same rep | **Prioritize contact owner** is on | Turn it off, or accept it |
| Invite has a Google Meet link on a phone call | A video link is attached to the page | Remove it (Step 3b) |
| Agent tells the contact a time that doesn't match the invite | The prompt's "never state a time" rule is missing | Step 11 |
| Booked leads still get chased | The `booked` branch is missing the Aloware disenroll | Step 9 |

---

## 11. Testing locally

No install is needed, just Node 20.

```bash
npm test
```

```bash
npm run demo
```

The tests stub HubSpot and **freeze the clock**, so they never go stale as their
sample dates pass. They cover busy-block exclusion, the link's own duration,
timezone slugs, the offline-booking failure, conflicts vs. configuration errors,
consent, phone normalization, and the 160-character SMS ceiling on every reply.
The demo prints what the agent sends, which HubSpot calls are made, and what the
contact would receive, for ten scenarios.

---

## 12. Security

- The booking key lives **only** in HubSpot workflow **Secrets**. It never goes in
  Aloware, in code or in chat.
- The optional `get_available_times` key sits in an Aloware header, so make it a
  **separate read-only key** limited to the cache object.
- **Consent is never assumed.** The code only sends a consent response when the
  workflow passes a consent type **and** an opt-in the contact actually gave.
- The meeting link slug isn't secret, because it's already in the public booking
  URL.
- To shut everything off at once, turn off the HubSpot workflow.

---

Built by [Jibril Sulaiman](https://github.com/jbrillionaire).
