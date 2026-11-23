/* WireCAM – DRAW mode: CAD tools, selection, layers, DXF import */
(function () {
'use strict';
const { V } = WC; const { S, $, $$, esc, r3, num, toast, hint } = App;
const D2R = Math.PI / 180;
const opt = { rectR: 0, rectCentre: false, polySides: 6, filletR: 1, chamferD: 1, offsetD: 1, mirrorKeep: true, gapTol: 0.05, extLen: 0, scaleF: 2, arrMode: 'rect', arrCols: 3, arrRows: 1, arrDx: 10, arrDy: 10, arrN: 6, arrAng: 360, arrRot: true, slotW: 6, gM: 1, gZ: 20, gPA: 20, gX: 0, gBore: 0 };

// ------------------------------------------------------------------ helpers
const ents = () => S.ents;
function addEnts(list) { list.forEach(e => S.ents.push(e)); }
function byId(id) { return S.ents.find(e => e.id === id); }
function removeIds(ids) { const set = new Set(ids); S.ents = S.ents.filter(e => !set.has(e.id)); ids.forEach(i => S.sel.delete(i)); if (S.cons.length) S.cons = S.cons.filter(c => !c.refs.some(r => set.has(r.e))); }
function selEnts() { return S.ents.filter(e => S.sel.has(e.id)); }
function curLayer() { return '0'; }
function rectEnts(a, b, r) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y); const L = curLayer();
  r = Math.max(0, Math.min(r || 0, (x1 - x0) / 2 - 1e-9, (y1 - y0) / 2 - 1e-9));
  if (r <= 1e-9) return [WC.mkLine({ x: x0, y: y0 }, { x: x1, y: y0 }, L), WC.mkLine({ x: x1, y: y0 }, { x: x1, y: y1 }, L), WC.mkLine({ x: x1, y: y1 }, { x: x0, y: y1 }, L), WC.mkLine({ x: x0, y: y1 }, { x: x0, y: y0 }, L)];
  const P = Math.PI;
  return [WC.mkLine({ x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }, L), WC.mkArc({ x: x1 - r, y: y0 + r }, r, -P / 2, 0, L),
    WC.mkLine({ x: x1, y: y0 + r }, { x: x1, y: y1 - r }, L), WC.mkArc({ x: x1 - r, y: y1 - r }, r, 0, P / 2, L),
    WC.mkLine({ x: x1 - r, y: y1 }, { x: x0 + r, y: y1 }, L), WC.mkArc({ x: x0 + r, y: y1 - r }, r, P / 2, P, L),
    WC.mkLine({ x: x0, y: y1 - r }, { x: x0, y: y0 + r }, L), WC.mkArc({ x: x0 + r, y: y0 + r }, r, P, 1.5 * P, L)].filter(e => e.type !== 'line' || V.dist(e.a, e.b) > 1e-9);
}
function polyEnts(c, p, n) { const R = V.dist(c, p), a0 = WC.angOf(c, p); const pts = []; for (let i = 0; i < n; i++) pts.push(WC.onCircle(c, R, a0 + i * 2 * Math.PI / n)); return pts.map((q, i) => WC.mkLine(q, pts[(i + 1) % n], curLayer())); }
function arc3(a, b, c) {
  const ctr = WC.circle3(a, b, c); if (!ctr) return null; const r = V.dist(ctr, a);
  const ccw = V.cross(V.sub(b, a), V.sub(c, b)) > 0; const aa = WC.angOf(ctr, a), ac = WC.angOf(ctr, c);
  return ccw ? WC.mkArc(ctr, r, aa, ac, curLayer()) : WC.mkArc(ctr, r, ac, aa, curLayer());
}
function previewEnts(list, color) { const ctx = App.ctx; list.forEach(e => App.strokePath([WC.entSeg(e)], color || '#ffe14d', 1.6, [6, 4])); }
function lastBase() { return S.ts.base || S.ts.p0 || null; }
function mouseP() { return App.ortho(lastBase(), S.mouse.w); }
function transformSel(f, mirror, copy) {
  const list = selEnts(); if (!list.length) return [];
  App.pushUndo();
  const out = list.map(e => { const t = WC.transformEnt(e, f, mirror); if (copy) { t.id = WC.newId(); } return t; });
  if (copy) { addEnts(out); } else { out.forEach(t => { const i = S.ents.findIndex(e => e.id === t.id); S.ents[i] = t; });
    const ids = out.map(t => t.id); if (!App.solveAround(ids, { fixed: ids, strict: true })) { App.revertLast(); toast('Blocked by constraints (for example a FIXED item or a horizontal/vertical rule). Remove the constraint first.', 'e', 5000); return []; } }
  App.markChanged(); return out;
}
// parameter of point on entity: line t (0..1), arc angle offset from a0 (0..sweep), circle angle (0..2pi)
function entParam(e, p) { if (e.type === 'line') return WC.segNearest(WC.entSeg(e), p).t; const a = WC.normPos(WC.angOf(e.c, p) - (e.type === 'arc' ? e.a0 : 0)); return a; }
function entSweep(e) { return e.type === 'arc' ? (WC.normPos(e.a1 - e.a0) || 2 * Math.PI) : 2 * Math.PI; }

// ------------------------------------------------------------------ tools
const T = {};
T.select = {
  prompt: () => S.sel.size ? S.sel.size + ' selected. Del = delete, Esc = clear. Drag a box to select more (Shift = add).' : 'Click a line/arc to select it, or drag a box. Choose a tool on the left to draw.',
  click(p, sx, sy, d) { const e = App.pickEnt(sx, sy); if (!e) { if (!d.shift && !d.ctrl) S.sel.clear(); } else if (d.shift || d.ctrl) { S.sel.has(e.id) ? S.sel.delete(e.id) : S.sel.add(e.id); } else { S.sel.clear(); S.sel.add(e.id); } refresh(); },
};
T.line = {
  ph: (ts) => ts.p0 ? 'Length (e.g. 25) or @dx,dy or @L<angle or x,y' : 'Start point x,y (e.g. 0,0)',
  prompt: (ts) => ts.p0 ? 'Click END point of the line – or type a length. Right-click / Esc = finish.' : 'Click START point of the line (or type x,y and Enter).',
  click(p, ts) { if (!ts.p0) { ts.p0 = p; ts.first = p; return; } this.add(App.ortho(ts.p0, p), ts); },
  add(q, ts) { if (V.dist(ts.p0, q) < 1e-9) return; App.pushUndo(); addEnts([WC.mkLine(ts.p0, q, curLayer())]); ts.p0 = q; App.markChanged(); },
  typed(v, ts) { if (!ts.p0) { if (v.kind === 'point') { ts.p0 = v.p; ts.first = v.p; return true; } return false; }
    if (v.kind === 'point') { this.add(v.p, ts); return true; }
    if (v.kind === 'number') { const dir = V.unit(V.sub(mouseP(), ts.p0)); if (V.len(V.sub(mouseP(), ts.p0)) < 1e-9) return false; this.add(V.add(ts.p0, V.mul(dir, v.v)), ts); return true; } return false; },
  preview(ts) { if (ts.p0) { const q = mouseP(); App.strokePath([WC.segL(ts.p0, q)], '#ffe14d', 1.5, [6, 4]); App.label(q, 'L ' + r3(V.dist(ts.p0, q)) + '  ∠' + (Math.atan2(q.y - ts.p0.y, q.x - ts.p0.x) / D2R).toFixed(1) + '°', '#ffe14d'); } },
};
T.rect = {
  ph: (ts) => ts.p0 ? 'Width,Height (e.g. 40,20)' : 'First corner x,y',
  prompt: (ts) => ts.p0 ? 'Click the OPPOSITE corner – or type width,height (e.g. 40,20).' : (opt.rectCentre ? 'Click the CENTRE of the rectangle (or type x,y).' : 'Click FIRST corner of the rectangle (or type x,y).'),
  click(p, ts) { if (!ts.p0) { ts.p0 = p; return; } this.make(ts.p0, p, ts); },
  make(a, b, ts) { let p0 = a, p1 = b; if (opt.rectCentre) { const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y); p0 = { x: a.x - dx, y: a.y - dy }; p1 = { x: a.x + dx, y: a.y + dy }; } if (Math.abs(p0.x - p1.x) < 1e-9 || Math.abs(p0.y - p1.y) < 1e-9) return; App.pushUndo(); addEnts(rectEnts(p0, p1, opt.rectR)); App.markChanged(); ts.p0 = null; },
  typed(v, ts) { if (!ts.p0) { if (v.kind === 'point') { ts.p0 = v.p; return true; } return false; }
    if (v.kind === 'point') { let w, h; if (v.rel || v.polar) { w = v.p.x - ts.p0.x; h = v.p.y - ts.p0.y; } else { w = v.p.x; h = v.p.y; } const m = mouseP(); const sx = m.x >= ts.p0.x ? 1 : -1, sy = m.y >= ts.p0.y ? 1 : -1;
      if (opt.rectCentre) this.make(ts.p0, { x: ts.p0.x + w / 2, y: ts.p0.y + h / 2 }, ts); else this.make(ts.p0, { x: ts.p0.x + sx * Math.abs(w), y: ts.p0.y + sy * Math.abs(h) }, ts); return true; } return false; },
  preview(ts) { if (!ts.p0) return; let a = ts.p0, b = S.mouse.w; if (opt.rectCentre) { const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y); b = { x: a.x + dx, y: a.y + dy }; a = { x: ts.p0.x - dx, y: ts.p0.y - dy }; } previewEnts(rectEnts(a, b, opt.rectR)); App.label(S.mouse.w, r3(Math.abs(b.x - a.x)) + ' × ' + r3(Math.abs(b.y - a.y)), '#ffe14d'); },
};
T.circle = {
  ph: (ts) => ts.c ? 'Radius (e.g. 5) or d10 for diameter' : 'Centre x,y',
  prompt: (ts) => ts.c ? 'Click a point on the circle – or type radius (5) or diameter (d10).' : 'Click the CENTRE of the circle (or type x,y).',
  click(p, ts) { if (!ts.c) { ts.c = p; return; } this.make(V.dist(ts.c, p), ts); },
  make(r, ts) { if (!(r > 1e-9)) return; App.pushUndo(); addEnts([WC.mkCircle(ts.c, r, curLayer())]); App.markChanged(); ts.c = null; },
  typed(v, ts) { if (!ts.c) { if (v.kind === 'point') { ts.c = v.p; return true; } return false; } if (v.kind === 'number' || v.kind === 'radius') { this.make(v.v, ts); return true; } if (v.kind === 'diameter') { this.make(v.v / 2, ts); return true; } if (v.kind === 'point') { this.make(V.dist(ts.c, v.p), ts); return true; } return false; },
  preview(ts) { if (!ts.c) return; const r = V.dist(ts.c, S.mouse.w); previewEnts([WC.mkCircle(ts.c, r)]); App.label(S.mouse.w, 'R ' + r3(r) + '  Ø ' + r3(2 * r), '#ffe14d'); },
};
T.arc3 = {
  ph: () => 'Point x,y',
  prompt: (ts) => ['Click FIRST end of the arc.', 'Click a point ON the arc (middle).', 'Click the OTHER end of the arc.'][(ts.pts || []).length],
  click(p, ts) { ts.pts = ts.pts || []; ts.pts.push(p); if (ts.pts.length === 3) { const a = arc3(ts.pts[0], ts.pts[1], ts.pts[2]); if (a) { App.pushUndo(); addEnts([a]); App.markChanged(); } else toast('Points are in a straight line', 'w'); ts.pts = []; } },
  typed(v, ts) { if (v.kind === 'point') { this.click(v.p, ts); return true; } return false; },
  preview(ts) { const p = ts.pts || []; if (p.length === 1) App.strokePath([WC.segL(p[0], S.mouse.w)], '#ffe14d', 1, [4, 4]); if (p.length === 2) { const a = arc3(p[0], p[1], S.mouse.w); if (a) { previewEnts([a]); App.label(S.mouse.w, 'R ' + r3(a.r), '#ffe14d'); } } },
};
T.arcc = {
  ph: (ts) => ts.c && ts.s ? 'End angle sweep in degrees (e.g. 90)' : 'Point x,y',
  prompt: (ts) => !ts.c ? 'Click the CENTRE of the arc.' : !ts.s ? 'Click the START point of the arc (sets radius).' : 'Click the END point (arc goes anti-clockwise) – or type the angle (e.g. 90).',
  click(p, ts) { if (!ts.c) { ts.c = p; return; } if (!ts.s) { if (V.dist(ts.c, p) < 1e-9) return; ts.s = p; return; } this.make(WC.angOf(ts.c, p), ts); },
  make(aEnd, ts) { const r = V.dist(ts.c, ts.s), a0 = WC.angOf(ts.c, ts.s); App.pushUndo(); addEnts([WC.mkArc(ts.c, r, a0, aEnd, curLayer())]); App.markChanged(); ts.c = ts.s = null; },
  typed(v, ts) { if (v.kind === 'point') { this.click(v.p, ts); return true; } if (v.kind === 'number' && ts.c && ts.s) { this.make(WC.angOf(ts.c, ts.s) + v.v * D2R, ts); return true; } return false; },
  preview(ts) { if (ts.c && !ts.s) App.strokePath([WC.segL(ts.c, S.mouse.w)], '#ffe14d', 1, [4, 4]); if (ts.c && ts.s) { const r = V.dist(ts.c, ts.s); previewEnts([WC.mkArc(ts.c, r, WC.angOf(ts.c, ts.s), WC.angOf(ts.c, S.mouse.w))]); } },
};
T.polygon = {
  ph: (ts) => ts.c ? 'Corner radius (distance centre→corner)' : 'Centre x,y',
  prompt: (ts) => ts.c ? 'Click a CORNER of the polygon (' + opt.polySides + ' sides) – or type centre-to-corner distance.' : 'Click the CENTRE of the polygon.',
  click(p, ts) { if (!ts.c) { ts.c = p; return; } if (V.dist(ts.c, p) < 1e-9) return; App.pushUndo(); addEnts(polyEnts(ts.c, p, opt.polySides)); App.markChanged(); ts.c = null; },
  typed(v, ts) { if (!ts.c) { if (v.kind === 'point') { ts.c = v.p; return true; } return false; } if (v.kind === 'number') { this.click({ x: ts.c.x + v.v, y: ts.c.y }, ts); return true; } return false; },
  preview(ts) { if (ts.c && V.dist(ts.c, S.mouse.w) > 1e-9) previewEnts(polyEnts(ts.c, S.mouse.w, opt.polySides)); },
};
function corner(ts, mode) { // fillet / chamfer between two lines
  const [e1, e2] = [byId(ts.e1), byId(ts.e2)]; if (!e1 || !e2) return;
  if (e1.type !== 'line' || e2.type !== 'line') { toast('Fillet / chamfer works between two straight lines.', 'w'); return; }
  const X = WC.curveInter(WC.entSeg(e1), WC.entSeg(e2))[0]; if (!X) { toast('Lines are parallel', 'w'); return; }
  const far = (e, c) => { const n = WC.segNearest(WC.entSeg(e), c); const u = V.sub(c, X); const da = V.dot(V.sub(e.a, X), u), db = V.dot(V.sub(e.b, X), u); return da > db ? e.a : e.b; };
  const f1 = far(e1, ts.c1), f2 = far(e2, ts.c2); const u1 = V.unit(V.sub(f1, X)), u2 = V.unit(V.sub(f2, X));
  const th = Math.acos(Math.max(-1, Math.min(1, V.dot(u1, u2)))); if (th < 1e-6 || th > Math.PI - 1e-6) { toast('Lines are in a straight line', 'w'); return; }
  App.pushUndo();
  if (mode === 'fillet' && opt.filletR > 0) {
    const R = opt.filletR, t = R / Math.tan(th / 2); if (t > V.dist(X, f1) + 1e-9 || t > V.dist(X, f2) + 1e-9) { App.undo(); toast('Radius too big for these lines', 'w'); return; }
    const T1 = V.add(X, V.mul(u1, t)), T2 = V.add(X, V.mul(u2, t)); const bis = V.unit(V.add(u1, u2)); const C = V.add(X, V.mul(bis, R / Math.sin(th / 2)));
    const a1 = WC.angOf(C, T1), a2 = WC.angOf(C, T2); const arc = WC.normPos(a2 - a1) < Math.PI ? WC.mkArc(C, R, a1, a2, e1.layer) : WC.mkArc(C, R, a2, a1, e1.layer);
    e1.a = f1; e1.b = T1; e2.a = f2; e2.b = T2; addEnts([arc]);
  } else if (mode === 'chamfer' && opt.chamferD > 0) {
    const d = opt.chamferD; if (d > V.dist(X, f1) + 1e-9 || d > V.dist(X, f2) + 1e-9) { App.undo(); toast('Chamfer too big for these lines', 'w'); return; }
    const C1 = V.add(X, V.mul(u1, d)), C2 = V.add(X, V.mul(u2, d)); e1.a = f1; e1.b = C1; e2.a = f2; e2.b = C2; addEnts([WC.mkLine(C1, C2, e1.layer)]);
  } else { e1.a = f1; e1.b = X; e2.a = f2; e2.b = X; }
  App.pruneConstraints(); App.markChanged();
}
T.fillet = {
  ph: () => 'Radius (e.g. 2)', prompt: (ts) => ts.e1 ? 'Click the SECOND line.' : 'Fillet R' + opt.filletR + ': click the FIRST line near the corner. (Type a number to change radius. R0 = sharp corner)',
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy); if (!e) return; if (!ts.e1) { ts.e1 = e.id; ts.c1 = S.mouse.raw; S.sel.clear(); S.sel.add(e.id); return; } if (e.id === ts.e1) return; ts.e2 = e.id; ts.c2 = S.mouse.raw; corner(ts, 'fillet'); S.sel.clear(); ts.e1 = ts.e2 = null; },
  typed(v) { if (v.kind === 'number' || v.kind === 'radius') { opt.filletR = Math.max(0, v.v); refresh(); return true; } return false; }, snapOff: true,
};
T.chamfer = {
  ph: () => 'Distance (e.g. 1)', prompt: (ts) => ts.e1 ? 'Click the SECOND line.' : 'Chamfer ' + opt.chamferD + ' mm: click the FIRST line near the corner. (Type a number to change size)',
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy); if (!e) return; if (!ts.e1) { ts.e1 = e.id; ts.c1 = S.mouse.raw; S.sel.clear(); S.sel.add(e.id); return; } if (e.id === ts.e1) return; ts.e2 = e.id; ts.c2 = S.mouse.raw; corner(ts, 'chamfer'); S.sel.clear(); ts.e1 = ts.e2 = null; },
  typed(v) { if (v.kind === 'number') { opt.chamferD = Math.max(0, v.v); refresh(); return true; } return false; }, snapOff: true,
};
function trimAt(e, p) {
  const others = App.visibleEnts().filter(o => o.id !== e.id); const seg = WC.entSeg(e); const params = [];
  for (const o of others) WC.segInter(seg, WC.entSeg(o), 1e-6).forEach(q => params.push(entParam(e, q)));
  const pc = entParam(e, p); const L = e.type === 'line' ? 1 : entSweep(e);
  const eps = e.type === 'line' ? 1e-7 : 1e-7;
  if (e.type === 'circle') {
    const ps = [...new Set(params.map(x => Math.round(x * 1e9) / 1e9))].sort((a, b) => a - b); if (ps.length < 2) return null;
    let lo = null, hi = null; for (const x of ps) { if (x < pc) lo = x; if (x > pc && hi === null) hi = x; } if (lo === null) lo = ps[ps.length - 1]; if (hi === null) hi = ps[0];
    return [WC.mkArc(e.c, e.r, hi, lo, e.layer)];
  }
  let lo = 0, hi = L; for (const x of params) { if (x > eps && x < pc - eps && x > lo) lo = x; if (x < L - eps && x > pc + eps && x < hi) hi = x; }
  if (lo <= eps && hi >= L - eps) return null;
  const out = [];
  if (e.type === 'line') { const P = (t) => V.lerp(e.a, e.b, t); if (lo > eps) out.push(WC.mkLine(e.a, P(lo), e.layer)); if (hi < L - eps) out.push(WC.mkLine(P(hi), e.b, e.layer)); }
  else { if (lo > eps) out.push(WC.mkArc(e.c, e.r, e.a0, e.a0 + lo, e.layer)); if (hi < L - eps) out.push(WC.mkArc(e.c, e.r, e.a0 + hi, e.a1, e.layer)); }
  return out;
}
T.trim = {
  ph: () => '', prompt: () => 'Click the PIECE of a line/arc you want to cut away (between crossings).', snapOff: true,
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy); if (!e) return; const res = trimAt(e, S.mouse.raw); App.pushUndo(); removeIds([e.id]); if (res) addEnts(res); else toast('No crossing found – the whole item was removed (Undo = Ctrl+Z)', 'w'); App.pruneConstraints(); App.markChanged(); },
};
T.split = {
  ph: () => '', prompt: () => 'Click a POINT on a line/arc/circle to break it in two.',
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy, 12); if (!e) return; const q = WC.entNearest(e, p).pt; App.pushUndo(); let out;
    if (e.type === 'line') { const t = WC.segNearest(WC.entSeg(e), q).t; if (t < 1e-6 || t > 1 - 1e-6) { App.undo(); return toast('That is already an end point', 'w'); } out = [WC.mkLine(e.a, q, e.layer), WC.mkLine(q, e.b, e.layer)]; }
    else if (e.type === 'arc') { const a = WC.angOf(e.c, q); out = [WC.mkArc(e.c, e.r, e.a0, a, e.layer), WC.mkArc(e.c, e.r, a, e.a1, e.layer)]; }
    else { const a = WC.angOf(e.c, q); out = [WC.mkArc(e.c, e.r, a, a, e.layer)]; }
    removeIds([e.id]); addEnts(out); App.markChanged(); toast('Broken at point', 'o'); },
};
T.offset = {
  ph: () => 'Distance (e.g. 2)', prompt: (ts) => ts.e ? 'Click on the SIDE where the copy should go.' : 'Offset ' + opt.offsetD + ' mm: click the line/arc/circle to copy. (Type a number to change distance)',
  click(p, ts, sx, sy) { if (!ts.e) { const e = App.pickEnt(sx, sy); if (e) { ts.e = e.id; S.sel.clear(); S.sel.add(e.id); } return; } const e = byId(ts.e); if (!e) { ts.e = null; return; } const n = this.make(e, S.mouse.raw); if (n) { App.pushUndo(); addEnts([n]); App.markChanged(); } S.sel.clear(); ts.e = null; },
  make(e, p) { const d = opt.offsetD; if (e.type === 'line') { const u = V.unit(V.sub(e.b, e.a)), nl = V.perpL(u); const s = V.dot(V.sub(p, e.a), nl) >= 0 ? 1 : -1; const o = V.mul(nl, s * d); return WC.mkLine(V.add(e.a, o), V.add(e.b, o), e.layer); }
    const out = V.dist(p, e.c) > e.r; const r = e.r + (out ? d : -d); if (r <= 1e-9) { toast('Radius would become zero', 'w'); return null; } return e.type === 'circle' ? WC.mkCircle(e.c, r, e.layer) : WC.mkArc(e.c, r, e.a0, e.a1, e.layer); },
  typed(v) { if (v.kind === 'number') { opt.offsetD = Math.abs(v.v); refresh(); return true; } return false; },
  preview(ts) { if (ts.e) { const e = byId(ts.e); if (e) { const n = this.make(e, S.mouse.raw); if (n) previewEnts([n]); } } },
};
// tools working on a selection
function selTool(def) {
  return Object.assign({
    needSel: true,
    selPrompt: 'First SELECT the objects (click them or drag a box), then press Enter or right-click.',
  }, def);
}
T.move = selTool({
  ph: (ts) => ts.base ? 'Move distance dx,dy (e.g. 10,0)' : 'Base point x,y',
  prompt: (ts) => ts.base ? 'Click the NEW position – or type move distance dx,dy (e.g. 10,0).' : 'Click a BASE point (where to hold the objects).',
  click(p, ts) { if (!ts.base) { ts.base = p; return; } const q = App.ortho(ts.base, p); const d = V.sub(q, ts.base); transformSel(x => V.add(x, d), false, false); ts.base = null; App.setTool('select'); },
  typed(v, ts) { if (v.kind !== 'point') return false; if (!ts.base) { if (v.rel) { transformSel(x => V.add(x, V.sub(v.p, { x: 0, y: 0 })), false, false); App.setTool('select'); return true; } ts.base = v.p; return true; } const d = (v.rel || v.polar) ? V.sub(v.p, ts.base) : v.p; transformSel(x => V.add(x, d), false, false); ts.base = null; App.setTool('select'); return true; },
  preview(ts) { if (ts.base) { const d = V.sub(mouseP(), ts.base); previewEnts(selEnts().map(e => WC.transformEnt(e, x => V.add(x, d), false))); App.label(mouseP(), 'dX ' + r3(d.x) + '  dY ' + r3(d.y), '#ffe14d'); } },
});
T.copy = selTool({
  ph: (ts) => ts.base ? 'Copy distance dx,dy (e.g. 10,0)' : 'Base point x,y',
  prompt: (ts) => ts.base ? 'Click where to place the COPY – or type distance dx,dy. (Esc = stop copying)' : 'Click a BASE point.',
  click(p, ts) { if (!ts.base) { ts.base = p; return; } const d = V.sub(App.ortho(ts.base, p), ts.base); transformSel(x => V.add(x, d), false, true); },
  typed(v, ts) { if (v.kind !== 'point') return false; if (!ts.base) { ts.base = v.p; return true; } const d = (v.rel || v.polar) ? V.sub(v.p, ts.base) : v.p; transformSel(x => V.add(x, d), false, true); return true; },
  preview(ts) { if (ts.base) { const d = V.sub(mouseP(), ts.base); previewEnts(selEnts().map(e => WC.transformEnt(e, x => V.add(x, d), false))); } },
});
T.rotate = selTool({
  ph: (ts) => ts.base ? 'Angle in degrees (+ = anti-clockwise)' : 'Centre x,y',
  prompt: (ts) => ts.base ? 'Type the ANGLE (e.g. 90, -45) and Enter – or click to set the angle.' : 'Click the CENTRE of rotation.',
  click(p, ts) { if (!ts.base) { ts.base = p; return; } const a = WC.angOf(ts.base, p); this.rot(a, ts); },
  rot(a, ts) { const c = ts.base; transformSel(x => V.rot(x, a, c), false, false); ts.base = null; App.setTool('select'); },
  typed(v, ts) { if (!ts.base) { if (v.kind === 'point') { ts.base = v.p; return true; } return false; } if (v.kind === 'number') { this.rot(v.v * D2R, ts); return true; } return false; },
  preview(ts) { if (ts.base) { const a = WC.angOf(ts.base, S.mouse.w); previewEnts(selEnts().map(e => WC.transformEnt(e, x => V.rot(x, a, ts.base), false))); App.label(S.mouse.w, (a / D2R).toFixed(1) + '°', '#ffe14d'); } },
});
function mirrorFn(a, b) { const u = V.unit(V.sub(b, a)); return (p) => { const d = V.sub(p, a); const t = V.dot(d, u); const proj = V.add(a, V.mul(u, t)); return V.sub(V.mul(proj, 2), p); }; }
T.mirror = selTool({
  ph: () => 'Point x,y',
  prompt: (ts) => ts.base ? 'Click the SECOND point of the mirror line (hold Shift for straight).' : 'Click the FIRST point of the mirror line.',
  click(p, ts) { if (!ts.base) { ts.base = p; return; } const q = App.ortho(ts.base, p); if (V.dist(q, ts.base) < 1e-9) return; transformSel(mirrorFn(ts.base, q), true, opt.mirrorKeep); ts.base = null; App.setTool('select'); },
  typed(v, ts) { if (v.kind === 'point') { this.click(v.p, ts); return true; } return false; },
  preview(ts) { if (ts.base) { const q = mouseP(); if (V.dist(q, ts.base) < 1e-9) return; App.strokePath([WC.segL(ts.base, q)], '#ff8f6b', 1, [8, 4]); previewEnts(selEnts().map(e => WC.transformEnt(e, mirrorFn(ts.base, q), true))); } },
});
T.delete = {
  ph: () => '', prompt: () => 'Click objects to DELETE them (or select first, then press Del).', snapOff: true,
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy); if (!e) return; App.pushUndo(); removeIds([e.id]); App.markChanged(); },
};
T.measure = {
  ph: () => 'Point x,y',
  prompt: (ts) => ts.p0 ? 'Click the SECOND point.' : 'Click the FIRST point to measure from. (Select an arc to see its radius in the panel.)',
  click(p, ts) { if (!ts.p0) { ts.p0 = p; ts.res = null; return; } const d = V.sub(p, ts.p0); ts.res = { a: ts.p0, b: p }; ts.p0 = null; toast('Distance ' + r3(V.len(d)) + '   dX ' + r3(d.x) + '   dY ' + r3(d.y) + '   angle ' + (Math.atan2(d.y, d.x) / D2R).toFixed(2) + '°', 'o', 8000); },
  typed(v, ts) { if (v.kind === 'point') { this.click(v.p, ts); return true; } return false; },
  preview(ts) { const a = ts.p0, b = ts.p0 ? S.mouse.w : null; const draw = (x, y) => { App.strokePath([WC.segL(x, y)], '#5fe0ff', 1.5, [5, 3]); const d = V.sub(y, x); App.label(V.lerp(x, y, 0.5), r3(V.len(d)) + '  (dX ' + r3(d.x) + ', dY ' + r3(d.y) + ')', '#5fe0ff'); }; if (a) draw(a, b); else if (ts.res) draw(ts.res.a, ts.res.b); },
};
T.origin = {
  ph: () => 'New zero point x,y', prompt: () => 'Click the point that should become X0 Y0 (drawing zero). Everything moves.',
  click(p) { setZero(p); },
  typed(v) { if (v.kind === 'point') { setZero(v.p); return true; } return false; },
};
function setZero(p) {
  App.pushUndo(); const f = (x) => V.sub(x, p);
  S.ents = S.ents.map(e => WC.transformEnt(e, f, false));
  S.cons.forEach(c => { if (c.type === 'fix') { const e = S.ents.find(x => x.id === c.refs[0].e); if (e) c.vals = WC.entParams(e); } });
  S.jobs.forEach(j => { const mv = (q) => q ? f(q) : q; j.start = mv(j.start); j.end = mv(j.end); j.entry = mv(j.entry); j.offStart = mv(j.offStart); j.segs = (j.segs || []).map(s => moveSeg(s, f)); if (j.taper && j.taper.topSegs) { j.taper.topSegs = j.taper.topSegs.map(s => moveSeg(s, f)); j.taper.topEntry = mv(j.taper.topEntry); } });
  App.markChanged(); toast('Drawing zero moved', 'o'); App.setTool('select'); App.fit();
}
function moveSeg(s, f) { const o = WC.cloneSeg(s); o.p0 = f(s.p0); o.p1 = f(s.p1); if (s.c) o.c = f(s.c); return o; }

// ---------------- EXTEND
function extendEnt(e, clickP) {
  const others = App.visibleEnts().filter(o => o.id !== e.id);
  if (e.type === 'line') {
    const atB = V.dist(clickP, e.b) <= V.dist(clickP, e.a); const end = atB ? e.b : e.a, other = atB ? e.a : e.b; const u = V.unit(V.sub(end, other));
    let target = null;
    if (opt.extLen > 0) target = V.add(end, V.mul(u, opt.extLen));
    else { const ray = WC.segL(end, V.add(end, V.mul(u, 1e6))); let best = Infinity; for (const o of others) for (const q of WC.segInter(ray, WC.entSeg(o), 1e-6)) { const t = V.dot(V.sub(q, end), u); if (t > 1e-6 && t < best) { best = t; target = q; } } }
    if (!target) return false; if (atB) e.b = target; else e.a = target; return true;
  }
  if (e.type === 'arc') {
    const [s0, s1] = WC.entEnds(e); const atEnd = V.dist(clickP, s1) <= V.dist(clickP, s0); const sw = WC.normPos(e.a1 - e.a0) || 2 * Math.PI; const free = 2 * Math.PI - sw;
    let best = null;
    if (opt.extLen > 0) best = Math.min(free - 1e-6, opt.extLen / e.r);
    else { const full = WC.mkCircle(e.c, e.r); for (const o of others) for (const q of WC.segInter(WC.entSeg(full), WC.entSeg(o), 1e-6)) { const a = WC.angOf(e.c, q); const rel = atEnd ? WC.normPos(a - e.a1) : WC.normPos(e.a0 - a); if (rel > 1e-7 && rel < free - 1e-7 && (best === null || rel < best)) best = rel; } }
    if (best === null || best <= 0) return false; if (atEnd) e.a1 = WC.normPos(e.a1 + best); else e.a0 = WC.normPos(e.a0 - best); return true;
  }
  return false;
}
T.extend = {
  ph: () => 'Extend length (0 = to next line)', snapOff: true,
  prompt: () => opt.extLen > 0 ? 'EXTEND by ' + opt.extLen + ' mm: click a line/arc near the END you want longer. (Type 0 to extend up to the next line)' : 'EXTEND: click a line/arc near the END you want to lengthen – it grows to the next line it meets. (Type a number to extend by a length)',
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy); if (!e) return; if (e.type === 'circle') return toast('A circle cannot be extended', 'w'); App.pushUndo(); if (!extendEnt(e, S.mouse.raw)) { App.dropUndo(); return toast('Nothing to extend to in that direction', 'w'); } App.pruneConstraints(); App.markChanged(); },
  typed(v) { if (v.kind === 'number') { opt.extLen = Math.max(0, v.v); refresh(); return true; } return false; },
};
// ---------------- SCALE
T.scale = selTool({
  ph: (ts) => ts.base ? 'Scale factor (e.g. 2 or 0.5)' : 'Base point x,y',
  prompt: (ts) => ts.base ? 'Type the SCALE FACTOR (e.g. 2 = double, 0.5 = half) and Enter.' : 'Click the BASE point (it stays where it is).',
  click(p, ts) { if (!ts.base) { ts.base = p; return; } },
  typed(v, ts) { if (!ts.base) { if (v.kind === 'point') { ts.base = v.p; return true; } return false; } if (v.kind !== 'number' || !(v.v > 0)) return false; const b = ts.base, k = v.v; transformSel(x => V.add(b, V.mul(V.sub(x, b), k)), false, false); ts.base = null; App.setTool('select'); return true; },
});
// ---------------- ARRAY
function arrayCopies(centre) {
  const src = selEnts(); const out = [];
  if (opt.arrMode === 'rect') { for (let i = 0; i < Math.max(1, opt.arrCols); i++) for (let j = 0; j < Math.max(1, opt.arrRows); j++) { if (!i && !j) continue; const d = { x: i * opt.arrDx, y: j * opt.arrDy }; src.forEach(e => out.push(WC.transformEnt(e, x => V.add(x, d), false))); } }
  else if (centre) { const n = Math.max(2, Math.round(opt.arrN)); const full = Math.abs(Math.abs(opt.arrAng) - 360) < 1e-9; const step = (opt.arrAng * D2R) / (full ? n : n - 1);
    for (let i = 1; i < n; i++) { const a = step * i; src.forEach(e => { if (opt.arrRot) out.push(WC.transformEnt(e, x => V.rot(x, a, centre), false)); else { const c0 = WC.segPoint(WC.entSeg(e), 0.5), c1 = V.rot(c0, a, centre), d = V.sub(c1, c0); out.push(WC.transformEnt(e, x => V.add(x, d), false)); } }); } }
  return out;
}
T.array = selTool({
  ph: () => '',
  prompt: (ts) => opt.arrMode === 'rect' ? 'ARRAY: set columns / rows / spacing on the right, then press "Create array" (or Enter).' : 'POLAR ARRAY: set number and angle on the right, then click the CENTRE of the circle pattern.',
  click(p, ts) { if (opt.arrMode === 'polar') this.make(p); },
  make(centre) { const list = arrayCopies(centre); if (!list.length) return toast('Nothing to create – check the numbers', 'w'); App.pushUndo(); list.forEach(e => { e.id = WC.newId(); }); addEnts(list); App.markChanged(); toast(list.length + ' items created', 'o'); App.setTool('select'); },
  typed() { return false; },
  enter() { if (opt.arrMode === 'rect') { this.make(null); return true; } return false; },
  preview(ts) { const list = opt.arrMode === 'rect' ? arrayCopies(null) : arrayCopies(S.mouse.w); previewEnts(list.slice(0, 2000)); },
});
// ---------------- SLOT
function slotEnts(a, b, w) {
  const r = w / 2; const L = curLayer(); if (V.dist(a, b) < 1e-9) return [WC.mkCircle(a, r, L)];
  const u = V.unit(V.sub(b, a)), n = V.mul(V.perpL(u), r); const ang = Math.atan2(u.y, u.x);
  return [WC.mkLine(V.sub(a, n), V.sub(b, n), L), WC.mkArc(b, r, ang - Math.PI / 2, ang + Math.PI / 2, L), WC.mkLine(V.add(b, n), V.add(a, n), L), WC.mkArc(a, r, ang + Math.PI / 2, ang + 1.5 * Math.PI, L)];
}
T.slot = {
  ph: (ts) => ts.p1 ? 'Slot width (e.g. 6)' : ts.p0 ? 'Second centre (@L<angle or x,y)' : 'First centre x,y',
  prompt: (ts) => !ts.p0 ? 'SLOT: click the FIRST end centre.' : !ts.p1 ? 'Click the SECOND end centre (or type @length<angle).' : 'Click to set the WIDTH – or type the width (' + opt.slotW + ').',
  click(p, ts) { if (!ts.p0) { ts.p0 = p; return; } if (!ts.p1) { ts.p1 = App.ortho(ts.p0, p); return; } const w = 2 * WC.segNearest(WC.segL(ts.p0, ts.p1), p).d; this.make(w, ts); },
  make(w, ts) { if (!(w > 1e-6)) return; opt.slotW = Math.round(w * 1e6) / 1e6; App.pushUndo(); addEnts(slotEnts(ts.p0, ts.p1, w)); App.markChanged(); ts.p0 = ts.p1 = null; },
  typed(v, ts) { if (!ts.p0) { if (v.kind === 'point') { ts.p0 = v.p; return true; } return false; } if (!ts.p1) { if (v.kind === 'point') { ts.p1 = v.p; return true; } if (v.kind === 'number') { const d = V.unit(V.sub(mouseP(), ts.p0)); ts.p1 = V.add(ts.p0, V.mul(d, v.v)); return true; } return false; } if (v.kind === 'number') { this.make(v.v, ts); return true; } return false; },
  preview(ts) { if (ts.p0 && !ts.p1) { App.strokePath([WC.segL(ts.p0, mouseP())], '#ffe14d', 1, [4, 4]); previewEnts(slotEnts(ts.p0, mouseP(), opt.slotW)); } if (ts.p0 && ts.p1) { const w = 2 * WC.segNearest(WC.segL(ts.p0, ts.p1), S.mouse.w).d; if (w > 1e-6) { previewEnts(slotEnts(ts.p0, ts.p1, w)); App.label(S.mouse.w, 'width ' + r3(w), '#ffe14d'); } } },
};
// ---------------- GEAR
let gearCache = null;
function gearProfile() { const key = [opt.gM, opt.gZ, opt.gPA, opt.gX].join('|'); if (!gearCache || gearCache.key !== key) gearCache = { key, g: WC.gearSegs({ module: opt.gM, teeth: opt.gZ, pa: opt.gPA, shift: opt.gX }) }; return gearCache.g; }
T.gear = {
  ph: () => 'Centre x,y', snapOff: false,
  prompt: () => { const g = gearProfile(); return g.error ? 'GEAR: ' + g.error : 'GEAR: set module / teeth on the right, then click the CENTRE (or type x,y). Outside Ø ' + r3(2 * g.ra) + ', pitch Ø ' + r3(2 * g.rp) + '.'; },
  click(p) { this.make(p); },
  make(c) { const g = gearProfile(); if (g.error) return toast(g.error, 'e'); App.pushUndo(); const L = curLayer(); g.segs.forEach(s => { const e = WC.segToEnt(s, L); addEnts([WC.transformEnt(e, x => V.add(x, c), false)]); }); if (opt.gBore > 0) addEnts([WC.mkCircle(c, opt.gBore / 2, L)]); App.markChanged(); toast('Gear created: ' + opt.gZ + ' teeth, module ' + opt.gM + (g.warn.length ? '. ' + g.warn.join(' ') : ''), g.warn.length ? 'w' : 'o', 5000); },
  typed(v) { if (v.kind === 'point') { this.make(v.p); return true; } return false; },
  preview() { const g = gearProfile(); if (g.error || !S.mouse.inside) return; const c = S.mouse.w; App.strokePath(g.segs.map(s => { const o = WC.cloneSeg(s); o.p0 = V.add(s.p0, c); o.p1 = V.add(s.p1, c); if (s.c) o.c = V.add(s.c, c); return o; }), '#ffe14d', 1.2, [5, 3]); },
};
// ---------------- JOIN (merge collinear lines / same-circle arcs)
function joinSel() {
  let list = selEnts(); let merged = 0; const tol = Math.max(App.cfg.joinTol, 1e-6); let changed = true; App.pushUndo();
  while (changed) { changed = false;
    outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      if (A.type === 'line' && B.type === 'line') { const ua = V.unit(V.sub(A.b, A.a)), ub = V.unit(V.sub(B.b, B.a)); if (Math.abs(V.cross(ua, ub)) > 1e-7) continue; const pts = [A.a, A.b, B.a, B.b]; let touch = false; for (const p of [A.a, A.b]) for (const q of [B.a, B.b]) if (V.dist(p, q) <= tol) touch = true; const on = WC.segNearest(WC.segL(A.a, A.b), B.a).d < tol || WC.segNearest(WC.segL(A.a, A.b), B.b).d < tol; if (!touch && !on) continue; if (Math.abs(V.cross(ua, V.sub(B.a, A.a))) > tol) continue;
        const ts = pts.map(p => V.dot(V.sub(p, A.a), ua)); const lo = pts[ts.indexOf(Math.min(...ts))], hi = pts[ts.indexOf(Math.max(...ts))]; A.a = V.copy(lo); A.b = V.copy(hi); removeIds([B.id]); list.splice(j, 1); merged++; changed = true; break outer; }
      if (A.type === 'arc' && B.type === 'arc' && V.dist(A.c, B.c) <= tol && Math.abs(A.r - B.r) <= tol) { const [a0, a1] = WC.entEnds(A), [b0, b1] = WC.entEnds(B);
        if (V.dist(a1, b0) <= tol) { A.a1 = B.a1; } else if (V.dist(b1, a0) <= tol) { A.a0 = B.a0; } else continue; if (Math.abs(WC.normPos(A.a1 - A.a0)) < 1e-9) { const c = WC.mkCircle(A.c, A.r, A.layer); c.id = A.id; Object.keys(A).forEach(k => delete A[k]); Object.assign(A, c); } removeIds([B.id]); list.splice(j, 1); merged++; changed = true; break outer; }
    } }
  if (!merged) { App.dropUndo(); toast('Nothing to join – select lines in one straight line, or arcs on the same circle, that touch', 'w'); return; }
  App.pruneConstraints(); App.markChanged(); toast(merged + ' joins made', 'o');
}
T.join = selTool({ ph: () => '', prompt: () => 'JOIN: select lines that lie in one straight line (or arcs of the same circle), then press Enter / right-click.', click() { }, typed() { return false; } });
App.tools = T;

// ------------------------------------------------------------------ tool switching
App.setTool = function (name) {
  if (!T[name]) name = 'select';
  if (name === 'join' && S.sel.size) { joinSel(); name = 'select'; }
  if (name === 'delete' && S.sel.size) { App.pushUndo(); removeIds([...S.sel]); App.markChanged(); toast('Deleted', 'o'); name = 'select'; }
  S.tool = name; S.ts = {};
  if (T[name].needSel && !S.sel.size) S.ts.selecting = true;
  $$('.tool, .cbtn').forEach(b => b.classList.toggle('on', b.dataset.tool === name));
  refresh();
};
function promptNow() { const t = T[S.tool]; if (!t) return ''; if (S.ts.selecting) return t.selPrompt; return t.prompt(S.ts); }
function refresh() {
  if (S.mode !== 'draw') return; hint(promptNow()); const t = T[S.tool]; App.setCmdPlaceholder(t && t.ph ? t.ph(S.ts) : ''); renderDrawPanel(); App.redraw();
}
App.refreshDraw = refresh;

// ------------------------------------------------------------------ draw-mode event handlers (called by mode router)
const H = App.drawHandlers = {
  click(p, sx, sy, d) {
    const t = T[S.tool];
    if (S.tool === 'select' && App.consAt) { const cid = App.consAt(sx, sy); if (cid) { S.selCons = cid; App.consHover = cid; const c = S.cons.find(x => x.id === cid); toast((c ? WC.CONS_INFO[c.type].label : '') + ' selected – press Del to remove it', 'o'); refresh(); return; } }
    S.selCons = null; if (App.consHover && S.tool === 'select') App.consHover = null;
    if (S.tool === 'select' || S.ts.selecting) { T.select.click(p, sx, sy, d); if (S.ts.selecting) refresh(); return; }
    t.click(p, S.ts, sx, sy); refresh();
  },
  dragSelect(x0, y0, x1, y1, d) {
    if (S.tool !== 'select' && !S.ts.selecting) return;
    const a = App.s2w(Math.min(x0, x1), Math.max(y0, y1)), b = App.s2w(Math.max(x0, x1), Math.min(y0, y1)); const crossing = x1 < x0;
    if (!d.shift && !d.ctrl) S.sel.clear();
    for (const e of App.visibleEnts()) {
      const bb = WC.entBBox(e); const inside = bb.x0 >= a.x && bb.x1 <= b.x && bb.y0 >= a.y && bb.y1 <= b.y;
      let hit = inside;
      if (!hit && crossing) { const ov = !(bb.x1 < a.x || bb.x0 > b.x || bb.y1 < a.y || bb.y0 > b.y); if (ov) { const pts = WC.segSample(WC.entSeg(e), 0.05); hit = pts.some(q => q.x >= a.x && q.x <= b.x && q.y >= a.y && q.y <= b.y) || boxEdgeHit(e, a, b); } }
      if (hit) S.sel.add(e.id);
    }
    refresh();
  },
  right() { if (S.ts.selecting) { if (S.sel.size) { S.ts.selecting = false; if (S.tool === 'join') { joinSel(); App.setTool('select'); return; } refresh(); } return; } const t = T[S.tool]; if (S.tool === 'select') { S.sel.clear(); refresh(); return; } if (Object.keys(S.ts).length) { S.ts = {}; refresh(); } else App.setTool('select'); },
  escape() { if (Object.keys(S.ts).filter(k => S.ts[k]).length && !(S.ts.selecting && !S.sel.size)) { const sel = S.ts.selecting; S.ts = {}; if (sel) S.ts.selecting = true; if (T[S.tool].needSel && !S.sel.size) S.ts.selecting = true; refresh(); return; } if (S.tool !== 'select') App.setTool('select'); else { S.sel.clear(); refresh(); } },
  typed(str) {
    if (S.ts.selecting) { return false; }
    const t = T[S.tool]; if (!t || !t.typed) return false; const v = App.parseTyped(str, lastBase()); if (!v) return false; const r = t.typed(v, S.ts); refresh(); return r;
  },
  enter() { if (S.ts.selecting && S.sel.size) { S.ts.selecting = false; if (S.tool === 'join') { joinSel(); App.setTool('select'); return true; } refresh(); return true; } const tt = T[S.tool]; if (tt && tt.enter && tt.enter()) return true; if (S.tool === 'line' && S.ts.p0) { S.ts = {}; refresh(); return true; } return false; },
  key(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selCons) { App.pushUndo(); S.cons = S.cons.filter(c => c.id !== S.selCons); S.selCons = null; App.consHover = null; App.markChanged(); toast('Constraint removed', 'o'); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (S.sel.size) { App.pushUndo(); removeIds([...S.sel]); App.markChanged(); toast('Deleted', 'o'); } return true; }
    if (e.key === 'Enter') return H.enter();
    const busy = Object.keys(S.ts).some(k => k !== 'selecting' && S.ts[k]);
    const map = { l: 'line', r: 'rect', c: 'circle', a: 'arc3', t: 'trim', m: 'move', s: 'select', o: 'offset', e: 'extend' };
    if (!busy && !e.ctrlKey && !e.altKey && map[e.key.toLowerCase()]) { App.setTool(map[e.key.toLowerCase()]); return true; }
    if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) { App.visibleEnts().forEach(x => S.sel.add(x.id)); refresh(); return true; }
    return false;
  },
  hover(sx, sy) { const t = T[S.tool]; const wants = S.tool === 'select' || S.ts.selecting || (t && t.snapOff) || S.tool === 'split' || (S.tool === 'offset' && !S.ts.e); const e = wants ? App.pickEnt(sx, sy) : null; S.hover = e ? e.id : null; },
  draw() {
    App.drawConstraints && App.drawConstraints(); App.drawGrips && App.drawGrips(); App.drawPointPick && App.drawPointPick();
    const t = T[S.tool]; if (t && t.preview && !S.ts.selecting) t.preview(S.ts);
    if (S.dragBox) { const b = S.dragBox; const c = App.ctx; c.save(); const crossing = b.x1 < b.x0; c.strokeStyle = crossing ? '#35c46f' : '#2f8cff'; c.fillStyle = crossing ? 'rgba(53,196,111,.1)' : 'rgba(47,140,255,.1)'; c.setLineDash(crossing ? [5, 4] : []); c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); c.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); c.restore(); }
    if (S.showGaps) { S.showGaps.forEach(p => { App.dot(p, 9, '#ff5a5a', true); }); }
  },
  wantsSnap() { if (S.grip) return true; const t = T[S.tool]; return !(S.tool === 'select' || S.ts.selecting || (t && t.snapOff)); },
};
function boxEdgeHit(e, a, b) { const s = WC.entSeg(e); const edges = [WC.segL(a, { x: b.x, y: a.y }), WC.segL({ x: b.x, y: a.y }, b), WC.segL(b, { x: a.x, y: b.y }), WC.segL({ x: a.x, y: b.y }, a)]; return edges.some(ed => WC.segInter(s, ed, 1e-9).length > 0); }

// ------------------------------------------------------------------ draw panel
function propHTML(e) {
  if (e.type === 'line') { const L = V.dist(e.a, e.b), ang = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x) / D2R;
    return `<div class="row"><span class="lbl">Start X / Y</span><input class="fld" data-p="ax" value="${r3(e.a.x)}"><input class="fld" data-p="ay" value="${r3(e.a.y)}"></div>
    <div class="row"><span class="lbl">End X / Y</span><input class="fld" data-p="bx" value="${r3(e.b.x)}"><input class="fld" data-p="by" value="${r3(e.b.y)}"></div>
    <div class="row"><span class="lbl">Length / Angle°</span><input class="fld" data-p="len" value="${r3(L)}"><input class="fld" data-p="ang" value="${ang.toFixed(3)}"></div>`; }
  const isArc = e.type === 'arc';
  return `<div class="row"><span class="lbl">Centre X / Y</span><input class="fld" data-p="cx" value="${r3(e.c.x)}"><input class="fld" data-p="cy" value="${r3(e.c.y)}"></div>
  <div class="row"><span class="lbl">Radius / Dia.</span><input class="fld" data-p="r" value="${r3(e.r)}"><input class="fld" data-p="dia" value="${r3(2 * e.r)}"></div>
  ${isArc ? `<div class="row"><span class="lbl">Start° / End°</span><input class="fld" data-p="a0" value="${(e.a0 / D2R).toFixed(3)}"><input class="fld" data-p="a1" value="${(e.a1 / D2R).toFixed(3)}"></div><div class="note">Arc goes anti-clockwise from start angle to end angle. Length ${r3(WC.entLen(e))}</div>` : ''}`;
}
function applyProp(e, k, v) {
  App.pushUndo();
  if (e.type === 'line') {
    if (k === 'ax') e.a.x = v; if (k === 'ay') e.a.y = v; if (k === 'bx') e.b.x = v; if (k === 'by') e.b.y = v;
    if (k === 'len' && v > 0) { const u = V.unit(V.sub(e.b, e.a)); e.b = V.add(e.a, V.mul(u, v)); }
    if (k === 'ang') { const L = V.dist(e.a, e.b); e.b = V.add(e.a, { x: L * Math.cos(v * D2R), y: L * Math.sin(v * D2R) }); }
  } else {
    if (k === 'cx') e.c.x = v; if (k === 'cy') e.c.y = v; if (k === 'r' && v > 0) e.r = v; if (k === 'dia' && v > 0) e.r = v / 2;
    if (k === 'a0') e.a0 = WC.normPos(v * D2R); if (k === 'a1') e.a1 = WC.normPos(v * D2R);
  }
  if (!App.solveAround([e.id], { fixed: [e.id], strict: true })) { App.revertLast(); toast('Not possible with the constraints on this item. Change or remove the constraint.', 'e', 5000); App.refreshDraw(); return; }
  App.markChanged();
}
function findGaps() {
  const g = WC.buildGraph(App.visibleEnts(), App.cfg.joinTol); return g.nodes.filter(n => n.edges.length === 1).map(n => n.p);
}
function joinGaps(tol) {
  const list = App.visibleEnts().filter(e => e.type === 'line'); const all = App.visibleEnts(); let fixed = 0; App.pushUndo();
  const ends = []; all.forEach(e => WC.entEnds(e).forEach((p, k) => ends.push({ e, k, p })));
  const g = WC.buildGraph(all, App.cfg.joinTol); const open = g.nodes.filter(n => n.edges.length === 1).map(n => n.p);
  for (const p of open) {
    let best = null, bd = Infinity; for (const q of open) { if (q === p) continue; const d = V.dist(p, q); if (d < bd) { bd = d; best = q; } }
    if (best && bd <= tol && bd > 0) { // move line end at p to best (if p belongs to a line)
      for (const e of list) { if (V.dist(e.a, p) < 1e-9) { e.a = V.copy(best); fixed++; break; } if (V.dist(e.b, p) < 1e-9) { e.b = V.copy(best); fixed++; break; } }
    }
  }
  App.markChanged(); return fixed;
}
function renderDrawPanel() {
  const P = $('#panel-draw'); if (S.mode !== 'draw') return;
  const t = S.tool; let toolOpts = '';
  if (t === 'rect') toolOpts = `<div class="row"><span class="lbl">Corner radius</span><input class="fld" data-o="rectR" value="${opt.rectR}"></div><div class="row"><label class="chk"><input type="checkbox" data-o="rectCentre" ${opt.rectCentre ? 'checked' : ''}> Start from centre</label></div>`;
  if (t === 'polygon') toolOpts = `<div class="row"><span class="lbl">Number of sides</span><input class="fld" data-o="polySides" value="${opt.polySides}"></div>`;
  if (t === 'fillet') toolOpts = `<div class="row"><span class="lbl">Fillet radius</span><input class="fld" data-o="filletR" value="${opt.filletR}"></div><div class="note">0 = make a sharp corner (extend / cut both lines).</div>`;
  if (t === 'chamfer') toolOpts = `<div class="row"><span class="lbl">Chamfer size</span><input class="fld" data-o="chamferD" value="${opt.chamferD}"></div>`;
  if (t === 'offset') toolOpts = `<div class="row"><span class="lbl">Offset distance</span><input class="fld" data-o="offsetD" value="${opt.offsetD}"></div>`;
  if (t === 'extend') toolOpts = `<div class="row"><span class="lbl">Extend by</span><input class="fld" data-o="extLen" value="${opt.extLen}"> mm</div><div class="note">0 = extend up to the next line / arc it meets.</div>`;
  if (t === 'array') toolOpts = `<div class="row"><button class="btn ${opt.arrMode === 'rect' ? 'on' : ''}" data-arr="rect">Rectangular</button><button class="btn ${opt.arrMode === 'polar' ? 'on' : ''}" data-arr="polar">Polar (circle)</button></div>` + (opt.arrMode === 'rect'
      ? `<div class="row"><span class="lbl">Columns / Rows</span><input class="fld" data-o="arrCols" value="${opt.arrCols}"><input class="fld" data-o="arrRows" value="${opt.arrRows}"></div><div class="row"><span class="lbl">Spacing X / Y</span><input class="fld" data-o="arrDx" value="${opt.arrDx}" data-neg="1"><input class="fld" data-o="arrDy" value="${opt.arrDy}" data-neg="1"></div><div class="row"><button class="btn pri" data-a="arrMake" ${S.ts.selecting ? 'disabled' : ''}>Create array</button></div>`
      : `<div class="row"><span class="lbl">Number of items</span><input class="fld" data-o="arrN" value="${opt.arrN}"></div><div class="row"><span class="lbl">Total angle °</span><input class="fld" data-o="arrAng" value="${opt.arrAng}" data-neg="1"></div><label class="chk note"><input type="checkbox" data-o="arrRot" ${opt.arrRot ? 'checked' : ''}> Rotate the items</label><div class="note">Then click the centre point.</div>`);
  if (t === 'slot') toolOpts = `<div class="row"><span class="lbl">Last width</span><input class="fld" data-o="slotW" value="${opt.slotW}"> mm</div>`;
  if (t === 'scale') toolOpts = `<div class="note">After the base point, type the factor: 2 = double size, 0.5 = half size.</div>`;
  if (t === 'join') toolOpts = `<div class="note">Select the pieces, then press Enter. Lines must lie in one straight line; arcs must be on the same circle.</div>`;
  if (t === 'gear') { const g = gearProfile(); toolOpts = `<div class="row"><span class="lbl">Module m</span><input class="fld" data-o="gM" value="${opt.gM}"></div><div class="row"><span class="lbl">Number of teeth z</span><input class="fld" data-o="gZ" value="${opt.gZ}"></div><div class="row"><span class="lbl">Pressure angle °</span><input class="fld" data-o="gPA" value="${opt.gPA}"></div><div class="row"><span class="lbl">Profile shift x</span><input class="fld" data-o="gX" value="${opt.gX}" data-neg="1"></div><div class="row"><span class="lbl">Bore Ø (0 = none)</span><input class="fld" data-o="gBore" value="${opt.gBore}"></div>
    ${g.error ? `<div class="note err">${esc(g.error)}</div>` : `<div class="kv"><span>Pitch Ø</span><span>${r3(2 * g.rp)}</span><span>Outside Ø</span><span>${r3(2 * g.ra)}</span><span>Root Ø</span><span>${r3(2 * g.rf)}</span><span>Base Ø</span><span>${r3(2 * g.rb)}</span></div>${g.warn.length ? `<div class="note warn">${esc(g.warn.join(' '))}</div>` : ''}`}<div class="note">External spur gear, involute teeth. Then click the centre.</div>`; }
  if (t === 'mirror') toolOpts = `<div class="row"><label class="chk"><input type="checkbox" data-o="mirrorKeep" ${opt.mirrorKeep ? 'checked' : ''}> Keep original (make a mirrored copy)</label></div>`;
  const toolName = (($$(`.tool[data-tool="${t}"]`)[0] || {}).textContent || t).trim();
  const sel = [...S.sel].map(byId).filter(Boolean);
  let selHTML = '<div class="note">Nothing selected. Click a line or arc to see and edit its size.</div>';
  if (sel.length === 1) selHTML = `<div class="note">${sel[0].type === 'line' ? 'LINE' : sel[0].type === 'arc' ? 'ARC' : 'CIRCLE'} &nbsp; layer <b>${esc(sel[0].layer)}</b></div>` + propHTML(sel[0]);
  else if (sel.length > 1) selHTML = `<div class="note">${sel.length} objects selected.</div>`;
  const layers = {}; S.ents.forEach(e => layers[e.layer] = (layers[e.layer] || 0) + 1);
  const lay = Object.keys(layers).map(l => `<div class="layer"><button data-lay="${esc(l)}" title="Show / hide">${S.hidden.has(l) ? ICONS.eyeoff : ICONS.eye}</button><span class="sw" style="background:${App.layerColor(l)}"></span><span>${esc(l)}</span><span class="cnt">${layers[l]}</span></div>`).join('') || '<div class="note">No drawing yet.</div>';
  const bb = WC.entsBBox(App.visibleEnts());
  P.innerHTML = `
  <div class="card active"><div class="ch">✏️ Tool: ${esc(toolName)}</div><div class="cb"><div class="note">${esc(promptNow())}</div>${toolOpts}
    ${T[t] && T[t].needSel ? `<div class="row"><button class="btn" data-a="selDone" ${S.ts.selecting && S.sel.size ? '' : 'disabled'}>Selection done ➜</button></div>` : ''}</div></div>
  <div class="card"><div class="ch">Selected</div><div class="cb">${selHTML}
    <div class="row">${sel.length ? `<button class="btn danger" data-a="delSel">${ICONS.delete} Delete</button>` : ''}${sel.length ? `<button class="btn pri" data-a="toPath">Make wire path ➜</button>` : ''}</div></div></div>
  ${App.consPanelHTML ? App.consPanelHTML() : ''}
  <div class="card"><div class="ch">Layers <span class="sum">eye = show / hide</span></div><div class="cb">${lay}
    ${S.hidden.size ? '<div class="row"><button class="btn danger" data-a="delHidden">Delete hidden layers</button></div>' : ''}</div></div>
  <div class="card"><div class="ch">Check drawing</div><div class="cb">
    <div class="note">${S.ents.length} items. ${isFinite(bb.x0) ? 'Size ' + r3(bb.x1 - bb.x0) + ' × ' + r3(bb.y1 - bb.y0) + ' mm' : ''}</div>
    <div class="row"><button class="btn" data-a="gaps">Show open ends</button><button class="btn" data-a="joinGaps">Close gaps ≤</button><input class="fld" data-o="gapTol" value="${opt.gapTol}" style="width:60px"> mm</div>
    ${S.showGaps ? `<div class="note ${S.showGaps.length ? 'warn' : 'ok'}">${S.showGaps.length ? S.showGaps.length + ' open ends (red circles). A closed shape has none.' : 'No open ends – all shapes are closed.'}</div>` : ''}
  </div></div>`;
  P.querySelectorAll('[data-o]').forEach(inp => { inp.onchange = () => { const k = inp.dataset.o; opt[k] = inp.type === 'checkbox' ? inp.checked : (k === 'polySides' ? Math.max(3, Math.round(num(inp.value, 6))) : ['arrCols', 'arrRows', 'arrN', 'gZ'].includes(k) ? Math.max(1, Math.round(num(inp.value, opt[k]))) : inp.dataset.neg ? num(inp.value, opt[k]) : Math.max(0, num(inp.value, opt[k]))); refresh(); }; inp.onkeydown = (e) => e.stopPropagation(); });
  P.querySelectorAll('[data-arr]').forEach(b => b.onclick = () => { opt.arrMode = b.dataset.arr; refresh(); });
  if (App.bindConsPanel) App.bindConsPanel(P);
  P.querySelectorAll('[data-p]').forEach(inp => inp.onchange = () => { if (sel.length === 1) applyProp(sel[0], inp.dataset.p, num(inp.value, 0)); });
  P.querySelectorAll('[data-lay]').forEach(b => b.onclick = () => { const l = b.dataset.lay; S.hidden.has(l) ? S.hidden.delete(l) : S.hidden.add(l); S.sel.clear(); App.markChanged(); });
  P.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'delSel') { App.pushUndo(); removeIds([...S.sel]); App.markChanged(); }
    if (a === 'selDone') { S.ts.selecting = false; if (S.tool === 'join') { joinSel(); App.setTool('select'); return; } refresh(); }
    if (a === 'arrMake') T.array.make(null);
    if (a === 'toPath') { App.setMode('path'); App.startNewPath && App.startNewPath(); }
    if (a === 'delHidden') { App.pushUndo(); S.ents = S.ents.filter(e => !S.hidden.has(e.layer)); S.hidden.clear(); App.markChanged(); }
    if (a === 'gaps') { S.showGaps = findGaps(); refresh(); }
    if (a === 'joinGaps') { const n = joinGaps(opt.gapTol); S.showGaps = findGaps(); toast(n + ' line ends joined', n ? 'o' : 'w'); refresh(); }
  });
}
App.renderDrawPanel = renderDrawPanel;

// ------------------------------------------------------------------ DXF import
App.importDXF = async function (text, name) {
  if (!/SECTION/.test(text.slice(0, 2000))) { toast('This file is not a text DXF (maybe an ELCam .prf or binary DXF). Save it as ASCII DXF and try again.', 'e', 7000); return; }
  let r; try { r = WC.parseDXF(text, { fitTol: App.cfg.fitTol }); } catch (e) { console.error(e); toast('DXF could not be read: ' + e.message, 'e'); return; }
  let list = r.entities;
  if (r.insunits === 1) { const ans = await App.modal('Drawing units', '<p>This DXF says its units are <b>INCH</b>. The machine program is in <b>mm</b> (G71).</p><p>Convert the drawing from inch to mm (× 25.4)?</p>', [{ label: 'Keep as it is', value: 'keep' }, { label: 'Convert inch → mm', value: 'conv', cls: 'pri' }]); if (ans === 'conv') list = list.map(e => WC.transformEnt(e, p => V.mul(p, 25.4), false)); }
  const dd = WC.dedupeEntities(list);
  let mode = 'replace';
  if (S.ents.length) { mode = await App.modal('Open drawing', `<p>You already have a drawing. What do you want to do with <b>${esc(name)}</b>?</p>`, [{ label: 'Cancel', value: null }, { label: 'Add to current drawing', value: 'add' }, { label: 'Replace drawing', value: 'replace', cls: 'pri' }]); if (!mode) return; }
  App.pushUndo();
  if (mode === 'replace') { S.ents = []; S.cons = []; S.hidden.clear(); S.layerOrder = []; S.jobs = []; S.cur = -1; S.viewer = null; }
  S.ents = S.ents.concat(dd.entities); S.sel.clear(); S.showGaps = null;
  if (!S.fileName) S.prog.title = name.replace(/\.[^.]+$/, '');
  App.markChanged(); App.setMode('draw'); App.fit();
  const sk = Object.entries(r.skipped).map(([k, v]) => v + ' ' + k).join(', ');
  toast('Opened ' + name + ': ' + dd.entities.length + ' lines/arcs' + (dd.removed ? ', ' + dd.removed + ' double items removed' : '') + (sk ? '. Ignored: ' + sk : '') + (r.warnings.length ? '. ' + r.warnings.join(' ') : ''), 'o', 7000);
};
})();
