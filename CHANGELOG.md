# Changelog

## 1.5.0 – 21-11-26
- Passes: closed loops continue around the loop; open paths go back on the same path (G41/G42 swapped) or straight back to the start. Choice shown in the Passes card.
- Taper: RESULT sizes (e.g. Ø10.000 → Ø10.698) and a 3D view (job, bottom/top faces, cut surface, wire); "drawn size at bottom/top face".

## 1.4.0 – 21-11-26
- Lead-in point = program zero X0 Y0 (shown on the drawing, PROG coordinates in the status bar).
- Break points on the path: HOLD (M0, continue) and STOP (cut only up to here, lead-out chosen there).

## 1.3.0 – 20-11-26
- DRAW: Extend, Slot, Gear, Join, Scale, Array, grip editing, perpendicular/tangent snaps.
- Constraints bar (RULES) and driving dimensions with a numeric solver.

## 1.2.0 – 20-11-26
- Lead-in point can be any point (join point picked on the shape). Lead-out: back to start / wire stays / other point.

## 1.1.0 – 20-11-26
- New wire-path flow: start point → lead-in → first line sets direction → junction choices → offset side → passes (purpose, D, E code).

## 1.0.0 – 20-11-26
- First version: DXF import, CAD tools, wire path wizard, taper G51/G52 and G74, program generation, simulation, .WC viewer, Windows app.
