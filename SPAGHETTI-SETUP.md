# AI spaghetti watchdog — setup & usage

The watchdog lives **inside `server.js`**. While the Giga prints it scores the camera
snapshot through a self-hosted Obico ML API and, depending on **mode**, alerts you and/or
cancels the print. Everything is driven from the **AI pill** on the Forge's card (next to
Abort) — tap it to open the settings panel.

You only have to do one new thing to turn it on: **stand up the ML API container** and
point the console at it.

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
  urgent priority, and a ⚠️ icon so they stand out on your lock screen.
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
- `GET /api/spaghetti` — current state (the pill polls this)
- `POST /api/spaghetti/settings` — `{mode, schedule, thresholds, ignoreZones, notify}`
- `POST /api/spaghetti/reset` — clear an alert
- `GET /api/spaghetti/probe` — snapshot + raw detections (used by Calibrate)
- `POST /api/spaghetti/test-notify` — fire a test ntfy push

Auto-cancel always reuses the Giga's existing Moonraker cancel — the **same** call as the
Abort button. It never sends M112, and it never cancels on an error or a stale frame.
