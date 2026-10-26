# Third-party notices

This integration ports to JavaScript the knowledge of the HTTP API of SOMA
Connect held by the projects below. No file is copied, and nothing of them is
installed at runtime.

## pysoma

<https://github.com/ratsept/pysoma> (master branch, commit f1b5674 of
2025-07-21; `setup.py` 0.0.13, 0.0.14 on PyPI), by Wazombi Labs OÜ, the maker
of SOMA, the library of the Soma integration of Home Assistant. Ported: the
requests `list_devices`, `get_shade_state`, `get_battery_level`,
`set_shade_position` and `stop_shade`, as GET requests on port 3000, and the
two URL forms (`?mac=` for firmware 3, `/<mac>` before), chosen on the major
version that `list_devices` gives. Its `LICENSE` file:

```
Copyright (c) 2019 Wazombi Labs OÜ

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, `soma` integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/soma>
(dev branch, read on 2026-10-26), by the Home Assistant authors, under the
Apache License, Version 2.0, the same licence as this repository, whose full
text is in the `LICENSE` file (copied into the image). Taken from it, as
knowledge only: the meaning of the positions (a shade at 0 is open; a Tilt
gives the magnitude of its position and `closed_upwards` when its slats close
upwards), the `type` of `list_devices` (missing before Connect 2.2.6: a shade),
the `result` field that says success, and the battery reading
(`battery_percentage`, else `battery_level` where 360 is empty and 410 full).
