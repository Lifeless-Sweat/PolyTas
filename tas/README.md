# PolyTrack TAS Tool

A portable, in-renderer TAS (tool-assisted speedrun) tool for **PolyTrack 0.6.2**
(Kodub's official Electron build). It runs entirely inside the game's window —
no separate control app, no cross-process IPC in hot loops — so it stays fast and
ports between game versions with copy-paste.

This is built in **phases** so each piece is testable before the next is added:

| Phase | Status | Contents |
|------:|:------:|----------|
| **1** | ✅ | Worker-tap capture backbone · live speed + per-wheel grip overlay · input editor with `tap` · leaderboard gate |
| **2a** | ✅ | Bruteforce — parallel **stock-worker pool**, **checkpoint** + **trigger-box** objectives, evolutionary search |
| **3** | ✅ this drop | **Savestate** — drive a run/replay from any frame **N** (upload blocked when N&gt;0) · TAS keybinds + options moved **into the game's own Settings page** · hotkey to open the game Settings **from anywhere** |
| 2b | later | Bruteforce **turbo** — custom worker with prefix snapshot + in-worker scoring (big speedup) |

> **Heads-up (Phase 3):** unlike Phases 1–2a, Phase 3 makes **two small edits to
> the game's own bundles** (the physics worker + one line in `main.bundle.js`) —
> the savestate genuinely can't work otherwise (see *Porting* / *How it works*).
> Backups `*.bundle.js.orig` are kept next to them; re-apply per version.

---

## Install (per game version)

1. Copy the whole `tas/` folder into the game's app directory (next to
   `index.html`, `main.bundle.js`, `simulation_worker.bundle.js`).
2. Add **one line** to `index.html`, immediately **before** the
   `error_screen.bundle.js` / `main.bundle.js` scripts in `<head>`:

   ```html
   <script src="tas/tas.js"></script>
   ```

   > It must be **before** `main.bundle.js` and **not** `defer`red — the tool
   > patches `window.Worker` and `XMLHttpRequest` before the game boots so it can
   > observe the physics worker and gate uploads.

That's the entire install. To **port to a new version**, copy `tas/` over and
re-apply that one line. See *Porting* below for the version-locked bits to check.

### Electron note
The shipped Electron `main.js` sets `webPreferences.devTools:false`. The tool
itself doesn't need devtools, but if you want to see its `[TAS]` console logs
while testing, temporarily set `devTools:true` in `electron/main.js`.

---

## Using it (Phase 1)

Hotkeys (all **rebindable** — see *Keybinds & settings* below — defaults shown):

| Key | Action |
|-----|--------|
| **F8** | Toggle the telemetry **overlay** (top-right) — works everywhere |
| **F9** | Toggle the **TAS panel** (viewer only) |
| **F10** | Toggle the **leaderboard upload block** (the "tainted" flag) |
| **F7** | **Reload** the viewed replay's inputs into the editor (viewer only) |
| **F6** | Open the **game's Settings page** from anywhere |
| **F5** | **Savestate** — drive this track from the replay's scrubbed frame (viewer only) |

> **The editor / Apply / Brute Force / Savestate work only inside the standalone
> Replays viewer** — open a leaderboard or PB replay via **Watch**; editing the
> script edits *that* replay. The **telemetry overlay** is the only thing that
> *also* works during live driving. (F8 / F6 / F10 work anywhere; F9 / F7 / F5
> are viewer-only.)

### Keybinds & settings
All TAS keybinds and options now live **inside PolyTrack's own Settings page** —
there is no separate TAS settings window. Open Settings (from the main menu, or
with **F6** from anywhere) and scroll to the **TAS Tool** section: every TAS
keybind is rebindable there (click the key button, press a key, `Esc` cancels),
alongside *Interface size · Speed units · Speed decimals · Panel layout · Remember
editor*. The panel's **⚙** button opens the same page. Settings persist across
reloads.

> **Interface size** scales the TAS overlay, panel, and in-run HUDs together
> (100 % – 200 %) — use it if the tool reads small on a high-DPI or large display.
> It takes effect live.
>
> **Speed decimals** (0 – 5, default 3) sets the precision of every speed readout —
> the TAS overlay **and the game's own speedometer** (bottom-center while driving),
> which normally shows only a whole number. Live, no reload.

> The game must reach its **main menu once** after launch so the Settings page
> can initialise; after that, **F6** opens it from anywhere (driving, replay,
> editor, …).

**Overlay** shows live speed (km/h — switchable to mph / m/s in Settings, at the
**Speed decimals** precision, default 3), current frame, steering,
next-checkpoint index, the held keys, and a **per-wheel grip bar** for FL / FR /
RL / RR (green = high grip, red = low; "air" when the wheel isn't touching the
ground). It follows the **active car** and is read
straight off the physics worker's `CarState` stream — the same numbers the
game's own debug HUD uses.

> **Telemetry in the replay viewer:** the overlay follows the replay you're
> **scrubbing** (speed / frame / steering / per-wheel grip at the current frame)
> as well as live driving — it reads the focused replay's stored `CarState` at
> the scrub frame via a viewer hook.

**Panel layout** — the panel is **resizable from any edge or corner** (grab an
edge — the cursor changes; the bottom-right corner has a grip) and its body
scrolls, so it can't push content off-screen; size + position are remembered. **⚙ Settings → Panel layout** switches between **Tall** (vertical)
and **Wide** (horizontal) arrangements.

**Panel → Input editor** — type directly into the editor (one entry per line):
- `frame,keys` — set the held keys from that frame on. Keys are `w a s d r`
  (forward, left, brake, right, reset). Empty keys = release everything.
- `tap START END KEYS ON OFF` — between `START` and `END`, alternate **`KEYS`**
  for `ON` frames and the **previous state** for `OFF` frames. The tapped keys
  must *differ* from what's held just before `START`, or nothing changes. Example
  — hold W, then tap the **D** (right) key 10 frames on / 5 off:

  ```
  0,w
  tap 1500 1700 wd 10 5
  2000,w
  ```
  (At 1500 it holds `wd`; for 5 frames it drops back to `w`; repeat — i.e. it taps
  the right key while keeping the throttle. If the line before were `1200,wd`, the
  "previous state" would be `wd` and the tap would do nothing — a common mistake.)
- `# ...` — comment.

The editor is **bound to the replay you're viewing** — opening a replay loads its
inputs into the editor automatically. Buttons: **Reload replay** (re-load the
viewed replay's inputs, discarding edits), **Compact** (shrink the script: dedupe
+ fold alternating inputs back into `tap` macros), **Stats**, **Copy**,
**Save**/**Load file** (`.tas`), **Clear**. **⚙** opens the game Settings.

**Apply → replay** re-simulates the **replay you're viewing** with your editor
inputs: edit the loaded script, press **Apply → replay**, and the viewer reloads
and plays your edited replay back. (It hands the game a copy of the loaded
records with the focused replay's recording replaced by the editor's compiled
recording, and re-enters the viewer so it preloads + re-simulates it.)

> Physics runs at a fixed **1 ms / frame (1000 fps)**, so "frame" numbers are
> milliseconds of run time.

---

## Savestate (Phase 3)

Launched **from the replay viewer**: drop into **live driving** of the same track
starting at an **arbitrary frame N** of the replay you're watching — practice the
back half of a track without re-driving the front, or hand-finish a TAS'd opening.
The panel's **Savestate** section:

1. Open a replay (**Watch**) and scrub to the frame you want to take over at.
2. Click **Use scrub frame** (fills **Frame N**), then **Drive from frame N**
   (or press **F5**).
3. The tool leaves the viewer, starts you driving the same track, and the car
   **fast-forwards** the prefix `[0..N)` — the editor script, so your edits count
   — then hands you live control exactly at frame N.

> **How it's possible:** the physics worker can't seed a moving car's velocity,
> so the prefix is genuinely **re-simulated** (our worker patch fast-forwards it
> in a few frames, not in real time), then the *same* car switches from the
> recorded inputs to your keyboard. Everything before N is replayed identically;
> everything after N is you.

**Leaderboard safety:** a run started at **N&gt;0 is tainted** — the upload is
**blocked** (the overlay border turns red, the panel's *Upload block* shows ON),
while the **local PB + ghost still save** normally. N=0 is just a clean run from
the start and uploads as usual. After a savestate run, toggle the upload block
**off** (F10) when you want to set a real time again.

## Brute Force (Phase 2a)

Open the panel (**F9**) and expand **Brute Force**. It spawns a pool of the
game's own physics workers and searches in parallel for inputs that best meet an
objective. You **must enter a track and drive once first** so the tool has
captured the track data.

**Pick an objective:**
- **Checkpoint / Finish** — reach the **Target** as early as possible. Target is
  either `finish` or a number = *how many checkpoints to pass* (`1`, `2`, …).
- **Trigger boxes** — drive the car **through one or more boxes in order**. Each
  box is a small card: **center** X/Y/Z on one row, **size** X/Y/Z on the next,
  and a **no-go** toggle + **Remove**. Add boxes by hand or click **+ at car** to
  drop one at the car's current spot (works while driving **or** scrubbing a
  replay). The **dist ↔ speed** slider blends *reach the box early* vs *carry speed
  at the box*.
  - **3D view** — boxes are drawn **in the game's own 3D scene** as a cyan
    wireframe (green when the car is inside), always-on-top (x-ray). Toggle with
    *Draw boxes in the game's 3D view*. This is done by recovering the camera
    from THREE's shader uniforms and projecting onto an overlay — a best-effort
    hook; if a future build's shaders differ it silently falls back to the map.
  - **Minimap** — a top-down (X→ / Z↑) view under the boxes also draws each box +
    the live car + a long trail, with a per-box `distance / INSIDE / speed`
    readout.

**Search range** — `Start frame` / `End frame` is the `[start, end)` window the
search is allowed to change; everything outside it is kept exactly as the base.
`Check frame` caps how far each run simulates (blank = auto). **Base** is either
your editor script or your current run. **Keys** is the comma-list of key-sets
the search may use (`w, wa, wd, none`). **Workers** defaults to your CPU cores − 1.

**Edit `tap` macros** — tick *Edit `tap` macros as units* to search **tap
parameters** instead of expanding the tap into raw frames: the bruteforce nudges a
tap's **start / end / keys / hold (on) / release (off)** (e.g. `tap 1000 2000 w 1 1`
→ `tap 1010 2000 w 1 1` or `… 1000 2010 …`). Give each of the five parts its own
**weight** (0 = never touch that part). *Off* = expand and freely edit every frame
(the default); *on with all five weights 0* = **protect** the taps (keep their
pattern, optimize only around them). Only taps that sit fully inside the
Start/End window are edited, and the best is written back **as `tap` macros**.

Click **Start BF**. The **New Bests** log + **Best** line update as it improves,
and a **live stats** panel shows *state · best score · runs · runs/sec · elapsed ·
since-best · workers busy · pending · iters left · horizon* so you can see how the
search is progressing at a glance. **Apply best → editor** drops the winning
inputs into the editor.

> **Speed note (why 2b exists):** the stock worker re-simulates from frame 0 on
> every variant, so optimizing a *late* section of a long track is slower than it
> should be. Keep the search window tight and the Check frame reasonable. Phase 2b
> replaces this with a custom worker that snapshots the prefix — a big speedup.

---

## Phase 2a — what to verify in-game

1. **Setup** — drive a track once (so track data is captured), then expand
   **Brute Force**. With objective **Checkpoint/Finish**, target `finish`, a
   sensible window (e.g. `0`–`2000`), click **Start BF**. The pill should show a
   rising run count and **New Bests** should populate; **Best** shows
   `reached @f…`. Lower frame = better.
2. **Apply** — click **Apply best → editor**; the editor fills with the best
   inputs. (Verifying it *drives* in-game is Phase 3.)
3. **Triggers** — switch to **Trigger boxes**, drive to a spot, **+ at car**,
   then Start. Best should progress `box 1/1 …` → `all 1 boxes …`. Slide
   dist↔speed and confirm the chosen best changes character.
4. **Sanity** — Start/Stop toggles cleanly; bad inputs give a clear status
   message (empty run base, no trigger, bad target) instead of doing nothing.

---

## Phase 1 — what to verify in-game

1. **It loads** — open the game; F9 shows the TAS panel, F8 shows the overlay.
   The panel's *capture* row should read **"sim worker attached ✓"** once you
   enter a track.
2. **Telemetry streams** — drive a track. Speed, frame, steering, checkpoint and
   the four grip bars should update smoothly. Compare speed against the game's
   own speedometer — they should match.
3. **Grip sanity** — wheels off the ground read "air"; drifting/locking a wheel
   drops its grip bar.
4. **Extract run** — drive, then click **Extract run** (or press **F7** anywhere
   to copy it to the clipboard). You should get `frame,keys` lines matching what
   you did. **Compact** then folds repeated alternations into `tap` macros.
   Open **⚙ Settings** and try rebinding a key (e.g. overlay → `Q`) and switching
   units to mph — both should take effect immediately and survive a reload.
5. **Upload gate** — press **F10** (button shows "Upload block: ON", overlay
   border turns red). Set a (slow, throwaway) PB on a track while blocked: the
   local best/ghost should still save, but **no leaderboard entry appears**.
   Turn it **OFF** and confirm a normal run *does* upload. (Use a sandbox/custom
   track to avoid polluting a real board while testing.)

If any step fails, tell me what you saw — the likely culprits are the worker
filename, the message field names, or the `CarState` layout, all of which are
isolated and easy to adjust.

---

## How it works (and why it ports well)

The tool never depends on minified webpack identifiers (which change every
build). It anchors only on **stable wire contracts**:

- **Capture** wraps `window.Worker`; when the game creates
  `simulation_worker.bundle.js` it taps that instance's `postMessage`
  (to learn the track context) and `message` events (to read the live
  `CarState` stream). Messages are recognised by **field shape**, not the
  numeric `messageType` enum.
- **CarState** is parsed from the worker's 227-byte buffer with a hand-written
  port of the game's decoder (the layout is variable-length; only the prefix is
  fixed-offset, so it's walked sequentially). Wheel order is `[FL, FR, RL, RR]`;
  grip is `wheelSkidInfo`.
- **Recording** codec (5 toggle channels → zlib → base64url) is byte-compatible
  with the game's, implemented with the browser-native `CompressionStream`
  (zero third-party code).
- **Upload gate** drops the `POST` to `ptproxy.cwcinc.dev/.../leaderboard` (and the
  `fetch` equivalent) while `window.__TAS_tainted` is set, synthesising a clean
  empty response. Local saving happens before the network call, so PBs/ghosts
  are unaffected.
- **Input shield** — the game's W/A/S/D handlers `preventDefault()` on those
  keys, which would swallow them when you type in the editor (and drive the car).
  A capture-phase key listener installed before the game `stopPropagation()`s
  events targeting the TAS UI, so the field types normally and the car stays put.

## Porting checklist (version bump)

Most of the tool is version-specific only in **`tas/tas.js`** near the top / in
the marked sections:
- `GAME_VERSION` constant (the game/worker assert this string).
- `SIM_WORKER_FILE` (the physics worker filename).
- The `CarState` field layout in `parseCarState` (re-verify offsets if Kodub
  changes the car model — only matters if the byte layout changes).
- The leaderboard host/path match in `TAS.gate.isSubmitUrl`.

If physics changes (new car, new fields), the determinism shim and struct
layout used by the Phase-2 bruteforce worker also need a re-check; the tool
will self-validate and warn when that lands.

### Phase 3 game-bundle edits (re-apply per version)
Two small, surgical edits to the **game's own bundles** make the savestate +
settings features possible. Backups (`*.bundle.js.orig`) sit next to them; the
edits are anchored on stable strings, so re-applying after a version bump is a
find-and-replace.

1. **`simulation_worker.bundle.js`** — adds a *drivable car with a recording
   prefix*. Three insertions, all keyed off `tasSwitchFrame`:
   - `CreateCar`: when `carRecording` **and** `tasSwitchFrame` are present, also
     build a live `userControls` buffer (so the car is drivable after the prefix).
   - the car record carries `tasSwitchFrame`.
   - the **realtime loop** fast-forwards such a car through `controls.getControls`
     up to `tasSwitchFrame` (budgeted ~4000 frames/tick), then skips it in the
     wall-clock loop until it reaches `tasSwitchFrame`, after which it reads
     live `userControls`. (The flat-out loop / bruteforce path is untouched.)
2. **`main.bundle.js`** — **three inserted statements** exposing live objects on
   `window` (no behaviour changed), **plus one speedometer-precision hook**:
   - the **settings factory** in the main-menu builder, right after the settings
     button's `<img src="images/settings.svg">`, exposing
     `window.__TAS_settings = { make:(parent,onClose)=>new <SettingsScreen>(parent, …deps…, onClose), … }`.
     `openGameSettings()` uses it to open the real Settings page from anywhere.
     Anchor: `x.innerHTML='<img src="images/settings.svg">',x.addEventListener("click",`.
   - the **replay-viewer enter/drive + track context**, at the router's
     enter-viewer callback (right after `$=new cg(...)`), exposing
     `window.__TAS_view = { enter, drive, trackMeta, trackData, category, records }`
     (`enter` re-enters the viewer = re-simulate; `drive` starts driving the same
     track). `Apply → replay` calls `enter(...)` with the focused record's
     recording swapped; **Savestate** calls `drive(...)`. Anchor:
     `$=new cg(A,w,e,t,n,y,b,d,l,S,r,i,((e,t,n,i)=>{J(e,t,n,i,null)})),I.PM(),I.tU()`.
   - the **viewer state getter**, at the start of the preview-viewer
     `cg=class{constructor(...){`, exposing `window.__TAS_viewState()` →
     `{ frame: round(1000*qp), state: jp[Hp].replay.getFrame(frame), focus, count }`
     (current scrub frame + focused replay `CarState`). Powers telemetry-in-viewer
     and the savestate frame. cg fields: `jp` records, `Hp` focus, `qp` time (s).
   - the **speedometer-precision hook** (for the *Speed decimals* setting): the
     game speedometer's `update()` shows a truncated integer; the number formatter
     `const n=Math.trunc(t).toString()` is changed to emit
     `t.toFixed(window.__TAS_speedDecimals)` when that global is set (`tas.js`
     mirrors the setting onto it). Falls back to the stock integer when unset, so
     it's harmless without the tool. Anchor: `const n=Math.trunc(t).toString();if(n!=`.

The savestate prefix is injected on the renderer side (no game edit) by
`onOutbound` in `tas.js`, which rewrites the player `CreateCar` (`carRecording`
+ `tasSwitchFrame`) when a savestate is armed. The TAS keybind/option rows are
injected into the live Settings DOM by a `MutationObserver` (no game edit).
