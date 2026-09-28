<!--
  docs/ALOWARE-AGENT.md -- AloAI Custom Function config and agent prompts
  Author:  Jibril Sulaiman
  Created: 2026-09-28 (from a production build first shipped 2026-08-19)
  What:    Exact field values and copy-paste prompts for the Aloware side.
  Why:     The prompt's "never state a confirmed time" rule is load-bearing --
           without it the agent invents appointment times it cannot know.
-->

# Aloware agent setup

This page covers the Custom Function field values, the variables, and prompts you
can copy for SMS and inbound voice.

## `request_booking` (required)

Go to **AloAI agent → Custom Functions → + Add Function**.

| Field | Value |
|---|---|
| Function Name | `request_booking` |
| Description *(255-char limit)* | `Use when the contact has agreed to a call and given a day and rough time. Submits the booking request. Do not use before they have chosen a day.` |
| Method | `POST` |
| Endpoint URL | The workflow's webhook trigger URL (Setup 3.2) |
| Headers | `Content-Type: application/json` |
| Respond during execution | **On.** On voice this is non-negotiable, or the caller sits in silence while HubSpot is called. |
| Respond after execution | **On** |

### Variables

| Variable | Type | Required | Notes |
|---|---|---|---|
| `first_name` | string | Yes | |
| `last_name` | string | No | The action splits a full name if this is empty |
| `email` | string | Yes | HubSpot can't book without it |
| `phone` | string | No | The contact record's number is used first |
| `preferred_date` | string | Yes | Exactly `YYYY-MM-DD` |
| `preferred_period` | string | No | `morning`, `afternoon` or `evening` |
| `timezone` | string | No | An IANA name, used only if the contact has no IP Timezone |

Attach it through **Add action → Custom function → `request_booking`**, set to
trigger when the contact has agreed to a day.

### Prompt: SMS agent

Paste this where the prompt handles booking. **The "Never state a specific
appointment time" paragraph matters most.** Without it, the agent will invent a
confirmed time it has no way of knowing.

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

### Prompt: inbound voice agent

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

The last paragraph is there for a practical reason: spelling an email address
aloud is where voice agents reliably fail. The workflow reads the email from the
contact record anyway, so the caller doesn't need to give one.

## Optional: `get_available_times`

This needs Setup Phase 4B, meaning the cache record and the refresh workflow,
already in place.

| Field | Value |
|---|---|
| Name | `get_available_times` |
| Description | `Use when the caller asks what times are available, or before offering times. Returns the current openings.` |
| Method | `GET` |
| URL | `https://api.hubapi.com/crm/v3/objects/{objectType}/{recordId}` |
| Query parameter | `properties` → `slot_offer_text,slot_1_label,slot_1_date,slot_1_period,slot_2_label,slot_2_date,slot_2_period,slot_3_label,slot_3_date,slot_3_period` |
| Header | `Authorization` → `Bearer <READ-ONLY key>`. **Not** the booking key. |
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

### Prompt addition

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

Offered times can go stale between the read and the booking, and that's safe.
`request_booking` re-reads live availability before it writes, so a stale pick
comes back as `slot_taken` with three current alternatives. The contact hears
*"that one just went, I do have…"*, which is what a person would say.
