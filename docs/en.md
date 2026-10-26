# SOMA Connect

Control your **SOMA Smart Shades** (roller shade motors) and **SOMA Tilt**
(venetian blind motors) from Gladys, through the local HTTP API of your
**SOMA Connect** bridge.

> Unofficial integration, not affiliated with SOMA (Wazombi Labs). It has
> **never been tested with a real SOMA Connect**: it follows the API used by
> pysoma, the library of the maker. Feedback is welcome.

## How it works

- Gladys speaks **HTTP only** to SOMA Connect, on your local network (port
  3000). The Bluetooth link to the shades stays inside SOMA Connect: Gladys
  needs no Bluetooth. No account, no cloud.
- Each device listed by SOMA Connect becomes a **shutter** in the Discovery
  tab, with:
  - **Open / close**: open, close and **stop**;
  - **Position**: 0 % (closed) to 100 % (open);
  - **Battery** (%), read at most once an hour (each read wakes the shade).
- A **Tilt** turns the slats: 100 % = slats level (open), 0 % = closed
  downwards. A Tilt closed upwards (from the SOMA app) reads as closed; Gladys
  only closes downwards.

## Set up

1. Pair your shades with SOMA Connect in the SOMA app, and check that SOMA
   Connect is on your network.
2. Give SOMA Connect a fixed address in your router (DHCP reservation).
3. In Gladys, type its **IP address** (port 3000 by default; another port:
   `192.168.1.50:3001`) and save. Press **Test the connection**.
4. In the **Discovery** tab, add the shades.

## Commands

- **Open, close and position** go to SOMA Connect within 3.5 s of your click,
  or are refused with nothing sent. Each shade takes its moves one at a time
  (4 waiting at most); different shades move side by side, so a scene can move
  all your shades at once.
- The acknowledgement says that **SOMA Connect accepted** the command. The
  position is **confirmed** only when a read shows it (within 2 %): the shade
  is read again 2, 5, 20, 45 and 90 s after a command. A shade that did not
  reach its position after the last read gets a warning badge and a line in
  the status.
- A command that may have reached SOMA Connect without an answer is told
  "sent, without confirmation", not "not sent".

### Stop

Stop goes first: it takes no queue, needs no read before it, has no option,
and goes through a pause asked by SOMA Connect and through the spacing of
the tries after a failure. It works right after a restart, before any read (the
address, the firmware and the shades are kept in `/data`). It cancels the moves
of that shade not sent yet: a move asked before a stop does not leave after it.
A read silent for a second is cut to give it the way.

A stop is refused, or not sent, in these cases only:

- the shade is unknown to the integration (never listed by SOMA Connect, and
  not kept in `/data`), or no address of SOMA Connect is typed nor kept;
- a move of that shade asked **after** the stop was accepted by SOMA Connect
  meanwhile (that move is what you asked last);
- SOMA Connect cannot be reached, or answers an error, during 3.5 s (tried
  every 250 ms): the stop is then **kept** (also in `/data`) and sent again
  with the next reads (at least once a minute), 3 times at most; the status
  and the badge say so, and say when it is given up.

When the reads after a stop show the shade still moving, the stop is sent
again (3 times at most).

## Reads

- Every interval (60 s by default, 30 to 3600 s): the list of devices, then
  the position of each shade. Never sooner than the interval, except the reads
  after a command, even after a restart, a reconnection or the Test button.
- A shade out of Bluetooth reach of SOMA Connect is shown "not read" and its
  badge unreachable; the others go on.
- SOMA Connect unreachable: tried again after 30 s, 1, 2 then 5 min (never
  sooner than the interval). A "too many requests" (HTTP 429) or an error 5xx
  pauses the reads and the moves (1 min to 6 h, kept in `/data`); the pause
  does not hold a stop.
- A position is published only while it is recent; nothing old is published
  again as new.

## Limits

- One SOMA Connect, 32 devices at most.
- The light level of the solar panel is not read yet (its unit is not known).
- The type of a device (shade or Tilt) changed in SOMA Connect applies after a
  **Scan** in the Discovery tab.
- Never tested with a real SOMA Connect: the URL form of firmware 3 and later,
  the answers and the time SOMA Connect takes to answer are to be checked.
