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
   - [Step 10: Create the Aloware agent and Custom Function](#step-10-create-the-aloware-agent-and-custom-function)
   - [Step 11: Add the booking instructions to the agent](#step-11-add-the-booking-instructions-to-the-agent)
   - [Step 12: Test end to end](#step-12-test-end-to-end)
   - [Step 13: Go live and watch the first day](#step-13-go-live-and-watch-the-first-day)
   - [Step 14: Change the meeting link later](#step-14-change-the-meeting-link-later)
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
| **Aloware** with **AloAi Agents** (a *Pro* feature in Aloware's menu) | The agent reaches HubSpot through a Custom Function |
| **An approved 10DLC campaign** on the Aloware line (for SMS) | Until it's approved, Aloware blocks outbound SMS. The text agent's replies fail with *"Messaging is disabled for this line"*, and a yellow banner shows at the top of Aloware. Voice agents don't need it. |
| **HubSpot Sales Hub** seat tier that allows another scheduling page | A free tier gets one booking page. A second one shows *"You've used your 1 free booking page"* and an upgrade prompt. |
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

**You paste [`src/booking-action.js`](src/booking-action.js) into HubSpot.** Everything else is for
checking, testing or reference.

---

## 5. Setup, step by step

Do the steps in order. Each one ends with a ✅ **check**, and you shouldn't move
on until it passes. Most failures in this build are silent (HTTP 200 or 202 with
nothing booked), so the checks are the only way you'll see them.

You'll switch between three windows the whole way through: **HubSpot**,
**Aloware**, and a **PowerShell** (or bash) terminal open in this repo's folder.

> **About the labels:** text in **bold** or *"quotes"* is copied from screenshots
> of the live HubSpot and Aloware apps taken in August and September 2026. Where a
> screen wasn't captured, the step says *(wording may differ)*. Both vendors move
> menus occasionally. If a path doesn't match, search for the setting by name.

> **Keep a scratch note open.** You'll collect five values along the way and paste
> each one later: the meeting link **slug** (Step 3), the **service key** (Step 4),
> the **webhook URL** (Step 7), and, for the optional section 6, the cache object's
> **type id** and **record id**. The service key goes only into HubSpot Secrets,
> never into Aloware, chat or email.

### Step 1: Check your HubSpot and Aloware plans

*About 15 minutes. Stop here if 1a or 1b fails.*

**1a. HubSpot has custom code actions.**
1. In HubSpot, go to **Automation → Workflows** and open any workflow, or create
   a blank one. You can delete it afterwards.
2. Click the **+** under the trigger card to add an action.
3. In the action panel, open **Data ops**, or search for `code`.

✅ **Check:** **Custom code** is listed. If it isn't, your portal doesn't have
Data Hub Professional (formerly Operations Hub), and nothing in this guide will
work. Sales Hub or Service Hub Enterprise seats don't prove you have it.

**1b. Aloware can create the agent type you need.**
1. In Aloware's left menu, click **AloAi Agents** (it has a *Pro* badge), then
   **+ New Agent** (top right).
2. The modal **"Choose your AloAi Agent type:"** shows two cards:
   - **Text:** *"This agent can be used to handle marketing campaigns, sales &
     support over text."*
   - **Voice:** *"This agent can be used to handle inbound and missed calls for
     different use cases."*
3. Look at the **Text** card. If it's greyed out and won't click, text agents
   aren't enabled on your account yet. That's a question for your Aloware account
   manager, not a build problem.
4. Click **Voice**. The **Create agent** modal asks for a direction. If the
   **Outbound** card reads *"Outbound voice agents are disabled for this company.
   Please contact Aloware support."*, only inbound voice is available.
5. Close the modal without creating anything.

✅ **Check:** you know which agent types you can build today. Custom functions
live in a different place on each type:
- **Text agents** have a **Custom Functions** item in the agent's left menu
  (Configure, Instructions, Context, Schedule, Actions, **Custom Functions**).
- **Voice agents** have no such menu item. Functions live in the right-hand
  **Functions** panel, under **+ Add**.

> **Only inbound voice available?** You can still prove the whole chain on an
> inbound voice agent (Step 10B) and move to SMS later. Nothing on the HubSpot
> side changes. The workflow doesn't know which agent called it.
>
> **No custom functions at all?** You can still do this more slowly: have the
> agent use *Update Contact Field* to write a property that syncs to HubSpot, and
> trigger the workflow on that property changing instead of on a webhook.

**1c. The Aloware ↔ HubSpot integration is connected.**
1. In Aloware, click **Integrations** in the left menu, then the **HubSpot** card.
2. On the **Connection** tab, check that **Integration Status** is switched on and
   reads **Connected**. Click **Test Connection** if you want to be sure.
3. Read the notice at the top of that tab: HubSpot's **Send a text (SMS/MMS)**
   workflow action counts as *automated and paid* usage in Aloware. Step 9 uses
   that action, so make sure whoever owns the Aloware bill knows.

✅ **Check:** the integration reads **Connected**.

**1d. SMS only: the line is on an approved 10DLC campaign.**
1. If Aloware shows a yellow banner reading *"IMPORTANT - Some of your Outbound
   SMS/MMS Messages are being blocked by the major carriers!..."*, outbound texts
   from some lines are blocked, including your agent's replies.
2. Go to **Account** (left menu) and open the **Compliance** tab.
3. Under **A2P Campaigns**, confirm you have at least one campaign with status
   **Approved**.
4. Under **Unregistered Lines [Needs Attention]**, tick the line your agent will
   use, then click **Add to existing campaign**.

✅ **Check:** your agent's line no longer appears under **Unregistered Lines**.
Until it's registered, every agent reply fails with *"Messaging is disabled for
this line"* (you'll see it in Step 12). Voice agents don't need this.

### Step 2: Add a HubSpot meeting type for AI bookings

*About 5 minutes.*

This is the label every bot booking will carry. It's what your reports and deal
automation will key on.

1. Click the **Settings** gear (top right).
2. In the left menu, under **Data Management**, go to **Objects → Activities**
   and open the call and meeting types settings. *If you can't find it, type
   "call and meeting types" in the settings search box* (wording may differ). An
   older path is **Settings → Properties →** *Call and meeting type*.
3. The side panel **"Edit call and meeting types"** opens: a list of types with a
   drag handle and a trash icon on each, and **Sort: Custom** at the top.
4. Click **+Add type** and name it, for example, **`AI Booked Call`**.
5. Save the panel.

✅ **Check:** the new type appears in the list, spelled exactly as you want it in
reports. Watch for a stray double space or a different dash, because Step 3 picks
it from a dropdown and every report filters on that exact string. The internal
property behind it is `hs_activity_type`, labelled *Call and meeting type* on
meeting records.

> Don't reuse a call-direction property (inbound or outbound) for this. A booked
> meeting isn't a call in either direction. And don't write the type from code:
> the meeting link stamps it for you (Step 3b).

### Step 3: Build the HubSpot round-robin meeting link

*About 30 minutes.*

**3a. Create the scheduling page.**
1. Go to **Sales → Meetings**. *In newer navigation this is* **Library →
   Meetings**.
2. Create a new scheduling page and choose **Round robin**. The wizard header
   reads **"Create round robin"**, *Step 1 of 4*, with four steps: **Overview →
   Team members → Scheduling → Automation**.

> ⚠️ **Free-tier limit.** If the top of the Overview step reads *"You've used your
> 1 free booking page. Unlock more booking pages with Enterprise Customer
> Platform."* with an **Upgrade** button, you can't save a second page on your
> current seat. Upgrade, or repurpose an existing page, before you go further.

**3b. Overview.** The fields appear in this order:

| Field | Set it to | Why |
|---|---|---|
| **Internal name** \* | e.g. `AI Booked Call` | Only for you. It doesn't affect attribution. |
| **Marketing campaigns** | Optional. Pick the campaign these calls belong to. | Gives you booking attribution against the campaign for free |
| **Organizer** | The owner of the page | |
| **Event title** | e.g. `Discovery Call`. Use **Personalize** for tokens. | This is what shows on calendars |
| **Location** | `Phone Call`, or whatever your reps actually use | It's stamped on `hs_meeting_location`. If any report keys off it, use the same wording on every link. |
| **Add videoconference link** | **Click Remove** unless you want video | Otherwise API bookings get a Google Meet or Zoom URL even for a phone call |
| **Cancel and reschedule** | Leave **on**: *"Include cancel and reschedule links in the event description"* | Contacts can move the booking themselves. The agent's prompt relies on this. |
| **Description** | Keep the **Reschedule Link** and **Cancel Link** tokens HubSpot pre-fills | Those tokens are the links in the invite |
| **Meeting type** (the dropdown at the bottom) | `AI Booked Call` (from Step 2) | **This is all the attribution there is.** Every booking through this link, including API bookings, gets this type. |

Click **Next**.

**3c. Team members.**
1. Click to edit the members. The side panel **"Edit round robin members"** opens.
2. Under **Round robin member setup**, choose **Select users** (or **Use a
   rotation**).
3. In **Users**, add the reps who should take these calls, one by one. Pick them
   deliberately rather than adding everyone. To remove someone, click the **×**
   on their chip.
4. Click **Confirm**.
5. Back on the **Team members** tab, read the **NAME** list.

✅ **Check:** every member reads **"Calendar connected"**.

> ⚠️ **Every rep in the pool needs a connected calendar.** If a rep's calendar is
> disconnected, HubSpot treats them as free at every hour of every day. Any
> booking the round robin gives them returns **HTTP 200 and creates nothing**: no
> meeting and no calendar event. Only a contact is left behind. Step 5 checks
> every rep again from the API side.

> ⚠️ **Member changes can fail to save.** In the original build, a rep was removed
> in this panel but the API still listed them afterwards, and the page's
> last-updated time hadn't moved. Finish the whole wizard and save the page after
> any member change, then re-run the probe (Step 5) to confirm the pool really
> changed.

**3d. Scheduling.** HubSpot enforces all of these *before* the code ever sees a
slot, so set them properly here. There's nothing matching to configure in the
code.

| Setting | Recommendation |
|---|---|
| **Duration** | Pick **one** length. The code reads it from the link and books that length. |
| **Availability** | Your team's real working hours, in their timezone. The agent's prompt (Step 11) must only offer times of day inside these hours. |
| **Minimum notice time** | This decides how soon the bot can book. The code adds no lead time of its own. |
| **Buffer time** | Whatever gap you want between meetings |
| **Booking window** (how far ahead) | For example, 2 weeks. The bot can't book anything beyond it, and neither can your tests (see Step 8h). |
| **Start time increment** | For example, 15 or 30 minutes |
| **Prioritize contact owner** | **Decide this deliberately.** When it's on, a contact who already has an owner goes to that owner instead of the round robin. If your leads arrive already owned (for example, from a form sync), the round robin will barely rotate. |

(Labels in this table weren't captured on screen, so wording may differ.) Step 5
prints these same values back from the API, so you can confirm them there.

**3e. Form questions.** The booking form's questions are set with **Add contact
property** (a *"Select a contact property"* dropdown), next to a **Block free
email domains** toggle. Depending on your portal, this sits on the Scheduling or
Automation step (wording may differ). Note every **required** question. Each one
must be sent in the API request, or HubSpot rejects the booking.

- First name, last name and email are always sent. You don't need to do anything
  for those.
- If the form requires **Phone number**, you'll switch that on in Step 6.
- Leave **Block free email domains off.** Many leads text from Gmail or Yahoo
  addresses.
- Every other required question is something the bot has to collect. Add nothing
  it can't reliably get in a text conversation.

**3f. Data privacy.** If your portal adds a **Data privacy** consent checkbox to
the booking page, keep it **optional** unless you have a reason not to. If
consent is *required*, the bot must capture a real yes or no for each consent
type (see Step 8c). Step 5 shows whether consent is enforced.

**3g. Save and copy the slug.** Finish the last step and save the page. Copy its
URL. The **slug** is everything after `meetings.hubspot.com/`:

```
https://meetings.hubspot.com/your-team/ai-booked-call
                             └──────── slug ────────┘
```

Put the slug in your scratch note.

**3h. Book one by hand.**
1. Open the link in a private browser window. The public page has two steps,
   **CHOOSE TIME → YOUR INFO**, and shows *Meeting location*, *Meeting duration*
   and the timezone (e.g. *UTC -04:00 Eastern Time*).
2. Pick a time. The **Your information** step lists the required fields (like
   *First name \**, *Last name \**, *Your email address \**, *Phone number \**),
   then the **Data privacy** block and a **Confirm** button. Write down which
   fields have an asterisk. That's what Step 6 must match.
3. Fill it in as if you were a lead, using an email you control, and click
   **Confirm**.

✅ **Check:** the contact shows a Meeting on its timeline, with **Call and meeting
type = AI Booked Call**. The confirmation email arrives, and the invite lands on
the assigned rep's calendar. Note which rep got it.

**3i. Delete the test meeting.** You'll do this after every test in this guide:
1. Open the test contact's record in HubSpot.
2. On the activity timeline, hover the meeting and open the **⋯** menu, then click
   **Delete** (wording may differ). This removes the HubSpot meeting and cancels
   the calendar event.
3. If the contact is a throwaway, delete it too: **Actions** (top of the record) →
   **Delete**. Don't delete real contacts.

### Step 4: Create the HubSpot service key

*About 5 minutes.*

1. Go to **Settings**. In the left menu, under **Account Management**, expand
   **Integrations** and click **Service Keys**. *Older portals call these*
   **Private Apps**, and HubSpot's legacy-app screen now recommends service keys.
2. Create a new service key and name it `AI Booking Bridge`.
3. Add **both** of these scopes before saving:

   | Scope | Why |
   |---|---|
   | `scheduler.meetings.meeting-link.read` | Read the link, its form and its availability |
   | `crm.objects.contacts.write` | **Required to book.** Booking creates or updates the contact. |

4. Save. On the key's page (it has a **Back to all Service Keys** link at the top),
   find the **Service Key** box (*"Used to make API calls."*). The key shows
   masked, like `pat-na1-xxxx**-****-...`. Click **Show**, then **Copy**. The same
   page has **Rotate** (issue a new key), **View Logs**, **Edit** (change scopes
   later), a **Scopes** box, and **Delete this Service Key**.
5. Paste the full key into your scratch note.

> ⚠️ **Read-only is not enough.** With only the read scope, reading works and
> booking returns **403** on every payload shape. That looks like a broken API,
> but it's only a missing scope. It happened in the original build. If you already
> made a read-only key, click **Edit**, add `crm.objects.contacts.write`, and save.
> The key value doesn't change, so you don't need to re-copy it.

> ⚠️ **Copy the real key, not the masked one.** The masked text on the page (or a
> shortened `pat-na1-xxxx...` in a note) returns **401** on everything. The full
> key is roughly 45 characters: `pat-na1-` followed by a long id with no dots or
> asterisks.

✅ **Check:** the **Scopes** box on the key's page lists both scopes, and your
scratch note holds the full key.

### Step 5: Probe your portal before writing anything

*About 20 minutes.*

The probe asks your real portal the questions that decide whether this build will
work. Probe sections 1–4 only read. Section 5 writes a real booking, and only when
you pass `-Book`.

**5a. Open a terminal in this repo's folder.**
- **Windows:** open PowerShell and `cd` to the folder you cloned, e.g.
  `cd $HOME\Downloads\aloware-ai-hubspot-scheduling`. Use the PowerShell script:
  bash usually isn't on the Windows PATH even when Git Bash is installed.
- **macOS / Linux / Git Bash:** open a terminal in the same folder and use
  [`scripts/probe.sh`](scripts/probe.sh).

If PowerShell refuses to run the script, allow local scripts for this window only:
`Set-ExecutionPolicy -Scope Process Bypass`.

**5b. Run the read-only probe.** Replace the token and slug with yours.

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call
```

```bash
HUBSPOT_TOKEN=pat-na1-xxxx MEETING_SLUG=your-team/ai-booked-call bash scripts/probe.sh
```

Read the output section by section:

| Probe section | What you want to see | If you don't |
|---|---|---|
| **1. API version** | `/scheduler/2026-03/...` returns **HTTP 200** | **401** on both = wrong or truncated key (Step 4). **403** = scope missing. Only `/v3/` answers = change `SCHEDULER` in Step 6. |
| **2. Meeting links** | Your link appears, with `type: ROUND_ROBIN_CALENDAR` and the member ids you expect | Wrong members = Step 3c didn't save |
| **3. Form and pool** | Under *POOL MEMBERS*, **every rep reads `calendar OK`**. Note the required `formFields`, whether `legalConsentOptions` is enforced, `ownerPrioritized`, and the working hours, buffer, increment, booking window and duration. | A rep with `isOffline: true` has a disconnected calendar. Reconnect it or remove the rep, and re-run. |
| **4. Availability** | Start times appear, decoded into readable times, and they match what the public page shows | A time that the rep is actually busy for means an offline rep is making the pool look free |

**5c. Write one real test booking.**
1. From section 4, take a start time (the long number next to a readable time) for
   a slot the assigned rep is genuinely free for. Take it from the **availability**
   list, never from a busy block.
2. Run the write test with an email address you control:

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call -Book -StartMs 1788890400000 -Email you@yourdomain.com
```

3. The probe sends both payload shapes that HubSpot's documentation describes.
   **Expect the millisecond shape to succeed and the ISO shape to fail with 400.**
   That's normal, and the code uses the millisecond shape.

Read the response:

| You see | It means | Do this |
|---|---|---|
| A non-empty `calendarEventId` and `isOffline: false` | A real booking | Check it in HubSpot (below) |
| **403** on both shapes | The write scope is missing | Step 4 warning, then re-run |
| **400** on both shapes | The slot isn't bookable (busy, past, or outside the window) | Pick another start time from section 4 |
| `"isOffline": true` and an empty `calendarEventId` | **Nothing was booked.** Section 3 names the offline rep. | Reconnect or remove that rep, re-run 5b, then 5c on a real opening |

✅ **Check:** one response carries a non-empty `calendarEventId`. In HubSpot, open
the test contact's meeting and confirm:
- **Call and meeting type** is `AI Booked Call`. This proves the link stamps API
  bookings.
- `hs_meeting_source` is `INTEGRATION` (bookings made on the public page read
  `MEETINGS_PUBLIC`, so bot bookings are separable two ways).
- A rep was assigned, the event is on their calendar, and there's no Google Meet
  or Zoom link unless you wanted one.

**5d. Clean up.** Delete the test meeting and the test contact (Step 3i). Every
`-Book` run creates another probe contact, so delete as you go. After an offline
booking there's no meeting to delete, only the contact.

### Step 6: Configure the code for your link

*About 5 minutes.*

Open [`src/booking-action.js`](src/booking-action.js) in any text editor and change the settings near the
top:

```js
// Everything after meetings.hubspot.com/
const MEETING_SLUG = 'your-team/ai-booked-call';

// Used only when neither the contact nor the agent supplies a valid timezone
const DEFAULT_TZ = 'America/New_York';

// Mirror your link's form (Step 3h / probe section 3).
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

If probe section 1 showed only `/v3/` answering, also change `SCHEDULER` to
`'/scheduler/v3/meetings/meeting-links'`.

If you plan to build the optional section 6, make the same `MEETING_SLUG`,
`DEFAULT_TZ`, `PERIODS` and `SCHEDULER` changes in [`src/refresh-slots-action.js`](src/refresh-slots-action.js)
now, so the two files can't drift.

> ⚠️ **Match `FORM_FIELDS` to the form exactly, in both directions.** A required
> field you don't send is rejected with *"required form field phone does not have
> a corresponding value"*. A field the form doesn't have can also be rejected. If
> `FORM_FIELDS` requires phone and no number is available, the action doesn't fail
> the booking. It returns `needs_phone` and asks the contact for one. But if the
> form *doesn't* need phone and you leave it required here, **every** booking
> stops at `needs_phone`. That happened when the original build moved to a second
> link that only asked for name and email.

✅ **Check:** if you have Node 20, run `npm test`. It should print
`all checks passed` twice.

### Step 7: Build the HubSpot workflow and webhook trigger

*About 20 minutes.*

**7a. Create the workflow.**
1. Go to **Automation → Workflows → Create workflow → From scratch**.
2. Choose **Contact-based**.
3. Click the pencil next to the workflow title at the top and name it
   `AI Booking — Book Meeting`.

**7b. Start the webhook trigger.**
1. Click the trigger card, which reads **Trigger enrollment for contacts**.
2. Choose **When a webhook is received**, then create a new webhook event. A
   four-step wizard titled **"Create a webhook event"** opens: **Name → Connect →
   Map → Match**, with **Back**, **Cancel** and **Next** along the bottom.
3. **Name:** e.g. `AI Booking — Book Meeting` (the same as the workflow is
   easiest). This name becomes the group heading for the webhook's fields in the
   **All data tokens** panel in Step 8, so make it recognisable. Click **Next**.
4. **Connect:** the heading reads *"Send a test event to connect your webhook"*,
   with four numbered instructions (copy the URL, go to the third-party app's
   webhook settings, paste it, send a test event). Under **Webhook URL**, click
   **Copy**. The URL looks like this:
   ```
   https://api.hubapi.com/automation/v4/webhook-triggers/<portal id>/<webhook id>
   ```
   Paste it into your scratch note. Below it, HubSpot shows a spinner and
   *"Waiting for the test event"*. Leave this tab open.

**7c. Send one test event** so HubSpot learns the payload shape. Send the
**full** field set now, because fields missing from the test event can't be
mapped later. Use the email of a contact that **already exists** in HubSpot, so
the Match step can validate.

PowerShell, with your URL pasted in:

```powershell
Invoke-RestMethod -Method Post -Uri "<the webhook URL>" -ContentType "application/json" -Body '{"email":"you@yourdomain.com","first_name":"Alex","last_name":"Morgan","phone":"+15550100123","preferred_date":"2026-09-08","preferred_period":"afternoon","timezone":"America/New_York"}'
```

Or let the probe send it:

```powershell
.\scripts\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call -WebhookUrl "<the webhook URL>" -Email you@yourdomain.com
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

The webhook replies **`202 Accepted`** with a body like `{"id": "..."}` and
nothing else. That's the proof the trigger can't return data to the caller, which
is why the confirmation arrives as a separate text.

Back in HubSpot, **"Review your test event"** appears with each key and value
(*"Please review the test event and confirm it is how you want."*). Check that all
seven keys are there. If one is missing, fix the sender and click **Retry a new
test event**. Otherwise click **Next**.

**7d. Map.** The heading reads *"Map the data for your webhook's properties"*
(*Step 3 of 4*). Each field gets a card with **Third-party property label**,
**HubSpot property label** and **Data type**, plus a trash icon to remove it.

1. **HubSpot property label** auto-fills as `['email']`, `['phone']` and so on.
   Rename each one to something readable, because this label is what you'll see
   in the workflow editor. The code doesn't read these labels, so any wording
   works:

   | Third-party property label | HubSpot property label | Data type |
   |---|---|---|
   | `email` | Booking email | String |
   | `phone` | Booking phone | String |
   | `timezone` | Booking timezone | String |
   | `last_name` | Booking last name | String |
   | `first_name` | Booking first name | String |
   | `preferred_date` | Booking preferred date | String |
   | `preferred_period` | Booking preferred period | String |

2. **Data type** starts empty on every card. HubSpot won't let you continue until
   every card has one (*"There are errors or missing values in the properties
   below. Please fix them before continuing."*). Set all seven to the text/string
   type.
3. Click **Next**.

> ⚠️ **Set every Data type to text/string, especially `preferred_date` and
> `phone`.** If `preferred_date` is typed as a date, HubSpot reformats the value.
> The code compares it as the literal text `2026-09-08`, so a reformatted date
> silently fails to match, and the contact is booked on the next open day instead
> of the day they chose. A phone-typed field may be reformatted too.

**7e. Match.** The heading reads *"Match your enrollment property"* (*"Choose a
property from your incoming third-party webhook that's an exact match for one of
the unique HubSpot properties."*).
- **Associated object:** Contact
- **Third-party property label:** `email`
- **HubSpot property label:** Email

Click through to finish the wizard.

> ⚠️ **Unknown emails fail silently.** The trigger enrolls only an *existing*
> contact whose Email exactly matches. If no contact has that email, HubSpot
> returns the same `202 Accepted`, and nothing appears in the workflow history.
> By default Aloware doesn't create HubSpot contacts for new numbers, so a first
> text from a stranger books nothing. See [Known limitations](#9-known-limitations).

**7f. Check the trigger card.** You're back in the workflow editor. The trigger
card now reads *"[your webhook name] has been completed any number of times
anytime"*.
1. At the bottom of the trigger card, check that it reads **Re-enroll on**. If it
   doesn't, click **Details** and turn re-enrollment on (wording may differ).
   Without it, a contact who books once can never book again.
2. Leave **Only enroll contacts that meet these conditions** empty.

✅ **Check:** all seven fields are mapped with a text data type, the match is
`email` → Email, re-enrollment is on, and the webhook URL is in your scratch note.

### Step 8: Add the custom code action

*About 30 minutes.*

**8a. Add the action.**
1. Click the **+** under the trigger and choose **Custom code** (it's in the
   **Data ops** group, or search for `code`). The panel opens titled **Custom
   code**, with **Cancel** and **Save** at the top.
2. **Language:** **Node.js 20.x**.

**8b. Add the secret.**
1. Under **Secrets** (*"Choose one or multiple secrets to use in this action."*),
   open the **Choose a secret** dropdown. It's a checkbox list of your portal's
   secrets, with **Add secret** and **Manage secrets** links at the bottom.
2. Click **Add secret**. Name it exactly **`HUBSPOT_BOOKING_TOKEN`**, paste the
   Step 4 key as the value, and save it.
3. Back in the dropdown, tick **`HUBSPOT_BOOKING_TOKEN`** so it shows as a chip in
   the field.

> ⚠️ **The secret name must be one the code reads:** `HUBSPOT_BOOKING_TOKEN` or
> `HUBSPOT_TOKEN`. In the original build the first secret was named after the
> service key instead, and the action couldn't find it. If you already have a
> secret under another name, create a second one with the right name.
> **Manage secrets** (also under **Settings** in the workflow editor) opens
> **Secrets management**, where you can **Edit** or **Delete** secrets later.

**8c. Map the inputs.** Under **Property to include in code** (*"Each property
needs to be defined in your code."*), add one row per input:
1. Click **Add property**.
2. Type the **input name** in the left box, exactly as shown below. The code reads
   these names.
3. Click **Select a property** on the right. The **All data tokens** panel opens.
   Type part of the name in its search box. Results are grouped under **Enrolled
   contact** (the contact's own properties) and under your **webhook's name** (the
   fields from Step 7).
4. Click the token from the group shown in the table. The row shows a chip like
   `Phone Numb…` or `phone (AI Booking …`.

| Input name | Pick from | Token |
|---|---|---|
| `first_name` | your webhook's group | `first_name` |
| `last_name` | **Enrolled contact** | *Last Name* |
| `email` | **Enrolled contact** | *Email* |
| `phone` | **Enrolled contact** | *Phone Number* |
| `phone_agent` | your webhook's group | `phone` |
| `preferred_date` | your webhook's group | `preferred_date` |
| `preferred_period` | your webhook's group | `preferred_period` |
| `timezone` | **Enrolled contact** | *IP Timezone* |
| `timezone_agent` | your webhook's group | `timezone` |

Why these sources:
- `email` and `last_name` come from the record because the trigger already matched
  on email, and HubSpot's copy is the normalized one. A blank last name is sent as
  `-`, since HubSpot rejects an empty one.
- `phone` comes from the record because the contact must already exist and your
  integration syncs the number in. The agent often doesn't send a phone at all.
  `phone_agent` is only a fallback.
- `timezone` comes from **IP Timezone**, which HubSpot derives and the agent can't
  know. It's stored as a slug (`america_slash_chicago`), which the code converts.
  `timezone_agent` covers contacts HubSpot has never seen on a tracked page. The
  code prefers the contact's, then the agent's, then `DEFAULT_TZ`.
- `preferred_date` and `preferred_period` are what the contact just said, so they
  must come from the webhook.

> ⚠️ **Two "Phone Number" tokens.** Searching `phone` also shows a company's
> *Phone Number*. Hover the chip after you pick it and make sure it says Enrolled
> contact. Booking a lead with their company's switchboard number is a quiet,
> annoying bug.

> ⚠️ **Rows can reset.** In the original build, earlier rows went back to
> **Select a property** after later edits. Before you save, read every row. A row
> with no value shows *"Property selection is required"* in red.

*Optional:* `consent_type_id` and `consented`. Map these only if your form
*requires* consent (probe section 3) and the agent actually asks for it. The code
never invents consent.

**8d. Paste the code.** Scroll to **Code**, click into the editor, select all and
delete the sample code, then paste in **all** of [`src/booking-action.js`](src/booking-action.js). The
**Full screen** button makes this easier. The file ends with an `exports.__test`
block. Leave it in: HubSpot only calls `exports.main`, and the block is what the
offline tests use.

> Whenever you change the code later, select all and replace the **whole** file.
> In the original build, an older paste still running in HubSpot produced an error
> that had already been fixed locally.

**8e. Declare the data outputs.** Under **Data outputs** (*"Define the data type
and name of outputs from your code. Each output name must be unique and can only
be used once."*), HubSpot already lists `hs_execution_state` as an
**Enumeration**. Leave it alone. Click **Add output** for each row below, choosing
the type from the dropdown and typing the name:

| Output | Type |
|---|---|
| `booking_status` | String |
| `confirmation_text` | String |
| `booking_label` | String |
| `alternatives_text` | String |
| `error_detail` | String |
| `payload_shape` | String |
| `booked_contact_id` | String |
| `calendar_event_id` | String |
| `booked_start_ms` | Number |
| `booked_duration_ms` | Number |

Anything you don't declare is invisible to later steps, even if the code returns
it.

**8f. Rate limit.** **Configure rate limit** sits just above **Test action**. The
default is fine. It's the setting to come back to if a campaign ever drives a
burst of simultaneous bookings.

**8g. Save.** Click **Save** at the top of the panel.

**8h. Test the action.**
1. Expand **Test action**. HubSpot warns *"Changes will be applied to your
   contact. If you don't want to edit existing contacts try making a test
   contact."* This test really does book a meeting.
2. In **Contact**, pick a test contact that has an email **and** a phone number
   (if your form needs one). The contact-sourced inputs (`email`, `last_name`,
   `phone`, `timezone`) come from this contact, so they don't get test boxes.
3. Under **Properties to include in code**, only the webhook-sourced inputs show an
   **Enter test value** box. Fill them:

   | Input | Test value |
   |---|---|
   | `first_name` | `Test` |
   | `phone_agent` | `+15550100123` |
   | `preferred_date` | A weekday **inside the link's booking window** that has openings, e.g. tomorrow's date as `YYYY-MM-DD` |
   | `preferred_period` | `morning` |
   | `timezone_agent` | `America/New_York` |

4. Click **Test**. (**View contact** opens the record in a new tab.)

✅ **Check:** **Status** reads *Success*, and the **Data outputs** table shows:

| Name | Value |
|---|---|
| `booking_status` | `booked` |
| `booking_label` | e.g. `Tuesday, September 8 at 2:00 PM EDT`, in the *contact's* timezone |
| `payload_shape` | `legacy-millis` |
| `calendar_event_id` | a real id |
| `confirmation_text` | `You're all set for Tue Sep 8 at 2:00 PM EDT. Invite headed to …` |

**Logs** shows *Memory* and *Runtime*, for example `Memory: 97/2048 MB` and
`Runtime: 673.74 ms`. A booking takes about 0.7 to 1.5 seconds. Then **delete the
test meeting** (Step 3i).

Outputs the run didn't set show a yellow dot and *"Not defined in code"*. On a
`slot_taken` run, for example, every booked-only output reads that, which is
normal. It only means a typo if it appears on a `booked` run.

If you don't get `booked`, these are the results the original build hit, in
order:

| You got | Cause | Fix |
|---|---|---|
| `slot_taken` with `alternatives_text` | Your `preferred_date` is outside the booking window, or that day is full | Use a date inside the window with openings. This is the "offer three real times" path working. |
| `error`, *"required form field phone does not have a corresponding value"* | `phone` is blank: the test contact has no number, or the row is mapped to a webhook field the agent never sends | Map `phone` to **Enrolled contact → Phone Number** (8c), or fix `FORM_FIELDS` (Step 6) |
| `needs_phone` | Same, caught before calling HubSpot | Same |
| `error` naming `HUBSPOT_BOOKING_TOKEN` | Secret not ticked, or named differently | 8b |
| `error` with **401** or **403** | Key wrong, or write scope missing | Step 4 |
| `not_scheduled` | The rep the round robin picked has an offline calendar. Nothing was booked. | Run the probe (Step 5) and fix the pool |

**8i. Turn the workflow off between test rounds.** Until Step 9 is done, the
workflow runs straight from the custom code to **End**. A real trigger would book
and then do nothing, and any failure would vanish. If you turned it on to test,
turn it off again now.

### Step 9: Branch the workflow on the result

*About 30 minutes.*

> The original build's branches weren't captured on screen, so the branch labels
> below may differ.

1. Under the custom code action, click **+** and choose **Branch**.
2. Choose to branch on one property or action output (wording may differ), and
   select the custom code output **`booking_status`**.
3. Add one branch per value, typing each value exactly as shown. Then add the
   actions in each branch:

| `booking_status` | What happened | Actions to add |
|---|---|---|
| `booked` | A real meeting exists, with a calendar event | **Aloware → Disenroll from all sequences**, so a booked lead stops getting chased. Optionally, **Set property** for reporting. If you build section 6, add the refresh action here too. |
| `slot_taken` | Nothing matched the request, or the slot went mid-booking | **Aloware → Send a text (SMS/MMS)** with the message body set to the output **`confirmation_text`**. It already offers three real times. |
| `needs_email` | No email address on file | **Aloware → Send a text (SMS/MMS)** with `confirmation_text`. It asks for the email. |
| `needs_phone` | Only happens if your form requires phone and none was found | **Aloware → Send a text (SMS/MMS)** with `confirmation_text` |
| `not_scheduled` | **HubSpot returned 200 but booked nothing.** A rep's calendar is offline. | **Create task**, due today and assigned to a manager: "Bot booking failed; call the contact and fix the calendar." **Don't** disenroll them. The contact was told a human will follow up. |
| `no_availability` | The link has no openings at all | **Create task** for the sales team |
| `error` | Token, scope, network or configuration problem | **Create task** with `error_detail` in the body |
| *(none of the above)* | Shouldn't happen | **Create task**, same as `error` |

To use an output in an action, click the field's data-token picker and look under
the custom code action's outputs (wording may differ).

The Aloware actions (**Send a text (SMS/MMS)**, **Enroll to sequence**,
**Disenroll from all sequences**, **Add to power dialer**) appear in the HubSpot
workflow action list once the Aloware integration is installed. You don't need any
code to call Aloware. Remember the SMS action is billed as automated usage
(Step 1c). If you'd rather keep texts inside Aloware sequences, use **Enroll to
sequence** with a sequence that sends the same message.

> ⚠️ **On a voice agent there's no way back.** The webhook returns only `202`, so
> the agent never hears the result. A `slot_taken` or `needs_email` result can only
> reach a caller by text afterwards, which is another reason SMS is the stronger
> channel.

4. Click **Review and turn on** (top right). When asked about existing contacts,
   choose *not* to enroll them: webhook workflows only enroll when an event
   arrives.

✅ **Check:** the workflow header reads **ON**, and the branch shows all seven
values plus the fallback.

**How to read a run** (you'll use this in every test from here on):
1. In the workflow, open **Enrollment history** and click the contact's run. The
   path of that run is highlighted.
2. The **Logs of one run** panel lists *"Triggered from: [your webhook name]"*,
   *"Successfully executed"* and *"Completed workflow"*, each marked *Success*.
3. *"Successfully executed"* only means the code didn't crash. Every result,
   including failures, returns normally. To see what actually happened, click
   **1. Custom code** under **Action** in that entry. The event details show a
   **Return value** with `booking_status`, `error_detail` and the rest.

### Step 10: Create the Aloware agent and Custom Function

*About 30 minutes.*

Aloware's screens are **different for text and voice agents**. Follow 10A for an
SMS agent or 10B for a voice agent. Both send the same JSON to the same HubSpot
webhook.

#### 10A. Text (SMS) agent

**10A.1 Create the agent.** A text agent must exist before you can add a function
to it.
1. **AloAi Agents → + New Agent → Text.** The page **Create a new agent** opens
   (subtitle *Text - Inbound*), with a left menu: Configure, Instructions, Context,
   Schedule, Actions, Custom Functions.
2. **Configure** tab:

   | Field | Value |
   |---|---|
   | **Name** | e.g. `AI Booking — SMS` |
   | **Description** | `Books calls into HubSpot Meetings for contacts who ask over text.` |
   | **Agent type** | **Text** |
   | **Direction** | **Inbound** (it replies when someone texts in) |
   | **Inbound lines (Optional)** | A **test line**, not a production number. You can change this later in Line Settings. |
   | **Text model** | Change the default **GPT-5.4 Nano** to a stronger model, e.g. **GPT-5.4**. The agent turns "next Tuesday" into a date and fills structured arguments, which is where the smallest models slip. A wrong date books the wrong day and nothing errors. |
   | **Engagement expiration** | `7` Days is fine |

3. **Instructions** tab. Both boxes are required before **Create** will work
   (*"Please provide an opener for the agent"*, *"Please provide instructions for
   the agent"*):
   - **Greeting Message:** e.g. `Hi! Thanks for reaching out. I can answer
     questions or get you booked in with an advisor — what can I do for you?`
     Don't put a name variable in it. A new number arrives in Aloware as
     "No Name", so `{first_name}` would render as "Hi ,".
   - **Instructions:** paste the SMS prompt from Step 11 for now. You'll insert
     the function chip in Step 11 once the function exists.
4. Click **Create** (top right). The page title changes to the agent's number and
   name, with a subtitle like *Text - Inbound - GPT-5.4 - Enabled*.

**10A.2 Open the function editor.** In the agent's left menu, click **Custom
Functions**, then **+ Add function** (right). The modal **Create Custom Function**
opens, with **Close** and **Save** at the top.

**10A.3 Set up your custom function details:**

| Field | Value |
|---|---|
| **Function name** *(255 chars)* | `request_booking` |
| **Function description** *(255 chars)* | `Submits a booking request once the contact has given a day and rough time of day. Use only after they've agreed to a call.` |
| **Reply to the contact during execution?** | **Off**. The webhook answers in about 120 ms, so nobody notices a pause on SMS. |
| **Reply to the contact after execution?** | **On**, so the agent confirms it's locking it in |

**10A.4 Variables** (*"These are the inputs this agent will request the contact to
provide in the middle of the conversation."*). Click **+ Add variable** for each
row. Every row has **Name**, **Description**, **Type** and **Required** (*"Is
required to execute?"*, default *No*). The descriptions do real work: the model
reads them at the moment it fills each value.

| Name | Description | Type | Required |
|---|---|---|---|
| `email` | `The contact's email address. Ask for it if you don't already have it — over text they can type it accurately.` | String | **Yes** |
| `first_name` | `The contact's first name.` | String | No |
| `preferred_date` | `The day they want, as YYYY-MM-DD. Resolve "tomorrow", "next Tuesday" and similar using today's date.` | String | **Yes** |
| `preferred_period` | `Rough time of day: morning or afternoon. Never evening.` (match your calendar's hours) | String | No |
| `timezone` | `IANA timezone such as America/New_York, if known. Omit if unsure.` | String | No |

`email` is required because HubSpot matches on it. Without it the workflow enrolls
nobody and still returns 202. *Optional extras:* `last_name` and `phone` (both
String, not required). The code reads last name and phone from the contact record
first, so these only matter as fallbacks.

**10A.5 Connect to the API** (four tabs):
- **Endpoint:** set the method dropdown to **POST** and paste the webhook URL from
  your scratch note. **Timeout** defaults to `10` seconds, which is fine.
- **Headers:** add `Content-Type` = `application/json`.
- **Authorization:** leave it empty. The webhook URL needs no auth.
- **Body:** click **+ Add body** once per variable. For each row:
  1. Open **Type** (*"Tell from where this data comes."*) and change it from
     **Static** to **Variable**.
  2. **Name** (*"Tell what this field is called."*): the exact key, e.g.
     `preferred_date`.
  3. **Value**: once Type is Variable, this turns into a dropdown. Pick the
     matching variable.

  | Type | Name | Value |
  |---|---|---|
  | Variable | `email` | `email` |
  | Variable | `first_name` | `first_name` |
  | Variable | `preferred_date` | `preferred_date` |
  | Variable | `preferred_period` | `preferred_period` |
  | Variable | `timezone` | `timezone` |

  Add `last_name` and `phone` rows too if you added those variables.

> ⚠️ **Body rows default to Static.** A **Static** row with Value `email` sends the
> literal word `"email"`. HubSpot then matches no contact and returns the same
> **202** as a success, so nothing errors anywhere. If the Value box is a dropdown,
> the row is Variable and you're fine. Also: variables are **not** sent unless they
> have a body row. A variable with no row never reaches HubSpot.

**10A.6 Test the API Call.**
1. Click **Initialize custom function**. The section then reads *"Please, provide
   some values for the mapped variables before testing the custom function."* with
   a box per variable.
2. **First test, nobody:** enter an email that matches **no** HubSpot contact
   (e.g. `nobody@example.com`), `first_name` `Test`, a `preferred_date` inside the
   booking window, `preferred_period` `morning`, `timezone` `America/New_York`.
   Click **Make API Call**. A green toast reads *"AloAi Custom Function — API call
   was successful! Now, you can map the response fields to be used during the
   conversation."* In HubSpot, **Enrollment history** should show **nothing**. That's
   the silent no-op from Step 7e, seen once on purpose.
3. **Second test, a real contact:** change the email to a real test contact and
   click **Make API Call** again. Same toast. This time a run appears in
   **Enrollment history** within seconds and books a real meeting. Check it with
   "How to read a run" (Step 9), then delete the meeting (Step 3i).

**10A.7 Leave "Map the API response fields to be used in the conversation"
empty.** The webhook only returns its own id. Mapping it would hand the agent a
meaningless string to talk about. The real answer arrives by text from the
workflow.

**10A.8 Save.** Click **Save** at the top of the modal. The **Custom Functions**
list now shows `request_booking` with its description and edit and delete icons.
Then click **Save** at the top right of the agent page.

> The **Actions** item in the text agent's left menu is **not** where functions are
> attached. It only holds **Enable Follow Up** (automatic nudges to unresponsive
> contacts). The function is attached from the Instructions, in Step 11.

#### 10B. Voice agent

**10B.1 Create the agent.**
1. **AloAi Agents → + New Agent → Voice.** In **Create agent**, choose
   **Inbound**, then **Blank agent** (*"Start from scratch."*). Don't pick a
   *Booking* template like *Generic Appointment Booking*: those come pre-wired to
   other schedulers. Click **Create agent**.
2. The agent opens with tabs **Configure**, **Lines & Scheduling** and
   **Post-Call Actions**, and a subtitle like *Voice - Inbound - GPT 4.1 Mini -
   Enabled*. Rename it with the pencil next to the title. If it's a test agent,
   say so in the name (e.g. `Booking Test - Delete Me`).

**10B.2 Set the agent's context and call settings** (right-hand panels):

| Panel | Setting | Value |
|---|---|---|
| **Context** | **Contact Information** | **On**. It gives the agent the caller's name, email and phone from their contact record, which is how it knows the email without asking. |
| **Context** | **Communications** | On |
| **Call Settings** | **End Call on Silence** | **Off**, so a pause while HubSpot is called can't hang up |
| **Call Settings** | **Max Call Duration** | 15 min is plenty |
| **Security & Fallback Settings** | **Data Storage** / **Retention Period** | Review with whoever owns compliance. Calls capture personal data. |
| **Calendar Integration** | | **Leave it alone.** That's the other-scheduler path this build replaces. |

**10B.3 Open the function editor.**
1. In the right-hand **Functions** panel (at the very top of the right rail),
   click **+ Add**.
2. The **Add Function** modal shows **Search functions…** and a **CATEGORY** row:
   Call Control · Contact Management · Communication · Call Management ·
   Scheduling · Integrations · **Advanced**.
3. Click the **Advanced** chip *inside the modal* and choose the custom function
   option (wording may differ). Don't confuse it with **Advanced Call Handling** in
   the right rail, which is a different setting. **Scheduling** only offers other
   schedulers' booking actions, so skip it.
4. The **Custom Function** modal opens. A notice at the top reads *"Appears as a
   tag in your prompt"*: the function is inserted as a tag like
   `{Run this function: request_booking|cf_…}`, and removing the tag deletes the
   function.

**10B.4 Fill in the Custom Function modal:**

| Field | Value |
|---|---|
| **Name** *(letters, numbers, underscores and dashes only, max 64 characters)* | `request_booking` |
| **Description** | `Submits a booking request once the caller has given a day and rough time of day. Use only after they've agreed to a call.` |
| **API Endpoint** | Method **POST**. Paste the webhook URL in *"Enter the URL of the custom function"*. |
| **Timeout** | Drag the slider from the default **120 s** down to **15 s**. The webhook answers instantly. 120 s only means a caller waiting two minutes if something hangs. |
| **Headers** | **+ New key value pair** → `Content-Type` = `application/json` |
| **Query Parameters** | None |
| **Parameters (Optional)** | Click the **JSON** tab, paste the schema below, and click **Format JSON**. Turn **Payload: args only** **on**, so the body is exactly the arguments. |
| **Body Template (Optional)** | Leave empty. With "args only" on, the arguments are the body. |
| **Response Format** | **Auto-detect** |
| **Response Variables** | None. The webhook returns only its id. |
| **Speak During Execution** | **Check it.** It's unchecked by default, and on a call that's dead air. Choose **Prompt** and enter: `Tell the caller you're locking that time in now and it will just take a moment. Do not state a specific appointment time or confirm any particular slot.` |
| **Speak After Execution** | ✅ Checked (the default) |

Schema for **Parameters**:

```json
{
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "description": "The contact's email address, taken from their contact record in context. Never ask the caller to spell out an email address."
    },
    "first_name": { "type": "string", "description": "The caller's first name." },
    "preferred_date": {
      "type": "string",
      "description": "The day they want, as YYYY-MM-DD. Resolve 'tomorrow', 'next Tuesday' and similar using today's date."
    },
    "preferred_period": {
      "type": "string",
      "enum": ["morning", "afternoon", "evening"],
      "description": "Rough time of day they asked for."
    },
    "timezone": {
      "type": "string",
      "description": "IANA timezone such as America/New_York, if known. Omit if unsure."
    }
  },
  "required": ["email", "preferred_date"]
}
```

`email` is required because HubSpot matches the webhook on it. The agent takes it
from **Context → Contact Information**, never by asking aloud. If the caller has no
email on file, nothing can be booked (see [Known limitations](#9-known-limitations)).
Remove `"evening"` from the enum if your calendar doesn't run evenings.

> ⚠️ **The prompt matters more than the checkbox.** Without the "do not state a
> specific time" sentence, the model fills the pause by inventing "great, I've got
> you down for 2 o'clock" before anything has been booked.

**10B.5 Test Function.** Expand **Test Function** (*"Send a test request to your
endpoint"*) at the bottom of the modal.
1. In the **REQUEST** column, check **Request Preview** shows `POST` and your
   webhook URL, and **Headers (1)** shows `Content-Type: application/json`.
2. **Request Body** is pre-filled with your schema's fields and empty values (use
   **Reset** / **Format** if needed). Fill it with an email that matches **no**
   contact first:
   ```json
   {
     "email": "nobody@example.com",
     "first_name": "Test",
     "preferred_date": "2026-09-08",
     "preferred_period": "morning",
     "timezone": "America/New_York"
   }
   ```
3. Click **Send Test Request**. The **RESPONSE** column shows **202 Accepted**, a
   response time, and a body of `{"id": "..."}`. Nothing should appear in the
   workflow's **Enrollment history**.
4. Change the email to a real test contact (and the date to one inside the booking
   window) and send again. Same 202, but now a run appears in **Enrollment
   history** and a meeting is booked. Check it, then delete it.

**10B.6 Save.** Click **Save** at the bottom of the modal, then **Save** at the top
right of the agent. The **Functions** panel now lists `request_booking`, and the
tag appears in the prompt editor.

✅ **Check (either type):** after the real-contact test, the workflow's
**Enrollment history** shows a new run within a few seconds, and its **Return
value** has `booking_status` = `booked`.

### Step 11: Add the booking instructions to the agent

*About 20 minutes.*

**Where the prompt goes:**
- **Text agent:** **Instructions** tab, **Instructions** box (up to 80,000
  characters; the counter shows e.g. *1,408 / 80,000 chars*). The **`</>`** button
  under the box switches between chips and raw text.
- **Voice agent:** **Configure** tab, the prompt editor (*"Type in a universal
  prompt for your agent…"*). The function tag from Step 10B is already in it.

**11a. Paste the prompt.** Paste one of these into the part of the prompt that
handles booking. Replace `9 to 5` and the offered times of day with your
calendar's real hours.

**SMS (text) agent:**

```text
You are a scheduling assistant. You help people book a call with an
advisor. Be brief and warm — you are texting, so keep messages short.

When the contact wants to book a call:

1. Make sure you have their first name and email address. Ask for
   whichever is missing — over text people type an email accurately,
   so there is no reason to skip it.
2. Ask which day works and roughly what time of day.
3. Convert their answer to a calendar date in YYYY-MM-DD format,
   using today's date to resolve "tomorrow", "next Tuesday" and the
   like. Map their answer to morning or afternoon.
4. Use the request_booking function to submit the booking. Do not
   skip this step. Everything after it depends on it having run.
5. Tell them you are locking it in and the confirmation will arrive
   by text and email shortly.

Never state a specific appointment time as confirmed. You do not
know which slot was taken until the confirmation goes out. If they
press for the exact time, say the confirmation will state it.

Only offer morning or afternoon. Never offer evening — the calendar
runs 9 to 5, so an evening slot can never be booked.

You cannot see the calendar and cannot list specific available times.
If they ask what times are available, say so plainly and move forward.
Never re-ask for a time of day without acknowledging that you couldn't
answer their question. Say something like: "I don't have the live
calendar in front of me, but if you send me a day plus morning or
afternoon, I'll book the closest opening and the confirmation will
come by email. You can always reschedule from the invite if needed."

You must call request_booking before telling the contact anything is
booked or being booked. Never say you have booked, will book, or are
locking in a time unless you have actually called request_booking in
this conversation. If you cannot call it, say a team member will
confirm shortly instead.
```

**Inbound voice agent:**

```text
When the caller wants to book a call:

1. Ask which day works best, and whether morning or afternoon suits
   them better.
2. Convert their answer to a calendar date in YYYY-MM-DD format,
   using today's date to resolve "tomorrow", "next Tuesday" and the
   like. Map their time of day to morning, afternoon or evening.
3. Use the request_booking function with those values, their first
   name, and the email address from their contact information.
4. Tell them you are locking it in and the calendar invite will
   arrive by email shortly.

Never state a specific appointment time as confirmed. You do not
know which slot was taken until the invite goes out. If they press
for the exact time, say the invite will confirm it.

You cannot see the calendar and cannot list specific available times.
If the caller asks what times are available, say so plainly and move
forward. Never re-ask for a time of day without acknowledging that you
couldn't answer their question. Say something like: "I can't pull up
the calendar from here, but if you tell me the day and whether morning
or afternoon works, I'll book the closest opening and email you the
confirmation right away. If the time doesn't suit you, you can
reschedule straight from that email."

Do not try to collect an email address by voice. If you do not have
one already, say a team member will confirm the details shortly and
end the call politely.

You must call request_booking before telling the caller anything is
booked or being booked. If you cannot call it, say a team member will
confirm shortly instead.
```

**The two most important paragraphs** are "Never state a specific appointment
time" and "You must call request_booking before…". Without the first, the agent
makes a time up. Without the second, a wiring mistake produces a perfect
conversation, a happy contact, and no meeting.

**11b. Insert the function chip (text agent).** Writing `request_booking` in the
prompt isn't enough. The model has to see the actual function.
1. Put your cursor at the start of step 4 of the prompt.
2. Click **+ Add Action** under the Instructions box and pick `request_booking`.
3. A chip appears reading **Run this function: request_booking|cf_…** (in raw text:
   `{Run this function: request_booking|cf_…}`).
4. Look at the **+ Add Action** button. It shows a count, e.g. **Add Action (1)**.
   If it says **(2)** or more, the chip is in the prompt twice. Delete the extra
   chip. **Never delete all of them**: removing the last chip deletes the
   function's trigger.
5. Click **Save** (top right).

**Voice agent:** the tag is inserted when you save the function (Step 10B). Make
sure it's still in the prompt, write the instructions *around* it rather than
replacing the whole box, and click **Save**.

> ⚠️ **It talked, but didn't book.** In the original build, the first live SMS test
> read perfectly ("locking that in") and nothing reached HubSpot. The prompt named
> the function in prose, and the chip had been inserted twice. The fix was one chip
> at step 4, the imperative step 4 wording, and the guard paragraph. If a test
> conversation says it's booking and **Enrollment history** stays empty, check
> the chip first.

✅ **Check:** test the agent. On a voice agent use **Test your Agent** (bottom
right). On a text agent, text the test line from your phone. Ask to book. The agent
should ask for a day, say it's *locking it in* **without** naming a time, and a run
should appear in **Enrollment history** the moment you give a day. Ask "what times
are available?" once, and check it answers honestly instead of looping.

### Step 12: Test end to end

*About 45 minutes.* Use a real phone and a real HubSpot test contact whose number
and email you control. Make sure the workflow is **ON**.

**12a. Attach the agent to a test line** if you haven't yet: see Step 13, 1.

**12b. The happy path.** Text (or call) the agent and ask for a call on a day you
know is open, inside the booking window.

✅ **Check all of these:**
- [ ] The agent asks for your email only if the contact has none (text agent), and
      never asks for it on voice.
- [ ] It offers only times of day your calendar runs, and never names a time.
- [ ] The workflow's **Enrollment history** shows the run, and the **Return value**
      has `booking_status` = `booked`.
- [ ] The Meeting is on the contact, with **Call and meeting type = AI Booked
      Call**.
- [ ] The invite is on the assigned rep's calendar, with no unwanted video link.
- [ ] The contact received the `booked` text (Step 9) and HubSpot's confirmation
      email.
- [ ] **The chase stopped:** enroll the test contact in an Aloware sequence first,
      book through the bot, and confirm **Disenroll from all sequences** fired.

**12c. Check the reply actually sent (SMS).** Open the conversation in Aloware and
click one of the agent's messages. The **Communication Info** page shows *Current
Status*. *Failed* with *"Messaging is disabled for this line"* means the line
isn't on a 10DLC campaign yet (Step 1d).

**12d. The failure paths.**

| Try | Expect |
|---|---|
| Ask for a day and time that are fully booked | `slot_taken`, and a text offering three real times |
| Book from a contact with no email (SMS) | `needs_email`, and the agent asks for one |
| Ask for a date months ahead | `slot_taken` with alternatives, not silence |
| Text or call from a number that isn't in HubSpot | Aloware creates a "No Name" contact with only the phone number. HubSpot gets nothing, so nothing enrolls and nothing books. The agent still says it's booking. Know this failure by sight. |
| Temporarily disconnect one pool rep's calendar | `not_scheduled` and an urgent task, **never** "you're all set" |
| Untick the secret on the action | `error`, and `error_detail` names `HUBSPOT_BOOKING_TOKEN`. Tick it again afterwards. |

**12e. Clean up.** Delete every test meeting (Step 3i) and throwaway contact.
Keep any test agent until the production agent books successfully, so you have
something known-working to compare against, then delete it.

### Step 13: Go live and watch the first day

*About 20 minutes, plus spot checks through the first day.*

1. **Attach the agent to a line.** In Aloware, go to **Lines**, open the line, and
   click the **Routing & IVR** tab:
   - **SMS agent:** under *"Who should handle incoming messages?"*, switch on
     **An AloAi Agent** (*"Route incoming messages to an AloAi Agent for an
     AI-powered messaging conversation."*), then pick it in **Select AloAi
     Agent:**.
   - **Voice agent:** under *"Who should answer incoming calls?"*, switch on
     **An AloAi Agent**, then pick it in **Select AloAi Agent:**.
   - **Go to the AloAi Agent** under each picker opens that agent.
   - Click the green **Save** (bottom right).

   A line can have a voice agent and a text agent at the same time, because each
   is picked separately. Before go-live, take any **test** agent off the line, or
   two agents with different prompts will answer the same number.
2. **Make sure the agent is on.** In **AloAi Agents**, each agent row has an on/off
   toggle. The production agent's must be on, and its header reads *Enabled*.
3. **Make sure the round robin is production-ready:** the real reps are in the pool
   (Step 3c), every one reads *Calendar connected*, the probe shows `calendar OK`
   for each (Step 5), and the meeting type is set.
4. **Decide on follow-ups.** The text agent's **Actions → Enable Follow Up** sends
   automatic nudges to contacts who go quiet. If you turn it on, set the number and
   timing deliberately. Nudges a few minutes apart read as pushy.
5. During the first day, check:
   - the HubSpot workflow's **Enrollment history** (use **More filters** to find
     failed runs), and the **Return value** of a sample of runs
   - each Aloware contact's timeline, which logs *"Contact enrolled to AloAi Text
     Agent: …"* and every agent reply
   - the task queue fed by the `not_scheduled`, `no_availability` and `error`
     branches
   - a sample of `AI Booked Call` meetings, compared against what each contact
     actually asked for.
6. Build a report: **Meetings** where *Call and meeting type* is `AI Booked Call`,
   grouped by week and by owner.

**To roll back,** turn the workflow **Off**. Aloware's call is still accepted,
nothing is booked, and there's no half-finished state to clean up.

### Step 14: Change the meeting link later

*About 20 minutes. Do this every time you point the bot at a different link.*

1. Build or pick the new link and set its **Meeting type** to `AI Booked Call`
   (Step 3b). A new link doesn't inherit it, and without it bookings arrive
   unlabelled and drop out of your reports.
2. Match its **Location** wording to the old link if any report keys off it
   ("Phone" and "Phone Call" are different values).
3. Open the new link's public page. Note the required fields on **YOUR INFO**, and
   check how far out the first opening is. If it's weeks away, check the link's
   minimum notice and availability, because the bot will offer whatever it finds.
4. Run the read-only probe on the new slug (Step 5b). Confirm the pool, `calendar
   OK` for every rep, and `formFields`.
5. Update `MEETING_SLUG` in [`src/booking-action.js`](src/booking-action.js) (and in
   [`src/refresh-slots-action.js`](src/refresh-slots-action.js) if you built section 6). Update `FORM_FIELDS` to
   match the new form (Step 6). Run `npm test`.
6. In HubSpot, open the custom code action, select all in the code editor and paste
   the **whole** updated file. **Save**, then **Review and update** the workflow
   (wording may differ).
7. Run one **Test action** booking (Step 8h) and delete it.

✅ **Check:** the test returns `booked`, and the meeting carries **Call and
meeting type = AI Booked Call**.

---

## 6. Optional: let the agent offer real times

*About 2 hours.*

Without this upgrade, the agent can only ask *"which day suits you?"* When someone
reasonably asks *"well, what's available?"* before booking, it has nothing to say.

**Do you need it?**

| | Real times when their pick is full | Real times on demand ("what's open?") |
|---|---|---|
| **Step 9 branches** (needed anyway) | ✅ texted back via `slot_taken` | ✗ |
| **This cache** | ✅ | ✅ |

On SMS, the branches already get real times to the contact one exchange later.
On voice there's no way back after the call, so this is the *only* way a voice
agent can ever state a time. Build the branches first, run it for a while, and
build this only if people keep asking to see options first.

**Why a cache:** the webhook trigger returns `202` with no data, so the agent
can't get an answer back from the workflow. Instead, a second action pre-computes
the next three openings onto **one HubSpot record**. A second Custom Function
reads that record straight from the HubSpot CRM API, which *is* synchronous. The
agent reads a finished sentence aloud and copies the chosen slot's date and period
into `request_booking`, so it never does any time math.

> None of this section was captured on screen in the original build. The code was
> built and tested offline. HubSpot and Aloware labels here are described rather
> than quoted (wording may differ).

**6a. Create the cache record in HubSpot.**
1. Go to **Settings → Data Management → Objects → Custom Objects** and create an
   object, for example `AI Booking Cache`.
2. Add these properties, **all Single-line text**, including the dates:

   | Property | Example value |
   |---|---|
   | `slot_offer_text` | `I have Tue Sep 8 at 9:00 AM EDT, Wed Sep 9 at 10:00 AM EDT, or Thu Sep 10 at 3:00 PM EDT. Which works best?` |
   | `slot_1_label`, `slot_2_label`, `slot_3_label` | `Tue Sep 8 at 9:00 AM EDT` |
   | `slot_1_date`, `slot_2_date`, `slot_3_date` | `2026-09-08` (**text, not Date**, same reason as Step 7d) |
   | `slot_1_period`, `slot_2_period`, `slot_3_period` | `morning` |
   | `slot_count` | `3` |
   | `slot_refreshed_at` | `2026-09-01T12:00:00.000Z` |

3. Create **one** record in the object. Availability is the same for everyone on a
   round-robin link, so one record serves every conversation.
4. Note the object's **type id** (like `p12345678_ai_booking_cache` or
   `2-12345678`) and the record's **id**, and put both in your scratch note.

> ⚠️ **Text, not Date.** A date-typed `slot_1_date` gets reformatted, and
> `request_booking` compares `2026-09-08` as literal text. The contact silently
> gets a different day than the one they picked.

**6b. Give the booking key access to the cache.** Open the Step 4 service key,
click **Edit**, and add the **read** and **write** scopes for your custom object
(named like `crm.objects.custom.read` / `crm.objects.custom.write`; wording may
differ). Save. The key value doesn't change.

**6c. Build the refresh workflow.**
1. **Automation → Workflows → Create workflow → From scratch**, and name it
   `AI Booking — Refresh Slots`. Use the scheduled trigger (*"Based on a
   schedule"*, Data Hub Professional), at least daily.
2. Add a **Custom code** action, **Node.js 20.x**.
3. **Secrets:** tick `HUBSPOT_BOOKING_TOKEN`, then use **Add secret** to create
   **`SLOT_CACHE_TYPE`** (the type id) and **`SLOT_CACHE_ID`** (the record id), and
   tick both.
4. **Property to include in code:** optional. `timezone` sets the zone the labels
   are written in. Leave it out to use `DEFAULT_TZ`.
5. **Code:** delete the sample code and paste in **all** of
   [`src/refresh-slots-action.js`](src/refresh-slots-action.js). Its `MEETING_SLUG` must be exactly the same as
   in `booking-action.js` (Step 6), or the agent offers times it can't then book.
6. **Data outputs:**

   | Output | Type |
   |---|---|
   | `refresh_status` | String |
   | `slot_count` | Number |
   | `slot_offer_text` | String |
   | `error_detail` | String |

7. **Save**, then **Test action** with any contact.

✅ **Check:** **Status** is *Success*, `refresh_status` is `ok`, `slot_count` is
`3` (or fewer if the link has fewer openings), and the cache record in HubSpot now
holds a sentence you'd be happy to hear read aloud.

8. **Review and turn on** the workflow.
9. Refresh from two more places, because each covers a different gap:
   - **After every booking:** add the same custom code action (same secrets, same
     outputs) at the end of the `booked` branch from Step 9, so the slot just taken
     stops being offered.
   - **When a conversation opens (optional):** give a copy of this workflow a
     webhook trigger (Step 7), and have the agent call it before it asks any
     questions.

**6d. Create a separate read-only key.** In **Service Keys**, create a second key,
e.g. `AI Booking Cache Read`, with only the **read** scope for your custom object.
This key will sit in an Aloware header outside HubSpot, so if it leaks, the worst
case is someone learning when your team is free. **Don't** reuse the booking key
here.

**6e. Add the second Aloware custom function.** It's a plain GET that takes no
variables. The URL, with the properties list built in, is:

```
https://api.hubapi.com/crm/v3/objects/<type id>/<record id>?properties=slot_offer_text,slot_1_label,slot_1_date,slot_1_period,slot_2_label,slot_2_date,slot_2_period,slot_3_label,slot_3_date,slot_3_period
```

The header is `Authorization: Bearer <read-only key from 6d>`.

| Setting | Text agent (Create Custom Function) | Voice agent (Custom Function) |
|---|---|---|
| Name | **Function name:** `get_available_times` | **Name:** `get_available_times` |
| Description | **Function description:** `Use when the contact asks what times are available, or before offering times. Returns the current openings.` | **Description:** same text |
| Replies | **Reply to the contact after execution?** On | **Speak After Execution** checked |
| Variables / parameters | None | **Parameters:** empty |
| Method and URL | **Endpoint** tab: **GET** and the full URL above | **API Endpoint:** **GET** and the URL without `?properties=…`; add `properties` = the comma list under **Query Parameters** |
| Auth | **Headers** tab: `Authorization` = `Bearer …` | **Headers:** `Authorization` = `Bearer …` |
| Test | **Initialize custom function**, then **Make API Call** | **Test Function → Send Test Request** |
| Response | Under **Map the API response fields to be used in the conversation**, **+ Add response mapping** for each field below | **Response Variables:** **+ New key value pair** for each field below (JSONPath) |

**Response fields to map:**

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

On a **text agent**, the mapping's **Value** is a dropdown of fields from the test
response, so run **Make API Call** first and then pick
`properties.slot_offer_text` and the rest. On a **voice agent**, type the JSONPath
as shown.

✅ **Check:** the test response is **200** and its body has a `properties` object
holding your cache sentence.

**6f. Add to the prompt,** and on a text agent insert a `get_available_times` chip
with **+ Add Action** at step 1 (Step 11b):

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

Remove the "You cannot see the calendar" paragraph from the Step 11 prompt, since
it's no longer true.

**Stale offers are safe.** `request_booking` always re-reads live availability
before it books, so a slot that was taken in the meantime comes back as
`slot_taken` with three fresh alternatives, never a double booking.

✅ **Check:** text the agent "what times are available?" It should read the cache
sentence word for word, and picking one should book exactly that slot.

---

## 7. Reference: inputs, outputs and settings

### Inputs to `booking-action.js`

| Input | Required | Source | Notes |
|---|---|---|---|
| `email` | Yes | Contact **Email** | Lowercased and trimmed. Missing → `needs_email`. |
| `first_name` | Yes | Webhook | If it holds a full name and `last_name` is empty, the name is split |
| `last_name` | No | Contact **Last Name** | Sent as `-` if empty, because HubSpot rejects blank last names |
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

- **Brand-new contacts can't book unless they already exist in HubSpot.** The
  webhook trigger only enrolls an existing HubSpot contact matched on email. By
  default, Aloware doesn't create HubSpot contacts for unknown numbers (an
  unknown caller shows up in Aloware as a "No Name" contact with only a phone
  number). Leads who came in through a HubSpot form are fine. Truly cold
  inbound contacts need a contact-creation step before this works.
- **Voice is the weaker channel.** HubSpot Meetings needs an email, and a voice
  agent can't reliably collect one. Voice works for callers whose email is
  already on their record. SMS can collect it.
- **SMS needs an approved 10DLC campaign** on the Aloware line before any agent
  reply is delivered.
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
| Agent calls the function, nothing in the workflow's Enrollment history | No HubSpot contact has that email, or (text agent) `email` has no **Body** row | Confirm the contact exists (Step 7e). On a text agent, check that every variable has a Body row (Step 10A.5). |
| Workflow runs, but `preferred_date` or other fields arrive empty | The text agent's **Body** tab is missing those rows | Add one *Variable* body row per field (Step 10A.5) |
| Agent's SMS replies show *"Failed"* / *"Messaging is disabled for this line"* | The line's 10DLC campaign isn't approved yet | Finish the 10DLC registration from Aloware's yellow banner (**Submit info**). Test on voice meanwhile. |
| Agent never answers texts or calls | The agent isn't attached to the line | **Lines → your line → Routing & IVR** (Step 13) |
| `error`, and `error_detail` names `HUBSPOT_BOOKING_TOKEN` | The secret isn't selected on the action | Step 8b |
| `error` with **401** | Key wrong or truncated | Re-copy the full key from **Show → Copy** |
| `error` with **403** | Missing write scope | Add `crm.objects.contacts.write` (Step 4) |
| `error` with `MEETING_DURATION_NOT_VALID` | Payload shape changed | Re-run the probe's booking test, then check `book()` in the code |
| `error` mentioning a *required form field* | `FORM_FIELDS` doesn't match the form | Step 6 |
| `not_scheduled` | A pool rep's calendar is disconnected | Run the probe. Reconnect the calendar or remove the rep. |
| Meeting has no Call and meeting type | The link's **Meeting type** isn't set | Step 3b |
| Booked on the wrong day | `preferred_date` mapped as Date | Re-map as String (Step 7d) |
| Times stated in the wrong timezone | IP Timezone not mapped to `timezone` | Step 8c |
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
