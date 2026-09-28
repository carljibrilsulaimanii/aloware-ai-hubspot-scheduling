<#
  probe.ps1 -- settle the questions only your real HubSpot portal can answer
  --------------------------------------------------------------------------
  Author:  Jibril Sulaiman
  Created: 2026-08-19 (sanitized for publication 2026-09-28)

  Deploy:  Nowhere. Run locally in PowerShell 5.1+ (Windows) before building the
           workflow. scripts/probe.sh is the same probe for bash.

  What it does:
    1. Which Scheduler API version answers for your portal (2026-03 or v3)
    2. Which meeting links your service key can see
    3. What the booking form requires, and whether every pool member's calendar
       is connected
    4. The raw availability payload, with the first five start times decoded
    5. (only with -Book) a real test booking in BOTH documented payload shapes
    6. (only with -WebhookUrl) what a workflow webhook trigger returns

  Why it exists:
    HubSpot's docs and its live API disagree on the booking payload, and a wrong
    shape, a missing scope or an offline rep calendar all fail in ways that look
    like "the endpoint is broken". Twenty minutes here saves days later.

  Steps 1-4 are read-only. Step 5 writes a real meeting and contact -- delete
  both afterwards.

  Usage:
    .\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call
    .\probe.ps1 -Token pat-na1-xxxx -Slug your-team/ai-booked-call `
                -Book -StartMs 1788890400000 -Phone +15550100123 -Email you@yourdomain.com

  Service key scopes: scheduler.meetings.meeting-link.read (steps 1-4),
                      plus crm.objects.contacts.write (step 5)
#>

param(
  [Parameter(Mandatory = $true)][string] $Token,
  [string] $Slug,
  [string] $TimeZone   = 'America/New_York',
  [switch] $Book,
  [long]   $StartMs    = 0,
  [long]   $DurationMs = 1800000,
  [string] $Phone      = '+15550100123',
  [string] $Email      = 'booking-probe@example.com',
  [string] $WebhookUrl
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Catch the most common mistake before spending a round trip on it: a placeholder
# copied out of a doc or chat rather than the real value from Show / Copy.
if ($Token -match '\.\.\.|\*|^\s*$' -or $Token.Length -lt 30) {
  Write-Host ""
  Write-Host "  That does not look like a full service key." -ForegroundColor Red
  Write-Host "  Got: $($Token.Length) chars"
  Write-Host "  Expected: pat-na1- followed by a long id, roughly 45 characters, no dots or asterisks."
  Write-Host "  Grab it from Settings > Integrations > Service Keys > your key > Show or Copy."
  Write-Host ""
  return
}

$Api   = 'https://api.hubapi.com'
$VNew  = '/scheduler/2026-03/meetings/meeting-links'
$VOld  = '/scheduler/v3/meetings/meeting-links'
$Auth  = @{ Authorization = "Bearer $Token" }

function Show-Head {
  param([string] $Text, [int] $Max = 3000)
  if ($null -eq $Text) { return }
  if ($Text.Length -gt $Max) { $Text.Substring(0, $Max) + "`n  ...(truncated)" } else { $Text }
}

function Invoke-Probe {
  param([string] $Method = 'Get', [string] $Url, $Body)

  $req = @{
    Method          = $Method
    Uri             = $Url
    Headers         = $Auth
    UseBasicParsing = $true
    ErrorAction     = 'Stop'
  }
  if ($Body) {
    $req.Body        = ($Body | ConvertTo-Json -Depth 6 -Compress)
    $req.ContentType = 'application/json'
  }

  try {
    $r = Invoke-WebRequest @req
    return [pscustomobject]@{ Status = [int] $r.StatusCode; Body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    $code = 0
    $text = $_.Exception.Message
    if ($resp) {
      $code = [int] $resp.StatusCode
      try {
        $sr = New-Object IO.StreamReader($resp.GetResponseStream())
        $text = $sr.ReadToEnd()
      } catch { }
    }
    return [pscustomobject]@{ Status = $code; Body = $text }
  }
}

Write-Host "`n=== 1. Which API version answers for this portal? ===" -ForegroundColor Cyan
foreach ($v in @($VNew, $VOld)) {
  $r = Invoke-Probe -Url "$Api$v`?limit=1"
  Write-Host ("  {0,-45} HTTP {1}" -f $v, $r.Status)
}
Write-Host "  200 = use it.  404 = not on this portal.  403 = scope missing."

$probe = Invoke-Probe -Url "$Api$VNew`?limit=1"
if ($probe.Status -eq 401) {
  Write-Host ""
  Write-Host "  STOPPING: HubSpot rejected the key itself (401), so nothing below would run." -ForegroundColor Red
  Write-Host "  401 means the credential is wrong, not that a scope is missing -- that would be 403."
  Write-Host "  Check you pasted the FULL key from Show / Copy, with no truncation or quotes."
  Write-Host "  Response body: $($probe.Body)"
  Write-Host ""
  return
}

if (-not $Slug) {
  Write-Host "`nPass -Slug to continue past step 1.`n" -ForegroundColor Yellow
  return
}

Write-Host "`n=== 2. Meeting links visible to this key ===" -ForegroundColor Cyan
$links = Invoke-Probe -Url "$Api$VNew`?limit=20"
Write-Host ("  HTTP {0}" -f $links.Status)
Write-Host (Show-Head $links.Body)

# A round-robin slug contains a slash ("your-team/ai-booked-call"), which is
# ambiguous as a path parameter: some endpoints want it raw, some want it
# percent-encoded. Try both and report which one HubSpot actually answers.
$slugForms = @(
  @{ Label = 'raw';     Value = $Slug },
  @{ Label = 'encoded'; Value = [uri]::EscapeDataString($Slug) }
)
if ($Slug -notmatch '/') { $slugForms = @($slugForms[0]) }

function Try-SlugPath {
  param([string] $PathTemplate, [string] $Query = '')

  foreach ($f in $slugForms) {
    $url = "$Api$VNew" + ($PathTemplate -replace '\{slug\}', $f.Value) + $Query
    $r   = Invoke-Probe -Url $url
    Write-Host ("  slug $($f.Label.PadRight(8)) HTTP $($r.Status)")
    if ($r.Status -eq 200) {
      Write-Host "  ^ this is the form to use" -ForegroundColor Green
      return $r
    }
    if ($r.Body) { Write-Host ("    " + (Show-Head $r.Body 400)) }
  }
  return $null
}

Write-Host "`n=== 3. What does the booking form REQUIRE? ===" -ForegroundColor Cyan
Write-Host "    Every required field must be in the POST body or the booking is rejected."
Write-Host "    Look for the form field names, and legalConsentOptions ids if consent is enforced."
# 2026-03 can answer this one with a 400, so try it with a timezone and then fall
# back to the v3 path -- this endpoint is only how we learn the required form
# fields and consent ids, so it is worth a second attempt.
$info = Try-SlugPath -PathTemplate '/book/{slug}' -Query "?timezone=$TimeZone"
if (-not $info) {
  Write-Host "  retrying on /v3/ ..." -ForegroundColor Yellow
  foreach ($f in $slugForms) {
    $r = Invoke-Probe -Url "$Api$VOld/book/$($f.Value)`?timezone=$TimeZone"
    Write-Host ("  v3 slug $($f.Label.PadRight(8)) HTTP $($r.Status)")
    if ($r.Status -eq 200) { $info = $r; break }
    if ($r.Body) { Write-Host ("    " + (Show-Head $r.Body 300)) }
  }
}
if ($info) {
  Write-Host (Show-Head $info.Body 4000)

  # The wall of JSON above hides the two things that actually matter, so pull
  # them out: who is in the pool, and whether each of their calendars is live.
  Write-Host "`n  POOL MEMBERS -- every one must read calendar OK:" -ForegroundColor Green
  foreach ($m in [regex]::Matches($info.Body,
      '"isOffline":(true|false),"meetingsUser":\{[^}]*?"userId":"(\d+)".*?"fullName":"([^"]*)"')) {
    $offline = $m.Groups[1].Value -eq 'true'
    $state   = if ($offline) { 'CALENDAR OFFLINE -- bookings will create nothing' } else { 'calendar OK' }
    $colour  = if ($offline) { 'Red' } else { 'Green' }
    Write-Host ("    {0,-20} {1,-12} {2}" -f $m.Groups[3].Value, $m.Groups[2].Value, $state) -ForegroundColor $colour
  }
  Write-Host ""
  Write-Host "  If you just changed the pool, confirm it saved: re-check"
  Write-Host "  userIdsOfLinkMembers in step 2 and the link's updatedAt timestamp."
} else {
  Write-Host "  Could not read the form definition. Not a blocker: check the public page for"
  Write-Host "  required fields, and step 5 will fail loudly if consent is also demanded."
}

Write-Host "`n=== 4. Availability ===" -ForegroundColor Cyan
Write-Host "    Confirm the key holding start times, the duration key, and that busy"
Write-Host "    blocks sit in a separate 'busy'-named branch."
$avail = Try-SlugPath -PathTemplate '/book/availability-page/{slug}' -Query "?timezone=$TimeZone"
if (-not $avail) { $avail = [pscustomobject]@{ Status = 0; Body = '' } }
Write-Host (Show-Head $avail.Body 4000)

# Surface the first few start times so you don't have to hunt through the JSON.
if ($avail.Status -eq 200) {
  $found = [regex]::Matches($avail.Body, '"startMillisUtc"\s*:\s*(\d{13})') |
           ForEach-Object { [long] $_.Groups[1].Value } | Sort-Object -Unique
  if ($found) {
    Write-Host "`n  Start times found (first 5, shown in US Eastern):" -ForegroundColor Green
    $zoneInfo = $null
    try { $zoneInfo = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time') } catch { }
    $found | Select-Object -First 5 | ForEach-Object {
      $utc   = [DateTimeOffset]::FromUnixTimeMilliseconds($_)
      $local = if ($zoneInfo) { [TimeZoneInfo]::ConvertTime($utc, $zoneInfo) } else { $utc }
      Write-Host ("    {0}  {1}" -f $_, $local.ToString('ddd MMM d, h:mm tt'))
    }
    Write-Host "  These are real openings only -- availabilities use startMillisUtc,"
    Write-Host "  busy blocks use plain start, so busy times cannot leak in here."
  }
}

Write-Host "`n=== 5. Test booking -- BOTH payload shapes ===" -ForegroundColor Cyan
Write-Host "    HubSpot's docs disagree: the 2026-03 reference types startTime as ISO 8601"
Write-Host "    and duration as MINUTES; the older guide uses epoch millis for both."
Write-Host "    Expect the millis shape to succeed and the ISO shape to 400."

if ($Book -and $StartMs -gt 0) {
  $iso    = [DateTimeOffset]::FromUnixTimeMilliseconds($StartMs).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.000Z')
  $durMin = [int] ($DurationMs / 60000)

  $shapes = @(
    @{ Name = '2026-03 (ISO + minutes)';  Start = $iso;     Duration = $durMin },
    @{ Name = 'legacy (millis + millis)'; Start = $StartMs; Duration = $DurationMs }
  )

  foreach ($s in $shapes) {
    Write-Host ("`n--- shape: {0} ---" -f $s.Name) -ForegroundColor Yellow
    $body = @{
      slug                   = $Slug
      firstName              = 'Booking'
      lastName               = 'Probe'
      email                  = $Email
      startTime              = $s.Start
      duration               = $s.Duration
      timezone               = $TimeZone
      locale                 = 'en-us'
      guestEmails            = @()
      likelyAvailableUserIds = @()
      formFields             = @(@{ name = 'phone'; value = $Phone })
      legalConsentResponses  = @()
    }
    $r = Invoke-Probe -Method Post -Url "$Api$VNew/book`?timezone=$TimeZone" -Body $body
    Write-Host ("  HTTP {0}" -f $r.Status)
    Write-Host (Show-Head $r.Body 1500)
  }

  Write-Host "`n  Whichever returned a calendarEventId is the shape. booking-action.js is" -ForegroundColor Green
  Write-Host "  pinned to millis; change book() only if your portal disagrees." -ForegroundColor Green
  Write-Host "`n  Then open the booked meeting and check:"
  Write-Host "    - Call and meeting type reads your AI-booking type"
  Write-Host "      (proves the link's Meeting type setting reaches API bookings)"
  Write-Host "    - which rep the round robin assigned"
  Write-Host "    - the phone number landed on the contact"
  Write-Host "  If your link has no phone field, the phone form field may be rejected -- drop it."
  Write-Host "  Then delete the test meeting and the probe contact."
} else {
  Write-Host "    (skipped -- rerun with -Book -StartMs <from step 4>)"
}

Write-Host "`n=== 6. What does a workflow webhook trigger return? ===" -ForegroundColor Cyan
if ($WebhookUrl) {
  # Send the FULL field set: HubSpot builds the trigger's property map from the
  # shape of this event, so anything missing here cannot be mapped later.
  $r = Invoke-Probe -Method Post -Url $WebhookUrl -Body @{
    email            = $Email
    first_name       = 'Booking'
    last_name        = 'Probe'
    phone            = $Phone
    preferred_date   = '2026-09-08'
    preferred_period = 'afternoon'
    timezone         = 'America/New_York'
  }
  Write-Host ("  HTTP {0}" -f $r.Status)
  Write-Host "  BODY: $($r.Body)"
  Write-Host "`n  Read the BODY, not the status code. Expect a bare 202 ack: the trigger"
  Write-Host "  cannot return the custom code action's output to the caller."
} else {
  Write-Host "    (skipped -- pass -WebhookUrl once the workflow exists)"
}

Write-Host ""
