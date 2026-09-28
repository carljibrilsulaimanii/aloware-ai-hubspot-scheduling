#!/usr/bin/env bash
# probe.sh -- settle the questions only your real HubSpot portal can answer
# -------------------------------------------------------------------------
# Author:  Jibril Sulaiman
# Created: 2026-08-19 (sanitized for publication 2026-09-28)
#
# Deploy:  Nowhere. Run locally in bash (macOS, Linux, Git Bash) before building
#          the workflow. scripts/probe.ps1 is the same probe for PowerShell, with
#          friendlier output (it decodes start times and flags offline calendars).
#
# What it does: checks the API version, lists meeting links, prints the form
#   definition and availability, and -- only with BOOK=yes -- writes one real
#   test booking in both documented payload shapes.
#
# Why it exists: HubSpot's docs and its live API disagree on the booking payload,
#   and a wrong shape, a missing scope or an offline rep calendar all fail in ways
#   that look like "the endpoint is broken".
#
#   export HUBSPOT_TOKEN=pat-na1-xxxxxxxx
#   export MEETING_SLUG=your-team/ai-booked-call
#   bash scripts/probe.sh
#
# Steps 1-4 are read-only. Step 5 writes a real meeting and contact.
# Scopes: scheduler.meetings.meeting-link.read, plus crm.objects.contacts.write
# for step 5.

set -uo pipefail

: "${HUBSPOT_TOKEN:?set HUBSPOT_TOKEN}"
TZ_NAME="${TZ_NAME:-America/New_York}"
PROBE_EMAIL="${PROBE_EMAIL:-booking-probe@example.com}"
AUTH="Authorization: Bearer $HUBSPOT_TOKEN"
API="https://api.hubapi.com"

# HubSpot moved to date-based versioning. /2026-03/ is current; /v3/ is legacy.
V_NEW="/scheduler/2026-03/meetings/meeting-links"
V_OLD="/scheduler/v3/meetings/meeting-links"

echo "=== 1. Which API version answers for this portal? ==="
for V in "$V_NEW" "$V_OLD"; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "$AUTH" "$API$V?limit=1")
  printf '  %-45s HTTP %s\n' "$V" "$CODE"
done
echo "  (200 = use it. 404 = not on this portal. 401 = bad key. 403 = scope missing.)"
echo

echo "=== 2. Meeting links visible to this token ==="
curl -sS -H "$AUTH" "$API$V_NEW?limit=20" | head -c 3000
echo; echo

: "${MEETING_SLUG:?set MEETING_SLUG to continue}"
SLUG_ENC=$(printf '%s' "$MEETING_SLUG" | sed 's#/#%2F#g')

echo "=== 3. What does the booking form REQUIRE? ==="
echo "    Every required field must be in the POST body or the booking is rejected."
echo "    Look for: formFields, legalConsentOptions ids, and isOffline per pool member"
echo "    (any member with isOffline:true will produce bookings that create nothing)."
curl -sS -H "$AUTH" "$API$V_NEW/book/${SLUG_ENC}?timezone=${TZ_NAME}" | head -c 4000
echo; echo

echo "=== 4. Availability for $MEETING_SLUG ==="
echo "    Confirm the key holding start times, the duration key, and that busy"
echo "    blocks sit in a separate 'busy'-named branch."
curl -sS -H "$AUTH" \
  "$API$V_NEW/book/availability-page/${SLUG_ENC}?timezone=${TZ_NAME}" \
  | head -c 4000
echo; echo

echo "=== 5. Test booking -- BOTH payload shapes ==="
echo "    The 2026-03 reference types startTime as ISO 8601 and duration as MINUTES;"
echo "    the older guide uses epoch millis for both. Expect millis to succeed."
echo
echo "    Set START_MS from step 4, PHONE, and BOOK=yes to write one."
if [ "${BOOK:-no}" = "yes" ]; then
  : "${START_MS:?set START_MS to a start time from step 4}"
  PHONE="${PHONE:-+15550100123}"
  DUR_MS="${DURATION_MS:-1800000}"
  DUR_MIN=$(( DUR_MS / 60000 ))
  ISO=$(date -u -d "@$(( START_MS / 1000 ))" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null \
        || date -u -r "$(( START_MS / 1000 ))" +%Y-%m-%dT%H:%M:%S.000Z)

  try_shape () {
    local NAME="$1" START="$2" DUR="$3"
    echo "--- shape: $NAME (startTime=$START duration=$DUR) ---"
    curl -sS -w '\n  HTTP %{http_code}\n' -X POST -H "$AUTH" -H "Content-Type: application/json" \
      "$API$V_NEW/book?timezone=${TZ_NAME}" \
      -d "{
        \"slug\": \"${MEETING_SLUG}\",
        \"firstName\": \"Booking\",
        \"lastName\": \"Probe\",
        \"email\": \"${PROBE_EMAIL}\",
        \"startTime\": ${START},
        \"duration\": ${DUR},
        \"timezone\": \"${TZ_NAME}\",
        \"locale\": \"en-us\",
        \"guestEmails\": [],
        \"likelyAvailableUserIds\": [],
        \"formFields\": [{\"name\": \"phone\", \"value\": \"${PHONE}\"}],
        \"legalConsentResponses\": []
      }"
    echo
  }

  try_shape "2026-03 (ISO + minutes)" "\"$ISO\"" "$DUR_MIN"
  try_shape "legacy (millis + millis)" "$START_MS" "$DUR_MS"

  echo "    Whichever returned a calendarEventId is the shape. booking-action.js is"
  echo "    pinned to millis; change book() only if your portal disagrees."
  echo
  echo "    Then open the booked meeting and check:"
  echo "      - Call and meeting type reads your AI-booking type"
  echo "      - which rep the round robin assigned"
  echo "    Then delete the test meeting and the probe contact."
else
  echo "    (skipped -- rerun with BOOK=yes START_MS=... )"
fi
echo

echo "=== 6. What does a workflow webhook trigger return? ==="
if [ -n "${WEBHOOK_URL:-}" ]; then
  curl -sS -i -X POST -H "Content-Type: application/json" "$WEBHOOK_URL" \
    -d "{\"email\":\"${PROBE_EMAIL}\",\"first_name\":\"Booking\",\"last_name\":\"Probe\",\"preferred_date\":\"2026-09-08\",\"preferred_period\":\"afternoon\",\"timezone\":\"America/New_York\"}"
  echo; echo
  echo "    Read the BODY, not the status code. Expect a bare 202 ack: the trigger"
  echo "    cannot return the custom code action's output to the caller."
else
  echo "    (skipped -- set WEBHOOK_URL to run it)"
fi
