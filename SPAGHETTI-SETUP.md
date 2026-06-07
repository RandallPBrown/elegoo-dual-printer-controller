# AI spaghetti watchdog — setup & usage

The watchdog lives **inside `server.js`**. While a printer prints it scores the camera
snapshot through a self-hosted Obico ML API and, depending on **mode**, alerts you and/or
cancels the print. Everything is driven from the **AI pill** on each printer's card (next
to Abort) — tap it to open that printer's settings panel.

**Both printers can be watched at once.** There is now **one independent watchdog per
printer** — the Forge (OrangeStorm Giga, Moonraker) *and* the Anvil (Centauri Carbon,
SDCP). Each has its own mode, sensitivity, dead zones and state, and each alert names the
printer that's failing and carries a **photo of that printer** plus a one-tap **Abort**
button (see *Phone alerts with a photo + remote Abort* below). The Forge ships in
**Notify** as before; the **Anvil ships `off`** so nothing arms unexpectedly — open its AI
pill and switch it to Notify/Auto/Schedule when you're ready.

You only have to do one new thing to turn it on: **stand up the ML API container** and
point the console at it.

> **One Obico server handles both printers — you do not need a second one.** The ML API is
> stateless: it just scores whatever image it's handed, so the single box at
> `192.168.10.168:3333` watches the Forge *and* the Anvil at once.
>
> **The Anvil needs no manual setup.** The Centauri (SDCP) has no direct snapshot URL the
> way the Giga does, so the console exposes the frame itself at `/<console>/api/0/snapshot`
> (it grabs a still off the shared camera hub, so it never knocks out the live feed). The
> console **auto-detects its own LAN address** and hands that to the ML API, so as long as
> the Obico box is on the same network it just works — nothing to configure. (You only need
> to set a **Public URL** in **Settings** if you want the phone *Abort* button to work from
> *outside* your home network; on your own wifi the auto address already covers it.)

---

## 1. Stand up the model (one-time, on a Linux box / VM)

The ML API is a Linux Docker container. Windows Server 2016 can't run Linux containers
(no WSL2 — that's 2019+), so run it on a spare Linux machine / mini-PC, or a small Hyper-V
Ubuntu VM (2 vCPU, 4 GB RAM) on an **External** switch so it gets a LAN IP.

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/nvtkaszpir/3d-print
cd 3d-print/obico-ml-api-only
docker compose up -d        # ~3 GB image; first pull takes a bit
```

It listens on **:3333**. Note the box's LAN IP, then test it:
```bash
curl "http://<that-ip>:3333/p/?img=https://bagno.hlds.pl/obico/bad_1.jpg"
#  -> [["failure", 0.50, [758, 969, 113, 160]], ...]
```
> If the pull gives an arch you can't run, set an `amd64` tag from
> https://quay.io/repository/kaszpir/ml_api?tab=tags in the compose file. Fallback: the
> full Obico server (github.com/TheSpaghettiDetective/obico-server) ships amd64.

## 2. Point the console at it

In `server.js`, edit the `SPAGHETTI` block in CONFIG:
- `mlApi` → `http://<that-ip>:3333`
- confirm `snapshotUrl` returns ONE JPEG in a browser
  (`http://192.168.10.119/webcam/?action=snapshot`; if your stream is on `:8080`, the snapshot is too)
- (optional) `notify.ntfyTopic` → your ntfy URL for phone push. You can also set this
  **straight from the UI now** (AI pill → Notifications → *ntfy topic URL*), so editing
  CONFIG is no longer required — whatever you type there is saved and survives a restart.

Restart: `node server.js`. The AI pill turns from "error" to "idle/watching".

---

## Modes (the AI pill → Mode)

| Mode | What it does |
|------|--------------|
| **Off** | Not watching. |
| **Notify** | On a confirmed failure it **alerts you** (browser pop-up, phone, red border on the feed) but **never cancels** — you hit Abort. |
| **Auto** | On a confirmed failure it **auto-cancels** the print (same cancel as the Abort button). |
| **Schedule** | **Auto-cancels during the night window**, **notify-only the rest of the day.** |

This is your arm/disarm: **Notify/Off = disarmed-ish**, **Auto = armed**, **Schedule =
armed only overnight.** Your choice is saved to `spaghetti.settings.json` and survives a
restart. The default ships as **Notify** (safe) — switch to Schedule/Auto once you trust it.

### The day/night flow you asked for
Set mode to **Schedule** and pick the window (default **22:00 → 07:00**). During the day it
just pings you so you can decide; overnight while you're asleep it cancels on its own.

## Notifications (AI pill → Notifications)

- **Phone (ntfy)** — the reliable one. Paste an ntfy topic URL right in the panel
  (e.g. `https://ntfy.sh/my-forge-alerts`), install the free ntfy app, subscribe to that
  exact topic, then hit **Send test**. This fires from the **server**, so it reaches your
  phone even when no browser tab is open anywhere — and alerts now carry a title, a high/
  urgent priority, and a ⚠️ icon so they stand out on your lock screen. The topic is
  **per printer** (each watchdog has its own), so you can route the Forge and the Anvil to
  the same topic or to different ones.

### Phone alerts with a photo + remote Abort
Every failure alert now includes:
- **A fresh photo of the failing printer** (a JPEG grabbed at the moment of the alert),
  so you can glance at your lock screen and judge whether it's a real fail.
- **The printer's name** in the title (e.g. *"Failure detected — The Anvil"*), so you
  always know *which* machine tripped.
- **Action buttons** — **Abort print** (cancels that exact printer, the same call as the
  Abort button) and **Open console**. These need your phone to be able to reach the
  console's web address, so they only appear when **`CONFIG.SELF_BASE_URL`** is set to a
  phone-reachable URL (a public URL / port-forward, a VPN/Tailscale address, etc.). The
  **Send test** button also pushes a photo + buttons so you can confirm the whole pipeline.

  > **Security note:** if `SELF_BASE_URL` is a public URL, the `/api/<id>/action` endpoint
  > the Abort button posts to is **unauthenticated** — anyone with the notification (or the
  > URL) could cancel a print. Put the console behind a VPN or a reverse proxy with auth if
  > that matters to you. Leave `SELF_BASE_URL` unset and alerts still arrive with the photo,
  > just without the one-tap Abort button.
- **Browser** — a Chrome pop-up + the affected feed gets a pulsing **red border** and the
  tab title flashes. *Important limitation:* the browser's Notification API only works in a
  "secure context" — that means **on the server PC itself** (`localhost`) or over **HTTPS**.
  Opening the console from another laptop over plain `http://<ip>:8080` will **silently fail
  to grant permission**, which is why this never worked from your laptops. Use **Phone
  (ntfy)** for alerts that actually reach you off-machine.
- **Sound** — optional beep on alert.

When a failure fires in Notify mode you'll see the red border + "⚠ Failure — stop print"
banner on the Forge's video; open the page and hit **Stop the print now** (or Abort on the
card). Tap the pill → **Reset alert** to clear a false alarm.

## Calibrate & dead zones (AI pill → Calibrate)

The **Dead zones** section of the AI menu now shows them **on the live snapshot** (green
boxes) instead of as a plain list — hover any box to see its center and size, or tap its
white **×** to delete it. To *add* a zone, open **Calibrate**.

Calibrate shows the **live snapshot** with the model's current detections (red boxes) and
your dead zones (green dashed). **Drag a box** over anything that falsely trips it — the
gantry rails, the drag chain, a glare spot — then **Save dead zones**. Anything centered in
a dead zone is ignored. Tap a white **×** to remove a zone. Dead zones are saved and persist.

## Sensitivity (AI pill → Sensitivity)

- **Tripped frames in a row** — how many bad frames before it acts (default 4 ≈ 100s at a
  25s poll). Higher = fewer false alarms, slower to catch a real fail.
- **Frame score / Single-box confidence** — lower = more sensitive.

Watch it in **Notify** first; the server log prints `[spaghetti] TRIP 2/4 sum=0.83 ...` so
you can tune before arming.

---

## Multi-zone bed + multiple extruders

The Forge's card now shows **every bed zone and every extruder** the printer reports
(T0…T3, Bed 1…4), auto-discovered from Klipper. Only the extruders that exist appear, so
adding a second/third tool later makes more chips show up automatically. The **Controls →
Temperatures** panel now matches: it lists a Set/Off row for *each* discovered heater
(Nozzle T0, Nozzle T1, Bed 1, Bed 2, …) instead of a single nozzle/bed, and each row drives
that exact heater via Klipper's `SET_HEATER_TEMPERATURE`. On first query the
server logs what it found:
```
[moonraker] heaters discovered - nozzles: extruder | beds: heater_bed, heater_generic bed_2, ...
```
If a zone is missed or misnamed, hard-set the names in the Giga's CONFIG block
(`extruders` / `bedHeaters`).

## Endpoints (for reference)
The watchdog routes are **per printer** now (`<id>` is the printer index — `0` = Anvil,
`1` = Forge):
- `GET /api/spaghetti` — **aggregate** state for all printers: `{ watchers: [ … ] }` (the
  pills poll this)
- `GET /api/<id>/spaghetti` — one printer's state
- `POST /api/<id>/spaghetti/settings` — `{mode, schedule, thresholds, ignoreZones, notify}`
- `POST /api/<id>/spaghetti/reset` — clear that printer's alert
- `GET /api/<id>/spaghetti/probe` — snapshot + raw detections (used by Calibrate)
- `POST /api/<id>/spaghetti/test-notify` — fire a test ntfy push (with photo + buttons)
- `GET /api/<id>/snapshot` — a single fresh JPEG still from that printer's camera
- the old un-indexed `/api/spaghetti/*` routes still work and target the Giga.

Settings persist to `spaghetti.settings.json` as `{ "byPrinter": { "0": {…}, "1": {…} } }`
(an older single-watchdog file is migrated onto the Giga automatically).

Auto-cancel always reuses that printer's existing cancel — the **same** call as the Abort
button. It never sends M112, and it never cancels on an error or a stale frame.

## Master Logs (header → Logs)
The **Logs** button in the header opens a filterable feed that aggregates what the console
sees: **AI** watchdog activity, **Control** actions, **ntfy** pushes, **printer** connect/
disconnect notes, and **system** output.

By default the feed is **idle** — only **critical** events are kept in the background
(errors, warnings, aborts, AI alerts/auto-cancels, ntfy sends/failures, printer connection
drops). Routine/info chatter is **not** captured and the page does **not** poll until you
press **Start live feed**; press it again (or close the panel) to stop. This keeps the logs
from "constantly running" while still always recording the things you'd want after the
fact. Filter by source with the chips; newest is at the bottom. It's an in-memory ring
buffer, so it resets on server restart — it's for "what just happened?", not history.
(`GET /api/logs`, `POST /api/logs/live {on}`.)
