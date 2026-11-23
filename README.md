# WireCAM

Wire-cut EDM CAD/CAM for **Electronica / ELCam** controllers (Mo wire machines).
Draw or import a DXF, define the wire path step by step, and save a ready-to-run `.WC` program.

- **1 DRAW**: CAD tools (line, rectangle, circle, arcs, polygon, slot, involute gear, trim, extend, fillet, chamfer, break, join, offset, move, copy, rotate, mirror, scale, array), grip editing, snaps, layers, gap check, constraints (coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, symmetric, fix) and driving dimensions.
- **2 WIRE PATH**: start point, lead-in point (= program zero X0 Y0), direction by choosing the first line, junction choices, break points (HOLD M0 / STOP), offset side G41/G42, passes with purpose and offset, lead-out, taper (G51/G52 or 4-axis G74 XY/UV) with a 3D view.
- **3 PROGRAM**: generated and checked program, simulation, save as `EMT####.WC`; any existing `.WC` can be opened and simulated.

## Run from source

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install          # downloads Electron and the build tools
npm start            # runs WireCAM from the source folder
npm test             # unit tests of the core (G-code, DXF, chaining, solver …)
```

`app/index.html` also opens directly in Chrome / Edge (saving then uses browser downloads).

## Build the Windows app

```bash
npm run build:win    # → dist/WireCAM-win32-x64/WireCAM.exe (portable, no installer)
npm run build:web    # → dist/WireCAM-web.html (single file)
```

Zip `dist/WireCAM-win32-x64` and copy it to the machine PC. Users unzip and double-click `WireCAM.exe`.
To release a new version, change `"version"` in `package.json` (it is written into the exe) and add a line to `CHANGELOG.md`.

## Folder layout

```
app/                 the application (plain HTML/CSS/JS, no framework, no build step)
  index.html
  css/app.css
  js/core.js         geometry, DXF import/export, chaining, offsets, G-code generator + parser,
                     constraint solver, gear generator  (no DOM – also runs in Node for tests)
  js/app.js          state, view, rendering, snapping, mouse/keyboard, undo, files
  js/cad.js          DRAW mode tools and panel
  js/constraints.js  constraints, dimensions, grip editing
  js/pathui.js       WIRE PATH mode (cuts, lead-in, path, breaks, offset, passes, lead-out, taper)
  js/view3d.js       3D taper view
  js/progui.js       PROGRAM mode (generate, check, simulate, save)
  js/main.js         mode switching, toolbar, settings, help, start-up
  js/icons.js        SVG icons
  js/sample.js       demo drawing for the "Try a sample drawing" button
electron/            desktop shell (main process + preload: file dialogs, close guard)
assets/              icon.png / icon.ico (icon-source.html = how the icon was drawn)
scripts/             build-win.js, build-web.js
tests/               node:test unit tests + fixture programs
docs/                DEVELOPMENT.md (format decisions, design notes), READ-ME-FIRST.txt (shipped with the exe)
```

## Program format (summary)

Header `G71 G9 G27 G40 G47 G50 G90 G75`, offset table `D0=0`, `D1=…`; lead-in with `G41/G42 D0`, offset on with `Dn` at the shape, `D0` for the lead-out, `G40`, `M0`.
Arcs `G2`/`G3` with end point `X Y` and centre `I J` measured from the arc start. 4-axis taper: `G74 Z B T`, XY with UV on the same line (`G101`, `G102/G103` with `P Q`), `G75`.
Details and open points: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

© Core Carbide Technologies – internal use.
