# Space-Layer Intercept: physics-driven concept

**[Open the live demo](https://wasomma.github.io/space-layer-intercept/)**: it runs in the browser, on desktop or phone, with nothing to install.

A browser-based 3D visualization of a space-layer missile intercept, driven by a textbook
two-body simulation at true Earth scale. A missile launches from a mobile launcher at a generic
interior site, boosts under thrust and gravity, and coasts on a ballistic arc. A sensor
satellite in a high orbit detects it when it enters the sensor's field of view. The track is
handed through a relay satellite that has line of sight to both ends, to an interceptor
satellite in a low orbit. That satellite was chosen because it has the cheapest transfer to the
missile's future position; it releases a kill vehicle that performs the solved burn, coasts
along the transfer arc and meets the missile mid-course. Dark ops-centre look, scripted
cinematic camera, a scrubbable 90-second timeline with a separate time warp for each beat, and
the animation loops. Built with three.js and Vite in plain JavaScript ES modules, with no
framework, no model or texture files, and nothing loaded from a CDN at runtime.

> **Physics-driven concept. Generic parameters. Not a model of any real system.**
> The physics is textbook. Every vehicle, sensor and constellation parameter is a generic round
> number chosen for the picture; in the code each one is marked `illustrative`. No programme or
> system is named, and the parameters are not taken from any public figures for a specific
> missile, interceptor, sensor or constellation. Labels are generic. The globe shows land
> outlines only, with nothing labelled.

## What the simulation models

- **Earth.** A sphere of radius 6371 km with gravitational parameter 398600.4418 km^3/s^2,
  rotating at the sidereal rate. The scene uses 1 unit = 1 km throughout. ECI is the inertial
  frame (Y toward the north pole). ECEF rotates about Y and coincides with ECI at ignition. The
  globe and the launch site rotate with ECEF.
- **Constellation.** Two circular shells propagated by Kepler at their real periods. The
  interceptor shell has 6 planes of 12 satellites at 1000 km and 55 degrees. The sensor shell
  has 2 planes of 4 satellites at 10000 km and 60 degrees. The phase of each shell is chosen by
  the scenario builder so that an engagement exists.
- **Missile.** Three constant-acceleration thrust phases integrated with RK4 at 0.05 s under
  thrust and gravity, starting from the site's rotating-Earth velocity. The pitch program holds
  the vertical, then turns over in the plane of the launch azimuth. After burnout the missile
  coasts on universal-variable Kepler propagation, and impact is bisected to 0.01 s.
- **Detection.** The sensor satellite is the one whose nadir passes nearest the site. Its field of
  view is locked to the satellite, just off the point beneath it, so the footprint travels across
  the Earth with the satellite's ground track. Detection is the first time the missile is inside
  the field-of-view cone and the line of sight clears the Earth. The cone is drawn projected onto the Earth: each edge ray
  is intersected with the sphere, so the footprint lies on the curved surface.
- **Handoff.** The relay is the interceptor-shell satellite with line of sight to both the
  sensor satellite and the interceptor satellite at both handoff times, minimizing the summed
  range. Link latencies are fixed illustrative delays.
- **Engagement.** A universal-variable Lambert search over every interceptor-shell satellite,
  with release times and times of flight on a 10 s grid. It rejects transfer arcs that dip below
  150 km altitude, then picks the minimum delta-v. Over the four minutes before release the
  satellite slews its launch tube from nadir onto the departure direction: thrusters spin the
  turn up, it coasts, and opposing thrusters brake it. The kill vehicle leaves the tube
  co-moving with the satellite and its motor burns for 2 s along the solved departure
  direction, integrated with RK4 under gravity and thrust. At burnout the arc to the intercept
  point is re-solved and a small trim applied, and it coasts by Kepler to the intercept.
- **Time.** Seven beats map 90 animation seconds onto about 33 simulated minutes. Each beat has
  its own warp: Launch and Intercept run in real time. Engage eases its pace: it slows into a 0.6x
  slow motion around the release so the launch out of the tube can be watched, speeds up through
  the coast (about 110x at its fastest), and slows smoothly to real time as the intercept nears.

Left out: J2 and every other gravity harmonic, drag and atmosphere, staging, guidance and
terminal homing (the kill vehicle flies its Lambert arc exactly), sensor noise, track filtering,
link budgets, attitude dynamics (the slew follows a prescribed spin-up, coast and brake
profile), third-body effects, and any notion of real system performance.

## Illustrative outcomes

These are the numbers the generic model produces with the tuned `DEFAULT_PARAMS` in
`src/sim/scenario.js`. They are outcomes of round illustrative inputs, not data about anything
real.

| Quantity | Value |
|---|---|
| Thrust phases | 0.035, 0.045, 0.065 km/s^2 for 60 s each; pitch-over to 0 degrees at T+150 s |
| Burnout | T+180 s, 6.77 km/s inertial, 314 km altitude |
| Coast | apogee 1202 km at T+982 s; impact T+1914 s; range 8986 km |
| Shell phases | sensor 0 degrees, interceptor 28 degrees |
| Detection and track | T+3 s, T+18 s (8 degree cone) |
| Handoff and assignment | T+38 s, T+58 s, T+78 s |
| Release and intercept | T+348 s, T+1048 s (700 s time of flight), intercept altitude 1196 km |
| Pre-release slew | 124.5 degrees over 240 s, peak 0.65 deg/s |
| Kill-vehicle burn | 2 s at 12.9 g, plus a 0.43 m/s trim at burnout |
| Kill-vehicle delta-v | 0.25 km/s |
| Closing speed | 2.39 km/s |
| Beat warps | 5.6, 1, 2, 4.2, 43.3, 1, 149.3 |

`npm run check` prints the same summary from a fresh build of the scenario.

## Run

```bash
npm install
```

```bash
npm run dev
```

The dev server opens on `http://localhost:5173` (strict port). It also serves two dev
harnesses beside the app:

- `/dev/scene.html?t=60` renders the 3D scene alone from hand-made sample states (add
  `&orbit=1` for free orbit, `&anim=1` to run the clock).
- `/dev/hud.html` exercises the overlay against a fake clock.

## Build

```bash
npm run build
```

```bash
npm run preview
```

`npm run build` writes a static site to `dist/` with relative asset paths, so it opens from any
folder or static host. `npm run preview` serves that folder locally. The live demo is this build,
published to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.

```bash
npm run build:artifact
```

`npm run build:artifact` builds a variant into `.build-artifact/` for hosts that only run scripts
from a short list of CDNs: the same code, with three.js loaded from jsDelivr at the pinned version
through an import map (`scripts/artifact-page.html`) instead of bundled. Publish its
`index.html`, `assets/app.js` and `assets/app.css`.

## Test and check

```bash
npm run test
```

```bash
npm run check
```

`npm run test` runs the physics-core unit tests with `node:test`:

- Kepler propagation: circular, elliptic and hyperbolic cases, plus conservation of energy and
  angular momentum.
- Lambert: a circular quarter orbit, and a Hohmann transfer against its closed form.
- RK4 against Kepler.
- Line-of-sight and cone geometry.
- Frame round trips.

`npm run check` builds the scenario under Node and asserts:

- range and apogee within their bands;
- detection within the first minute;
- event order;
- the kill vehicle meets the missile within 1 m;
- delta-v within its cap, and the transfer arc above its floor;
- relay and beam line of sight;
- every state field finite at 0.1 s steps over the run;
- trail lengths, fresh state objects, camera clearance, contiguous beats, actor visibility.

## Controls

| Input | Action |
|---|---|
| Space | Play / pause |
| Left / Right arrow | Previous / next beat (Left restarts the current beat when more than 1 s into it) |
| C | Toggle free camera (drag to orbit, wheel to zoom, about the scripted camera's target at toggle time; the scripted camera resumes when toggled off) |
| R | Replay from the start |
| Transport bar | Play/pause, 0.5x 1x 2x speed, scrubber in animation time with the seven beat markers, FREE CAM |
| Summary card | Shown during the final beat with each beat's mission time, and a REPLAY button |

The top right shows the mission clock in simulated time (`T-mm:ss` before ignition), the
current warp (`REAL TIME` at 1x) and the beat. The bottom right lists live readouts for the
current beat, all computed from the simulation:
- **Constellation:** the shells' altitudes, orbital speeds and periods.
- **Launch, before ignition:** the site's position and its speed from the Earth's rotation.
- **Launch and boost:** threat altitude, speed, thrust in g, flight-path angle, downrange
  distance and sensor range.
- **Handoff:** the two link ranges with their light-time delay.
- **Engage and intercept:** satellite altitude and speed, slew rate, kick-burn acceleration,
  separation speed, kill-vehicle speed, time to go, closing speed and range.
- **Resolution:** an engagement summary.

The bottom left logs events stamped in mission time.

After the launch the camera pulls out to a course view above the two flight paths. Dashed lines show where the kill vehicle and the threat are headed: their own future positions from the simulation, ending at the intercept point. The view tightens as the two close and stays on that angle through the intercept and the debris, then pulls back for the summary.

For scripting or verification from the browser console, `window.__viz` exposes:

- playback: `seek(t)`, `play()`, `pause()`, `setSpeed(s)`, `freeCam(bool)`, `jumpBeat(id)`;
- time: `t()`, `simT()`;
- state: `states()`, `origin()`, `scenario`, `timeline`;
- `step(dt, n)`, which runs frames synchronously when the page is not animating.

## Module map

| Path | Role |
|---|---|
| `index.html` | Full-viewport canvas plus the label and HUD layers |
| `src/main.js` | Wiring: renderer with a logarithmic depth buffer, simulation, master clock, scene, floating origin, scripted camera with anchor-relative smoothing and shake, free-orbit toggle, HUD callbacks, resize, `window.__viz` |
| `src/shared/constants.js` | Earth radius, gravitational parameter, rotation rate, degree and g0 constants |
| `src/shared/geo.js` | Lat/lon to vectors, ECI/ECEF rotation, site velocity, local east-north-up frames, great-circle helpers |
| `src/shared/easing.js`, `palette.js` | Scalar easing helpers; the colour palette as constants and CSS custom properties |
| `src/sim/kepler.js` | Universal-variable Kepler propagation, circular orbit states, period, apsides |
| `src/sim/lambert.js` | Universal-variable Lambert solver |
| `src/sim/integrate.js` | RK4 step and two-body gravity |
| `src/sim/los.js` | Segment-sphere line of sight, cone containment, nadir direction |
| `src/sim/scenario.js` | `DEFAULT_PARAMS` and `buildScenario`: boost integration, coast, detection, relay choice, the engagement and phase searches, the event log |
| `src/sim/timeline.js` | The seven beats, per-beat warp, the animation-simulation time mapping, `KEY_TIMES` |
| `src/sim/states.js` | `computeStates(animT)`: every actor's state, trails, beams, labels, effects and readouts for one frame |
| `src/sim/camera.js` | The scripted camera, one shot per beat with a hard cut at each beat start |
| `src/sim/clock.js`, `index.js` | The master clock; the `createSimulation` entry point |
| `src/scene/index.js` | The three.js scene, multisampled bloom composer and CSS2D label renderer; fans states out to the actors with the floating origin |
| `src/scene/earth.js`, `starfield.js`, `constellation.js` | The rotating globe with land outlines, graticule and atmosphere rim; stars; both shells as fixed-pixel markers with small bodies and camera-relative orbit rings |
| `src/scene/terrain.js`, `launcher.js` | The woodland tile at the launch site; the eight-axle launcher with erecting canister |
| `src/scene/missile.js`, `kv.js`, `satellite.js` | The missile and kill vehicle with plumes and trails; satellites with halos, the launch tube and reaction-control puffs |
| `src/scene/beam.js` | The sensor's field of view projected onto the Earth: walls to the ground, footprint on the curved surface |
| `src/scene/course.js` | The projected course in the Engage beat: dashed paths of the kill vehicle and the threat to the intercept point, and its marker |
| `src/scene/links.js`, `interceptFx.js`, `labels.js`, `util.js` | Handoff beams and the track line; the intercept flash, ring and burst; CSS2D labels; shared sprites, trails and helpers |
| `src/hud/index.js`, `hud.css` | The DOM overlay: title, mission clock, warp badge, readouts, transport, scrubber, event log, summary card, keyboard; label styling |
| `scripts/check-scenario.mjs` | The Node check described above |
| `scripts/build-artifact.mjs`, `artifact-page.html` | The CDN-hosted build variant (`npm run build:artifact`) and its page |
| `tests/*.test.mjs` | Physics-core unit tests |
| `dev/scene.*`, `dev/hud.*` | Dev harnesses for the scene and the HUD |
| `.github/workflows/pages.yml` | Tests, checks, builds and publishes the live demo on every push to `main` |

## Re-timing and re-tuning

Animation time and simulation time are separate. The animation boundaries of the seven beats
(0, 10, 24, 38, 50, 76, 83, 90 s) are fixed in `BEAT_TABLE` in `src/sim/timeline.js`. The
simulation time each beat starts and ends at comes from the scenario: for example, Engage runs
from 10 s after target assignment to 3 s before the intercept. The warp of each beat follows from
the two, so moving an animation boundary changes only how fast that stretch plays, and every
state, label, event and camera move follows automatically. A beat can also be split into
segments with a warp at each end, eased between them: `RELEASE_SLOWMO` in the same file sets the
slow-motion window around the release. `KEY_TIMES` lists every anchor in both
times. To change the physical story, change `DEFAULT_PARAMS` in `src/sim/scenario.js`: thrust
phases, pitch program, shells, sensor cone, latencies and the engagement search window. Then
run `npm run check`; it confirms the range and apogee bands, the event order, the meeting at the
intercept and the rest. Camera framing per beat lives in `src/sim/camera.js`.

## Notes

Code comments sometimes cite numbered sections (for example 4.2 or 5.7) of the original design
specification, which is not part of this repository.

## License

Licensed under the [PolyForm Strict License 1.0.0](LICENSE.md): you may use and run the software
for any permitted purpose, but not distribute it or make changes or new works based on it.
