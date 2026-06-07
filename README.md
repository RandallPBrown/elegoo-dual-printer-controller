# Printer Console

A single, self-contained web app that shows **both printers on one screen** with live
camera + heat stats overlaid, a **big red ABORT** per printer, and a clean control modal
(jog / temps / fans / speed) with **Files** and **Print History** tabs.

- **Printer 1 — Elegoo Centauri Carbon** @ `192.168.10.153` (Elegoo **SDCP** protocol)
- **Printer 2 — Elegoo OrangeStorm Giga** @ `192.168.10.119` (Klipper / **Moonraker**)

Zero npm dependencies. The values above are just defaults — **everything is editable in
the app** from the **Settings** page (gear icon, top right): printer IPs, names, drivers,
camera URLs, the Obico ML API address, the file-library folder, and more. Your changes
save to `config.local.json` and most apply live (printer connection changes rebuild that
printer on the fly; only a port/host change needs a restart). You never have to edit
`server.js`.

---

## Run it

```bash
node server.js
```

Requires **Node 20+** (Node 22 LTS or newer recommended — it uses Node's built-in
WebSocket, UDP, and HTTP, which is how it stays dependency-free).

Then open from any laptop on the network:

```
http://<the-server-ip>:8080
```

(Locally on the box itself: `http://localhost:8080`.) Stop with `Ctrl+C`.

---

## What you can control per printer

The two printers speak different protocols, so the controls differ. The UI greys out
anything a printer's API doesn't expose, so you only see buttons that actually work.

| Capability        | OrangeStorm Giga (Moonraker) | Centauri Carbon (SDCP) |
|-------------------|:---------------------------:|:----------------------:|
| Live camera + heat overlay | ✅ | ✅ |
| **Abort** print   | ✅ | ✅ |
| Pause / Resume    | ✅ | ✅ |
| Print speed       | ✅ | ✅ |
| Fan speeds        | ✅ (part fan) | ✅ (model / aux / chamber) |
| Files + History   | ✅ | ✅ |
| **Jog** (move axes) | ✅ | ❌ — not in the SDCP API |
| **Set nozzle/bed temp** | ✅ | ❌ — not in the SDCP API |

The Centauri's protocol (documented at <https://docs.opencentauri.cc/software/api/>) simply
has no move-axis or set-temperature command — Elegoo doesn't expose those over SDCP — so
those two sections are disabled on that printer. Everything else works on both.

Abort is intentionally a deliberate action: clicking it asks for confirmation first, then
sends Stop (SDCP `Cmd 130`) or Moonraker `print/cancel`.

---

## If something needs adjusting against the real hardware

I built the drivers from the published SDCP and Moonraker specs, but I couldn't test against
your actual printers. If a value looks off, every knob below is editable from the **Settings**
page in the app (gear icon) — you don't need to open `server.js`. (They also still live in the
`CONFIG` block at the top of `server.js` as the defaults, if you prefer.)

- **Centauri camera shows "No signal"?** The Centauri permits only **one** video stream at
  a time. If the ELEGOO app or slicer is open with the camera live, it owns that single slot
  and the console can't get a second one — the overlay will say so. Close the other viewer and
  the feed appears within ~5s. (The console shares one upstream across all laptops, so multiple
  laptops viewing the console at once is fine — it's only *other apps* that conflict.) The exact
  printer response is printed to the `node server.js` console if you need to dig further.
- **Giga shows OFFLINE (but the camera works)?** The Giga runs Klipper/Moonraker behind the
  Fluidd web UI. The console auto-detects Moonraker on either the port-80 path (same address
  Fluidd opens at) or `:7125` directly. If it still can't connect, open
  `http://<server>:8080/api/1/connection` — the `tried` list shows what each address returned:
  a **401/403** means Moonraker is refusing this machine (add the server's IP to
  `[authorization] trusted_clients` in `moonraker.conf`, or disable `force_logins`, then restart
  Moonraker); a **timeout** on both means neither path is reachable (set `moonrakerBase` in
  CONFIG to the exact URL Fluidd opens at). The offline reason also shows on the card itself
  (hover the status line for the full text).
- **Giga camera not showing?** The default is `http://192.168.10.119/webcam/?action=stream`
  (standard Klipper/crowsnest). If yours is on a different port, edit `webcamUrl`.
- **Giga chamber temp blank?** Set `chamberSensor` to match the `[temperature_sensor ...]`
  name in your `printer.cfg` (default `"chamber"`). If you have no chamber sensor, ignore it.
- **Centauri remaining-time looks 1000× off?** Flip `SDCP_TICKS_ARE_MS` (the firmware reports
  time in either ms or seconds depending on version).
- **Centauri won't connect?** It's found via a UDP broadcast (`M99999` on port 3000) to learn
  its mainboard ID. If your network blocks broadcast, set `mainboardId` directly on that
  printer's config entry (it's printed in the Elegoo app / discovery response).

That's it — no build step, no database, no services to install.

---

## How it's wired (for reference)

- `server.js` — the whole backend. A small driver per printer (`SdcpDriver`, `MoonrakerDriver`)
  normalizes each protocol to one common status shape, plus a shared **MJPEG hub** that opens
  **one** upstream camera connection and fans it out to every viewer (required, since the
  Centauri only allows a single video stream at a time).
- `public/index.html` — the entire UI (no framework, no external assets).

### Endpoints
- `GET /api/printers` — list + capabilities
- `GET /api/{id}/status` — normalized live status
- `GET /api/{id}/stream` — proxied MJPEG camera
- `GET /api/{id}/snapshot` — a single fresh JPEG still (used by the AI watchdog + alerts)
- `GET /api/{id}/files` · `GET /api/{id}/history`
- `POST /api/{id}/action` — `{ action: "pause"|"resume"|"abort"|"jog"|"home"|"setTemp"|"setFan"|"setSpeed", ... }`
- `GET /api/spaghetti` — aggregate watchdog state; `GET|POST /api/{id}/spaghetti[...]` per printer
- `GET /api/logs` — the master log buffer (the Logs modal polls this)

---

## B&B Ranch theme & The Forge

The UI is themed in the house colors (espresso brown, tan, whitewashed copper). The
OrangeStorm Giga shows as **The Forge** (set via `nickname` in `CONFIG.PRINTERS`).
You can give the Centauri a nickname too — there's a `nickname: null` slot on it
(e.g. `'The Anvil'`). The print-progress indicator is a **hand-swung hammer striking an
anvil** that travels along the bar as the job advances: the hand winds the hammer back and
swings it through a ~45° arc, **sparks fly off the impact**, and the **live percentage
rides up with the sparks** on each strike. It hammers while printing, rests when paused,
and hides when the printer is idle/offline.

## AI watchdog (both printers) & master Logs

- **AI spaghetti watchdog — both printers.** Each printer has its own **AI pill** and its
  own independent watchdog (Forge via Moonraker's snapshot, Anvil via a snapshot the
  console proxies off the shared camera hub). Alerts name the failing printer, attach a
  **photo**, and can carry a one-tap **Abort** button to your phone. See
  [`SPAGHETTI-SETUP.md`](SPAGHETTI-SETUP.md) — note the Anvil needs `CONFIG.SELF_BASE_URL`
  set, and the phone Abort button needs it too.
- **Logs** button in the header opens a live, filterable feed of AI / control / ntfy /
  printer / system events — "what just happened?" in one place.

## Filament (3DXTech)

The **Filament** button in the header opens a panel of real links into
3dxtech.com (Shop All, plus PLA / PETG / ABS / ASA / TPU / Nylon / Carbon Fiber /
Polycarbonate, the sale page, the 2026 catalog, rewards, and the drying guide).
They open in a new tab because their store (Shopify) blocks embedding.

## 3D Files library

The **3D Files** page browses a folder defined by `CONFIG.FILE_BROWSER.root`
(default `\\Chronos\Brain\3D Files`, or set the `FILES_ROOT` env var). It's read
**by the server**, so the laptops viewing the dashboard don't need access to the
share — only the machine running the console does. Features:

- Click folders to navigate; breadcrumbs jump back; a filter box searches the
  current folder.
- Thumbnails are generated automatically: image files are shown directly, and
  previews are extracted from `.gcode` (embedded slicer thumbnail) and from
  `.3mf` / `.zip` (embedded preview image). Models without a preview (`.stl`,
  `.step`, `.obj`, …) get a clean type icon.
- Click any file to preview it and **Download** it through the dashboard.

Path access is sandboxed to `root` (a `..` traversal is rejected).

**If you run the console as a Windows service (SYSTEM):** services can't see
mapped drives (Z:) and may not reach `\\Chronos\...` without credentials. Either
run it under an account that has share access, or point `FILE_BROWSER.root` at a
local path on the server (e.g. `D:\Brain\3D Files`).

---

## Update — lighting, file organizing, lighter theme

**Theme.** The palette is now light: a soft white/cream background with copper
accents (less of the dark earth tones). The video HUD stays dark-on-video so the
overlay text remains readable.

**Centauri = The Anvil, with lighting.** The Centauri is nicknamed *The Anvil*.
Open its **Controls** and you'll find a **Lighting** section (shown because the
SDCP driver reports the light capability): toggle the work light on/off, pick an
RGB accent colour, and use the presets (Off / Warm / White / Forge). These send
the SDCP `LightStatus` command (work LED + RGB). If your unit ignores the RGB
channel in firmware, the work-light toggle still works; the rest degrades quietly.

**Organizing the 3D Files library.** With `FILE_BROWSER.writable: true` (the
default) the 3D Files page can reorganize the share:

- **New folder** button in the toolbar.
- Each item has a **⋮** menu: Rename, **Move to…** (opens a folder picker so you
  can drop e.g. *Unsorted → Shop/Fasteners*), and Delete. Files also offer
  Preview/Download; folders offer Open.
- **Delete is safe.** It does *not* erase anything — it moves the item into a
  hidden `.trash` folder at the root of the share, so it's recoverable (just dig
  it out of `\\Chronos\Brain\3D Files\.trash`). `.trash` is hidden from the
  browser. Empty it yourself whenever you like.
- Moves refuse to drop a folder inside itself and won't clobber a same-named item.
- Set `FILE_BROWSER.writable: false` to make the page read-only again.

All write operations are sandboxed to the configured root and run on the server,
same as browsing — so this only works where the server account can write to the
share.
