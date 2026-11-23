# WireCAM – development notes

## Program format decisions
Taken from the ELCam sample programs and the controller's "G M Codes" list.

- Header `G71 G9 G27 G40 G47 G50 G90 G75`, then `; Wire Compensation Definitions`, `D0=0`, `D1..Dn` (one D per distinct offset value across all cuts and passes). Optional `E<code>` per pass (machining condition).
- **Program zero** = lead-in point of the first cut (`settings.originPt`). The program starts with `G0 <start point> U0 V0` and `M0` (thread the wire). Without `originPt` the generator uses the start point – regenerating the sample programs EMT0130 / EMT0107 then gives byte-identical code (see tests).
- Lead-in with `G41/G42 D0`; the offset is switched on (`Dn`) at the join point on the shape (or at a chosen point); `D0` again before the lead-out; `G40`; `M0`.
- Arcs: `G2` clockwise / `G3` anti-clockwise, `X Y` end point, `I J` = centre minus arc **start** point. Arcs over 180° are split.
- Default offset D = 0.10 mm (Ø0.18 Mo wire / 2 + 0.01 spark gap → 0.20 slot).
- `G41` = wire on the LEFT of the travel direction.
- Passes (`job.passMode`): closed loop `loop` (one lead-in, the loop continues with the next D), open path `reverse` (every 2nd pass backward with G41⇄G42 and G51⇄G52 swapped), or `restart` (back to the start point, lead in again). The slug `M0` is on pass 1.
- Break points (`job.breaks`): `hold` → `M0` at that distance (pass 1 or every pass); `stop` → path ends there (treated as an open path) and the lead-out starts there.
- Taper: `G51/G52 A<angle> W<height of drawn size> Z<guide distance>` … `G50` before the lead-out; or 4-axis `G74 Z B T` with XY (bottom) and UV (top) on one line (`G100–G103`, `P Q` = UV arc centre from the UV start), closed with `G75`.
- **Not confirmed on the machine yet:** meaning of W and Z in G51/G52, B in G74, and which of G51/G52 is which side ("Swap G51 ⇄ G52" checkbox). Make the first taper job a test cut.

## Architecture
- `core.js` has no DOM access and is shared by the browser and Node (`module.exports`). Everything that decides the G-code lives there and is unit-tested.
- Segments: `{t:'L', p0, p1}` or `{t:'A', p0, p1, c, r, ccw, full}`. Drawing entities: `line {a,b}`, `arc {c,r,a0,a1}` (a0→a1 anti-clockwise), `circle {c,r}`.
- Chaining: `Chainer.fromPoint` splits entities at the lead-in point and at T-junctions, then grows one way; at every node with more than one way it returns `junction` and the UI asks the user.
- Offsets for preview and taper: `offsetPath` (round joins for wire compensation preview, miter joins for taper top faces).
- Different top shape (G74): bottom and top chains are paired by projecting vertices onto each other (longest monotone sequence), falling back to length fractions.
- Constraint solver: Levenberg–Marquardt with a sparse numeric Jacobian, conjugate-gradient steps and minimum-change regularisation; only the connected components that changed are solved; quick mode while dragging.
- Project files (`.wcam`) are JSON: `{app:'WireCAM', version, ents, cons, hidden, jobs, prog, cur}`. Work is also auto-saved to localStorage.

## Ideas / not done
- ELCam `.prf` import (binary MFC archive with `GLineSeg`, `GArc`, `GPolyLine`).
- Installer (NSIS) instead of the portable zip.
- Fillet/chamfer between line and arc; gear undercut; kerf width in the 3D view.
