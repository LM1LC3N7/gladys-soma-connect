# TODO — SOMA Connect v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session (one
  post per wave in /t/10385).

## Status

- [x] **Milestone 1 — core** (2026-10-26): HTTP client of SOMA Connect (five
      requests, both URL forms), up to 32 devices, one shutter each (open,
      close, stop, position, battery), positions bounded, lanes per shade,
      stop first (retries, kept in /data, resent, contradicted), follow-up
      reads and confirmation, pauses, reads paced on a monotonic clock, config
      read again while it fails, Test button, en/fr, docs, cover. Tested
      against a simulated SOMA Connect and a local HTTP server only.
- [ ] **Milestone 2 — real SOMA Connect**: run against a real bridge (firmware
      2 and 3) and compare with the SOMA app (see "To check"); turn the answers
      (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: light level of the solar panel (once its unit is
      known), "close upwards" for a Tilt as an option, morning mode.
- [ ] **Milestone 4 — first release**: Release workflow, topic, GHCR package public.

## To check on a real SOMA Connect

- The URL form of firmware 3 and later (`?mac=..&pos=..`, from pysoma) and
  whether firmware 4 (if any) keeps it; the 404 of the other form.
- The answers: `version` of `list_devices`, `type` (`shade`/`tilt`), the
  `position` of a Tilt and `closed_upwards`, `battery_percentage` against
  `battery_level`, the `result` of an error.
- How long SOMA Connect takes to answer (it asks the shade over Bluetooth):
  reads are cut at 4 s, moves sent within 3.5 s; whether it answers several
  requests at once (a scene sends one per shade side by side; a stop opens its
  own connection while a read may run).
- Whether `get_shade_state` shows the position while the shade moves (the
  check of a stop by two reads relies on it) and how long a full travel takes
  (follow-up reads at 2, 5, 20, 45, 90 s).
- Whether `set_shade_position` answers before or after the move.
- `get_light_level`: its field and unit.
- The answer of `stop_shade` on a shade that does not move (an `error` result
  would keep each such stop and send it again 3 times).
- The HTTP status of a shade out of Bluetooth reach (200 with `error`, or a
  5xx: a 5xx of one shade holds no other, review r1 I2).
- The first digit of the version of recent firmware (the URL form: pysoma
  takes `?mac=` for "3" only; both forms are tried after a 404 anyway).
- How many reads at once a real SOMA Connect takes (4 here, follow-ups
  included; a stop waits behind them on a bridge that serves one at a time).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-soma-connect:0.1.0`):
  the first patch release gives 0.1.1.
- **SDK `^0.15.0`**: 0.16.0 is not published on npm yet (checked 2026-10-26,
  `npm view` gives 0.15.0); move to it when it is (migration planned).
- **pysoma (MIT, Wazombi Labs OÜ, the maker)** is ported, not run (Python);
  the meaning of the positions and the battery reading come from the Home
  Assistant `soma` integration (Apache-2.0). Both credited in
  THIRD_PARTY_NOTICES.md, copied into the image. No Bluetooth in the module:
  only HTTP to SOMA Connect.
- **Shutter, not curtain**: roller shades and venetian blinds; the core's
  `shutter` category (`state`, `position`). Never `switch`/`binary`. Battery in
  `battery/integer`, `%`.
- **Positions** (Gladys 100 = open): shade = 100 − SOMA; Tilt = 100 − |SOMA|;
  commands SOMA = 100 − Gladys, integer 0..100, checked again in the client
  (`apiPosition`) right before the URL is built. A Tilt is never closed
  upwards by Gladys (no negative value sent).
- **Identity rule** (frozen: it fixes the external ids): the MAC address of
  `list_devices` (`aa:bb:..` or 12 digits), lower case without separators;
  `ext:<selector>:soma:<mac>`. The MAC is only sent in a URL after the strict
  check of its form. Two entries of one MAC: the first wins, the status says
  it. A type change applies at the next Scan only.
- **The ack means "accepted by SOMA Connect"**: a shade travels for up to a
  minute, so a read of the position asked cannot fit in the 5 s of the ack.
  The confirmation is the follow-up reads: badge "not confirmed" while a move
  sent without answer is not read back, "not reached" after the last one.
- **One lane per shade**, never one for the bridge: a scene that moves five
  shades with 900 ms per answer sends the five (test). Reads are not in the
  lanes: a read begun before a command left is not applied.
- **Close is protective too** (review r1 I7, same decision as
  gladys-somfy-mylink): `state = -1` and `position = 0`; no lane (it cancels the
  moves waiting), through a pause, before the configuration (address and shade
  of /data), never `LaneFull`, retried every 250 ms within 3.5 s, re-sent once
  after a move that was leaving; a newer stop or accepted move cancels it.
  Never kept nor re-sent by itself (not after a restart).
- **Store category `lighting`** (spec §3: covers, shutters, blinds).
- **URL form** (review r1 I4): pysoma's rule first (`?mac=` for a major
  version of exactly 3, the path form otherwise), the other form after a 404
  in every case (a 404 did nothing), the form that answered kept (in /data
  too) and tried first.
- **Stop**: protective command. It cancels the
  moves not sent yet (and a move numbered before it never leaves), cuts the
  reads silent for 1 s and waits for their close (200 ms at most), is tried
  again every 250 ms while nothing reached the motor (no connection, an error
  result, a 404 of both forms, a 4xx/429/5xx) within 3.5 s; a silence after the
  request is "sent, without confirmation" and also kept. Kept in /data and
  sent again with the reads (at least once a minute, through a pause or a
  backoff; at once after a restart), 3 times at most, then given up with a
  status line. A newer move ACCEPTED by SOMA Connect cancels the resend of an
  older stop; a move sent without answer does not (in doubt, the stop goes).
  The stops kept have their own timer (at once at the start, then once a
  minute), independent of the configuration, of a pause and of a backoff
  (review r1 I3); they leave side by side. After a stop, only the follow-up
  reads of 2 and 5 s check it: the shade still going the way it went (known
  from the move stopped, else any way) gets it again (3 times at most); two
  equal reads or a move the other way end the check; a cycle read never sends
  a stop (review r1 I1: a move from the app or a remote is left alone).
- **Reads**: the last read time written to /data before the reads, at most
  once a minute (and at a clean stop); after a restart the next read waits the
  interval. The battery at most once an hour per shade, its time kept in /data.
- **Pauses** (review r1 I2): a 429 on any request, or a 5xx of
  `list_devices`, pauses the moves of the bridge for what Retry-After asks
  (1 min to 6 h), else 1, 2, 4 then 5 min; the reads never come sooner than
  the interval anyway. A 5xx on one shade only marks that shade not read.
  Monotonic clock (wall clock in /data); stop and close go through. A read cut
  for a stop is no failure: a cut list is asked again 3 s later.
- **getConfig() failing at the start**: tried again from 5 s, doubled, up to
  every 5 min, with a status; moves refused "configuration not loaded", stop
  works from /data.
- **No secret**: the API of SOMA Connect has no authentication. An address not
  understood is never shown back in the status.
- **Light level not read in v1**: the SOMA HTTP API page is not reachable
  from the VM (403) and pysoma gives no unit; publishing a raw value as lux
  would be wrong.
- **Store fields for Gladys >= 5.3.0** (not set yet, `gladys_version` stays
  `>=5.1.0`): keywords `soma, smart shades, tilt, blinds, store, volet`,
  countries `EE, FR, DE, GB, NL, BE, CH, AT, IT, ES, SE, FI, NO, DK, PL`.
