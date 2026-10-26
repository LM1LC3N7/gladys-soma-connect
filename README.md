# gladys-soma-connect

[Gladys Assistant](https://gladysassistant.com) external integration for
**SOMA Smart Shades** and **SOMA Tilt** motors, through the local HTTP API of
the **SOMA Connect** bridge: each shade becomes a Gladys shutter of the
Discovery tab (open, close, stop, position, battery). Gladys only speaks HTTP to
SOMA Connect on the local network (port 3000); the Bluetooth link to the shades
stays inside SOMA Connect. No account, no cloud. Unofficial, not affiliated
with SOMA (Wazombi Labs).

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Development version.** Tested against a simulated SOMA Connect only: it has
> never been tested with a real SOMA Connect yet. Feedback and bug reports are
> welcome in the [GitHub issues](https://github.com/LM1LC3N7/gladys-soma-connect/issues).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SomaApp) ⇄ src/soma/client.js ⇄ GET http://<soma-connect>:3000/...
                                   ├─ src/lane.js       moves of one shade one at a time (4 waiting at most)
                                   ├─ src/devices.js    answers -> Gladys devices, positions, ids (pure)
                                   ├─ src/publisher.js  states within 300/min
                                   └─ src/store.js      /data: address, firmware, shades, pause, stops kept
```

- **Protocol** (pysoma, MIT, by the maker): `list_devices`, `get_shade_state`,
  `get_battery_level`, `set_shade_position`, `stop_shade`, as GET requests
  answered in JSON (`result: "success"`). Firmware 3 and later take
  `?mac=<mac>&pos=<pos>`, older ones `/<mac>/<pos>`; unknown firmware: the
  path form, then the query form after a 404 (nothing done).
- **Devices**: one `shutter` per device (`state` write-only, `position` 0 closed
  .. 100 open, `battery` %), never a `switch`. Shade: Gladys = 100 − SOMA; Tilt:
  Gladys = 100 − |SOMA| (closed upwards reads as closed); a command is always
  SOMA = 100 − Gladys, an integer 0..100 checked again in the client. Identity
  rule (it fixes the external ids): the MAC address of `list_devices`, 12
  lower-case hexadecimal digits; `ext:<selector>:soma:<mac>`.
- **Commands**: a move goes through the lane of its shade, sent within 3.5 s of
  its arrival or refused; shades move side by side (a scene of five shades
  sends the five). The ack means "accepted by SOMA Connect"; the position is
  confirmed only by a read of it (follow-up reads at 2, 5, 20, 45, 90 s; a
  read equal to the position before is "not applied yet"; not reached: badge
  and status). STOP takes no lane, needs no read, goes through a pause and a
  backoff, works before the first read (from `/data`), cancels the moves not
  sent yet, cuts a read silent for 1 s (its connection closed first), is tried
  again every 250 ms within 3.5 s, then kept in `/data` and sent again with the
  next reads (3 times at most), unless a newer move was accepted; a stop the
  reads contradict is sent again (3 times at most); a move that was leaving is
  followed by a second stop.
- **Reads**: `list_devices` then each shade (4 at a time) every interval (60 s
  by default, 30 to 3600 s), the battery at most once an hour; never sooner
  than the interval otherwise (Test button, scan, reconnection, unchanged
  save, restart: the last read time is kept in `/data`, written before the
  reads at most once a minute). Two clocks: the wall clock for `/data`, a
  monotonic one for the pacing, the pauses, the deadlines and the freshness.
- **Failures**: 429/5xx -> a pause of 1 min to 6 h kept in `/data` (stop goes
  through); anything else -> 30 s, 1, 2, 5 min, never sooner than the interval;
  one shade out of Bluetooth reach never holds the others. The configuration
  of Gladys not read at the start is tried again (5 s doubled up to 5 min) with
  a status.

## Development

```bash
npm install
npm test             # node --test: fake Gladys, fake SOMA Connect, local HTTP server
npm run lint
npm run format:check
npm run cover        # cover.png (800×534) in plain Node
```

See [CLAUDE.md](CLAUDE.md) for the project rules and [TODO.md](TODO.md) for the
decisions and what is left.

## License

Apache-2.0 (see [LICENSE](LICENSE)); ported logic under MIT (pysoma) and
Apache-2.0 (Home Assistant), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
SOMA is a trademark of Wazombi Labs OÜ; this project is not affiliated with
Wazombi Labs.
