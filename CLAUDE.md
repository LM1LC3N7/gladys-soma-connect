# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It drives SOMA Smart Shades and Tilt through the local HTTP API of SOMA
Connect (logic ported from pysoma, MIT).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/stop.test.js             # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png (800×534) in plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers before connect())
src/app.js                        SomaApp: lifecycle, reads, commands, stop, badges, status, test
src/soma/client.js                the five requests, the two URL forms, answer checks
src/soma/http.js                  one GET on node:http: deadline, size cap, beforeSend, cut
src/soma/errors.js                errors by kind, `sent` / `answered`
src/lane.js                       moves of one shade one at a time, bounded
src/devices.js                    answers -> Gladys devices, positions, ids (pure)
src/publisher.js                  states within 300/min
src/store.js                      /data/soma-connect-state.json
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       texts in English and French
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
scripts/cover.mjs                 generates cover.png
test/                             node --test: SDK fake Gladys, fake SOMA Connect on a clock that
                                  moves at every read, local HTTP server, real-clock test
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Safety rules of this integration

- A shade is a `shutter`, never `switch`/`binary`.
- Every position written is an integer 0..100 (checked in `src/devices.js` and
  again in `src/soma/client.js`).
- STOP is not put behind anything: no lane, no read, no option, through a pause
  and a backoff, before the first read (from /data); it cancels the moves not
  sent yet; retried within its 3.5 s, kept and resent once a minute by its own
  timer (3 at most), resent when the reads of 2 and 5 s contradict it. CLOSE
  goes the same way but is never kept. The docs list its refusal cases
  exactly: keep them true when changing the code.
- One reading of the clock per decision (`dueAt(mono)`), pacing on the
  monotonic clock; the tests use a clock that moves at every read, plus
  `test/realclock.test.js` (real time ×20).
- Sent within 3.5 s or refused; a request that may have left is never told
  "not sent"; the ack never waits for a publication to Gladys.
- Never read sooner than the interval except the reads after a command.
- Answers bounded (64 KB), parsed once, copied key by key; ids from the network
  are only Map keys, a MAC goes into a URL only after its strict check.
- No Bluetooth in this code: SOMA Connect keeps it.

## Rules

- **External ids are forever.** `gladys.externalIds('soma', mac)`, the MAC of
  `list_devices` lower case without separators; never a name nor an address.
  The same goes for every key users store: manifest `config_schema`,
  `actions`, feature keys.
- **A device published again never loses a feature** (`app.publishDevices`
  merges the features of `gladys.devices`).
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree (never a pinned value).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language. No config
  key starts with `gladys_`.
- **User-facing text** is bilingual (English and French), kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.1.
