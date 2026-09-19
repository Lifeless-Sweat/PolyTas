# TAS Tool — AI context / internals (newer version)

Orients an AI assistant working on this PolyTrack TAS tool. Companion docs:
[README.md](README.md) = how to *use* it; [TASBOARD.md](TASBOARD.md) = the
community-leaderboard (Supabase) setup. **This** file = how it's *built*, so you
can edit it safely.

> **Primary edit target:** [tas.js](tas.js) — one self-contained ~2600-line IIFE.
> The tool also relies on small edits to two **game** bundles (§ 12) and to
> `index.html` / the Electron layer, all outside `tas/`.

> **Scope note:** §§ 1–10 + 12 (the portable core, wire contracts, CarState,
> recording, gate, shield, savestate, game-bundle edits) are documented in full and
> are shared with the base tool. The **newer-only features** — the native TAS
> **board / leaderboard twin**, the **positions HUD**, **simulate-finish**, and the
> **island/snapshot bruteforce** — are summarized (§ 11, § 13) with pointers to the
> code + TASBOARD.md rather than exhaustively reverse-documented. Read the code for
> their exact internals before touching them.

---

## 1. What this is

A portable, **in-renderer** TAS tool for **PolyTrack 0.6.2** (Kodub's Electron
build). Runs entirely inside the game window — no separate app, no cross-process
IPC in hot loops. Design goals, in priority order:

1. **Zero dependence on minified webpack identifiers** (they change every build).
   Anchors only on **stable wire contracts** — see § 3.
2. **Self-contained & copy-pasteable** — no imports, no build step.
3. **Phased** — each capability testable before the next.

### Feature status
| Area | State | Notes |
|------|:-----:|-------|
| Capture backbone · telemetry overlay · input editor (`tap`) · leaderboard gate · input shield | ✅ | Portable core (§§ 3–10) |
| Bruteforce — parallel worker pool, **trigger-box objective** (boxes only; put one on the finish line), **island/population** evolutionary search, **snapshot** (prefix-skip) mode | ✅ | § 11 |
| **Savestate** — drive a run from any frame N; `ssSet`/`ssReturn` set/return-to a live position | ✅ | § 8 |
| TAS settings inside the game's own Settings page | ✅ | § 14 |
| **Native TAS board** (Supabase) + **leaderboard twin** docked by the real board; **positions HUD**; **simulate-finish → upload** | ✅ | Newer-only; § 13 + [TASBOARD.md](TASBOARD.md) |
| **UI scale**, **speed decimals** (overlay + game speedometer), **trigger-box cards**, **BF live-stats** | ✅ | Ported in (§ 18 changelog) |

---

## 2. File & integration map

Inside `tas/`: **`tas.js`** (the whole tool), **`README.md`**, **`TASBOARD.md`**,
**`AGENTS.md`** (this file).

Outside `tas/` (keep in sync when porting):
- **`index.html`** — has `<script src="tas/tas.js"></script>` **before**
  `main.bundle.js`, un-`defer`red (patches install before the game boots).
- **`simulation_worker.bundle.js`** — physics worker, **patched** for savestate
  (keyed on `tasSwitchFrame`). Backup: `….orig`.
- **`main.bundle.js`** — **patched** with `window.__TAS_*` exposures + the
  speedometer-decimals hook (§ 12). Backup: `….orig`.
- **`electron/preload.js` / `main.js`** — `window.electron.tasSaveRun / tasReadRun
  / tasListRuns` (saved-runs storage in `userData/tas-runs/*.tas`). `main.js` sets
  `webPreferences.devTools:false` — flip to `true` to see `[TAS]` logs.

---

## 3. Stable wire contracts (the ONLY game coupling)

The load-bearing assumptions; if something breaks after a version bump it's almost
always one of these:

- **Sim worker filename** `SIM_WORKER_FILE = "simulation_worker.bundle.js"`.
- **`GAME_VERSION = "0.6.2"`** (worker asserts it; bump on port).
- **Numeric `messageType` enum** — defaults in `capture.msgType`, but **relearned**
  from live traffic by **field-shape detection** (`onOutbound`/`onInbound`); never
  classified by raw number.
- **CarState binary layout** — 227-byte variable-length buffer; § 4.
- **Recording codec** — 5 toggle channels → zlib → base64url; byte-compatible with
  the game's; § 5.
- **Leaderboard endpoint** — host contains `ptproxy.cwcinc.dev`, path ends `/leaderboard`
  (`TAS.gate.isSubmitUrl`). This is the **official** board the gate blocks; the
  tool's own board (§ 13) is a separate Supabase host.

---

## 4. CarState binary layout

`parseUpdateBuffer(ab)` → `parseCarState(dv,u8,i)` (port of the game's module-3899
decoder), exposed as `TAS.parseCarState`. Buffer: `[u32 carId][CarState…]`,
**variable-length LE** — only the prefix through the flags byte is fixed-offset, so
**walk it sequentially**. Returns `null` on any malformed buffer.

| Bytes | Field | Notes |
|------|-------|-------|
| 3 | `frames` | LE u24. Physics = **1 ms/frame (1000 fps)** → frame ≈ ms. |
| 4 | `speedKmh` | f32 |
| 1 | `flags` | bit0 hasStarted, bit1 finished, bit2 hasCheckpointToRespawnAt, bits3-6 wheel-contact FL/FR/RL/RR |
| 3 | `finishFrames` | LE u24, **only if finished** |
| 2 | `nextCheckpointIndex` | u16 |
| 12 | `position` | 3×f32 |
| 16 | `quaternion` | 4×f32 |
| 1 | `impCount` | ≤4 (guard: >4 → null) |
| 4×impCount | `collisionImpulses` | f32 each |
| 24× (per contacting wheel) | `wheelContact[w]` | `{position,normal}` (only set-flag wheels) |
| 16 ×4 | `wheelSuspensionLength / Velocity / DeltaRotation / SkidInfo` | `wheelSkidInfo` = per-wheel grip 0..1 |
| 4 | `steering` | f32 radians |
| 1 | `controlByte` | bit0 up, 1 right, 2 down, 3 left, 4 reset, 5 brakeLight |

**Wheel order `[FL, FR, RL, RR]`** everywhere. Also returns `carId` + `byteLength`.

---

## 5. Recording codec

`Recording` (`TAS.Recording`), byte-compatible with the game's. **5 toggle
channels** `up,right,down,left,reset` — each an ascending list of toggle frames.
Serialize: `packChannels` (per channel `[3B LE count][3B LE deltas]`) → `deflate`
(native `CompressionStream("deflate")`, RFC-1950 zlib, **zero third-party code**) →
`b64urlEncode`. Both `serialize`/`deserialize` are **async**. Editor letters
`w a s d r` → forward,left,brake,right,reset; **channel order ≠ key-letter order** —
conversions in `keysToControls`/`recordingToScript` handle it. `MAX_FRAMES=5999999`.

---

## 6. Editor script format

State-based text; `compileScript` → sorted `[{frame,keys}]`, then
`scriptToRecording`. Inverse `recordingToScript`; `compactScript` folds alternating
runs into `tap`. Exposed on `TAS`.
- `frame,keys` — hold `keys⊆wasdr` from `frame` on; empty/`none` = release all.
- `tap START END KEYS ON OFF` — alternate KEYS (ON frames) / previous state (OFF).
  KEYS must differ from the pre-START state. Expanded in pass 2 after all plain lines.
- `# …` comment.

---

## 7. Capture backbone (`TAS.capture`)

Installed **synchronously at eval** by `patchWorker()`. Wraps `window.Worker`; for
the sim worker taps outbound `postMessage` (`onOutbound` → Init / CreateCar track
context, by **key-set shape**) and inbound `message` (`onInbound` → parse
`carStateBuffers[]`, emit `carstate`/`telemetry`). Key state: `playerCarId` (last
CreateCar with `carRecording==null`), `activeCarId` (viewed car via `pickActiveCar`),
`_RealWorker` (native ctor for untapped BF workers), `msgType` (relearned enum). The
savestate prefix injection also lives in `onOutbound`.

---

## 8. Savestate (`TAS.savestate` / `SS`)

Drive live from an arbitrary frame **N** of the viewed replay. The worker can't seed
a moving car's velocity, so the prefix `[0..N)` is **re-simulated** (fast-forwarded
in the patched worker), then the same car switches to live keyboard at N.
`armSavestate(frame,text)` encodes the editor script as prefix + `setTaint(frame>0)`;
`window.__TAS_view.drive(...)` leaves the viewer; `onOutbound` injects prefix +
`tasSwitchFrame` into the player CreateCar (re-applies on each reset). Newer keybinds:
**`ssSet`** marks a live position, **`ssReturn`** returns to it (`ssSetPoint` /
`ssGotoLast`; positions HUD § 13). Taint (`window.__TAS_tainted`) blocks the official
upload (§ 9); the native board (§ 13) still records driven runs.

---

## 9. Leaderboard gate (`TAS.gate`)

No-op unless `window.__TAS_tainted`. **XHR shim** drops a tainted `POST` matching
`isSubmitUrl` and synthesizes a clean `200`/`"null"` (readystatechange+load+loadend);
**fetch guard** mirrors it. Match = `POST` + host `ptproxy.cwcinc.dev` + path ending
`/leaderboard`. Local PB/ghost persist before the network call, so they're unaffected.

---

## 10. Input shield

Capture-phase `keydown/keyup/keypress` on `window`, before the game's. For events
targeting `#tas-panel`/`#tas-modal` it `stopPropagation()`s (so W/A/S/D don't drive
the car) but **not** `preventDefault()` (field still types).

---

## 11. Bruteforce (`TAS.bf` / `BF`) — island + snapshot

Spawns a pool of **untapped** real physics workers (via `capture._RealWorker`), inits
from the captured `Init` with `isRealtime:false`, and evolves input variants.

- **Objective = trigger boxes, full stop.** There is no `checkpoint`/`finish` objective
  any more (no `BF.objective`, `bf-obj`, `BF.target*`, `acc.targetFrame`): you place a
  box on each checkpoint you care about and one on the **finish line**, and the search
  optimizes the frame it reaches the last box. That old objective had no target position
  to aim at — it never learned where checkpoints are in world space — so its fallback
  score was `maxCp*1e5 + lastSpeed`, i.e. *maximize speed and hope you get lucky*. Boxes
  carry their own distance gradient, which is why this replaced the planned unified
  waypoint list. Ordered boxes + `dist↔speed` blend + **no-go** boxes → `-Infinity`.
  Mutations (`bfMutate`) confined to `[startFrame,endFrame)`; a fixed end-anchor keeps
  post-window play identical. `bfNewAcc`/`bfAccumulate`/`bfScore`/`bfDescribeAcc`.
  `acc.maxCp`/`finished`/`finishFrames` survive as **readout only** (`cp3 FIN@29995`) —
  the game's own checkpoint count and finish frame are the cross-check on your box
  placement (`box 1/3 cp4` = the car is fine, a box is in the wrong spot).
- **Crossing the finish does NOT end the run** (`bfIsDone`; worker's `done` condition).
  It used to, and that inverted the search whenever the last box sat on the finish line:
  the game latches `finished` the frame the car enters the finish detector, the run was
  cut dead there, and a box a few frames beyond was never collected — so a run that
  actually finished scored as incomplete (`trigEntered < length`) and **lost by ~1e9** to
  one that missed the finish but drove the boxes. Only collecting every box, a no-go, or
  the horizon ends a run now. Safe because the game's own non-realtime loop (`h()`) never
  checked the flag either, and the auto horizon leaves ~4000 frames past the player's
  finish. The snapshot prefix loop likewise no longer breaks on `hasFinished` — that left
  `snapFrames < sf`, silently re-simulating the prefix on *every* variant.
- **Exit speed at a common check frame** (`BF.speedFrame`, `acc.checkSpeed`, worker
  `sf2`/`chkSp`). For a **completed** run the score blends the *arrival frame at the last
  box* (the unconfounded time term) with speed sampled at `BF.speedFrame` — the **same
  frame for every run** — NOT speed at box entry. Box-entry speed sampled each run at its
  own arrival frame, so a run that reached the box a frame earlier was measured a frame
  earlier in its acceleration and looked *slower*, letting the blended score reject the
  genuinely-faster run (at the default 50/50, arriving one frame earlier gained +0.05 but
  cost ~0.5–1.0 in speed → the search preferred arriving *later*). `speedFrame` defaults
  to `endFrame` (the section-exit boundary, past which all inputs are frozen identical);
  the **Check frame** field overrides it and also caps the horizon; clamped `≤ horizon`
  so a completed run always reaches it. `bfIsDone` keeps a completed run simulating until
  `st.frames ≥ speedFrame` (a little past the last box), which is the small extra compute
  this costs. Incomplete-run scoring is unchanged (closest-approach distance + its
  aligned speed). Readout: `all N boxes @f<arrival> exit<spd>`.
- **Vector-aligned speed** (`BF.align`, `bf-align`, default off):
  scores the speed term by `speed × cos θ` between the car's velocity and the direction
  to the next box (`bfAlignedSpeed`; worker twin `_algnSp`) instead of raw speed — a car
  sliding past a box at 300 no longer outranks one arriving at 150. **CarState has no
  velocity vector** (§ 4), so direction comes from the position delta between consecutive
  frames (`acc.prevX/Y/Z`, worker `ppx/ppy/ppz`); magnitude stays `|speedKmh|`, so a car
  reversing *into* a box still scores positive and `blend`/`FRAME_W` keep their tuned
  scale. Applied **only at closest approach** (the term that ranks runs which MISS);
  entry speed stays raw because inside the box the direction to its centre is meaningless
  and for the final box there is no next target. Can go negative (moving away). Readout
  says `algn` vs `spd`.
- **Adaptive cooling** (`BF.cool`, `bf-cool`, default **on**): `bfMutStrength(island)`
  anneals that island's `rate`/`maxShift` geometrically (`x^t`, `t = 1 − stalls/stallLimit`)
  from the configured values down to `1` as it stalls, resetting to full strength on
  every new island best. `t=1` reproduces the configured values *exactly*, so a
  freshly-improved island is identical to the old fixed-strength behaviour; `t=0`
  coincides with the stall kick. Big shifts find the line, small ones polish it.
- **Variant model**: a variant is `{ map, taps }` (`map` = plain-state timeline,
  `taps` = structured `{start,end,keys,on,off}` macros). `bfCompileVariant` clones
  `map`, expands each tap (`bfExpandTapInto`, = `compileScript` pass-2 semantics), then
  **freezes the whole post-window tail** to the base (`BF.tail` = every base frame
  `>= endFrame`, captured in `bfStart`) — not just a single `endFrame` anchor, so a
  non-editable tap reaching past `endFrame` can't re-derive its off-phase (`prev`)
  values from mutated in-window state and leak edits past the window. `bfVariantToRecording`
  = entries→Recording. `bfCloneVariant` deep-clones (incl. `bfCloneTap`) so a mutated
  variant never aliases its parent island best / `BF.base` / `BF.best`.
- **Tap-parameter editing** (`BF.tapEdit` / `BF.tapMut`, the `bf-tapedit` toggle):
  **off** → taps are expanded into `map` (`taps=[]`) and freely frame-mutated (old
  default). **on** → taps stay structured so `bfMutate` can nudge one parameter
  (`bfMutateTapParam`: start/end/keys/on/off) of a tap that lies **wholly inside the
  window**, selected with weight `wStart+wEnd+wKeys+wOn+wOff` (the 5 `bf-tw-*` inputs);
  clamped to keep the tap valid and inside `[startFrame,endFrame)` (end `< endFrame`).
  **on + all 5 weights 0** ⇒ taps kept but never mutated = the old "protect taps".
  Free-frame edits always skip any tap's span. `bfBestText` runs the winner through
  `compactScript` when `tapEdit` so the output keeps `tap` macros. (Replaced the old
  `protectTaps` checkbox / `bfParseTapRanges`.)
- **Island model** (newer): `BF.numIslands` independent populations (`BF.islands[]`,
  each `{best, stalls}`). A population that stalls ≥ `BF.stallLimit` is **kicked** —
  half the time migrate the global best (intensify), half restart from the base
  (diversify); `BF.migrations` counts kicks. `bfFinalize` sets `improved=true` on the
  base-finalize and whenever a global best is beaten.
- **Snapshot mode** (newer, `BF.snapshot`): each worker keeps ONE persistent car,
  simulates the prefix `[0..startFrame)` once, snapshots WASM memory, and
  restores+continues per variant — skipping prefix re-sim (boxes must be after the start
  frame). Scoring config handed to the worker via
  `BF._cfg` (scores in-thread). The track context (`trackData`/`mountainVertices`/
  `mountainOffset`) + `cfg` are sent **once per run** in a single `__bfInit` message
  from `bfSpawnWorkers` (keyed by `BF._runId`) and cached on the worker's `__bf.ctx`;
  per-variant `__bfSnap` messages carry only `{carId, prefixKey, startFrame,
  targetSimulationFrames, rawCh}`. They used to ride along on *every* dispatch even
  though the worker reads them once — and `mountainVertices` is a plain `Array` of
  ~2.5k–57k doubles (`createMountainVertices` → `Array.from`), so structured-cloning it
  per variant was burning main-thread time that directly capped runs/sec. The worker
  still prefers a message-carried copy when present, so ordering/older callers are safe;
  if neither is available it scores `-Infinity` with info `noctx`.
- **Lifecycle**: `bfStart`→`bfSpawnWorkers`→`bfPump`→`bfOnMessage`/`bfFinalize`; best
  auto-writes to the editor + optional `userData/tas-runs/`. `bfReap` reclaims stuck
  workers. Exposed: `TAS.bfStart/bfStop/bfBestText`.
- **Stop condition** (`BF.limitMode`, one `Stop after` row = `bf-limit-n` +
  `bf-limit-mode`, replacing the old Iterations box + "Run forever" checkbox):
  `"iters"` decrements `BF.iterLeft` per dispatch · `"time"` runs for exactly N seconds
  — `bfBudgetLeft()` stops dispatching at `BF.deadline` **and** `BF.limitTimer`
  hard-finishes on schedule, so the wall-clock is honoured rather than overrunning by
  whatever is in flight · `"never"` = unbounded (`BF.infinite` mirrors this for the
  public surface). `bfStop` clears the timer. NB the `bf-limit-mode` change handler
  re-defaults an obviously-wrong carried-over value on a **user** unit swap, and is
  suppressed via `bfImporting` during `bfImportSettings` (otherwise importing "500
  iterations" silently became 100000).
- **PB log** (`BF.pbQueue`/`pbDropped` → `drainPbLog`): `bfFinalize` queues **every
  island** personal-best (`islandPb`), not just global bests (`improved`), so each
  population's own progress shows even while another leads. Lines carry run #,
  population, info, score, and — for global bests — the delta and the ★/gold class; the
  `maxShift` the variant was *born at* rides along (`slot.mut`, captured at dispatch,
  since a PB has already reset its island's stalls by finalize time). Queued rather than
  rendered inline so the DOM never touches the finalize hot path; bounded at 300 with
  the overflow counted, drained into one fragment on the 250ms tick, log capped at 200
  rows. Only `improved` writes the editor/autosave — a trailing population's PB must
  never clobber the leader.
- **Share settings** (`bf-export` / `bf-import`, `TAS.bfExportSettings/bfImportSettings`):
  dumps every BF control + the trigger boxes to a tagged JSON block
  (`{tas:"bf-settings", v:1, …}`), copied to the clipboard and shown in a modal
  (`tasModal` grew a `textarea` option for this); import pastes/loads it back. **One
  table (`BF_SETTINGS`, `[elementId, friendlyName]`) drives both directions** — add a
  row when you add a control or it silently won't round-trip. Values are read/written
  generically off `el.type` (blank number ⇄ `null`, so "Check frame = auto" survives),
  and import re-fires `input`/`change` so handler-driven layout (objective sub-panel,
  blend readout, tap weights) follows. **Excluded on purpose:** `bf-file` (a local
  output path) and the editor script (that's the TAS, not a setting). Triggers replace
  wholesale and are world coordinates, so the export stamps `TAS.currentTrackId` and
  import warns on mismatch; it also warns when `workers` exceeds `hardwareConcurrency`.
  Unknown keys are skipped, not fatal (forward-compat with newer exports).
- **Live stats** (ported): `#bf-stats` grid + `updateStats()` — state, best score,
  runs, runs/sec, elapsed, since-best (`totalRuns - BF.bestAtRun`), workers-busy,
  pending, iters-left, horizon. 300ms interval + calls from `refresh()`/start/stop;
  backed by `BF.startedAt`/`BF.bestAtRun` (set in `bfStart`/`bfFinalize`).
- **Trigger-box UI** rows use class **`.trbox`** (a card: `.trline` grids for center
  X/Y/Z + size X/Y/Z, `.trfoot` no-go+Remove). `.trow` now styles **only** the
  `dist↔speed` blend slider; `readTriggers` queries `.trbox`.
- **3D box overlay** (`installRendererBoxOverlay`): recovers the camera VP from THREE's
  `projectionMatrix`/`viewMatrix` shader uniforms via patched WebGL `draw*`, projects
  box corners onto a full-screen canvas (x-ray). Silently no-ops if shaders differ.

---

## 12. Game-bundle edits (re-apply per version)

Outside `tas/`; mostly *expose live objects on `window`* / add a savestate code path /
one speedometer hook. Anchored on stable strings. Backups `*.bundle.js.orig` are the
**clean** originals — don't overwrite; re-apply every edit per version.

**`simulation_worker.bundle.js`** — drivable car with a recording prefix, keyed on
`tasSwitchFrame`: (1) CreateCar builds a live `userControls` buffer when
`carRecording`+`tasSwitchFrame` present; (2) the car record carries `tasSwitchFrame`;
(3) the realtime loop fast-forwards via `controls.getControls` to `tasSwitchFrame`
(~4000 frames/tick), then reads live `userControls`.
Plus the **BF snapshot** path (`__bf`, `__tasBfSnap`, `_tasRawCtrls`, § 11), whose
`onmessage` branches on `__bfInit` (cache track ctx + cfg) and `__bfSnap` (run+score a
variant in-thread). `_algnSp` there is the twin of `tas.js`'s `bfAlignedSpeed` — note it
reuses the already-computed `dx=px−nx.x` (car→box **reversed**) and negates the dot, so
the two use **opposite sign conventions** and must stay in agreement. Backups:
`….orig` (clean), `….pre-snapshot.bak`, `….pre-align.bak`.

**`main.bundle.js`** — `window.__TAS_*` exposures + the speedometer hook:
1. `window.__TAS_settings = { make(parent,onClose) }` — builds the real Settings
   screen. Anchor: `x.innerHTML='<img src="images/settings.svg">',x.addEventListener("click",`.
2. `window.__TAS_view = { enter, drive, trackMeta, trackData, category, records }`.
   Anchor: `$=new cg(A,w,e,t,n,y,b,d,l,S,r,i,((e,t,n,i)=>{J(e,t,n,i,null)})),I.PM(),I.tU()`.
3. `window.__TAS_viewState()` → `{ frame, state, focus, count }`. Anchor: start of
   `cg=class{constructor(...){` (`cg`: `jp` records, `Hp` focus, `qp` time-sec).
3b. `window.__TAS_viewAll()` → `{ frame, focus, replays:[{i,focus,state,last}] }` — the
   per-frame CarState of **every** loaded replay (not just the focused one) plus its total
   frames (`last`, best-effort from `replay.getLastFrame()`). Added for the telemetry
   **comparison** HUD (§ 18 D2). Inserted right after the `__TAS_viewState` assignment,
   reusing the same closure (`_ts`, `jp` records, `qp` time, `Hp` focus). Anchor:
   immediately after `...count:_j?_j.length:0}}catch(_x){return null}}`. Purely additive.
3c. `window.__TAS_replaySplits()` → `[{i,splits:[frameAtEachCheckpoint],finish,last}]` —
   each loaded replay's **exact per-checkpoint crossing frames** (+ finish/last frame),
   computed by walking `replay.getFrame(f)` from 0 until it returns null. Powers the
   per-checkpoint ms deltas in the comparison HUD. Same closure; inserted after `__TAS_viewAll`.
3e. `window.__TAS_race(currentFrame)` → the **driving/racing** screen's ghosts (the viewer
   ones above are watch-mode). `[{name,isSelf,carId,splits:[cpFrame…],cpSpeeds,state,loaded}]`
   — `splits`/`cpSpeeds` from each ghost record's precomputed `checkpoints`, `state` =
   `ghost.replay.replay.getFrame(currentFrame)` (the `Ht` trajectory) for the live speed
   delta. Injected in the racing-screen constructor after `Oa.set(this,[])`; reuses `Oa` (the
   ghost-records array) + `R.gn`. Needed because the game deletes each ghost's worker car
   after pre-sim, so `capture.latest` can't see them during the drive.
3d. `window.__TAS_viewSeek(frame)` → sets the viewer's playback position (`qp = frame/1000`,
   clamped to duration `Qp`); returns true/false. `qp` advances incrementally in the play
   loop, so a set value sticks and playback continues from there. Used by Apply to resume
   where you were watching. Same closure; inserted after `__TAS_replaySplits`.
4. **Speedometer decimals** (ported): the speedometer `update(e)` truncates speed to
   an integer (`const n=Math.trunc(t).toString()`, then one span per char). Patched to
   `const n=(null!=window.__TAS_speedDecimals&&window.__TAS_speedDecimals>0?t.toFixed(window.__TAS_speedDecimals):Math.trunc(t).toString())`
   so it honours the shared **Speed decimals** setting. `t` = imperial-converted speed;
   the per-char loop renders `.` fine; falls back to stock integer when the global is
   absent/0 → **safe standalone**. Anchor: `const n=Math.trunc(t).toString();if(n!=`.
   `tas.js` mirrors `settings.speedDecimals` → `window.__TAS_speedDecimals`
   (`applySpeedDecimals`, at eval + every `settings` event); the game reads it/frame.

> The newer **board / leaderboard-twin / positions-HUD** features may rely on
> additional game data (e.g. nickname, `userTokenHash`, `car_style`, `__TAS_carThumb`).
> If a port breaks them, **diff `main.bundle.js` against `.orig`** to enumerate every
> hook — this doc does not exhaustively list the board's exposures.

---

## 13. Newer-only features (summary — read the code before editing)

- **Native TAS board** (`BOARD_URL` Supabase; see [TASBOARD.md](TASBOARD.md)) — the
  tool's own community board, **never** the official one. Runs tagged `driven`
  (finished, incl. savestate) or `edited` (input-edited full TAS), full recording
  attached. `board.cfg()`/`board.patchCfg()` (autoUpload etc., in `localStorage`).
- **Leaderboard twin** (`installLeaderboardTwin`) — docks the board next to the real
  in-game leaderboard; filter Driven/Edited; click a row to load into the editor.
- **Positions HUD** (`buildPositionsHUD`) — in-run savestate-position aid for the
  `ssSet`/`ssReturn` workflow.
- **Simulate-finish** (`boardSimulateFinish`) — headlessly sims the editor inputs to
  the finish, reads the real time (`Simulate finish → upload TAS` / `⏱ Time`).

These are viewer/driving features layered on the same capture + recording core; they
reuse `fmtSpeed`/`fmtTime` for display where they show speed/time.

---

## 14. Settings & hotkeys

All TAS settings live **inside the game's own Settings page** (`installGameSettings`
appends a "TAS Tool" section via MutationObserver: keybinds + **interface size** +
speed units + **speed decimals** + panel layout + remember-editor + a "TAS
leaderboard" subsection). `openGameSettings` opens it from anywhere via
`__TAS_settings.make`.

Persisted to `localStorage` `tas:settings` (`TAS.settings`, `saveSettings`). Defaults
(`DEFAULT_SETTINGS`): keys `overlay:F8, panel:F9, reload:F7, settings:F6,
savestate:F5, ssSet:F4, ssReturn:F3`; `units:kmh`; `rememberEditor:true`;
`layout:tall`; `scale:1`; `speedDecimals:3`. (The board twin opens with **F2** per
TASBOARD.md.) `installHotkeys` (capture-phase) dispatches; function keys/Escape still
fire while typing.

**Interface size (`settings.scale`, "Interface size" → 100–200%)** — `currentScale()`
/`applyScale()` set CSS **`zoom`** on the TAS-owned HUDs: `TAS.overlay.el`,
`TAS.posHUD.el` (positions HUD), and `TAS.panel.el` (toast, modals, game-settings
host, the 3D canvas, and the leaderboard twin — which must match the game's own
leaderboard — stay 1:1). `applyScale` is wired after `buildPositionsHUD()` so the
initial call already covers the HUD. `zoom` over `transform:scale` because
Chromium reflows it (panel keeps fitting the viewport). Consequence: the **panel drag**
divides mouse deltas by `currentScale()` (getBoundingClientRect is post-zoom;
`style.left` is pre-zoom CSS px), persisting the on-screen nudge via `TAS.panel.saveGeo`.
Loader **snaps** stored `scale` to the nearest offered option. `applyScale` runs on
build, on every `settings` event, **and on panel show** (`onEnter` / `toggle`) —
critical because the panel is `display:none` (viewer-only) most of the time, so the
overflow-nudge can only measure a laid-out element.

**Speed decimals (`settings.speedDecimals`, 0–5, default 3)** — `currentSpeedDecimals()`
/`applySpeedDecimals()` drive `fmtSpeed` (overlay + panel) **and** the game speedometer
via `window.__TAS_speedDecimals` (§ 12). Loader clamps to integer 0..5. Panel
settings-handler only resets width/height on **tall↔wide layout change** (so changing
size/units/decimals doesn't wipe a manual resize).

Other `localStorage` keys: `tas:editor`, `tas:panelGeo`, plus board prefs.

---

## 15. Viewer-only surface

Editor / Apply / Bruteforce / Savestate operate **only in the standalone replay
viewer** (`inReplayViewer` = `.preview-toolbar-ui`). The telemetry **overlay** also
works during live driving. `installViewerContext` shows/hides the panel on
enter/leave (debounced), auto-loads the focused replay (or a just-driven savestate run)
into the editor, disarms savestate on menu, and polls `__TAS_viewState()` for
telemetry while scrubbing. `currentCarState()` returns the scrub CarState in the viewer
else `capture.latest` for the active car.

---

## 16. Public `TAS.*` / `window` surface

`window.__TAS__` (alias `window.TAS`): `version, gameVersion, bus, capture, savestate,
bf, gate, settings, overlay, panel, parseCarState, Recording, compileScript,
scriptToRecording, recordingToScript, compactScript, armSavestate, disarmSavestate,
setTaint, bfStart, bfStop, bfBestText, bfExportSettings, bfImportSettings,
openGameSettings, applyScale, inViewer, currentState, …` (plus board/HUD helpers).

`window` globals: `__TAS_tainted`, `__TAS_speedDecimals`, and the game-bundle
exposures `__TAS_settings`, `__TAS_view`, `__TAS_viewState`, `__TAS_carThumb`.

`window.electron`: `tasSaveRun(name,content)`, `tasReadRun(name)`, `tasListRuns()`.

---

## 17. Gotchas when editing

- **Don't reference minified ids.** Need a game internal? Add a `window.__TAS_*`
  exposure in `main.bundle.js` anchored on a stable string; document it here + README.
- **Channel order ≠ key-letter order** (§ 5).
- **CarState is variable-length** — walk sequentially (§ 4).
- **Serialize/deserialize are async.**
- Patches install at **script eval** — inject line stays before `main.bundle.js`,
  un-`defer`red.
- **UI scale uses `zoom`, not `transform`** — new interactive UI reading mouse coords
  against `TAS.panel`/`overlay` must divide by `currentScale()` (or measure with
  getBoundingClientRect, which is post-zoom).
- After a version bump: re-verify § 3 and **diff `*.bundle.js` against `.orig`** to
  re-apply every game-bundle edit (base savestate/settings/viewer + the speedometer
  hook + any board hooks).

---

## 18. Changelog (newest first)

Append a line here when you change `tas.js`.

- **Pipeline: never lose a finisher.** `tas/pipeline/src/cli/run.js` — when phase 3 exhausts its
  budget without finishing, it now falls back to the phase-2 RRT ghost (a complete run) instead
  of aborting with a partial, and a final guard keeps whichever finisher is fastest. Validated
  end-to-end on a real custom track: ghost 7001 ms → polish 5318 ms → game-Verify PASS. Note the
  bridge STAGES the pipeline from the packaged app on each start, so pipeline fixes require
  re-packing the asar too. Panel UX: live progress pill (phase · locked s · best fin), tiny-budget
  warning, workers default cores−4, child runs at below-normal CPU priority.
- **Auto-TAS panel section (pipeline front-end).** New `buildAutoTas(panel)` section in the
  panel (below Brute Force) that runs the autonomous 4-phase TAS pipeline in
  [`tas/pipeline/`](pipeline/README.md) on the **currently captured track**
  (`capture.lastCar.trackData` — same source as BF). Electron main spawns
  `tas/pipeline/src/cli/run.js` as a background Node child — a **system `node` from PATH is
  preferred** (packaged builds often ship with the RunAsNode fuse disabled, where
  `ELECTRON_RUN_AS_NODE` silently fails or the exe respawn ENOENTs); the exe+RUN_AS_NODE path
  is only a fallback. Spawn errors and kills both clean the bridge state (Stop escalates
  TERM→KILL→taskkill and force-finishes if the handle is dead). **asar-safe**: the main
  process STAGES the pipeline (`src/`, `context/init-context.json`) plus the runtime game
  files (`simulation_worker.bundle.js`, `polytrack_physics.wasm`, `lib/polytrack_physics.js`)
  into `userData/tas-pipeline/` on every start and runs the child from there with
  `POLYTRACK_ROOT` pointing at the staged game files — a spawned Node cannot read inside
  app.asar, and Electron's patched fs makes the copy work either way. Log lines stream to the
  renderer and the artifacts return on exit; the
  resulting script (final, or best partial on budget exhaustion) is loaded straight into the
  editor. Controls: workers / RRT s / MCTS min / polish min / seed; live log; Stop kills the
  child. **Game-bundle-free but Electron-layer edits**: `electron/main.js` gained
  `tas-auto-start/stop/status` IPC + child management (artifacts under `userData/tas-auto/<runId>/`),
  `electron/preload.js` exposes `tasAutoStart/tasAutoStop/tasAutoStatus/onTasAutoLog/onTasAutoDone`.
  Requires a full game restart after updating the electron files, and the pipeline context to be
  built once (`node src/extract/build-context.js` in `tas/pipeline`). Runs are `edited`-category
  by definition; the upload gate/taint rules are unchanged.

- **Reset lag — the real cause was the capture tap (follow-up 5).** On a race reset the game
  re-simulates every ghost **through the sim worker**, which streams the whole trajectory back;
  `capture`'s inbound tap was doing a full `parseUpdateBuffer` on **every** ghost frame — the
  spike. Fix in `onInbound`: for a large batch (`bufs.length > 16`, i.e. a non-realtime
  pre-sim), only fully parse the **last** buffer per non-player car (+ every player frame,
  which `liveRecording` needs) via a cheap `readCarIdOnly` peek. Safe because the tap is a
  **separate `addEventListener` observer** — the game's own `onmessage` still processes the
  full message, so ghost trajectories are unaffected; and the tool only ever needs the latest
  state per ghost anyway. The HUD comparison was **reverted to full frame rate** (it was never
  the bottleneck) — the earlier ~8 Hz throttle is gone; the "skip compare while a ghost is the
  active car" guard stays (correct: you're not driving yet).
- **Comparison HUD — driving-mode ghosts via the racing screen (follow-up 4).** During a
  live drive the game pre-simulates each ghost then **deletes its worker car** and plays it
  back off-worker, so `capture.latest` loses the ghosts mid-drive (they only flashed up
  during the pre-sim). Added **`window.__TAS_race(currentFrame)`** — reads the racing
  screen's ghost records (`Oa`), each carrying `settings.nickname`, precomputed `checkpoints`
  ({time,speedKmh} per CP), and the `Ht` trajectory (`getFrame`). It returns
  `[{name,isSelf,carId,splits:[cpFrame…],cpSpeeds,state:getFrame(cf),loaded}]`. The driving
  compare path now reads ghosts from `__TAS_race(myFrame)` (exact per-checkpoint splits +
  the ghost's state at my current frame for the live speed delta + **real names**), with the
  player still live from `capture.latest`; the old `capture.latest` scan is the pre-sim
  fallback. Injected into the racing-screen constructor after `Oa.set(this,[])`.
- **Comparison HUD — reset-lag fix + real names (follow-up 3).**
  - **Lag on reset fixed.** Dropped the per-`carstate` split subscriber (it ran once per
    streamed frame — thousands of times during the ghost pre-sim burst on reset). Splits are
    now sampled from `capture.latest` **once per overlay render** (`cmpSampleLive`, ~60 Hz) —
    frame-accurate enough for splits at negligible cost. (Any residual reset lag is the game's
    own ghost re-simulation, not the tool.)
  - **Real names.** `__TAS_viewAll` / `__TAS_replaySplits` now return each replay's
    `settings.nickname` + `isSelf`; the watching HUD labels rows by **player nickname**
    (falls back to `#N`), focused row marked ` ◄`. Live racing labels rivals **`ghost 1/2/3`**
    sequentially instead of the raw car id (`ghost 11`). Real ghost names while *driving* would
    need a racing-screen hook (the physics worker only carries car ids) — not done.
  - **`__TAS_replaySplits` safety break:** stops scanning when `getFrame`'s frame counter
    stops advancing (guards against a build where getFrame clamps instead of returning null,
    which would have spun the 0..6e6 loop).
  - *Known limitation:* if a race pre-simulates ghosts then deletes them and plays them back
    off-worker, they won't be in `capture.latest` during driving, so only the `you` row shows.
    Watching (viewer) is unaffected.
- **Comparison HUD — show-all + live-racing robustness (follow-up 2).** Viewer path now
  lists **every** loaded replay including the focused one (a `#N (you)` row at 0/0), no 5-row
  cap. Live-driving path: "me" = `capture.playerCarId` (survives reset spawning a new active
  id) with its own `you` 0/0 row; **stale cars pruned** (`lastUpdateTs` > 500ms → skip) so a
  dead car from the previous attempt can't show as a frozen-speed "fake ghost"; the split
  tracker **resets a car's table when its frame goes backwards** (a reset restarts the run)
  instead of keeping stale splits. Self row styled (`.cmp-row.me`).
- **Telemetry comparison rewrite + Apply-position + QoL (follow-up).** Touches `tas.js`
  and `main.bundle.js`. All `node --check`-clean; **still runtime-unverified.**
  - **D2 comparison fixed.** The overlay now shows **one row per rival replay**, each with
    the **frame-accurate ms** I'm ahead/behind **at my current checkpoint** and the **live
    speed difference** — replacing the old single-reference row that showed a static finish
    delta / "ahead". Time deltas come from exact per-replay checkpoint split frames
    (`window.__TAS_replaySplits`, new); live states + speeds from `window.__TAS_viewAll`.
    "Me" = the focused replay. `cmpEnsureSplits` caches the scan and self-heals if it was
    taken before a re-sim finished building (`covers` = scan reached the watched frame);
    invalidated on Apply / track change (`TAS._cmpInvalidate`). Live-driving path (racing
    ghosts, worker streaming) uses `capture.latest` + `carstate`-built splits the same way.
  - **Apply resumes where you were watching.** `tas-apply` records the scrub frame, and
    after `V.enter` re-sims, seeks back via **`window.__TAS_viewSeek(frame)`** (new — sets
    the viewer's `qp` time, which advances incrementally so a set sticks). Retries until the
    fresh sim has built past that frame (viewSeek clamps to duration = the readiness signal),
    or the duration stops growing (edited run ends earlier).
  - **QoL:** overlay gained a **time** readout (frames → `fmtTime`, shows finish time once
    finished); **Ctrl/Cmd+Enter** in the editor triggers **Apply → replay**.
- **Big optimization + smarter-tool + UX pass (this session).** Touches `tas.js`,
  `simulation_worker.bundle.js` (rewrote `__tasBfSnap`), and `main.bundle.js` (added
  `window.__TAS_viewAll`). Backups: `*.bundle.js.pre-optimize.bak`. All three files
  `node --check`-clean; **not yet runtime-tested in the game — verify a BF run + a
  driven run before relying on it.** Items (matching the findings report IDs):
  - **A1 — in-thread scoring is now the DEFAULT** (`bf-snapshot` checkbox relabelled
    "In-thread scoring (fast)", default **on**; `BF.snapshot = opts.snapshot !== false`).
    Every variant is run+scored in the worker (`__tasBfSnap`) returning only
    `{score,info,hot}` — no per-frame CarState streamed back, no deflate on dispatch.
    Uncheck = legacy streaming path (unpatched worker). Biggest throughput lever.
  - **A2 (lite) — recreate-at-0.** `__tasBfSnap` now recreates the car per variant when
    `startFrame===0` instead of a full-heap `HEAPU8.set` restore (the multi-MB memcpy);
    `startFrame>0` still snapshots the prefix. Full sub-heap narrowing was **deferred** —
    it needs a WASM save/restore export the engine doesn't expose (documented, not risked).
  - **A3 — zero per-frame allocations in the worker hot loop.** `__tasBfSnap` no longer
    calls `n()` (which did `new Uint8Array(...).slice().buffer` per frame) — it does the
    `updateCarModel` ccall inline and reads fields straight from a persistent `DataView`
    over `t.HEAPU8` at the scratch pointer `i` (re-acquired if the heap grows). `n()` is
    unchanged for the normal game path.
  - **A4 — single-pass recording build.** `bfVariantToRecording` no longer does
    `bfCompileVariant→bfMapToEntries→bfEntriesToRecording` (two Map clones + sort +
    rebuild); it clones only when taps must be expanded and folds compile+sort+channel
    emit into one walk (semantically identical, tail still overrides). Cuts main-thread
    per-variant cost that capped runs/sec with many workers.
  - **A5 — variant dedup.** `bfSignature` (FNV-1a over the in-window genome) + `BF.seen`
    skip re-evaluating an already-tried genome (`bfSendVariant` re-mutates up to 3×).
  - **A6 — batch variants per message: NOT DONE.** Deferred — needs restructuring the
    one-slot-one-carId `BF.pending` model into per-variant batch metadata across
    dispatch/finalize/reap; too risky to ship without runtime testing.
  - **A7 — worker count auto-capped** to `navigator.hardwareConcurrency` in `bfStart`
    (`BF.workersCapped`, toast on reduce): more workers than cores is negative scaling.
  - **B1/B2/B4 — island populations.** Each island now keeps a top-`BF.poolSize` pool
    (`isl.pop`, `isl.best`=pop[0]) instead of a single best. `bfSelectParent` does an
    **annealed tournament** (fresh island → exploit the best; stalling → explore a random
    elite; this replaces a score-tier-ill-defined Metropolis, = B4). `bfCrossover` splices
    two elites at a random in-window frame (B2, `BF.crossover`, default on). `bfPopInsert`
    (dedup + top-K), `bfKick` (reseed on stall). New UI: **Pool** (`bf-pool`), **⚭ Crossover**
    (`bf-crossover`).
  - **B3 — gradient-guided mutation.** `acc.hotFrame` = the frame the run got closest to
    the box it's failing; carried on each elite (`.hot`) and via the worker's `hot` field.
    `bfMutate(parent, mut, hot)` biases a fraction (`BF.focus`, 0.5) of edits to a band
    around the hotspot (bounded re-roll — no inWin index invalidation).
  - **C1a — dead-run abort** (`BF.deadAbort`, default on; UI "Abort dead runs"): a run
    stopped (`speed<deadSpeed`) for `deadLimit` frames after the start is killed early
    (`acc.stuck`/`bfIsDone`; mirrored in the worker). Pure throughput.
  - **C1b — optional soft crash penalty** (`BF.crashWeight`, default **0**; UI "Crash
    penalty"): sums hard one-frame deceleration spikes (impact proxy — cheap and mirrors
    1:1 in the worker; CarState `collisionImpulses` also exist on the main-thread path) and
    subtracts `crashWeight × cost` from the score. 0 = ignore (a fast wall-scrape can be
    optimal). Both metrics are in `bfScore` **and** the worker, and in `BF._cfg`.
  - **D1 — keybind conflict fix.** The game reads controls as keydown+keyup **pairs**;
    `installHotkeys` intercepted only keydown → a colliding game bind could latch on.
    Now: `stopImmediatePropagation` (not just `stopPropagation`), an `e.repeat` guard, a
    **matching-keyup swallow** for TAS-bound keys, the input shield only eats a keyup whose
    keydown it ate (fixes the focus-shift stuck-key), the rebind UI warns on a PolyTrack
    collision (`gameBindingFor` reads `polytrack_v5_prod_key_bindings`), swallows the
    captured key's keyup, and cleans up on click-away.
  - **D2 — telemetry comparison.** New overlay line "vs <ref>: <Δtime> · <Δspeed>"
    (`computeCompare`). Live/racing: per-checkpoint split deltas from the per-car
    `carstate` event (`cmpLive`) + live speed delta vs the leading ghost/rival. Watching/
    scrubbing: reads every replay's state from **`window.__TAS_viewAll`** (new game-bundle
    export, § 12) — finish-time delta + progress + speed delta vs the best other replay.
  - **E — BF panel refactor.** One giant paragraph-laden `innerHTML` → collapsible
    `<details>` sections (Search window / Objective / Compute / Mutation / Crash handling /
    Output), long explanations moved into `?` tooltip chips (`.q`), Advanced sections
    collapsed by default. All prior element ids preserved; `BF_SETTINGS` gained the new
    controls (note: `bf-snapshot`'s export key changed `snapshotSkipPrefix`→`inThreadScoring`).
- **BF completed-run speed measured at a common check frame (confounding fix):** a
  completed run's score now blends *arrival frame at the last box* with *exit speed at
  `BF.speedFrame`* (a fixed frame, same for every run) instead of speed at box entry.
  Box-entry speed sampled each run at its own arrival frame, so the earlier/faster run
  was measured before it finished accelerating and looked slower — the blended score
  could then reject it. `speedFrame` defaults to the window End frame; the Check-frame
  field overrides it. `bfIsDone` runs a completed variant a little past the last box to
  reach it. Mirrored in the worker (`cfg.speedFrame`/`chkSp`). See § 11.
  *Still open: progress-first scoring with a per-waypoint split archive, and the BF panel
  reorganisation.*
- **BF is trigger-boxes-only + the finish-line bug:** the `checkpoint / finish` objective
  is gone (dropdown, Goal row, `BF.objective`/`target*`/`targetFrame`, and the worker's
  `cfg.objective` branches). You place a box on each checkpoint and on the finish line;
  boxes carry the distance gradient the old objective never had, which is what made it
  "maximize speed and hope". **Fixed:** crossing the finish no longer ends the run — it
  did, so a box on the finish line was never collected, and a *finishing* run scored as
  incomplete and lost by ~1e9 to one that missed. The snapshot prefix loop no longer
  breaks on `hasFinished` either (it left `snapFrames < sf`, re-simulating the prefix
  every variant). Readout gains `cp<N>`/`FIN@<frame>` as a box-placement cross-check.
  Replaces the planned unified waypoint list. See § 11.
  *Still open: progress-first scoring with a per-waypoint split archive, and the BF panel
  reorganisation.*
- **BF stop-after-time + per-population PB log:** the Iterations box and "Run forever"
  checkbox collapse into one `Stop after <n> [iterations|seconds|never]` row —
  `seconds` runs for exactly that long (`bfBudgetLeft` + a hard `BF.limitTimer`), and
  the stats readout reports the budget in whatever unit is in play. The BF log now
  shows **every population's** personal best (run #, `pop N`, info, score, and the
  `±Nf` cooling strength it was found at), with only the lines that took the overall
  lead in ★/gold; global bests also show their delta. See § 11.
  *Staged work — next: unified waypoint list (boxes + `checkpoint N` + `finish` in one
  ordered route, killing the objective dropdown), progress-first scoring with a
  per-waypoint split archive, and the BF panel reorganisation.*
- **Share BF settings:** `⇪ Export settings` / `⇩ Import settings` on the BF panel —
  every control + trigger boxes → a tagged, pretty-printed JSON block (clipboard +
  modal + optional `.json`), importable by paste or file. Driven by the single
  `BF_SETTINGS` table (§ 11); `tasModal` gained a `textarea` option (Enter stays a
  newline there) and `loadTextFile` an optional `accept`.
- **BF search quality — vector-aligned speed + adaptive cooling:** two new opt-ins on
  the BF panel (§ 11). `bf-align` (triggers only, default off) scores the speed term by
  the dot product of the car's velocity with the direction to the next box instead of raw
  speed, so runs that are fast in the wrong direction stop out-scoring slower ones that
  are actually arriving; velocity is derived from the position delta because CarState
  carries no velocity vector. `bf-cool` (default on) anneals each island's
  `rate`/`maxShift` from the configured values to 1 as it stalls and resets on every new
  best (`bfMutStrength`), so a search transitions from finding the line to polishing it
  without retuning the sliders. Both mirrored into the snapshot worker (`_algnSp`,
  `cfg.align`).
- **BF dispatch cost:** (a) the snapshot worker's track context + cfg now ship once per
  run via `__bfInit` instead of on every `__bfSnap` (`mountainVertices` is a plain Array
  of up to ~57k doubles — cloning it per variant was capping runs/sec on the main
  thread); (b) `bfMutate` builds its in-window frame list **once** and maintains it in
  place instead of rescanning the whole map per mutation (was O(map × rate) per variant);
  (c) `_tasRawCtrls` reuses one controls object instead of allocating per simulated
  frame. Snapshot readout also now matches the documented 3-decimal precision.
- **Panel edge/corner resize:** replaced CSS `resize:both` (corner only) with 8
  custom `.tas-rz` handles (N/S/E/W + corners) in `buildPanel`; zoom-aware like the
  header drag (deltas ÷ `currentScale()`; W/N edges also move `left`/`top`), clamped
  to `[300,150]`..`97vw/vh`, persisted via `saveGeo`. Hover highlight + SE grip.
- **Bruteforce tap-parameter editing:** BF variant is now `{map,taps}`; a new
  `bf-tapedit` mode mutates `tap` macro parameters (start/end/keys/on/off) with 5
  per-part weights (`bf-tw-*`). Off = expand & free-edit; on + all-zero = protect
  (replaces the old `protectTaps` checkbox). See § 11.
- **Ported in from the base tool (these sessions):** shared **Speed decimals** setting
  (`settings.speedDecimals`, 0–5, default 3) driving the TAS overlay (`fmtSpeed`) **and
  the game's own speedometer** (`main.bundle.js` speedometer hook via
  `window.__TAS_speedDecimals`, § 12); **Interface size** setting (`settings.scale`,
  100–200%, CSS `zoom` on overlay+panel, zoom-aware drag, on-show re-nudge);
  **trigger-box** `.trbox` card layout (no longer squished); **bruteforce live-stats**
  grid (runs/sec, elapsed, workers, pending, iters-left, since-best, …); **3-decimal**
  bruteforce new-best readout (`bfDescribeAcc` + Best line/score).
