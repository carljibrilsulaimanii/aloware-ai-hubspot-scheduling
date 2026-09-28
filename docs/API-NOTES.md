<!--
  docs/API-NOTES.md -- HubSpot Scheduler (Meetings) API behavior, verified live
  Author:  Jibril Sulaiman
  Created: 2026-09-28 (findings dated 2026-08-19)
  What:    What the Scheduler API actually does, where it differs from the docs.
  Why:     Every item below fails in a way that looks like something else --
           usually "the endpoint is broken". Re-verify with scripts/probe.*.
-->

# HubSpot Scheduler API: verified behavior

These notes come from testing against a live portal in August 2026. HubSpot
changes this API, so use `scripts/probe.ps1` or `scripts/probe.sh` to re-check
anything that matters to you.

## Endpoints used

| Purpose | Call |
|---|---|
| List links | `GET /scheduler/2026-03/meetings/meeting-links?limit=20` |
| Form definition, pool, consent | `GET /scheduler/2026-03/meetings/meeting-links/book/{slug}?timezone=…` |
| Availability | `GET /scheduler/2026-03/meetings/meeting-links/book/availability-page/{slug}?timezone=…` |
| Book | `POST /scheduler/2026-03/meetings/meeting-links/book?timezone=…` |

HubSpot moved to date-based API versions. `/2026-03/` is current and `/v3/` is
legacy. There's a long community thread about the v3 book path returning 500s.

## Scopes

- `scheduler.meetings.meeting-link.read` is enough for reads.
- **Booking also needs a write scope.** With only the read scope, `POST /book`
  returns **403** whatever the payload. The endpoint accepts several write scopes,
  and `crm.objects.contacts.write` is the sensible one because booking creates or
  updates the contact.

## The slug

- A round-robin slug contains a slash: `your-team/ai-booked-call`.
- **URL-encode it** in path parameters (`your-team%2Fai-booked-call`). In the
  POST body it goes in raw.

## Availability payload

```jsonc
{
  "linkAvailability": {
    "linkAvailabilityByDuration": {
      "1800000": {                          // key = duration in MILLISECONDS
        "meetingDurationMillis": 1800000,
        "availabilities": [
          { "startMillisUtc": 1787159700000, "endMillisUtc": 1787161500000 }
        ]
      }
    }
  },
  "allUsersBusyTimes": [                    // also has start times -- never offer these
    { "busyTimes": [ { "start": 1787166000000, "end": 1787169600000 } ] }
  ]
}
```

- Results are **keyed by duration** because a link can offer several lengths.
  Book with the key you read the slot from.
- Slots follow the link's *start time increment*. For example, a 30-minute
  meeting can offer starts every 15 minutes.
- Busy blocks sit in a separate branch and carry their own start times. A naive
  "find every start" walk will offer a rep's existing meeting as an opening. The
  action skips any subtree whose key matches
  `busy|unavailable|blocked|conflict|exclu`.
- Minimum notice, buffers, working hours and booking window are **already
  applied**. Don't re-apply them in code, or you'll silently override whatever
  the link owner configured.

## Booking payload

```json
{
  "slug": "your-team/ai-booked-call",
  "firstName": "Alex",
  "lastName": "Morgan",
  "email": "alex@example.com",
  "startTime": 1787159700000,
  "duration": 1800000,
  "timezone": "America/New_York",
  "locale": "en-us",
  "guestEmails": [],
  "likelyAvailableUserIds": [],
  "formFields": [],
  "legalConsentResponses": []
}
```

- **`startTime` and `duration` are both epoch milliseconds.** The 2026-03
  reference documents an ISO 8601 start with a duration in minutes. That shape
  returns
  `400 VALIDATION_ERROR / MeetingsBookingSchedulingError.MEETING_DURATION_NOT_VALID`.
- **Send one shape only.** A fallback retry in the other shape overwrites the real
  error, so a genuine fault (a missing form field, for example) gets reported as
  a fake duration error.
- **`lastName` can't be empty.** Send `-` if you don't have one.
- **`formFields` must match the page exactly.** A missing required field is
  rejected with *"required form field X does not have a corresponding value"*, and
  a field the form doesn't have can also be rejected.
- **`legalConsentResponses`** can be `[]` when consent is optional with implicit
  processing. When consent is required, answer each `communicationTypeId` from the
  form definition, and only with what the contact actually said.

## Booking response

```json
{
  "calendarEventId": "…",
  "contactId": "…",
  "isOffline": false,
  "start": "…",
  "duration": 1800000,
  "webConferenceUrl": "…"
}
```

### The offline booking trap

If the round robin assigns a rep whose calendar connection is down, the response
is **HTTP 200** with `isOffline: true` and `calendarEventId: ""`. **Nothing is
created**: no meeting engagement, no calendar event, only a contact. It looks like
a success in every log.

It happens because an offline rep has an empty busy list, so HubSpot thinks
they're free at all hours. Treat *any* empty `calendarEventId` as a failure,
whatever `isOffline` says. The form-definition call shows each pool member's
`isOffline` flag, so check it whenever the pool changes.

## What a successful booking stamps

| Property | Value |
|---|---|
| `hs_activity_type` | The link's **Meeting type** setting. This reaches API bookings too. |
| `hs_meeting_source` | `INTEGRATION` for API bookings, `MEETINGS_PUBLIC` for the public page |
| `hs_meeting_outcome` | `SCHEDULED` |
| `hs_meeting_location` | The link's location |
| `hs_video_conference_url` | Set if the page has a video link attached, **even for a Phone Call location** |
| Owner | The rep the round robin assigned |

Don't write booking source to a call-direction property (inbound or outbound). A
booked meeting isn't a call in either direction.

## Webhook trigger (workflow side)

- Returns `202 Accepted` with only an enrollment id. **It can't return the custom
  code action's outputs**, so the agent can't get a synchronous answer. That's why
  the confirmation goes out as a follow-up message, and why the optional slot
  cache exists.
- It **silently does nothing** for an email that matches no contact: the same
  202, the same body, and no history entry.
- Map fields as **String**. A Date-typed mapping reformats `YYYY-MM-DD`.

## Contact properties

- **IP Timezone** is stored as a slug, for example `america_slash_new_york` or
  `america_slash_indiana_slash_indianapolis`. Passing it to `Intl.DateTimeFormat`
  throws a `RangeError`. Convert it (`_slash_` → `/`, then capitalize each
  segment), validate it with `Intl`, and fall back if it's still invalid.
- Phone numbers are stored in whatever format they arrived in. Normalize US
  numbers to E.164 before sending them as a form field, and pass anything you
  don't recognize through unchanged.

## Custom code runtime

- Node.js 20. `axios` is available without an import step.
- There's a 20-second and 128 MB budget. A read plus a booking runs in about
  0.7 s and about 100 MB.
- Each selected secret is exposed as `process.env.<SECRET_NAME>`.
