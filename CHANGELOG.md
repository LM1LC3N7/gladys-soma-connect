# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- SOMA Smart Shades and SOMA Tilt through the local HTTP API of SOMA Connect
  (port 3000, no account, no cloud; the Bluetooth link stays inside SOMA
  Connect): each device is a shutter of the Discovery tab with open, close,
  stop, its position and its battery. Never a switch.
- Both URL forms of SOMA Connect (firmware 3 and later, and older ones),
  chosen from the version it gives.
- Moves sent within 3.5 s or refused, one at a time per shade and side by side
  across shades; positions bounded to 0..100; a position confirmed only by a
  read of it, a position not reached shown on the badge and in the status.
- Stop that goes first: no queue, no read, through a pause, before the first
  read (from `/data`), cancelling the moves not sent yet, cutting a silent
  read, tried again within 3.5 s, then kept and sent again by the next reads
  (3 times at most), and sent again when the reads show the shade still moving.
- Reads never sooner than the interval (also after a restart), the battery at
  most once an hour; pauses after a 429 or a 5xx; the configuration of Gladys
  read again while it fails.
- Documentation in English and French.

[Unreleased]: https://github.com/LM1LC3N7/gladys-soma-connect/commits/main
