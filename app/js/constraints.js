/* WireCAM – DRAW mode: geometric constraints, driving dimensions, grip editing */
(function () {
'use strict';
const { V } = WC; const { S, $, $$, esc, r3, num, toast, hint } = App;
const T = App.tools;
let consId = 1;
const nextConsId = () => { S.cons.forEach(c => { if (c.id >= consId) consId = c.id + 1; }); return consId++; };
const byId = (id) => S.ents.find(e => e.id === id);
const isCirc = (e) => e && (e.type === 'arc' || e.type === 'circle');
const consFor = (id) => S.cons.filter(c => c.refs.some(r => r.e === id));
App.consFor = consFor;

// ------------------------------------------------------------------ solving helpers
function applyUpdates(r) { r.updated.forEach((ne, id) => { const e = byId(id); if (e) { Object.assign(e, ne); } }); }
// solve the components touching ids; tries "fixed edited" first, then free. Returns true on success (geometry updated).
App.solveAround = function (ids, opts) {
  opts = opts || {}; if (!S.cons.length) return true;
  const only = new Set(ids); if (![...only].some(id => consFor(id).length)) return true;
  const tries = opts.noFix ? [{}] : opts.strict ? [{ fixed: new Set(opts.fixed || ids) }] : [{ fixed: new Set(opts.fixed || ids) }, {}];
  for (const t of tries) {
    const r = WC.solveConstraints(S.ents, S.cons, Object.assign({ only, quick: !!opts.quick, drag: opts.drag }, t));
    if (r.ok) { applyUpdates(r); return true; }
  }
  return false;
};
App.solveAll = function () { if (!S.cons.length) return true; const r = WC.solveConstraints(S.ents, S.cons, {}); if (r.ok) applyUpdates(r); return r.ok; };
// remove constraints whose entities are gone or that are no longer satisfied (after trim, fillet, extend …)
App.pruneConstraints = function (quiet) {
  if (!S.cons.length) return 0; const ids = new Set(S.ents.map(e => e.id)); const before = S.cons.length;
  S.cons = S.cons.filter(c => c.refs.every(r => ids.has(r.e)));
  S.cons = S.cons.filter(c => WC.consResidual(S.ents, c) < 1e-5);
  const n = before - S.cons.length; if (n && !quiet) toast(n + ' constraint(s) removed because the geometry changed', 'w', 3500); return n;
};

// ------------------------------------------------------------------ point references
const POINT_LABEL = { a: 'start', b: 'end', s: 'start', e: 'end', c: 'centre', m: 'middle' };
function refPoint(ref) { const e = byId(ref.e); if (!e) return null; if (e.type === 'line') return ref.p === 'b' ? e.b : ref.p === 'm' ? V.lerp(e.a, e.b, 0.5) : e.a; if (ref.p === 'c' || e.type === 'circle') return e.c; const [s0, s1] = WC.entEnds(e); return ref.p === 'e' ? s1 : s0; }
App.refPoint = refPoint;
function pickPointRef(sx, sy, opts) {
  opts = opts || {}; const w = App.s2w(sx, sy); const tol = 12 / S.view.scale; let best = null, bd = Infinity;
  for (const e of App.visibleEnts()) {
    const cands = e.type === 'line' ? ['a', 'b'].concat(opts.mid ? ['m'] : []) : e.type === 'arc' ? ['s', 'e', 'c'] : ['c'];
    for (const p of cands) { const q = refPoint({ e: e.id, p }); const d = V.dist(q, w); if (d < tol && d < bd - 1e-9) { bd = d; best = { e: e.id, p }; } }
  }
  return best;
}

// ------------------------------------------------------------------ adding constraints
function addCons(c, fixFirst) {
  App.pushUndo();
  c.id = nextConsId(); S.cons.push(c);
  const ids = WC.consEntIds(c);
  const ok = App.solveAround(ids, { fixed: fixFirst ? [ids[0]] : ids.slice(0, 1) });
  if (!ok) { App.revertLast(); toast('Not possible: "' + WC.CONS_INFO[c.type].label + '" conflicts with the shape or other constraints.', 'e', 5000); App.refreshDraw(); return false; }
  App.markChanged(); toast(WC.CONS_INFO[c.type].label + ' added', 'o', 1500); return true;
}
App.addConstraint = addCons;
function lineOnly(e) { if (!e || e.type !== 'line') { toast('Please click a straight LINE', 'w'); return false; } return true; }
function circOnly(e) { if (!isCirc(e)) { toast('Please click an ARC or CIRCLE', 'w'); return false; } return true; }
function selOrPick(type, ts, sx, sy, test) { // one-entity constraints
  const e = App.pickEnt(sx, sy); if (!e || !test(e)) return;
  if (S.cons.some(c => c.type === type && c.refs[0].e === e.id)) return toast('Already ' + WC.CONS_INFO[type].label.toLowerCase(), 'w');
  addCons({ type, refs: [{ e: e.id }] });
}
function twoEnts(type, test1, test2, make) {
  return {
    prompt: (ts) => ts.e1 ? 'Click the SECOND item. (It will move to fit.)' : 'Click the FIRST item (it stays where it is).', snapOff: true, cons: true,
    click(p, ts, sx, sy) {
      const e = App.pickEnt(sx, sy); if (!e) return;
      if (!ts.e1) { if (!test1(e)) return; ts.e1 = e.id; ts.c1 = S.mouse.raw; S.sel.clear(); S.sel.add(e.id); return; }
      if (e.id === ts.e1) return; if (!test2(e, byId(ts.e1))) return;
      const c = make(byId(ts.e1), e, ts); S.sel.clear(); ts.e1 = null; if (c) addCons(c, true);
    },
  };
}
function twoPoints(type, extra) {
  return Object.assign({
    prompt: (ts) => ts.r1 ? 'Click the SECOND point (end point or centre). It will move.' : 'Click the FIRST point (end point or centre of a line/arc).', snapOff: true, cons: true, pointPick: true,
    click(p, ts, sx, sy) {
      const r = pickPointRef(sx, sy); if (!r) return toast('Click near an end point or a centre', 'w');
      if (!ts.r1) { ts.r1 = r; return; }
      if (r.e === ts.r1.e) return toast('Choose a point of ANOTHER line/arc', 'w');
      const c = { type, refs: [ts.r1, r] }; ts.r1 = null; if (extra && extra(c) === false) return; addCons(c, true);
    },
  }, {});
}
T.c_coincident = twoPoints('coincident');
T.c_oncurve = {
  prompt: (ts) => ts.r1 ? 'Click the LINE / ARC the point must lie on.' : 'Click the POINT (end point or centre) that should lie on a line/arc.', snapOff: true, cons: true, pointPick: true,
  click(p, ts, sx, sy) { if (!ts.r1) { const r = pickPointRef(sx, sy); if (!r) return toast('Click near an end point or a centre', 'w'); ts.r1 = r; return; }
    const e = App.pickEnt(sx, sy); if (!e) return; if (e.id === ts.r1.e) return toast('Choose ANOTHER line/arc', 'w'); const c = { type: 'onCurve', refs: [ts.r1, { e: e.id }] }; ts.r1 = null; addCons(c, false); },
};
T.c_midpoint = {
  prompt: (ts) => ts.r1 ? 'Click the LINE – the point goes to its middle.' : 'Click the POINT that should sit in the MIDDLE of a line.', snapOff: true, cons: true, pointPick: true,
  click(p, ts, sx, sy) { if (!ts.r1) { const r = pickPointRef(sx, sy); if (!r) return toast('Click near an end point or a centre', 'w'); ts.r1 = r; return; }
    const e = App.pickEnt(sx, sy); if (!lineOnly(e)) return; if (e.id === ts.r1.e) return; const c = { type: 'midpoint', refs: [ts.r1, { e: e.id }] }; ts.r1 = null; addCons(c, false); },
};
T.c_horizontal = { prompt: () => 'Click a LINE to make it HORIZONTAL.', snapOff: true, cons: true, click(p, ts, sx, sy) { selOrPick('horizontal', ts, sx, sy, lineOnly); } };
T.c_vertical = { prompt: () => 'Click a LINE to make it VERTICAL.', snapOff: true, cons: true, click(p, ts, sx, sy) { selOrPick('vertical', ts, sx, sy, lineOnly); } };
T.c_parallel = twoEnts('parallel', lineOnly, lineOnly, (a, b) => ({ type: 'parallel', refs: [{ e: a.id }, { e: b.id }] }));
T.c_perpendicular = twoEnts('perpendicular', lineOnly, lineOnly, (a, b) => ({ type: 'perpendicular', refs: [{ e: a.id }, { e: b.id }] }));
T.c_tangent = twoEnts('tangent', (e) => !!e, (e, a) => { if (!isCirc(e) && !isCirc(a)) { toast('One of the two must be an ARC or CIRCLE', 'w'); return false; } return true; }, (a, b) => {
  const c = { type: 'tangent', refs: [{ e: a.id }, { e: b.id }] };
  if (a.type === 'line' || b.type === 'line') { const L = a.type === 'line' ? a : b, C = a.type === 'line' ? b : a; const u = V.unit(V.sub(L.b, L.a)); c.mode = V.cross(u, V.sub(C.c, L.a)) >= 0 ? 1 : -1; }
  else { const d = V.dist(a.c, b.c); c.mode = Math.abs(d - Math.abs(a.r - b.r)) < Math.abs(d - (a.r + b.r)) ? 'int' : 'ext'; }
  return c; });
T.c_equal = twoEnts('equal', (e) => !!e, (e, a) => { if ((e.type === 'line') !== (a.type === 'line')) { toast('Choose two LINES (equal length) or two ARCS/CIRCLES (equal radius)', 'w'); return false; } return true; }, (a, b) => ({ type: 'equal', refs: [{ e: a.id }, { e: b.id }] }));
T.c_concentric = twoEnts('concentric', circOnly, circOnly, (a, b) => ({ type: 'concentric', refs: [{ e: a.id }, { e: b.id }] }));
T.c_symmetric = {
  prompt: (ts) => !ts.r1 ? 'Click the FIRST point.' : !ts.r2 ? 'Click the SECOND point (it will move).' : 'Click the SYMMETRY LINE (centre line).', snapOff: true, cons: true, pointPick: true,
  click(p, ts, sx, sy) {
    if (!ts.r1 || !ts.r2) { const r = pickPointRef(sx, sy); if (!r) return toast('Click near an end point or a centre', 'w'); if (!ts.r1) ts.r1 = r; else ts.r2 = r; return; }
    const e = App.pickEnt(sx, sy); if (!lineOnly(e)) return; const c = { type: 'symmetric', refs: [ts.r1, ts.r2, { e: e.id }] }; ts.r1 = ts.r2 = null; addCons(c, true);
  },
};
T.c_fix = {
  prompt: () => 'Click a line/arc to LOCK it in place (click again to unlock).', snapOff: true, cons: true,
  click(p, ts, sx, sy) { const e = App.pickEnt(sx, sy); if (!e) return; const ex = S.cons.find(c => c.type === 'fix' && c.refs[0].e === e.id);
    if (ex) { App.pushUndo(); S.cons = S.cons.filter(c => c !== ex); App.markChanged(); toast('Unlocked', 'o'); return; }
    addCons({ type: 'fix', refs: [{ e: e.id }], vals: WC.entParams(e) }); },
};
const dimOpt = { mode: 'size' };
T.c_dim = {
  ph: (ts) => ts.last ? 'New value (e.g. 25) and Enter' : '',
  prompt: (ts) => ts.last ? 'Type the NEW VALUE and press Enter (or click the next item).' : dimOpt.mode === 'size' ? 'Click a LINE (length), ARC (radius) or CIRCLE (diameter).' : dimOpt.mode === 'angle' ? 'Click a LINE to fix its angle.' : (ts.r1 ? 'Click the SECOND point.' : 'Click the FIRST point (end point or centre).'),
  snapOff: true, cons: true, pointPick: () => dimOpt.mode === 'dist',
  click(p, ts, sx, sy) {
    let c = null;
    if (dimOpt.mode === 'dist') { const r = pickPointRef(sx, sy); if (!r) return toast('Click near an end point or a centre', 'w'); if (!ts.r1) { ts.r1 = r; return; } if (r.e === ts.r1.e && r.p === ts.r1.p) return; c = { type: 'distance', refs: [ts.r1, r], val: V.dist(refPoint(ts.r1), refPoint(r)) }; ts.r1 = null; }
    else { const e = App.pickEnt(sx, sy); if (!e) return;
      if (dimOpt.mode === 'angle') { if (!lineOnly(e)) return; c = { type: 'angle', refs: [{ e: e.id }], val: Math.round(Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x) * 180 / Math.PI * 1e6) / 1e6 }; }
      else if (e.type === 'line') c = { type: 'length', refs: [{ e: e.id }], val: V.dist(e.a, e.b) };
      else if (e.type === 'arc') c = { type: 'radius', refs: [{ e: e.id }], val: e.r }; else c = { type: 'diameter', refs: [{ e: e.id }], val: 2 * e.r }; }
    c.val = Math.round(c.val * 1e6) / 1e6;
    if (S.cons.some(x => x.type === c.type && JSON.stringify(x.refs) === JSON.stringify(c.refs))) return toast('This dimension already exists – change it in the list on the right', 'w');
    if (addCons(c)) ts.last = c.id;
  },
  typed(v, ts) { if (!ts.last || v.kind !== 'number') return false; App.setConsValue(ts.last, v.v); ts.last = null; return true; },
};
App.setConsValue = function (id, v) {
  const c = S.cons.find(x => x.id === id); if (!c) return;
  if ((c.type === 'length' || c.type === 'radius' || c.type === 'diameter' || c.type === 'distance') && !(v > 0)) return toast('Value must be more than 0', 'w');
  App.pushUndo(); c.val = v; const ok = App.solveAround(WC.consEntIds(c), { noFix: true });
  if (!ok) { App.revertLast(); toast('That value is not possible with the other constraints', 'e', 4000); App.refreshDraw(); return; }
  App.markChanged();
};
T.c_auto = {
  prompt: () => 'AUTO: adds constraints to the selected items (or the whole drawing). Press the button on the right.', snapOff: true, cons: true, click() { },
};
App.autoConstrain = function () {
  const list = S.sel.size ? App.visibleEnts().filter(e => S.sel.has(e.id)) : App.visibleEnts();
  const tol = Math.max(App.cfg.joinTol, 1e-6); const add = []; const have = new Set(S.cons.map(c => c.type + JSON.stringify(c.refs)));
  const push = (c) => { const k = c.type + JSON.stringify(c.refs); if (!have.has(k)) { have.add(k); add.push(c); } };
  const pts = []; list.forEach(e => (e.type === 'line' ? ['a', 'b'] : e.type === 'arc' ? ['s', 'e'] : []).forEach(p => pts.push({ e: e.id, p, q: refPoint({ e: e.id, p }) })));
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { if (pts[i].e === pts[j].e) continue; if (V.dist(pts[i].q, pts[j].q) <= tol) {
    if (!S.cons.some(c => c.type === 'coincident' && c.refs.some(r => r.e === pts[j].e && r.p === pts[j].p) && c.refs.some(r => r.e === pts[i].e && r.p === pts[i].p))) {
      const already = add.some(c => c.type === 'coincident' && c.refs[1].e === pts[j].e && c.refs[1].p === pts[j].p); if (!already) push({ type: 'coincident', refs: [{ e: pts[i].e, p: pts[i].p }, { e: pts[j].e, p: pts[j].p }] }); }
    // tangency at joints
    const A = byId(pts[i].e), B = byId(pts[j].e);
    if ((A.type === 'line') !== (B.type === 'line') || (A.type === 'arc' && B.type === 'arc')) { const ta = WC.segTan(WC.entSeg(A), pts[i].p === 'a' || pts[i].p === 's' ? 0 : 1), tb = WC.segTan(WC.entSeg(B), pts[j].p === 'a' || pts[j].p === 's' ? 0 : 1);
      if (Math.abs(V.cross(ta, tb)) < 1e-6) { const c = { type: 'tangent', refs: [{ e: A.id }, { e: B.id }] }; if (A.type === 'line' || B.type === 'line') { const L = A.type === 'line' ? A : B, C = A.type === 'line' ? B : A; c.mode = V.cross(V.unit(V.sub(L.b, L.a)), V.sub(C.c, L.a)) >= 0 ? 1 : -1; } else { const d = V.dist(A.c, B.c); c.mode = Math.abs(d - Math.abs(A.r - B.r)) < Math.abs(d - (A.r + B.r)) ? 'int' : 'ext'; } push(c); } }
  } }
  list.forEach(e => { if (e.type !== 'line') return; if (Math.abs(e.a.y - e.b.y) < 1e-7 && Math.abs(e.a.x - e.b.x) > 1e-7) push({ type: 'horizontal', refs: [{ e: e.id }] }); else if (Math.abs(e.a.x - e.b.x) < 1e-7) push({ type: 'vertical', refs: [{ e: e.id }] }); });
  if (!add.length) return toast('No new constraints found', 'w');
  App.pushUndo(); add.forEach(c => { c.id = nextConsId(); S.cons.push(c); });
  const n = add.length; App.pruneConstraints(true); App.markChanged(); toast(n + ' constraints added (corners joined, horizontal / vertical lines, tangent joints)', 'o', 4000);
};

// ------------------------------------------------------------------ drawing of constraint glyphs
const GLYPH = { horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', tangent: 'T', equal: '=', concentric: '◎', fix: '🔒', onCurve: '•', midpoint: 'M', symmetric: '⇹' };
function entAnchor(e) { const s = WC.entSeg(e); return e.type === 'circle' ? WC.onCircle(e.c, e.r, Math.PI / 4) : WC.segPoint(s, 0.5); }
function glyph(p, text, color, k, hl) {
  const a = App.w2s(p); const c = App.ctx; c.font = 'bold 11px Segoe UI, Arial'; const w = Math.max(14, c.measureText(text).width + 6);
  const x = a.x + 8 + k * (w + 2), y = a.y - 18; c.fillStyle = hl ? '#ffe14d' : 'rgba(30,40,60,.9)'; c.strokeStyle = color; c.lineWidth = 1; c.fillRect(x, y, w, 15); c.strokeRect(x + .5, y + .5, w - 1, 14);
  c.fillStyle = hl ? '#000' : color; c.fillText(text, x + (w - c.measureText(text).width) / 2, y + 11.5); return { x, y, w, h: 15 };
}
App.consHover = null;
App.drawConstraints = function () {
  if (!S.showCons || !S.cons.length) return; const c = App.ctx; const per = new Map(); const hits = [];
  for (const k of S.cons) {
    const hl = App.consHover === k.id; const col = WC.CONS_INFO[k.type] && WC.CONS_INFO[k.type].dim ? '#5fe0ff' : '#c9a7ff';
    if (k.type === 'coincident') { const p = refPoint(k.refs[0]); if (!p) continue; const a = App.w2s(p); c.fillStyle = hl ? '#ffe14d' : '#c9a7ff'; c.fillRect(a.x - 3, a.y - 3, 6, 6); continue; }
    if (k.type === 'length' || k.type === 'distance') {
      const p1 = k.type === 'length' ? byId(k.refs[0].e).a : refPoint(k.refs[0]), p2 = k.type === 'length' ? byId(k.refs[0].e).b : refPoint(k.refs[1]); if (!p1 || !p2) continue;
      const u = V.unit(V.sub(p2, p1)); const n = V.perpL(u); const off = 22 / S.view.scale; const q1 = V.add(p1, V.mul(n, off)), q2 = V.add(p2, V.mul(n, off));
      App.strokePath([WC.segL(p1, q1), WC.segL(p2, q2)], 'rgba(95,224,255,.5)', 1); App.strokePath([WC.segL(q1, q2)], hl ? '#ffe14d' : '#5fe0ff', 1.2); App.drawArrow(q2, u, '#5fe0ff', 6); App.drawArrow(q1, V.mul(u, -1), '#5fe0ff', 6);
      const m = App.w2s(V.lerp(q1, q2, 0.5)); const t = (k.type === 'length' ? '' : '↔ ') + r3(k.val); c.font = 'bold 12px Segoe UI, Arial'; const w = c.measureText(t).width + 8; c.fillStyle = hl ? '#ffe14d' : '#0f1318'; c.fillRect(m.x - w / 2, m.y - 9, w, 17); c.fillStyle = hl ? '#000' : '#5fe0ff'; c.fillText(t, m.x - w / 2 + 4, m.y + 4); hits.push({ id: k.id, x: m.x - w / 2, y: m.y - 9, w, h: 17 }); continue;
    }
    if (k.type === 'radius' || k.type === 'diameter') { const e = byId(k.refs[0].e); if (!e) continue; const p = entAnchor(e); App.strokePath([WC.segL(e.c, p)], 'rgba(95,224,255,.6)', 1, [4, 3]); const b = glyph(p, (k.type === 'radius' ? 'R' : 'Ø') + r3(k.val), '#5fe0ff', 0, hl); hits.push(Object.assign({ id: k.id }, b)); continue; }
    if (k.type === 'angle') { const e = byId(k.refs[0].e); if (!e) continue; const b = glyph(entAnchor(e), '∠' + (+k.val).toFixed(2) + '°', '#5fe0ff', 0, hl); hits.push(Object.assign({ id: k.id }, b)); continue; }
    const ids = WC.consEntIds(k); const txt = GLYPH[k.type] || '?';
    ids.slice(0, k.type === 'symmetric' ? 0 : 2).forEach(id => { const e = byId(id); if (!e) return; const n = per.get(id) || 0; per.set(id, n + 1); const b = glyph(entAnchor(e), txt, col, n, hl); hits.push(Object.assign({ id: k.id }, b)); });
    if (k.type === 'onCurve' || k.type === 'midpoint' || k.type === 'symmetric') { [k.refs[0], k.refs[1]].forEach(r => { if (!r.p) return; const p = refPoint(r); if (!p) return; const a = App.w2s(p); c.strokeStyle = hl ? '#ffe14d' : col; c.lineWidth = 1.5; c.beginPath(); c.arc(a.x, a.y, 5, 0, 7); c.stroke(); }); }
  }
  App.consHits = hits;
};
App.consAt = (sx, sy) => { const h = (App.consHits || []).find(b => sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h); return h ? h.id : null; };
App.drawPointPick = function () { // highlight point refs while a point-picking constraint tool is active
  const t = T[S.tool]; if (!t || !t.cons) return; const pp = typeof t.pointPick === 'function' ? t.pointPick() : t.pointPick; const ts = S.ts;
  [ts.r1, ts.r2].forEach(r => { if (r) { const p = refPoint(r); if (p) App.dot(p, 7, '#ffe14d', true); } });
  if (pp && S.mouse.inside) { const r = pickPointRef(S.mouse.sx, S.mouse.sy); if (r) { const p = refPoint(r); App.dot(p, 8, '#5fe0ff', true); App.label(p, POINT_LABEL[r.p] || '', '#5fe0ff'); } }
};

// ------------------------------------------------------------------ constraints panel (inside DRAW panel)
function consName(c) {
  const nm = (id) => { const e = byId(id); return e ? (e.type === 'line' ? 'line' : e.type) + ' #' + id : '?'; };
  const pr = (r) => nm(r.e) + (r.p ? ' ' + (POINT_LABEL[r.p] || r.p) : '');
  if (c.refs.length === 1) return nm(c.refs[0].e);
  return c.refs.map(r => r.p ? pr(r) : nm(r.e)).join(' – ');
}
App.consPanelHTML = function () {
  const selIds = S.sel;
  let list = S.cons; const onlySel = selIds.size > 0; if (onlySel) list = list.filter(c => c.refs.some(r => selIds.has(r.e)));
  const rows = list.map(c => { const info = WC.CONS_INFO[c.type]; return `<div class="layer" data-cons="${c.id}"><span class="sw" style="background:${info.dim ? '#5fe0ff' : '#c9a7ff'}"></span><span><b>${info.label}</b> <span class="note">${esc(consName(c))}</span></span>${info.dim ? `<input class="fld" data-cval="${c.id}" value="${+(+c.val).toFixed(4)}" style="width:72px;margin-left:auto">` : '<span class="cnt"></span>'}<button data-cdel="${c.id}" title="Remove">✕</button></div>`; }).join('');
  const t = S.tool;
  let tool = '';
  if (t === 'c_dim') tool = `<div class="row"><span class="lbl">Dimension type</span><select class="fld" data-dimmode><option value="size" ${dimOpt.mode === 'size' ? 'selected' : ''}>Length / radius / Ø</option><option value="dist" ${dimOpt.mode === 'dist' ? 'selected' : ''}>Distance between 2 points</option><option value="angle" ${dimOpt.mode === 'angle' ? 'selected' : ''}>Angle of a line</option></select></div>`;
  return `<div class="card ${t && t.startsWith('c_') ? 'active' : ''}"><div class="ch">📐 Constraints & dimensions <span class="sum">${S.cons.length}</span></div><div class="cb">
    ${tool}
    <div class="row"><button class="btn" data-ca="auto" title="Join corners, horizontal/vertical lines, tangent joints – for the selection or the whole drawing">✨ Auto-constrain ${S.sel.size ? 'selection' : 'all'}</button><label class="chk note"><input type="checkbox" data-ca="show" ${S.showCons ? 'checked' : ''}> show</label></div>
    <div style="max-height:230px;overflow:auto">${rows || `<div class="note">${onlySel ? 'No constraints on the selected items.' : 'No constraints yet. Use the purple bar above the drawing.'}</div>`}</div>
    ${S.cons.length ? `<div class="row"><button class="btn danger" data-ca="clear">Remove ${onlySel ? 'these' : 'all'}</button></div>` : ''}
    <div class="note">Constraints keep the shape when you change a size, drag a point or move a line. Dimension values can be changed here.</div></div></div>`;
};
App.bindConsPanel = function (P) {
  P.querySelectorAll('[data-cons]').forEach(el => { el.onmouseenter = () => { App.consHover = +el.dataset.cons; App.redraw(); }; el.onmouseleave = () => { App.consHover = null; App.redraw(); }; });
  P.querySelectorAll('[data-cdel]').forEach(b => b.onclick = () => { App.pushUndo(); const id = +b.dataset.cdel; S.cons = S.cons.filter(c => c.id !== id); App.consHover = null; App.markChanged(); });
  P.querySelectorAll('[data-cval]').forEach(inp => { inp.onchange = () => { const v = num(inp.value, NaN); if (isFinite(v)) App.setConsValue(+inp.dataset.cval, v); }; inp.onkeydown = (e) => e.stopPropagation(); });
  P.querySelectorAll('[data-ca]').forEach(b => { const a = b.dataset.ca; if (a === 'show') b.onchange = () => { S.showCons = b.checked; App.redraw(); }; else b.onclick = () => {
    if (a === 'auto') App.autoConstrain();
    if (a === 'clear') { App.pushUndo(); if (S.sel.size) S.cons = S.cons.filter(c => !c.refs.some(r => S.sel.has(r.e))); else S.cons = []; App.markChanged(); }
  }; });
  const dm = P.querySelector('[data-dimmode]'); if (dm) dm.onchange = () => { dimOpt.mode = dm.value; S.ts = {}; App.refreshDraw(); };
};

// ------------------------------------------------------------------ grip editing (select tool)
function gripsOf(e) {
  if (e.type === 'line') return [{ g: 'a', p: e.a }, { g: 'b', p: e.b }, { g: 'm', p: V.lerp(e.a, e.b, 0.5) }];
  if (e.type === 'arc') { const [s0, s1] = WC.entEnds(e); return [{ g: 's', p: s0 }, { g: 'e', p: s1 }, { g: 'c', p: e.c }, { g: 'r', p: WC.segPoint(WC.entSeg(e), 0.5) }]; }
  return [{ g: 'c', p: e.c }, { g: 'q', p: WC.onCircle(e.c, e.r, 0) }];
}
function gripEnts() { return S.mode === 'draw' && S.tool === 'select' && !S.ts.selecting && S.sel.size && S.sel.size <= 40 ? S.ents.filter(e => S.sel.has(e.id) && !S.hidden.has(e.layer)) : []; }
App.drawGrips = function () {
  const c = App.ctx; for (const e of gripEnts()) for (const g of gripsOf(e)) { const a = App.w2s(g.p); const hot = S.grip && S.grip.e === e.id && S.grip.g === g.g; c.fillStyle = hot ? '#ff5a5a' : g.g === 'm' || g.g === 'r' || g.g === 'q' ? '#20d0d0' : '#2f8cff'; c.strokeStyle = '#fff'; c.lineWidth = 1; c.fillRect(a.x - 4.5, a.y - 4.5, 9, 9); c.strokeRect(a.x - 4.5, a.y - 4.5, 9, 9); }
};
App.gripDown = function (sx, sy) {
  for (const e of gripEnts()) for (const g of gripsOf(e)) { const a = App.w2s(g.p); if (Math.abs(a.x - sx) <= 7 && Math.abs(a.y - sy) <= 7) {
    App.pushUndo(); S.grip = { e: e.id, g: g.g, start: V.copy(g.p), orig: JSON.parse(JSON.stringify(S.ents.filter(x => S.sel.has(x.id) || x.id === e.id))), moved: false };
    // other selected entities sharing this point move with it
    S.grip.shared = []; if (g.g !== 'm' && g.g !== 'r' && g.g !== 'q') for (const o of gripEnts()) { if (o.id === e.id) continue; for (const og of gripsOf(o)) if (og.g !== 'm' && og.g !== 'r' && og.g !== 'q' && V.dist(og.p, g.p) < 1e-7) S.grip.shared.push({ e: o.id, g: og.g }); }
    hint('Drag the point – release to drop it. (Snap works; Shift = straight)'); return true; } }
  return false;
};
App.snapExclude = () => S.grip ? new Set([S.grip.e]) : null;
const prevSnapBase = App.snapBase;
App.snapBase = () => { if (S.grip) return S.grip.g === 'm' ? null : (S.grip.g === 'a' || S.grip.g === 'b') ? (() => { const e = S.grip.orig.find(x => x.id === S.grip.e); return S.grip.g === 'a' ? e.b : e.a; })() : null; return S.mode === 'draw' ? (S.ts.base || S.ts.p0 || null) : null; };
function setGrip(e, g, p, orig) {
  if (e.type === 'line') { if (g === 'a') e.a = V.copy(p); else if (g === 'b') e.b = V.copy(p); else { const d = V.sub(p, V.lerp(orig.a, orig.b, 0.5)); e.a = V.add(orig.a, d); e.b = V.add(orig.b, d); } return; }
  if (g === 'c') { e.c = V.copy(p); return; }
  if (g === 'q' || g === 'r') { const r = V.dist(e.c, p); if (r > 1e-6) e.r = r; return; }
  if (g === 's') e.a0 = WC.normPos(WC.angOf(e.c, p)); if (g === 'e') e.a1 = WC.normPos(WC.angOf(e.c, p));
}
App.gripMove = function (p) {
  const G = S.grip; if (!G) return; G.moved = true;
  const keep = JSON.parse(JSON.stringify(S.ents.filter(x => x.id === G.e || G.shared.some(s => s.e === x.id) || consFor(x.id).length)));
  const e = byId(G.e); const orig = G.orig.find(x => x.id === G.e); setGrip(e, G.g, p, orig);
  G.shared.forEach(s => { const o = byId(s.e); setGrip(o, s.g, p, G.orig.find(x => x.id === s.e)); });
  const ids = [G.e].concat(G.shared.map(s => s.e));
  if (ids.some(id => consFor(id).length)) {
    let ok = App.solveAround(ids, { fixed: ids, quick: true });
    if (!ok && ['a', 'b', 's', 'e', 'c'].includes(G.g)) { // let the point slide along what the constraints allow
      keep.forEach(k => { const x = byId(k.id); if (x) Object.assign(x, JSON.parse(JSON.stringify(k))); });
      const r = WC.solveConstraints(S.ents, S.cons, { only: new Set(ids), quick: true, drag: [{ e: G.e, p: G.g, to: p }] }); ok = r.ok; if (ok) r.updated.forEach((ne, id) => { const x = byId(id); if (x) Object.assign(x, ne); });
    }
    if (!ok) keep.forEach(k => { const x = byId(k.id); if (x) Object.assign(x, JSON.parse(JSON.stringify(k))); });
  }
  App.redraw();
};
App.gripUp = function () {
  const G = S.grip; S.grip = null; if (!G) return;
  if (!G.moved) { App.dropUndo(); App.refreshDraw(); return; }
  const ids = [G.e].concat(G.shared.map(s => s.e)); if (ids.some(id => consFor(id).length)) App.solveAround(ids, { noFix: true });
  App.markChanged();
};
})();
