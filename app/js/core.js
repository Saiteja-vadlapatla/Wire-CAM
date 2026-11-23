/* WireCAM core: geometry, DXF import/export, chaining, offsets, G-code generation and parsing.
   Works in the browser (window.WC) and in Node (module.exports) so it can be unit-tested. */
(function (root) {
'use strict';
const TAU = Math.PI * 2;
const EPS = 1e-9;

// ---------------------------------------------------------------- vectors
const V = {
  p: (x, y) => ({ x, y }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  len: (a) => Math.hypot(a.x, a.y),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
  unit: (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; },
  perpL: (a) => ({ x: -a.y, y: a.x }),   // 90 deg left
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
  eq: (a, b, tol) => Math.abs(a.x - b.x) <= (tol || 1e-6) && Math.abs(a.y - b.y) <= (tol || 1e-6),
  rot: (a, ang, c) => { c = c || { x: 0, y: 0 }; const s = Math.sin(ang), k = Math.cos(ang), x = a.x - c.x, y = a.y - c.y; return { x: c.x + x * k - y * s, y: c.y + x * s + y * k }; },
  copy: (a) => ({ x: a.x, y: a.y }),
};
const angOf = (c, p) => Math.atan2(p.y - c.y, p.x - c.x);
const normPos = (a) => { a = a % TAU; if (a < 0) a += TAU; return a; };
const onCircle = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });

// ---------------------------------------------------------------- path segments
// Segment: {t:'L', p0, p1}  or  {t:'A', p0, p1, c, r, ccw, full?}
function segL(p0, p1, extra) { return Object.assign({ t: 'L', p0: V.copy(p0), p1: V.copy(p1) }, extra || {}); }
function segA(p0, p1, c, ccw, full, extra) {
  return Object.assign({ t: 'A', p0: V.copy(p0), p1: V.copy(p1), c: V.copy(c), r: V.dist(c, p0), ccw: !!ccw, full: !!full }, extra || {});
}
function cloneSeg(s) { const o = Object.assign({}, s); o.p0 = V.copy(s.p0); o.p1 = V.copy(s.p1); if (s.c) o.c = V.copy(s.c); return o; }
function sweep(s) {
  if (s.t !== 'A') return 0;
  const a0 = angOf(s.c, s.p0), a1 = angOf(s.c, s.p1);
  let w = s.ccw ? normPos(a1 - a0) : normPos(a0 - a1);
  if (w < 1e-10) w = s.full ? TAU : 0;
  return w;
}
function segLen(s) { return s.t === 'L' ? V.dist(s.p0, s.p1) : s.r * sweep(s); }
function pathLen(segs) { let l = 0; for (const s of segs) l += segLen(s); return l; }
function segPoint(s, t) {
  if (s.t === 'L') return V.lerp(s.p0, s.p1, t);
  const a0 = angOf(s.c, s.p0), w = sweep(s);
  return onCircle(s.c, s.r, a0 + (s.ccw ? 1 : -1) * w * t);
}
function segTan(s, t) {
  if (s.t === 'L') return V.unit(V.sub(s.p1, s.p0));
  const p = segPoint(s, t), r = V.unit(V.sub(p, s.c));
  return s.ccw ? { x: -r.y, y: r.x } : { x: r.y, y: -r.x };
}
function segReverse(s) {
  const o = cloneSeg(s); o.p0 = V.copy(s.p1); o.p1 = V.copy(s.p0); if (s.t === 'A') o.ccw = !s.ccw; return o;
}
function pathReverse(segs) { return segs.slice().reverse().map(segReverse); }
function segSplit(s, t) {
  const m = segPoint(s, t);
  if (s.t === 'L') return [segL(s.p0, m, { src: s.src }), segL(m, s.p1, { src: s.src })];
  return [segA(s.p0, m, s.c, s.ccw, false, { src: s.src }), segA(m, s.p1, s.c, s.ccw, false, { src: s.src })];
}
function segNearest(s, p) {
  if (s.t === 'L') {
    const d = V.sub(s.p1, s.p0), L2 = V.dot(d, d);
    let t = L2 < EPS ? 0 : V.dot(V.sub(p, s.p0), d) / L2; t = Math.max(0, Math.min(1, t));
    const q = V.lerp(s.p0, s.p1, t); return { t, pt: q, d: V.dist(p, q) };
  }
  const w = sweep(s); if (w < EPS) return { t: 0, pt: V.copy(s.p0), d: V.dist(p, s.p0) };
  const a0 = angOf(s.c, s.p0), ap = angOf(s.c, p);
  let rel = s.ccw ? normPos(ap - a0) : normPos(a0 - ap);
  let t;
  if (rel <= w) t = rel / w;
  else { // outside the sweep: pick nearer end
    t = V.dist(p, s.p0) < V.dist(p, s.p1) ? 0 : 1;
  }
  const q = segPoint(s, t); return { t, pt: q, d: V.dist(p, q) };
}
function segBBox(s, bb) {
  bb = bb || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const inc = (p) => { if (p.x < bb.x0) bb.x0 = p.x; if (p.y < bb.y0) bb.y0 = p.y; if (p.x > bb.x1) bb.x1 = p.x; if (p.y > bb.y1) bb.y1 = p.y; };
  inc(s.p0); inc(s.p1);
  if (s.t === 'A') {
    const w = sweep(s), a0 = angOf(s.c, s.p0);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2; const rel = s.ccw ? normPos(a - a0) : normPos(a0 - a);
      if (rel <= w + 1e-12) inc(onCircle(s.c, s.r, a));
    }
  }
  return bb;
}
function angleOnArc(s, a) { // is angle a inside sweep of arc seg s
  const w = sweep(s), a0 = angOf(s.c, s.p0);
  const rel = s.ccw ? normPos(a - a0) : normPos(a0 - a);
  return rel <= w + 1e-9 || rel >= TAU - 1e-9;
}
// sample a segment into points (for drawing / area)
function segSample(s, maxStepRad) {
  if (s.t === 'L') return [s.p0, s.p1];
  const w = sweep(s), n = Math.max(2, Math.ceil(w / (maxStepRad || 0.08)));
  const pts = []; for (let i = 0; i <= n; i++) pts.push(segPoint(s, i / n)); return pts;
}
function pathSample(segs) { const pts = []; segs.forEach((s, i) => { const q = segSample(s); if (i) q.shift(); pts.push(...q); }); return pts; }
function signedArea(segs) {
  const pts = pathSample(segs); let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
function pointInPath(segs, p) { // even-odd on sampled polygon
  const pts = pathSample(segs); let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}
function pathNearest(segs, p) {
  let best = null, acc = 0;
  segs.forEach((s, i) => { const n = segNearest(s, p); const L = segLen(s); if (!best || n.d < best.d) best = { i, t: n.t, pt: n.pt, d: n.d, s: acc + n.t * L }; acc += L; });
  return best;
}
function pathPointAtDist(segs, d) {
  let acc = 0;
  for (let i = 0; i < segs.length; i++) { const L = segLen(segs[i]); if (acc + L >= d - 1e-9) { const t = L < EPS ? 0 : (d - acc) / L; return { i, t: Math.max(0, Math.min(1, t)), pt: segPoint(segs[i], Math.max(0, Math.min(1, t))) }; } acc += L; }
  const last = segs[segs.length - 1]; return { i: segs.length - 1, t: 1, pt: V.copy(last.p1) };
}
// split a path at distance d -> [before, after]
function pathSplitAtDist(segs, d) {
  const r = pathPointAtDist(segs, d);
  const before = segs.slice(0, r.i).map(cloneSeg), after = segs.slice(r.i + 1).map(cloneSeg);
  const s = segs[r.i];
  if (r.t <= 1e-9) after.unshift(cloneSeg(s));
  else if (r.t >= 1 - 1e-9) before.push(cloneSeg(s));
  else { const [a, b] = segSplit(s, r.t); before.push(a); after.unshift(b); }
  return [before.filter(x => segLen(x) > 1e-7), after.filter(x => segLen(x) > 1e-7)];
}
function pathIsClosed(segs, tol) { return segs.length > 0 && V.eq(segs[0].p0, segs[segs.length - 1].p1, tol || 1e-4); }
function pathBBox(segs) { const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; segs.forEach(s => segBBox(s, bb)); return bb; }

// ---------------------------------------------------------------- intersections (infinite curves)
function llInf(p, d, q, e) { const den = V.cross(d, e); if (Math.abs(den) < 1e-12) return []; const t = V.cross(V.sub(q, p), e) / den; return [V.add(p, V.mul(d, t))]; }
function lcInf(p, d, c, r) {
  d = V.unit(d); const f = V.sub(p, c); const b = V.dot(f, d), cc = V.dot(f, f) - r * r; let disc = b * b - cc;
  if (disc < -1e-9) return []; disc = Math.max(0, disc); const s = Math.sqrt(disc);
  return [V.add(p, V.mul(d, -b - s)), V.add(p, V.mul(d, -b + s))];
}
function ccInf(c1, r1, c2, r2) {
  const d = V.dist(c1, c2); if (d < 1e-12) return []; if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d); const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m = V.add(c1, V.mul(V.sub(c2, c1), a / d)); const u = V.perpL(V.unit(V.sub(c2, c1)));
  return [V.add(m, V.mul(u, h)), V.add(m, V.mul(u, -h))];
}
function curveInter(a, b) { // infinite curves of two segs
  if (a.t === 'L' && b.t === 'L') return llInf(a.p0, V.sub(a.p1, a.p0), b.p0, V.sub(b.p1, b.p0));
  if (a.t === 'L') return lcInf(a.p0, V.sub(a.p1, a.p0), b.c, b.r);
  if (b.t === 'L') return lcInf(b.p0, V.sub(b.p1, b.p0), a.c, a.r);
  return ccInf(a.c, a.r, b.c, b.r);
}
function onSeg(s, p, tol) {
  tol = tol || 1e-6;
  if (s.t === 'L') { const n = segNearest(s, p); return n.d <= tol; }
  if (Math.abs(V.dist(p, s.c) - s.r) > tol) return false; return angleOnArc(s, angOf(s.c, p));
}
function segInter(a, b, tol) { return curveInter(a, b).filter(p => onSeg(a, p, tol) && onSeg(b, p, tol)); }

// ---------------------------------------------------------------- entities (drawing)
// {id, type:'line', a, b} | {id,type:'arc', c, r, a0, a1 (ccw radians)} | {id, type:'circle', c, r}
let _id = 1;
function newId() { return _id++; }
function setIdBase(n) { if (n >= _id) _id = n + 1; }
function mkLine(a, b, layer) { return { id: newId(), type: 'line', a: V.copy(a), b: V.copy(b), layer: layer || '0' }; }
function mkArc(c, r, a0, a1, layer) { return { id: newId(), type: 'arc', c: V.copy(c), r, a0: normPos(a0), a1: normPos(a1), layer: layer || '0' }; }
function mkCircle(c, r, layer) { return { id: newId(), type: 'circle', c: V.copy(c), r, layer: layer || '0' }; }
function entSeg(e) { // as path segment(s) oriented in natural direction
  if (e.type === 'line') return segL(e.a, e.b, { src: e.id });
  if (e.type === 'arc') return segA(onCircle(e.c, e.r, e.a0), onCircle(e.c, e.r, e.a1), e.c, true, Math.abs(normPos(e.a1 - e.a0)) < 1e-12, { src: e.id });
  return segA(onCircle(e.c, e.r, 0), onCircle(e.c, e.r, 0), e.c, true, true, { src: e.id });
}
function segToEnt(s, layer) {
  if (s.t === 'L') return mkLine(s.p0, s.p1, layer);
  if (s.full) return mkCircle(s.c, s.r, layer);
  const a0 = angOf(s.c, s.p0), a1 = angOf(s.c, s.p1);
  return s.ccw ? mkArc(s.c, s.r, a0, a1, layer) : mkArc(s.c, s.r, a1, a0, layer);
}
function entEnds(e) { if (e.type === 'line') return [e.a, e.b]; if (e.type === 'arc') return [onCircle(e.c, e.r, e.a0), onCircle(e.c, e.r, e.a1)]; return []; }
function entBBox(e, bb) { return segBBox(entSeg(e), bb); }
function entsBBox(ents) { const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; ents.forEach(e => entBBox(e, bb)); return bb; }
function entNearest(e, p) { return segNearest(entSeg(e), p); }
function entLen(e) { return segLen(entSeg(e)); }
function transformEnt(e, f, mirror) { // f: point->point (rigid / uniform scale), mirror: bool if det<0
  const o = Object.assign({}, e, { id: e.id });
  if (e.type === 'line') { o.a = f(e.a); o.b = f(e.b); return o; }
  const c = f(e.c), r = V.dist(c, f(V.add(e.c, { x: e.r, y: 0 })));
  if (e.type === 'circle') { o.c = c; o.r = r; return o; }
  const p0 = f(onCircle(e.c, e.r, e.a0)), p1 = f(onCircle(e.c, e.r, e.a1));
  o.c = c; o.r = r;
  if (!mirror) { o.a0 = normPos(angOf(c, p0)); o.a1 = normPos(angOf(c, p1)); } else { o.a0 = normPos(angOf(c, p1)); o.a1 = normPos(angOf(c, p0)); }
  return o;
}
function cloneEnt(e) { const o = JSON.parse(JSON.stringify(e)); o.id = newId(); return o; }

// ---------------------------------------------------------------- arc fitting of point lists (splines/ellipses)
function circle3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)); if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y };
}
function fitPoints(pts, tol) { // -> segments (lines and arcs) within tol
  tol = tol || 0.002; const out = [];
  const tryFit = (i, j) => {
    const a = pts[i], b = pts[j];
    // line?
    let okL = true; const L = segL(a, b);
    for (let k = i + 1; k < j; k++) if (segNearest(L, pts[k]).d > tol) { okL = false; break; }
    if (okL) return L;
    const m = pts[Math.floor((i + j) / 2)], c = circle3(a, m, b); if (!c) return null;
    const r = V.dist(c, a); if (r > 1e5) return null;
    const ccw = V.cross(V.sub(m, a), V.sub(b, m)) > 0;
    const s = segA(a, b, c, ccw);
    for (let k = i + 1; k < j; k++) { const p = pts[k]; if (Math.abs(V.dist(p, c) - r) > tol || !angleOnArc(s, angOf(c, p))) return null; }
    if (sweep(s) > Math.PI * 1.5) return null;
    return s;
  };
  let i = 0;
  while (i < pts.length - 1) {
    let lo = i + 1, best = segL(pts[i], pts[i + 1]), bestJ = i + 1;
    let step = 1, j = i + 1;
    while (j < pts.length) { const f = tryFit(i, j); if (f) { best = f; bestJ = j; step *= 2; j = Math.min(pts.length - 1, i + step); if (bestJ === pts.length - 1) break; } else break; }
    // binary refine between bestJ and j
    let hi = Math.min(j, pts.length - 1); lo = bestJ;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; const f = tryFit(i, mid); if (f) { best = f; lo = mid; bestJ = mid; } else hi = mid; }
    out.push(best); i = bestJ;
  }
  return out.filter(s => segLen(s) > 1e-7);
}

// ---------------------------------------------------------------- DXF import
function nurbsEval(deg, knots, ctrl, w, u) {
  const n = ctrl.length - 1; let k = deg;
  for (let i = deg; i <= n; i++) if (u >= knots[i] && u < knots[i + 1]) { k = i; break; }
  if (u >= knots[n + 1]) k = n;
  const d = []; for (let j = 0; j <= deg; j++) { const P = ctrl[k - deg + j], ww = w ? w[k - deg + j] : 1; d.push({ x: P.x * ww, y: P.y * ww, w: ww }); }
  for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
    const i = k - deg + j; const den = knots[i + deg - r + 1] - knots[i]; const a = den === 0 ? 0 : (u - knots[i]) / den;
    d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y, w: (1 - a) * d[j - 1].w + a * d[j].w };
  }
  return { x: d[deg].x / d[deg].w, y: d[deg].y / d[deg].w };
}
function parseDXF(text, opts) {
  opts = opts || {}; const warnings = []; const skipped = {};
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = []; for (let i = 0; i + 1 < lines.length; i += 2) { const c = parseInt(lines[i].trim(), 10); if (isNaN(c)) { i--; continue; } pairs.push([c, lines[i + 1]]); }
  // group into raw entities per section
  let sec = null, cur = null, block = null; const blocks = {}; const ents = []; let insunits = 0;
  const pushCur = () => { if (!cur) return; if (sec === 'ENTITIES') ents.push(cur); else if (sec === 'BLOCKS' && block) block.ents.push(cur); cur = null; };
  for (let i = 0; i < pairs.length; i++) {
    const [c, vRaw] = pairs[i]; const v = vRaw.trim();
    if (c === 0) {
      pushCur();
      if (v === 'SECTION') { const nx = pairs[i + 1]; sec = nx && nx[0] === 2 ? nx[1].trim() : null; i++; continue; }
      if (v === 'ENDSEC') { sec = null; continue; }
      if (sec === 'BLOCKS' && v === 'BLOCK') { block = { name: '', base: { x: 0, y: 0 }, ents: [] }; cur = null; let j = i + 1; for (; j < pairs.length && pairs[j][0] !== 0; j++) { const [cc, vv] = pairs[j]; if (cc === 2) block.name = vv.trim(); if (cc === 10) block.base.x = +vv; if (cc === 20) block.base.y = +vv; } i = j - 1; continue; }
      if (sec === 'BLOCKS' && v === 'ENDBLK') { if (block) blocks[block.name] = block; block = null; continue; }
      if (sec === 'ENTITIES' || (sec === 'BLOCKS' && block)) cur = { type: v, g: [] };
      continue;
    }
    if (sec === 'HEADER' && c === 9 && v === '$INSUNITS') { const nx = pairs[i + 1]; if (nx) insunits = parseInt(nx[1], 10) || 0; }
    if (cur) cur.g.push([c, v]);
  }
  pushCur();
  // merge POLYLINE/VERTEX/SEQEND sequences
  const merge = (list) => { const out = []; for (let i = 0; i < list.length; i++) { const e = list[i]; if (e.type === 'POLYLINE') { e.verts = []; while (i + 1 < list.length && list[i + 1].type === 'VERTEX') { e.verts.push(list[++i]); } if (i + 1 < list.length && list[i + 1].type === 'SEQEND') i++; } out.push(e); } return out; };
  const top = merge(ents); Object.values(blocks).forEach(b => b.ents = merge(b.ents));
  const out = []; const layers = {};
  const get = (e, code, def) => { for (const [c, v] of e.g) if (c === code) return v; return def; };
  const num = (e, code, def) => { const v = get(e, code, null); return v === null ? def : parseFloat(v); };
  // matrix helpers [a,b,c,d,e,f] : x' = a x + c y + e ; y' = b x + d y + f
  const I = [1, 0, 0, 1, 0, 0];
  const mm = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const ap = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
  const det = (m) => m[0] * m[3] - m[1] * m[2];
  const uniform = (m) => { const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]); return Math.abs(sx - sy) < 1e-9 * Math.max(1, sx) && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9; };
  const ocs = (e) => (num(e, 230, 1) < 0 ? [-1, 0, 0, 1, 0, 0] : I);
  const addSegs = (segs, layer) => segs.forEach(s => { if (segLen(s) > 1e-7) out.push(Object.assign(segToEnt(s, layer), {})); });
  const emitArcLike = (c, r, a0, a1, full, m, layer) => {
    if (uniform(m)) {
      const cc = ap(m, c), rr = r * Math.hypot(m[0], m[1]);
      if (full) { out.push(mkCircle(cc, rr, layer)); return; }
      const p0 = ap(m, onCircle(c, r, a0)), p1 = ap(m, onCircle(c, r, a1));
      if (det(m) > 0) out.push(mkArc(cc, rr, angOf(cc, p0), angOf(cc, p1), layer)); else out.push(mkArc(cc, rr, angOf(cc, p1), angOf(cc, p0), layer));
    } else { // non-uniform: sample + fit
      const w = full ? TAU : normPos(a1 - a0) || TAU; const n = 64; const pts = [];
      for (let i = 0; i <= n; i++) pts.push(ap(m, onCircle(c, r, a0 + w * i / n)));
      addSegs(fitPoints(pts, opts.fitTol || 0.002), layer);
    }
  };
  const doEnt = (e, m, depth, inLayer) => {
    let layer = get(e, 8, '0').trim(); if (layer === '0' && inLayer) layer = inLayer;
    const M = mm(m, ocs(e)); const t = e.type;
    if (t === 'LINE') {
      const a = ap(M, { x: num(e, 10, 0), y: num(e, 20, 0) }), b = ap(M, { x: num(e, 11, 0), y: num(e, 21, 0) });
      if (V.dist(a, b) > 1e-7) out.push(mkLine(a, b, layer));
    } else if (t === 'ARC') {
      const c = { x: num(e, 10, 0), y: num(e, 20, 0) }, r = num(e, 40, 0);
      if (r > 1e-7) emitArcLike(c, r, num(e, 50, 0) * Math.PI / 180, num(e, 51, 0) * Math.PI / 180, false, M, layer);
    } else if (t === 'CIRCLE') {
      const c = { x: num(e, 10, 0), y: num(e, 20, 0) }, r = num(e, 40, 0); if (r > 1e-7) emitArcLike(c, r, 0, TAU, true, M, layer);
    } else if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
      const vs = [];
      if (t === 'LWPOLYLINE') { let cv = null; for (const [c, v] of e.g) { if (c === 10) { cv = { x: +v, y: 0, b: 0 }; vs.push(cv); } else if (c === 20 && cv) cv.y = +v; else if (c === 42 && cv) cv.b = +v; } }
      else for (const vx of e.verts || []) { const fl = parseInt(get(vx, 70, '0'), 10); if (fl & 16) continue; vs.push({ x: num(vx, 10, 0), y: num(vx, 20, 0), b: num(vx, 42, 0) }); }
      const closed = (parseInt(get(e, 70, '0'), 10) & 1) === 1;
      const segs = [];
      for (let i = 0; i < vs.length; i++) {
        const a = vs[i], bIdx = i + 1 < vs.length ? i + 1 : (closed ? 0 : -1); if (bIdx < 0) break; const b = vs[bIdx];
        if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) continue;
        if (Math.abs(a.b) < 1e-12) segs.push(segL(a, b));
        else { const th = 4 * Math.atan(a.b), d = Math.hypot(b.x - a.x, b.y - a.y), u = V.unit(V.sub(b, a)), mid = V.lerp(a, b, 0.5), h = (d / 2) / Math.tan(th / 2); const c = V.add(mid, V.mul(V.perpL(u), h)); segs.push(segA(a, b, c, th > 0)); }
      }
      segs.forEach(s => {
        if (s.t === 'L') { const a = ap(M, s.p0), b = ap(M, s.p1); out.push(mkLine(a, b, layer)); }
        else { const a0 = angOf(s.c, s.p0), a1 = angOf(s.c, s.p1); if (s.ccw) emitArcLike(s.c, s.r, a0, a1, false, M, layer); else emitArcLike(s.c, s.r, a1, a0, false, M, layer); }
      });
    } else if (t === 'SPLINE') {
      const deg = parseInt(get(e, 71, '3'), 10); const knots = [], ctrl = [], w = [], fit = [];
      let lastCtrl = null, lastFit = null;
      for (const [c, v] of e.g) { if (c === 40) knots.push(+v); else if (c === 41) w.push(+v); else if (c === 10) { lastCtrl = { x: +v, y: 0 }; ctrl.push(lastCtrl); } else if (c === 20 && lastCtrl) lastCtrl.y = +v; else if (c === 11) { lastFit = { x: +v, y: 0 }; fit.push(lastFit); } else if (c === 21 && lastFit) lastFit.y = +v; }
      let pts = [];
      if (ctrl.length > deg && knots.length === ctrl.length + deg + 1) {
        const u0 = knots[deg], u1 = knots[ctrl.length]; let poly = 0; for (let i = 1; i < ctrl.length; i++) poly += V.dist(ctrl[i - 1], ctrl[i]);
        const n = Math.min(4000, Math.max(64, Math.ceil(poly / 0.05)));
        for (let i = 0; i <= n; i++) pts.push(nurbsEval(deg, knots, ctrl, w.length === ctrl.length ? w : null, u0 + (u1 - u0) * i / n));
      } else if (fit.length > 1) pts = fit;
      pts = pts.map(p => ap(M, p));
      if (pts.length > 1) addSegs(fitPoints(pts, opts.fitTol || 0.002), layer);
      warnings.push('SPLINE converted to arcs/lines (tolerance ' + (opts.fitTol || 0.002) + ' mm).');
    } else if (t === 'ELLIPSE') {
      const c = { x: num(e, 10, 0), y: num(e, 20, 0) }, mj = { x: num(e, 11, 0), y: num(e, 21, 0) }, ratio = num(e, 40, 1);
      let s0 = num(e, 41, 0), s1 = num(e, 42, TAU); if (s1 <= s0) s1 += TAU; const R = V.len(mj), rot = Math.atan2(mj.y, mj.x);
      const n = Math.max(64, Math.ceil((s1 - s0) / TAU * 360)); const pts = [];
      for (let i = 0; i <= n; i++) { const u = s0 + (s1 - s0) * i / n; const p = { x: R * Math.cos(u), y: R * ratio * Math.sin(u) }; pts.push(ap(M, V.add(c, V.rot(p, rot)))); }
      addSegs(fitPoints(pts, opts.fitTol || 0.002), layer);
      warnings.push('ELLIPSE converted to arcs/lines.');
    } else if (t === 'INSERT') {
      if (depth > 8) return; const b = blocks[get(e, 2, '').trim()]; if (!b) return;
      const pos = { x: num(e, 10, 0), y: num(e, 20, 0) }, sx = num(e, 41, 1), sy = num(e, 42, 1), rot = num(e, 50, 0) * Math.PI / 180;
      const cols = Math.max(1, parseInt(get(e, 70, '1'), 10) || 1), rows = Math.max(1, parseInt(get(e, 71, '1'), 10) || 1), cs = num(e, 44, 0), rs = num(e, 45, 0);
      for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
        const off = V.rot({ x: ci * cs, y: ri * rs }, rot);
        const T = [1, 0, 0, 1, pos.x + off.x, pos.y + off.y], R = [Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), 0, 0], S = [sx, 0, 0, sy, 0, 0], B = [1, 0, 0, 1, -b.base.x, -b.base.y];
        const BM = mm(M, mm(T, mm(R, mm(S, B))));
        b.ents.forEach(be => doEnt(be, BM, depth + 1, layer));
      }
    } else { skipped[t] = (skipped[t] || 0) + 1; }
  };
  top.forEach(e => doEnt(e, I, 0, null));
  out.forEach(e => { layers[e.layer] = (layers[e.layer] || 0) + 1; });
  let scale = 1; if (insunits === 1 && opts.inchToMm) scale = 25.4;
  if (scale !== 1) out.forEach((e, k) => out[k] = transformEnt(e, p => V.mul(p, scale), false));
  const uniqW = [...new Set(warnings)];
  return { entities: out, layers, skipped, warnings: uniqW, insunits };
}
function dedupeEntities(ents, tol) {
  tol = tol || 1e-5; const keep = []; let removed = 0; const seen = new Map();
  const k = (v) => Math.round(v / tol / 10);
  for (const e of ents) {
    let key;
    if (e.type === 'line') { const a = e.a, b = e.b; const [p, q] = (a.x < b.x || (a.x === b.x && a.y < b.y)) ? [a, b] : [b, a]; key = 'L' + [k(p.x), k(p.y), k(q.x), k(q.y)].join(','); }
    else if (e.type === 'arc') key = 'A' + [k(e.c.x), k(e.c.y), k(e.r), Math.round(e.a0 * 1e5), Math.round(e.a1 * 1e5)].join(',');
    else key = 'C' + [k(e.c.x), k(e.c.y), k(e.r)].join(',');
    if (seen.has(key)) { removed++; continue; } seen.set(key, 1); keep.push(e);
  }
  return { entities: keep, removed };
}
function writeDXF(ents) {
  const L = []; const w = (c, v) => { L.push(String(c)); L.push(String(v)); };
  const f = (n) => (Math.round(n * 1e8) / 1e8).toString();
  w(0, 'SECTION'); w(2, 'HEADER'); w(9, '$ACADVER'); w(1, 'AC1009'); w(9, '$INSUNITS'); w(70, 4); w(0, 'ENDSEC');
  w(0, 'SECTION'); w(2, 'ENTITIES');
  for (const e of ents) {
    if (e.type === 'line') { w(0, 'LINE'); w(8, e.layer || '0'); w(10, f(e.a.x)); w(20, f(e.a.y)); w(30, 0); w(11, f(e.b.x)); w(21, f(e.b.y)); w(31, 0); }
    else if (e.type === 'arc') { w(0, 'ARC'); w(8, e.layer || '0'); w(10, f(e.c.x)); w(20, f(e.c.y)); w(30, 0); w(40, f(e.r)); w(50, f(e.a0 * 180 / Math.PI)); w(51, f(e.a1 * 180 / Math.PI)); }
    else { w(0, 'CIRCLE'); w(8, e.layer || '0'); w(10, f(e.c.x)); w(20, f(e.c.y)); w(30, 0); w(40, f(e.r)); }
  }
  w(0, 'ENDSEC'); w(0, 'EOF'); return L.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- chaining with junction handling
function buildGraph(ents, tol) {
  tol = tol || 0.005; const nodes = []; const grid = new Map(); const cell = tol * 4;
  const keyOf = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  const findNode = (p) => {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const arr = grid.get((cx + i) + ',' + (cy + j)); if (arr) for (const n of arr) if (V.dist(nodes[n].p, p) <= tol) return n; }
    const id = nodes.length; nodes.push({ p: V.copy(p), edges: [] }); const k = keyOf(p.x, p.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(id); return id;
  };
  const edges = new Map();
  for (const e of ents) {
    if (e.type === 'circle') continue; const [a, b] = entEnds(e); const na = findNode(a), nb = findNode(b);
    if (na === nb && entLen(e) < tol * 4) continue; // tiny piece shorter than the join tolerance
    edges.set(e.id, { e, n0: na, n1: nb }); nodes[na].edges.push(e.id); if (nb !== na) nodes[nb].edges.push(e.id); else nodes[na].edges.push(e.id);
  }
  return { nodes, edges, tol };
}
// Chainer: stateful helper used by the UI. Grows forward, then backward. Stops at junctions to ask.
function Chainer(ents, startEnt, tol) {
  this.ents = ents; this.tol = tol || 0.005;
  if (startEnt.type === 'circle') { this.segs = [entSeg(startEnt)]; this.closed = true; this.done = true; this.used = new Set([startEnt.id]); return; }
  this.g = buildGraph(ents, this.tol); this.used = new Set([startEnt.id]);
  const ed = this.g.edges.get(startEnt.id);
  this.segs = [entSeg(startEnt)]; this.headNode = ed.n1; this.tailNode = ed.n0; this.phase = 'fwd'; this.closed = false; this.done = false; this.junction = null;
  if (ed.n0 === ed.n1) { this.closed = true; this.done = true; }
}
Chainer.prototype.candidates = function (node) { return this.g.nodes[node].edges.filter(id => !this.used.has(id)); };
Chainer.prototype.orientFrom = function (id, node) { const ed = this.g.edges.get(id); const s = entSeg(ed.e); return ed.n0 === node ? { s, next: ed.n1 } : { s: segReverse(s), next: ed.n0 }; };
Chainer.prototype.addFwd = function (id) { const o = this.orientFrom(id, this.headNode); o.s.p0 = this.segs.length ? V.copy(this.segs[this.segs.length - 1].p1) : V.copy(this.startPt || o.s.p0); this.segs.push(o.s); this.used.add(id); this.headNode = o.next; };
Chainer.prototype.addBack = function (id) { const o = this.orientFrom(id, this.tailNode); const r = segReverse(o.s); r.p1 = V.copy(this.segs[0].p0); this.segs.unshift(r); this.used.add(id); this.tailNode = o.next; };
Chainer.prototype.run = function (autoStraight) {
  // returns {state:'done'|'junction', node, cands}
  let guard = 0;
  while (!this.done && guard++ < 100000) {
    const node = this.phase === 'fwd' ? this.headNode : this.tailNode;
    if (this.headNode === this.tailNode && this.segs.length > 0) { // loop closed
      this.closed = true; this.done = true; const last = this.segs[this.segs.length - 1]; last.p1 = V.copy(this.segs[0].p0); break;
    }
    const c = this.candidates(node);
    if (c.length === 0) { if (this.phase === 'fwd' && !this.oneWay) { this.phase = 'back'; continue; } this.done = true; break; }
    let pick = null;
    if (c.length === 1) pick = c[0];
    else if (autoStraight && this.segs.length) pick = this.straightest(node, c);
    if (pick === null) { this.junction = { node, cands: c, phase: this.phase }; return { state: 'junction', node, cands: c, phase: this.phase, p: this.g.nodes[node].p }; }
    if (this.phase === 'fwd') this.addFwd(pick); else this.addBack(pick);
  }
  this.junction = null; return { state: 'done' };
};
Chainer.prototype.straightest = function (node, cands) {
  const fwd = this.phase === 'fwd'; const ref = fwd ? segTan(this.segs[this.segs.length - 1], 1) : V.mul(segTan(this.segs[0], 0), -1);
  let best = null, bd = -Infinity;
  for (const id of cands) { const o = this.orientFrom(id, node); const t = segTan(o.s, 0); const d = V.dot(ref, t); if (d > bd) { bd = d; best = id; } }
  return best;
};
Chainer.prototype.choose = function (id) { if (!this.junction) return; if (this.junction.phase === 'fwd') this.addFwd(id); else this.addBack(id); this.junction = null; };
Chainer.prototype.stopHere = function () { if (!this.junction) return; if (this.oneWay) this.done = true; else if (this.junction.phase === 'fwd') this.phase = 'back'; else this.done = true; this.junction = null; };
Chainer.prototype.undoLast = function () { // remove last added at head (fwd) or tail
  if (this.segs.length <= (this.oneWay ? 0 : 1)) return false; this.done = false; this.closed = false; this.junction = null;
  const last = this.segs.pop(); if (this.oneWay && !this.segs.length) { this.used.delete(last.src); this.headNode = this.tailNode; this.phase = 'fwd'; return true; } this.used.delete(last.src); const ed = this.g.edges.get(last.src);
  this.headNode = (V.dist(this.g.nodes[ed.n0].p, last.p0) <= this.tol * 1.01) ? ed.n0 : ed.n1; this.phase = 'fwd';
  return true;
};
// split every entity that passes through point p (not at its ends) so p becomes a graph node
function splitEntsAt(ents, p, tol) {
  tol = tol || 0.005; const out = [];
  for (const e of ents) {
    const n = entNearest(e, p);
    if (n.d > tol) { out.push(e); continue; }
    if (e.type === 'line') { if (V.dist(e.a, p) <= tol || V.dist(e.b, p) <= tol) { out.push(e); continue; } out.push(Object.assign(mkLine(e.a, p, e.layer), { from: e.id }), Object.assign(mkLine(p, e.b, e.layer), { from: e.id })); continue; }
    const a = angOf(e.c, p);
    if (e.type === 'circle') { out.push(Object.assign(mkArc(e.c, e.r, a, a + Math.PI, e.layer), { from: e.id }), Object.assign(mkArc(e.c, e.r, a + Math.PI, a, e.layer), { from: e.id })); continue; }
    const [q0, q1] = entEnds(e); if (V.dist(q0, p) <= tol || V.dist(q1, p) <= tol) { out.push(e); continue; }
    if (Math.abs(normPos(e.a1 - e.a0)) < 1e-12) { out.push(Object.assign(mkArc(e.c, e.r, a, a + Math.PI, e.layer), { from: e.id }), Object.assign(mkArc(e.c, e.r, a + Math.PI, a, e.layer), { from: e.id })); continue; }
    out.push(Object.assign(mkArc(e.c, e.r, e.a0, a, e.layer), { from: e.id }), Object.assign(mkArc(e.c, e.r, a, e.a1, e.layer), { from: e.id }));
  }
  return out;
}
// split entities where another entity's end point touches their middle (T-junctions)
function splitAtTJunctions(ents, tol) {
  tol = tol || 0.005; const ends = []; ents.forEach(e => entEnds(e).forEach(q => ends.push(q)));
  let list = ents;
  const out = [];
  for (const e of list) {
    const bb = entBBox(e); const pts = ends.filter(q => q.x >= bb.x0 - tol && q.x <= bb.x1 + tol && q.y >= bb.y0 - tol && q.y <= bb.y1 + tol);
    let pieces = [e];
    for (const q of pts) {
      const nx = []; for (const pc of pieces) { const r = splitEntsAt([pc], q, tol); nx.push(...r.map(x => (x.from = e.id, x))); } pieces = nx;
    }
    out.push(...pieces);
  }
  return out;
}
// merge consecutive collinear lines / same-circle arcs (pieces created by splitting at junctions)
function mergeCollinear(segs, tol) {
  tol = tol || 1e-6; const out = [];
  for (const s0 of segs) {
    const s = cloneSeg(s0); const prev = out[out.length - 1];
    if (prev && prev.t === 'L' && s.t === 'L') { const a = V.unit(V.sub(prev.p1, prev.p0)), b = V.unit(V.sub(s.p1, s.p0)); if (Math.abs(V.cross(a, b)) < 1e-9 && V.dot(a, b) > 0 && segNearest(segL(prev.p0, s.p1), prev.p1).d < tol) { prev.p1 = V.copy(s.p1); continue; } }
    if (prev && prev.t === 'A' && s.t === 'A' && prev.ccw === s.ccw && V.dist(prev.c, s.c) < tol && Math.abs(prev.r - s.r) < tol && sweep(prev) + sweep(s) < 2 * Math.PI - 1e-6) { prev.p1 = V.copy(s.p1); prev.full = false; continue; }
    out.push(s);
  }
  return out;
}
// one-way chainer that starts at a point (the lead-in end); the first choice sets the direction
Chainer.fromPoint = function (ents, p, tol) {
  tol = tol || 0.005; const list = splitEntsAt(splitAtTJunctions(ents, tol), p, tol);
  const ch = Object.create(Chainer.prototype); ch.ents = list; ch.tol = tol; ch.g = buildGraph(list, tol); ch.used = new Set(); ch.segs = []; ch.oneWay = true; ch.phase = 'fwd'; ch.closed = false; ch.done = false; ch.junction = null;
  let node = -1, bd = Infinity; ch.g.nodes.forEach((nd, i) => { const d = V.dist(nd.p, p); if (d < bd) { bd = d; node = i; } });
  if (node < 0 || bd > tol * 2) { ch.done = true; ch.error = 'not-on-drawing'; return ch; }
  ch.headNode = ch.tailNode = node; ch.startPt = V.copy(ch.g.nodes[node].p); return ch;
};
// nearest point on any entity (with vertex preference) -> {pt, d, vertex}
function nearestOnEnts(ents, p, vertexTol) {
  let best = null;
  for (const e of ents) { const n = entNearest(e, p); if (!best || n.d < best.d) best = { pt: n.pt, d: n.d, e }; }
  if (!best) return null;
  for (const q of entEnds(best.e)) if (V.dist(q, best.pt) <= (vertexTol || 0)) { best.pt = V.copy(q); best.vertex = true; }
  return best;
}
// candidate segment oriented from junction node (for drawing arrows)
Chainer.prototype.candSeg = function (id) { return this.orientFrom(id, this.junction.node).s; };

// ---------------------------------------------------------------- offset (preview / taper top)
// d > 0 : offset to LEFT of travel. join: 'round' (wire compensation) | 'miter' (taper top)
function offsetSeg(s, d) {
  if (s.t === 'L') { const n = V.mul(V.perpL(segTan(s, 0)), d); return segL(V.add(s.p0, n), V.add(s.p1, n), { src: s.src }); }
  const k = s.ccw ? -1 : 1; const r2 = s.r + k * d; if (r2 <= 1e-9) return null;
  const f = (p) => V.add(s.c, V.mul(V.unit(V.sub(p, s.c)), r2));
  return segA(f(s.p0), f(s.p1), s.c, s.ccw, s.full, { src: s.src });
}
function trimTo(s, p, atEnd) { const o = cloneSeg(s); if (atEnd) o.p1 = V.copy(p); else o.p0 = V.copy(p); if (o.t === 'A') { o.full = false; } return o; }
function offsetPath(segs, d, closed, join) {
  join = join || 'round'; const warnings = [];
  if (Math.abs(d) < 1e-12) return { segs: segs.map(cloneSeg), warnings };
  const off = segs.map(s => offsetSeg(s, d));
  off.forEach((o, i) => { if (!o) warnings.push('Arc R' + segs[i].r.toFixed(3) + ' is smaller than offset ' + Math.abs(d).toFixed(3)); });
  const list = []; const src = [];
  off.forEach((o, i) => { if (o) { list.push(o); src.push(segs[i]); } });
  if (!list.length) return { segs: [], warnings };
  const out = [];
  const n = list.length; const joins = closed ? n : n - 1;
  const res = list.map(cloneSeg);
  const extra = new Array(n).fill(null);
  for (let k = 0; k < joins; k++) {
    const i = k, j = (k + 1) % n; const a = res[i], b = res[j];
    if (V.dist(a.p1, b.p0) < 1e-7) continue;
    const ta = segTan(src[i], 1), tb = segTan(src[j], 0); const turn = V.cross(ta, tb);
    const v = src[i].p1; // original vertex
    const concave = turn * d > 0;
    if (concave || join === 'miter') {
      const cand = curveInter(a, b); let best = null, bd = Infinity;
      for (const p of cand) { const dd = V.dist(p, v); if (dd < bd) { bd = dd; best = p; } }
      if (best && bd < Math.abs(d) * 50 + 1) { res[i] = trimTo(res[i], best, true); res[j] = trimTo(res[j], best, false); continue; }
    }
    // round join (gap) or fallback
    if (join === 'round' && !concave) extra[i] = segA(a.p1, b.p0, v, turn > 0, false);
    else extra[i] = segL(a.p1, b.p0);
  }
  for (let i = 0; i < n; i++) { out.push(res[i]); if (extra[i]) out.push(extra[i]); }
  return { segs: out.filter(s => segLen(s) > 1e-8 || s.full), warnings };
}

// ---------------------------------------------------------------- job path building
function orientationCCW(segs) { return signedArea(segs) > 0; }
// Rotate a closed path so that it starts at point p (projected on path)
function rotateClosedTo(segs, p) {
  const n = pathNearest(segs, p); const s = segs[n.i];
  let first = [], rest = [];
  if (n.t <= 1e-9) { rest = segs.slice(n.i).concat(segs.slice(0, n.i)); }
  else if (n.t >= 1 - 1e-9) { rest = segs.slice(n.i + 1).concat(segs.slice(0, n.i + 1)); }
  else { const [a, b] = segSplit(s, n.t); if (s.full) { // full circle: make 1 full arc starting at point
      const q = n.pt; return [segA(q, q, s.c, s.ccw, true, { src: s.src })]; }
    rest = [b].concat(segs.slice(n.i + 1), segs.slice(0, n.i), [a]); }
  if (rest.length === 1 && rest[0].full) { const q = n.pt; return [segA(q, q, rest[0].c, rest[0].ccw, true, { src: rest[0].src })]; }
  return rest.map(cloneSeg);
}
/* Job definition (all coordinates in drawing space):
   { name, kind:'part'|'hole'|'open', segs, closed, entry:{x,y}, start:{x,y}, end:{x,y}|null,
     dir:'cw'|'ccw' (closed) | 'fwd'|'rev' (open), side:'auto'|'left'|'right'|'none',
     passes:[{d:0.1}], offStart:{x,y}|null, slug:'none'|'end'|'before', slugDist, overcut,
     taper:{mode:'none'|'angle'|'angle4'|'shape', angle, top:'bigger'|'smaller'|'left'|'right', thick, W, Z, B, swap, topSegs, topClosed} } */
function jobPath(job) {
  let segs = job.segs.map(cloneSeg);
  if (job.ordered) return segs;
  if (job.closed) {
    const wantCCW = job.dir === 'ccw'; if (orientationCCW(segs) !== wantCCW) segs = pathReverse(segs);
    segs = rotateClosedTo(segs, job.entry || segs[0].p0);
  } else {
    if (job.dir === 'rev') segs = pathReverse(segs);
  }
  return segs;
}
// break points on a path: STOP (cut only up to here) and HOLD (M0, continue)
function jobBreaks(job, segs) {
  segs = segs || jobPath(job); const L = pathLen(segs);
  const list = (job.breaks || []).filter(b => b && b.pt).map(b => Object.assign({}, b, { s: pathNearest(segs, b.pt).s })).filter(b => b.s > 1e-6 && b.s < L - 1e-6).sort((a, b) => a.s - b.s);
  const stop = list.find(b => b.type === 'stop') || null;
  const holds = list.filter(b => b.type !== 'stop' && (!stop || b.s < stop.s - 1e-9));
  return { L, stop, holds };
}
function jobEffective(job) {
  const full = jobPath(job); const br = jobBreaks(job, full); let segs = full;
  if (br.stop) segs = pathSplitAtDist(full, br.stop.s)[0];
  return { full, segs, closed: !!job.closed && !br.stop, stop: br.stop, holds: br.holds };
}
function interiorSide(segs) { return orientationCCW(segs) ? 'L' : 'R'; }
function jobSide(job, segs) {
  segs = segs || jobPath(job);
  if (job.side === 'none') return null;
  if (job.side === 'left') return 'L'; if (job.side === 'right') return 'R';
  if (!job.closed) return null;
  const inside = interiorSide(segs);
  if (job.kind === 'hole') return inside; return inside === 'L' ? 'R' : 'L';
}
function topOffsetSide(job, segs) { // 'L' or 'R' relative to travel: where the top plane contour lies
  const tp = job.taper || {};
  if (!job.closed) return tp.top === 'right' ? 'R' : 'L';
  const inside = interiorSide(segs);
  const outside = inside === 'L' ? 'R' : 'L';
  return tp.top === 'smaller' ? inside : outside;
}
function taperShift(job) { const tp = job.taper; return (tp.thick || 0) * Math.tan((tp.angle || 0) * Math.PI / 180); }
function topPathFor(job, segs) { // returns segs of top contour in same order (for angle4 / preview)
  const side = topOffsetSide(job, segs); const sh = taperShift(job) * (side === 'L' ? 1 : -1);
  return offsetPath(segs, sh, job.closed, 'miter');
}
// bottom / top contours of a taper job (for the 3D view). Returns {bottom, top, closed, T, W, error}
function taperSurfaces(job0) {
  if (!job0 || !job0.segs || !job0.segs.length) return { error: 'Choose the wire path first' };
  const tp = job0.taper || { mode: 'none' }; const eff = jobEffective(job0); let job = job0;
  const T = +tp.thick || 0; if (!(T > 0)) return { error: 'Enter the job thickness' };
  if (eff.stop) { const t0 = Object.assign({}, tp); if (job0.closed && (t0.mode === 'angle' || t0.mode === 'angle4')) t0.top = topOffsetSide(job0, eff.full) === 'L' ? 'left' : 'right'; job = Object.assign({}, job0, { segs: eff.segs, closed: false, ordered: true, taper: t0 }); }
  const segs = jobPath(job); const closed = !!job.closed && !eff.stop;
  let bottom = segs, top = null, W = 0;
  if (tp.mode === 'angle' || tp.mode === 'angle4') {
    const tn = Math.tan((+tp.angle || 0) * Math.PI / 180); const side = topOffsetSide(job, segs); const sg = side === 'L' ? 1 : -1;
    W = tp.mode === 'angle' ? Math.max(0, Math.min(T, +tp.W || 0)) : 0;
    const b = offsetPath(segs, -sg * W * tn, closed, 'miter'), t = offsetPath(segs, sg * (T - W) * tn, closed, 'miter');
    if (b.warnings.length || t.warnings.length) return { error: 'An arc becomes too small at this taper angle – reduce the angle.' };
    bottom = W > 0 ? b.segs : segs; top = t.segs;
  } else if (tp.mode === 'shape') {
    if (!tp.topSegs || !tp.topSegs.length) return { error: 'Pick the TOP shape' };
    let tt = tp.topSegs.map(cloneSeg);
    if (closed) { if (orientationCCW(tt) !== orientationCCW(segs)) tt = pathReverse(tt); tt = rotateClosedTo(tt, tp.topEntry || segs[0].p0); }
    else if (V.dist(tt[0].p0, segs[0].p0) > V.dist(tt[tt.length - 1].p1, segs[0].p0)) tt = pathReverse(tt);
    top = tt;
  } else return { error: 'No taper' };
  if (bottom.length !== top.length) { const r = syncChainsGeo(bottom, top); bottom = r[0]; top = r[1]; }
  return { bottom, top, closed, T, W, programmed: segs };
}
function shapeSize(segs, closed) { // {circle:true, d} or {w,h}
  if (closed && segs.length && segs.every(s => s.t === 'A' && V.dist(s.c, segs[0].c) < 1e-6 && Math.abs(s.r - segs[0].r) < 1e-6)) return { circle: true, d: 2 * segs[0].r, c: segs[0].c };
  const bb = pathBBox(segs); return { w: bb.x1 - bb.x0, h: bb.y1 - bb.y0, bb };
}
// sync two chains so they have equal number of segments (pairs by length fraction)
function syncChains(a, b) {
  if (a.length === b.length) return [a.map(cloneSeg), b.map(cloneSeg)];
  const fr = (segs) => { const L = pathLen(segs); let acc = 0; const f = []; segs.forEach(s => { acc += segLen(s); f.push(acc / L); }); f.pop(); return f; };
  const fa = fr(a), fb = fr(b); const all = [...new Set(fa.concat(fb).map(x => Math.round(x * 1e9) / 1e9))].sort((x, y) => x - y);
  const splitAll = (segs) => {
    const L = pathLen(segs); const out = []; let acc = 0; let k = 0;
    for (const s of segs) {
      const l = segLen(s); let cur = cloneSeg(s); let curStart = acc;
      while (k < all.length && all[k] * L < acc + l - 1e-7) {
        const at = all[k] * L; if (at > curStart + 1e-7) { const t = (at - curStart) / segLen(cur); const [x, y] = segSplit(cur, t); out.push(x); cur = y; curStart = at; }
        k++;
      }
      out.push(cur); acc += l;
      while (k < all.length && Math.abs(all[k] * L - acc) < 1e-7) k++;
    }
    return out;
  };
  return [splitAll(a), splitAll(b)];
}

// geometric sync: break points = vertices of each chain projected on the other (monotone subset), then length-fraction inside pieces
function splitAtDists(segs, ds) { // ds sorted distances (0 < d < L) -> array of pieces (each array of segs)
  const pieces = []; let rest = segs.map(cloneSeg); let done = 0;
  for (const d of ds) { const rel = d - done; if (rel <= 1e-9) { pieces.push([]); continue; } const r = pathPointAtDist(rest, rel); const before = rest.slice(0, r.i), after = rest.slice(r.i + 1); const sg = rest[r.i];
    if (r.t <= 1e-9) after.unshift(sg); else if (r.t >= 1 - 1e-9) before.push(sg); else { const [x, y] = segSplit(sg, r.t); before.push(x); after.unshift(y); }
    pieces.push(before); rest = after; done = d; }
  pieces.push(rest); return pieces;
}
function syncChainsGeo(a, b) {
  if (a.length === b.length) return [a.map(cloneSeg), b.map(cloneSeg)];
  const La = pathLen(a), Lb = pathLen(b); if (La < 1e-9 || Lb < 1e-9) return syncChains(a, b);
  const vA = []; let acc = 0; a.forEach((s, i) => { if (i) vA.push(acc); acc += segLen(s); });
  const vB = []; acc = 0; b.forEach((s, i) => { if (i) vB.push(acc); acc += segLen(s); });
  let pairs = [];
  vA.forEach(sa => { const p = pathPointAtDist(a, sa).pt; pairs.push([sa, pathNearest(b, p).s]); });
  vB.forEach(sb => { const p = pathPointAtDist(b, sb).pt; pairs.push([pathNearest(a, p).s, sb]); });
  pairs = pairs.filter(q => q[0] > 1e-6 && q[0] < La - 1e-6 && q[1] > 1e-6 && q[1] < Lb - 1e-6).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  // longest strictly increasing subsequence on second value
  const n = pairs.length; const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (pairs[j][1] < pairs[i][1] - 1e-9 && pairs[j][0] < pairs[i][0] + 1e-9 && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
  let bi = -1; for (let i = 0; i < n; i++) if (bi < 0 || len[i] > len[bi]) bi = i;
  const chosen = []; while (bi >= 0) { chosen.unshift(pairs[bi]); bi = prev[bi]; }
  // remove near duplicates
  const ch = []; chosen.forEach(q => { const l = ch[ch.length - 1]; if (!l || (q[0] - l[0] > 1e-6 || q[1] - l[1] > 1e-6)) ch.push(q); });
  const pa = splitAtDists(a, ch.map(q => q[0])), pb = splitAtDists(b, ch.map(q => q[1]));
  const A = [], B = [];
  for (let k = 0; k < pa.length; k++) {
    let x = pa[k], y = pb[k];
    if (!x.length) { const p = k ? (pa[k - 1].length ? pa[k - 1][pa[k - 1].length - 1].p1 : A[A.length - 1].p1) : a[0].p0; x = [segL(p, p)]; }
    if (!y.length) { const p = k ? (pb[k - 1].length ? pb[k - 1][pb[k - 1].length - 1].p1 : B[B.length - 1].p1) : b[0].p0; y = [segL(p, p)]; }
    if (x.length !== y.length) { if (pathLen(x) < 1e-9) { const p = x[0].p0; x = y.map(() => segL(p, p)); } else if (pathLen(y) < 1e-9) { const p = y[0].p0; y = x.map(() => segL(p, p)); } else [x, y] = syncChains(x, y); }
    A.push(...x); B.push(...y);
  }
  return [A, B];
}


// ---------------------------------------------------------------- geometric constraint solver
// Entity parameters: line [ax,ay,bx,by]  arc [cx,cy,r,a0,a1]  circle [cx,cy,r]
function entParams(e) { if (e.type === 'line') return [e.a.x, e.a.y, e.b.x, e.b.y]; if (e.type === 'arc') { let a1 = e.a1; if (a1 <= e.a0) a1 += TAU; return [e.c.x, e.c.y, e.r, e.a0, a1]; } return [e.c.x, e.c.y, e.r]; }
function setEntParams(e, q) {
  if (e.type === 'line') { e.a = { x: q[0], y: q[1] }; e.b = { x: q[2], y: q[3] }; return; }
  e.c = { x: q[0], y: q[1] }; e.r = Math.abs(q[2]);
  if (e.type === 'arc') { e.a0 = normPos(q[3]); e.a1 = normPos(q[4]); }
}
const CONS_INFO = {
  coincident: { n: 2, label: 'Coincident' }, onCurve: { n: 2, label: 'Point on line/arc' }, horizontal: { n: 1, label: 'Horizontal' }, vertical: { n: 1, label: 'Vertical' },
  parallel: { n: 2, label: 'Parallel' }, perpendicular: { n: 2, label: 'Perpendicular' }, tangent: { n: 2, label: 'Tangent' }, equal: { n: 2, label: 'Equal' },
  concentric: { n: 2, label: 'Concentric' }, fix: { n: 1, label: 'Fixed' }, length: { n: 1, label: 'Length', dim: true }, radius: { n: 1, label: 'Radius', dim: true },
  diameter: { n: 1, label: 'Diameter', dim: true }, distance: { n: 2, label: 'Distance', dim: true }, angle: { n: 1, label: 'Angle', dim: true }, midpoint: { n: 2, label: 'Midpoint' }, symmetric: { n: 3, label: 'Symmetric' },
};
// builds residual rows for one constraint. G(id) -> accessor object with point(p) / line() / circ()
function consRows(c, G) {
  const R = c.refs, W = 1;
  const A = G(R[0].e), B = R[1] ? G(R[1].e) : null;
  if (!A || (CONS_INFO[c.type].n >= 2 && !B)) return null;
  const P = (acc, ref) => acc.point(ref.p);
  const dirU = (L) => { const a = L.point('a'), b = L.point('b'); const d = V.sub(b, a); const l = Math.hypot(d.x, d.y) || 1e-12; return { x: d.x / l, y: d.y / l, len: l, a, b }; };
  switch (c.type) {
    case 'coincident': return [() => P(A, R[0]).x - P(B, R[1]).x, () => P(A, R[0]).y - P(B, R[1]).y];
    case 'midpoint': return [() => { const L = dirU(B); return P(A, R[0]).x - (L.a.x + L.b.x) / 2; }, () => { const L = dirU(B); return P(A, R[0]).y - (L.a.y + L.b.y) / 2; }];
    case 'onCurve': return [() => { const p = P(A, R[0]); if (B.type === 'line') { const L = dirU(B); return V.cross(L, V.sub(p, L.a)); } const ci = B.circ(); return V.dist(p, ci.c) - ci.r; }];
    case 'horizontal': return [() => { const L = dirU(A); return L.a.y - L.b.y; }];
    case 'vertical': return [() => { const L = dirU(A); return L.a.x - L.b.x; }];
    case 'parallel': return [() => { const u = dirU(A), v = dirU(B); return V.cross(u, v) * 10; }];
    case 'perpendicular': return [() => { const u = dirU(A), v = dirU(B); return V.dot(u, v) * 10; }];
    case 'tangent': {
      if (A.type === 'line' || B.type === 'line') { const Lacc = A.type === 'line' ? A : B, Cacc = A.type === 'line' ? B : A; const sd = c.mode || 1;
        return [() => { const L = dirU(Lacc), ci = Cacc.circ(); return sd * V.cross(L, V.sub(ci.c, L.a)) - ci.r; }]; }
      return [() => { const a = A.circ(), b = B.circ(); const d = V.dist(a.c, b.c); return c.mode === 'int' ? d - Math.abs(a.r - b.r) : d - (a.r + b.r); }];
    }
    case 'equal': if (A.type === 'line') return [() => dirU(A).len - dirU(B).len]; return [() => A.circ().r - B.circ().r];
    case 'concentric': return [() => A.circ().c.x - B.circ().c.x, () => A.circ().c.y - B.circ().c.y];
    case 'fix': return A.raw().map((_, k) => () => A.raw()[k] - c.vals[k]);
    case 'length': return [() => dirU(A).len - c.val];
    case 'radius': return [() => A.circ().r - c.val];
    case 'diameter': return [() => 2 * A.circ().r - c.val];
    case 'distance': return [() => V.dist(P(A, R[0]), P(B, R[1])) - c.val];
    case 'angle': return [() => { const u = dirU(A), t = c.val * Math.PI / 180; return V.cross(u, { x: Math.cos(t), y: Math.sin(t) }) * 10; }, () => { const u = dirU(A), t = c.val * Math.PI / 180; return Math.max(0, -V.dot(u, { x: Math.cos(t), y: Math.sin(t) })) * 10; }];
    case 'symmetric': { const Cc = G(R[2].e); if (!Cc) return null; return [() => { const L = dirU(Cc), p = P(A, R[0]), q = P(B, R[1]); return V.dot(V.sub(q, p), { x: L.x, y: L.y }); }, () => { const L = dirU(Cc), p = P(A, R[0]), q = P(B, R[1]); const m = V.lerp(p, q, 0.5); return V.cross(L, V.sub(m, L.a)); }]; }
  }
  return null;
}
function consEntIds(c) { return [...new Set(c.refs.map(r => r.e))]; }
// conjugate gradient for (J^T J + D) d = g  with J sparse rows [{cols, vals}]
function cgSolve(rows, n, diag, g, iters) {
  const mulA = (v) => { const out = new Float64Array(n); for (const r of rows) { let s = 0; for (let k = 0; k < r.cols.length; k++) s += r.vals[k] * v[r.cols[k]]; if (s !== 0) for (let k = 0; k < r.cols.length; k++) out[r.cols[k]] += r.vals[k] * s; } for (let i = 0; i < n; i++) out[i] += diag[i] * v[i]; return out; };
  const x = new Float64Array(n); let r = Float64Array.from(g); let p = Float64Array.from(r); let rr = 0; for (let i = 0; i < n; i++) rr += r[i] * r[i];
  const rr0 = rr; for (let it = 0; it < (iters || 300) && rr > 1e-30 && rr > rr0 * 1e-24; it++) {
    const Ap = mulA(p); let pAp = 0; for (let i = 0; i < n; i++) pAp += p[i] * Ap[i]; if (pAp <= 0) break; const a = rr / pAp;
    let rr2 = 0; for (let i = 0; i < n; i++) { x[i] += a * p[i]; r[i] -= a * Ap[i]; rr2 += r[i] * r[i]; } const b = rr2 / rr; rr = rr2; for (let i = 0; i < n; i++) p[i] = r[i] + b * p[i];
  }
  return x;
}
/* solveConstraints(ents, cons, opts)
   opts.fixed: Set of entity ids that must not change; opts.drag: [{e, p, to:{x,y}}] soft targets; opts.only: Set of ids whose component is solved
   returns {ok, maxRes, updated: Map(id -> new entity), unsatisfied: [cons ids]} — does not modify the input */
function solveConstraints(ents, cons, opts) {
  opts = opts || {}; const byId = new Map(ents.map(e => [e.id, e]));
  let list = cons.filter(c => consEntIds(c).every(id => byId.has(id)));
  // components (union-find)
  const par = new Map(); const find = (a) => { while (par.get(a) !== a) { par.set(a, par.get(par.get(a))); a = par.get(a); } return a; };
  const uni = (a, b) => { if (!par.has(a)) par.set(a, a); if (!par.has(b)) par.set(b, b); par.set(find(a), find(b)); };
  list.forEach(c => { const ids = consEntIds(c); ids.forEach(i => { if (!par.has(i)) par.set(i, i); }); for (let k = 1; k < ids.length; k++) uni(ids[0], ids[k]); });
  (opts.drag || []).forEach(d => { if (!par.has(d.e)) par.set(d.e, d.e); });
  let active = null;
  if (opts.only) { const roots = new Set([...opts.only].filter(i => par.has(i)).map(find)); active = new Set([...par.keys()].filter(i => roots.has(find(i)))); list = list.filter(c => active.has(consEntIds(c)[0])); }
  else active = new Set(par.keys());
  const fixed = opts.fixed || new Set();
  const varIds = [...active].filter(id => !fixed.has(id) && byId.has(id));
  const off = new Map(); let n = 0; const x0 = [];
  varIds.forEach(id => { const q = entParams(byId.get(id)); off.set(id, n); q.forEach(v => x0.push(v)); n += q.length; });
  const x = Float64Array.from(x0);
  const consts = new Map(); [...active].forEach(id => { if (!off.has(id) && byId.has(id)) consts.set(id, entParams(byId.get(id))); });
  const acc = (id) => {
    const e = byId.get(id); if (!e) return null; const o = off.get(id); const raw = () => o === undefined ? consts.get(id) : Array.from(x.subarray(o, o + entParams(e).length));
    const g = (k) => o === undefined ? consts.get(id)[k] : x[o + k];
    return { type: e.type, raw,
      point(p) { if (e.type === 'line') return p === 'b' ? { x: g(2), y: g(3) } : p === 'm' ? { x: (g(0) + g(2)) / 2, y: (g(1) + g(3)) / 2 } : { x: g(0), y: g(1) };
        if (p === 's' && e.type === 'arc') return { x: g(0) + g(2) * Math.cos(g(3)), y: g(1) + g(2) * Math.sin(g(3)) };
        if (p === 'e' && e.type === 'arc') return { x: g(0) + g(2) * Math.cos(g(4)), y: g(1) + g(2) * Math.sin(g(4)) };
        return { x: g(0), y: g(1) }; },
      circ() { return { c: { x: g(0), y: g(1) }, r: Math.abs(g(2)) }; } };
  };
  const accCache = new Map(); const G = (id) => { if (!accCache.has(id)) accCache.set(id, acc(id)); return accCache.get(id); };
  const rows = []; const rowCons = [];
  for (const c of list) { const f = consRows(c, G); if (!f) continue; const deps = []; consEntIds(c).forEach(id => { const o = off.get(id); if (o !== undefined) { const L = entParams(byId.get(id)).length; for (let k = 0; k < L; k++) deps.push(o + k); } }); f.forEach(fn => { rows.push({ fn, deps, w: 100 }); rowCons.push(c.id); }); }
  (opts.drag || []).forEach(d => { const A = G(d.e); if (!A) return; const o = off.get(d.e); if (o === undefined) return; const L = entParams(byId.get(d.e)).length; const deps = []; for (let k = 0; k < L; k++) deps.push(o + k);
    rows.push({ fn: () => A.point(d.p).x - d.to.x, deps, w: 1, drag: true }); rows.push({ fn: () => A.point(d.p).y - d.to.y, deps, w: 1, drag: true }); rowCons.push(null, null); });
  const updated = new Map();
  if (!n) { const maxRes = rows.reduce((m, r) => r.drag ? m : Math.max(m, Math.abs(r.fn())), 0); return { ok: maxRes < 1e-5, maxRes, updated, unsatisfied: maxRes < 1e-5 ? [] : rows.filter(r => !r.drag && Math.abs(r.fn()) > 1e-5).map((r, i) => rowCons[rows.indexOf(r)]) }; }
  let wReg = 1e-3; const xr = Float64Array.from(x0);
  const evalCost = () => { let s = 0; for (const r of rows) { const v = r.fn() * r.w; s += v * v; } for (let i = 0; i < n; i++) { const v = (x[i] - xr[i]) * wReg; s += v * v; } return s; };
  const runLM = (maxIt) => {
    let lambda = 1e-3; let cost = evalCost();
    for (let it = 0; it < maxIt; it++) {
      const J = []; const rv = [];
      for (const r of rows) { const f0 = r.fn(); rv.push(f0 * r.w); const cols = [], vals = []; for (const k of r.deps) { const h = 1e-7 * Math.max(1, Math.abs(x[k])); const old = x[k]; x[k] = old + h; const f1 = r.fn(); x[k] = old; const dv = (f1 - f0) / h * r.w; if (dv !== 0) { cols.push(k); vals.push(dv); } } J.push({ cols, vals }); }
      const g = new Float64Array(n); J.forEach((r, i) => { for (let k = 0; k < r.cols.length; k++) g[r.cols[k]] -= r.vals[k] * rv[i]; }); for (let i = 0; i < n; i++) g[i] -= wReg * wReg * (x[i] - xr[i]);
      let gmax = 0; for (let i = 0; i < n; i++) gmax = Math.max(gmax, Math.abs(g[i])); if (gmax < 1e-14) break;
      const dg = new Float64Array(n); J.forEach(r => { for (let k = 0; k < r.cols.length; k++) dg[r.cols[k]] += r.vals[k] * r.vals[k]; });
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const diag = new Float64Array(n); for (let i = 0; i < n; i++) diag[i] = wReg * wReg + lambda * (dg[i] + 1e-6);
        const d = cgSolve(J, n, diag, g, Math.max(200, 2 * n)); const xs = Float64Array.from(x); for (let i = 0; i < n; i++) x[i] += d[i];
        const c2 = evalCost(); if (c2 < cost) { const rel = (cost - c2) / Math.max(cost, 1e-300); cost = c2; lambda = Math.max(1e-12, lambda / 5); improved = rel > 1e-12; break; }
        x.set(xs); lambda *= 10;
      }
      if (!improved) break;
    }
  };
  runLM(opts.quick ? 12 : 60);
  if (!opts.quick) { xr.set(x); wReg = 1e-7; runLM(30); }
  let maxRes = 0; const uns = new Set(); rows.forEach((r, i) => { if (r.drag) return; const v = Math.abs(r.fn()); if (v > maxRes) maxRes = v; if (v > 1e-5) uns.add(rowCons[i]); });
  varIds.forEach(id => { const e = byId.get(id); const o = off.get(id); const q = Array.from(x.subarray(o, o + entParams(e).length)); const old = entParams(e); if (q.some((v, k) => Math.abs(v - old[k]) > 1e-12)) { const ne = JSON.parse(JSON.stringify(e)); setEntParams(ne, q); updated.set(id, ne); } });
  return { ok: maxRes < 1e-5, maxRes, updated, unsatisfied: [...uns] };
}
function consResidual(ents, c) { const r = solveConstraints(ents, [c], { fixed: new Set(consEntIds(c)) }); return r.maxRes; }


// ---------------------------------------------------------------- involute spur gear (external) outline
function gearSegs(o) {
  const m = o.module, z = Math.round(o.teeth), al = (o.pa || 20) * Math.PI / 180, xs = o.shift || 0;
  if (!(m > 0) || !(z >= 5)) return { error: 'Module must be > 0 and teeth ≥ 5' };
  const rp = m * z / 2, rb = rp * Math.cos(al), ra = rp + m * (1 + xs + (o.addendumAdj || 0)), rf = rp - m * (1.25 - xs);
  if (rf <= 0) return { error: 'Root circle is too small' };
  const inv = (a) => Math.tan(a) - a; const sP = m * (Math.PI / 2 + 2 * xs * Math.tan(al));
  const psi = (r) => sP / (2 * rp) + inv(al) - inv(Math.acos(Math.min(1, rb / r)));
  const radial = rb - rf > 0.01; const r0 = radial ? rb : Math.max(rb, rf); const step = 2 * Math.PI / z;
  if (psi(ra) <= 0) return { error: 'Teeth are pointed – reduce the profile shift or addendum' };
  if (step - 2 * psi(r0) <= 0) return { error: 'Teeth overlap at the root' };
  const warn = []; if (rf < rb && z < 17 && xs < (17 - z) / 17) warn.push('Few teeth: real gears get undercut here; profile is drawn without undercut.');
  const segs = []; const C = { x: 0, y: 0 }; const P = (r, a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
  const flank = (k, sign, up) => { const pts = []; const N = 40; for (let i = 0; i <= N; i++) { const t = i / N; const r = r0 + (ra - r0) * (1 - Math.cos(t * Math.PI / 2)); pts.push(P(r, k * step + sign * psi(r))); } if (!up) pts.reverse(); return fitPoints(pts, o.tol || 0.0005); };
  for (let k = 0; k < z; k++) {
    const phi = k * step;
    if (radial) segs.push(segL(P(rf, phi - psi(rb)), P(rb, phi - psi(rb))));
    segs.push(...flank(k, -1, true));
    segs.push(segA(P(ra, phi - psi(ra)), P(ra, phi + psi(ra)), C, true));
    segs.push(...flank(k, +1, false));
    if (radial) segs.push(segL(P(rb, phi + psi(rb)), P(rf, phi + psi(rb))));
    const a1 = phi + psi(r0), a2 = phi + step - psi(r0);
    const rr = radial ? rf : r0; segs.push(segA(P(rr, a1), P(rr, a2), C, true));
  }
  return { segs, rp, rb, ra, rf, warn };
}

// ---------------------------------------------------------------- G-code generation
function fmtNum(v, dec) {
  const m = Math.pow(10, dec); let r = Math.round(v * m) / m; if (Object.is(r, -0) || Math.abs(r) < 0.5 / m) r = 0;
  let s = r.toFixed(dec); if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s;
}
function splitBigArcs(segs, maxSweep) {
  const out = []; for (const s of segs) {
    if (s.t === 'A' && sweep(s) > maxSweep + 1e-9) { const n = Math.ceil(sweep(s) / maxSweep); let cur = s; for (let k = n; k > 1; k--) { const [a, b] = segSplit(cur, 1 / k); out.push(a); cur = b; } out.push(cur); }
    else out.push(s);
  } return out;
}
function nowStamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

function pairSplitAtDist(a, ta, d) {
  const r = pathPointAtDist(a, d); const A = [], B = [], TA = ta ? [] : null, TB = ta ? [] : null;
  a.forEach((s, k) => {
    const t = ta ? ta[k] : null;
    if (k < r.i) { A.push(cloneSeg(s)); if (t) TA.push(cloneSeg(t)); }
    else if (k > r.i) { B.push(cloneSeg(s)); if (t) TB.push(cloneSeg(t)); }
    else if (r.t <= 1e-9) { B.push(cloneSeg(s)); if (t) TB.push(cloneSeg(t)); }
    else if (r.t >= 1 - 1e-9) { A.push(cloneSeg(s)); if (t) TA.push(cloneSeg(t)); }
    else { const [x, y] = segSplit(s, r.t); A.push(x); B.push(y); if (t) { const [u, v] = segSplit(t, r.t); TA.push(u); TB.push(v); } }
  });
  return { a: A, b: B, ta: TA, tb: TB };
}
function splitPairsBig(a, ta, maxSweep) {
  const A = [], T = ta ? [] : null;
  a.forEach((s, k) => {
    const t = ta ? ta[k] : null;
    const n = Math.max(1, Math.ceil(Math.max(sweep(s), t ? sweep(t) : 0) / maxSweep - 1e-9));
    let cs = s, ct = t;
    for (let q = n; q > 1; q--) { const [x, y] = segSplit(cs, 1 / q); A.push(x); cs = y; if (ct) { const [u, v] = segSplit(ct, 1 / q); T.push(u); ct = v; } }
    A.push(cs); if (ct) T.push(ct);
  });
  return { a: A, ta: T };
}
function generateProgram(project) {
  const S = Object.assign({ decimals: 6, endCode: 'M0', thread: 'manual', title: '', eCode: '', maxArc: 180, origin: 'start', stamp: true }, project.settings || {});
  const jobs = project.jobs.filter(j => j.enabled !== false && j.segs && j.segs.length);
  const errors = [], warnings = [], L = [];
  if (!jobs.length) { errors.push('No wire path defined.'); return { text: '', errors, warnings }; }
  const dec = S.decimals; const f = (v) => fmtNum(v, dec);
  const org = S.originPt ? V.copy(S.originPt) : S.origin === 'start' ? V.copy(jobs[0].start) : { x: 0, y: 0 };
  const T = (p) => V.sub(p, org);
  // D table
  const dvals = [0]; const dIndex = (v) => { v = Math.round(v * 1e6) / 1e6; let i = dvals.findIndex(x => Math.abs(x - v) < 1e-9); if (i < 0) { dvals.push(v); i = dvals.length - 1; } return i; };
  jobs.forEach(j => { let sd = null; try { sd = jobSide(j); } catch (e) { sd = 'L'; } if (sd) (j.passes || [{ d: 0.1 }]).forEach(p => dIndex(p.d)); });
  const anyComplex = jobs.some(j => j.taper && (j.taper.mode === 'angle4' || j.taper.mode === 'shape'));
  // header
  if (S.title) S.title.split(/\r?\n/).forEach(t => L.push(';' + t.replace(/[\r\n]/g, '')));
  if (S.stamp) L.push(';' + nowStamp());
  L.push('G71', 'G9', 'G27', 'G40'); if (!anyComplex) L.push('G47'); L.push('G50', 'G90', 'G75');
  L.push('; Wire Compensation Definitions'); dvals.forEach((v, i) => L.push('D' + i + '=' + f(v)));
  if (S.eCode !== '' && S.eCode !== null && S.eCode !== undefined) L.push('E' + S.eCode);
  const info = { cutLength: 0, rapidLength: 0, jobs: [] };
  jobs.forEach((job0, jn) => {
    const tag = 'Job ' + (jn + 1) + (job0.name ? ' "' + job0.name + '"' : '');
    let job = job0; const eff = jobEffective(job0);
    if (eff.stop) { // cut only up to the STOP point: treat as an open path
      const t0 = Object.assign({}, job0.taper || { mode: 'none' });
      if (t0.mode === 'shape') errors.push(tag + ': a STOP break point cannot be used with "Different TOP shape" taper.');
      if (job0.closed && (t0.mode === 'angle' || t0.mode === 'angle4')) t0.top = topOffsetSide(job0, eff.full) === 'L' ? 'left' : 'right';
      job = Object.assign({}, job0, { segs: eff.segs, closed: false, ordered: true, overcut: 0, kind: 'open', taper: t0 });
    }
    const holdsS = eff.holds.map(h => ({ s: h.s, every: !!h.every }));
    const segs0 = jobPath(job);
    if (job.kind !== 'open' && !job.closed) errors.push(tag + ': shape is not closed. Choose "Open cut" or fix the drawing gaps.');
    const side = jobSide(job, segs0); const G = side === 'L' ? 'G41' : side === 'R' ? 'G42' : 'G41';
    const passes = job.passes && job.passes.length ? job.passes : [{ d: 0.1 }];
    const tp = job.taper || { mode: 'none' }; const tmode = tp.mode || 'none';
    const start = job.start; const stay = job.endMode === 'stay'; const end = stay ? null : (job.end || job.start);
    const leadPt = job.leadPt && V.dist(job.leadPt, job.start) > 1e-6 ? V.copy(job.leadPt) : null;
    // ---- path with overcut
    let path = segs0.map(cloneSeg);
    let pm = job.passMode || (job.closed ? 'loop' : 'reverse'); if (job.closed && pm === 'reverse') pm = 'loop'; if (!job.closed && pm === 'loop') pm = 'reverse';
    const ocLen = job.closed && job.overcut > 0 ? Math.min(job.overcut, pathLen(segs0) * 0.5) : 0;
    // ---- top (UV) path
    let topPath = null, topStart = start, topEnd = end;
    if (tmode === 'angle4') { const r = topPathFor(job, path); topPath = r.segs; r.warnings.forEach(w => errors.push(tag + ' taper top: ' + w)); if (topPath.length !== path.length) { errors.push(tag + ': taper top contour changed element count (an arc collapsed). Reduce angle or check radii.'); topPath = null; } }
    if (tmode === 'shape') {
      if (!tp.topSegs || !tp.topSegs.length) errors.push(tag + ': TOP shape not selected.');
      else {
        let top = tp.topSegs.map(cloneSeg);
        if (job.closed) { if (orientationCCW(top) !== orientationCCW(segs0)) top = pathReverse(top); top = rotateClosedTo(top, tp.topEntry || segs0[0].p0); }
        else { if (V.dist(top[0].p0, segs0[0].p0) > V.dist(top[top.length - 1].p1, segs0[0].p0)) top = pathReverse(top); }
        const [a, b] = syncChainsGeo(path, top); path = a; topPath = b;
      }
    }
    // ---- checks
    const entry = path[0].p0; const leadPts = [start].concat(leadPt && V.dist(leadPt, entry) > 1e-6 ? [leadPt] : [], [entry]);
    let leadLen = 0; for (let k = 1; k < leadPts.length; k++) leadLen += V.dist(leadPts[k - 1], leadPts[k]);
    const dmax = Math.max(...passes.map(p => p.d));
    if (leadLen < 1e-6) warnings.push(tag + ': start point is ON the shape (no lead-in). Wire offset cannot ramp in.');
    else if (side && V.dist(leadPts[leadPts.length - 2], entry) < Math.max(2 * dmax, 0.3)) warnings.push(tag + ': the last lead-in move is very short (' + V.dist(leadPts[leadPts.length - 2], entry).toFixed(3) + ' mm). Keep it at least ' + Math.max(2 * dmax, 0.3).toFixed(2) + ' mm so the offset can ramp in.');
    if (job.closed && job.kind !== 'open') {
      const inside = pointInPath(segs0, start);
      if (job.kind === 'hole' && !inside) warnings.push(tag + ': start point is OUTSIDE the hole shape. OK only if the wire enters from the open edge of the job.');
      if (job.kind === 'part' && inside) warnings.push(tag + ': start point is INSIDE the part shape. Lead-in will cut into the part!');
    }
    { let hits = 0; for (let k = 1; k < leadPts.length; k++) { const lead = segL(leadPts[k - 1], leadPts[k]); segs0.forEach(s => segInter(lead, s, 1e-5).forEach(p => { if (V.dist(p, entry) > 1e-3) hits++; })); } if (hits) warnings.push(tag + ': lead-in crosses the shape. Move the start point or the lead-in point.'); }
    const pm0 = job.passMode || (job.closed ? 'loop' : 'reverse'); const endsAtEntry = job.closed || (!job.closed && pm0 !== 'restart' && passes.length > 1 && passes.length % 2 === 0);
    if (!stay && !(endsAtEntry && (job.endMode === 'start' || !job.endMode))) { const endP = end; const lastP = endsAtEntry ? segs0[0].p0 : segs0[segs0.length - 1].p1; const lo = segL(lastP, endP); let hits = 0; if (segLen(lo) > 1e-6) segs0.forEach(s => segInter(lo, s, 1e-5).forEach(p => { if (V.dist(p, lastP) > 1e-3 && V.dist(p, endP) > 1e-3) hits++; })); if (hits) warnings.push(tag + ': lead-out crosses the shape. Check the lead-out end point.'); }
    if (stay && tp.mode === 'angle') warnings.push(tag + ': taper is switched off (G50) at the end without a lead-out move.');
    if (passes.length > 1 && !job.closed && pm === 'restart') warnings.push(tag + ': open path with several passes – between passes the wire goes STRAIGHT back to the start point. Check that this way is free.');
    if (tmode === 'angle' || tmode === 'angle4') { const sh = taperShift(job); if (leadLen < sh + 2 * dmax) warnings.push(tag + ': lead-in (' + leadLen.toFixed(2) + ') is shorter than taper shift (' + sh.toFixed(3) + ' mm). Make lead-in longer.'); if (!(tp.angle > 0)) errors.push(tag + ': taper angle must be more than 0.'); if (!(tp.thick > 0)) errors.push(tag + ': job thickness must be more than 0.'); }
    const complex = !!topPath;
    if (complex) { if (tmode === 'angle4') { topStart = start; topEnd = end; } }
    // taper G51/G52 side
    let taperG = null;
    if (tmode === 'angle') { const ts = topOffsetSide(job, segs0); let g = ts === 'L' ? 'G51' : 'G52'; if (tp.swap) g = g === 'G51' ? 'G52' : 'G51'; taperG = g + ' A' + f(tp.angle) + ' W' + f(tp.W || 0) + ' Z' + f(tp.Z || 0); }
    // ---- split points (offset start, slug stop)
    const total = pathLen(path); const contourLen = pathLen(segs0);
    let offStartDist = 0; if (job.offStart && side) { offStartDist = pathNearest(segs0, job.offStart).s; }
    let slugDist = null; if (job.slug === 'before' && job.slugDist > 0) slugDist = Math.max(0, contourLen - job.slugDist);
    const emitMove = (s, ts) => {
      const p0 = T(s.p0), p1 = T(s.p1); let line;
      if (s.t === 'L') line = 'G1 X' + f(p1.x) + ' Y' + f(p1.y);
      else { const c = T(s.c); const st = { x: +f(p0.x), y: +f(p0.y) }; line = (s.ccw ? 'G3' : 'G2') + ' X' + f(p1.x) + ' Y' + f(p1.y) + ' I' + f(c.x - st.x) + ' J' + f(c.y - st.y); }
      if (ts) { const q0 = T(ts.p0), q1 = T(ts.p1); if (ts.t === 'L') line += ' G101 U' + f(q1.x) + ' V' + f(q1.y); else { const c = T(ts.c); const st = { x: +f(q0.x), y: +f(q0.y) }; line += (ts.ccw ? ' G103' : ' G102') + ' U' + f(q1.x) + ' V' + f(q1.y) + ' P' + f(c.x - st.x) + ' Q' + f(c.y - st.y); } }
      L.push(line); info.cutLength += segLen(s);
    };
    const emitPairs = (a, ta) => { if (!a.length) return; const r = splitPairsBig(a, ta, (S.maxArc || 180) * Math.PI / 180); r.a.forEach((s, k) => emitMove(s, r.ta ? r.ta[k] : null)); };
    const emitPoly = (xy, uv) => { for (let k = 1; k < xy.length; k++) { if (V.dist(xy[k - 1], xy[k]) < 1e-9 && (!uv || V.dist(uv[k - 1], uv[k]) < 1e-9)) continue; if (complex) emitMove(segL(xy[k - 1], xy[k]), segL(uv[k - 1], uv[k])); else emitMove(segL(xy[k - 1], xy[k])); } };
    const flipG = (g) => g === 'G41' ? 'G42' : 'G41';
    const dTxtG = (g, i) => g + ' D' + i + ' ;D' + i + '=' + f(dvals[i]);
    const taperLine = (rev) => { if (!taperG) return null; return rev ? taperG.replace(/^G5([12])/, (m, d) => d === '1' ? 'G52' : 'G51') : taperG; };
    const ocPiece = ocLen > 0 ? pairSplitAtDist(path, topPath, ocLen) : null;
    const passHeader = (pass, pn, note) => {
      L.push(';#' + (jn + 1) + '.' + pn + '  Cavity=' + (jn + 1) + (pn === 0 ? ' RoughCut ' : ' TrimCut=' + pn + ' ') + (job.name ? ' ' + job.name : '') + (pass.purpose ? ' - ' + pass.purpose : '') + ' D=' + f(pass.d) + (note ? ' (' + note + ')' : ''));
      if (pass.e !== undefined && pass.e !== null && String(pass.e).trim() !== '') L.push('E' + String(pass.e).trim());
    };
    const startBlock = (first) => {
      const st = T(start);
      if (complex) { L.push('G74 Z' + f(tp.Z || 0) + ' B' + f(tp.B || 0) + ' T' + f(tp.thick || 0)); L.push(dTxtG(G, 0)); const ts = T(topStart); L.push('G0 X' + f(st.x) + ' Y' + f(st.y) + ' G100 U' + f(ts.x) + ' V' + f(ts.y)); }
      else L.push('G0 X' + f(st.x) + ' Y' + f(st.y) + ' U0 V0');
      if (first) { if (jn > 0 && S.thread === 'auto') L.push('M21'); else L.push('M0'); }
      if (!complex) L.push(dTxtG(G, 0));
      if (taperG) L.push(taperG);
      const xy = leadPts.slice(0, -1).concat([path[0].p0]); const uv = complex ? [topStart].concat(leadPts.slice(1, -1), [topPath[0].p0]) : null; emitPoly(xy, uv);
    };
    // cut one pass along a (possibly reversed) path. marks: [{at, what:'D'|'M0'}] distances along THIS path
    const cutPass = (segs, tsegs, g, di, marks, dAtStart) => {
      let cur = segs.map(cloneSeg), curT = tsegs ? tsegs.map(cloneSeg) : null; let done = 0; let dDone = !side;
      if (side && dAtStart) { L.push(dTxtG(g, di)); dDone = true; }
      marks.sort((a, b) => a.at - b.at);
      for (const mk of marks) {
        const rel = mk.at - done;
        if (rel > 1e-6) { const r = pairSplitAtDist(cur, curT, rel); emitPairs(r.a, r.ta); cur = r.b; curT = r.tb; done = mk.at; }
        if (mk.what === 'D') { if (!dDone) { L.push(dTxtG(g, di)); dDone = true; } } else L.push('M0');
      }
      if (!dDone) L.push(dTxtG(g, di));
      emitPairs(cur, curT);
    };
    const passMarks = (pn, len, reversed) => {
      const m = []; const conv = (x) => reversed ? len - x : x;
      if (pn === 0 && side && !reversed) m.push({ at: offStartDist, what: 'D' });
      holdsS.forEach(h => { if (pn === 0 || h.every) m.push({ at: conv(h.s), what: 'M0' }); });
      if (slugDist !== null && pn === 0) m.push({ at: slugDist, what: 'M0' });
      return m.filter(x => x.at >= -1e-9 && x.at <= len + 1e-9);
    };
    // lead-out from point pe (top te); atEntry = wire is at the path start (entry) so "back to start" can follow the lead-in back
    const endBlock = (pe, te, g, atEntry, toStartOnly) => {
      if (side || complex) L.push(dTxtG(g, 0));
      if (taperG) L.push('G50');
      let xy, uv = null;
      if (toStartOnly || job.endMode === 'start' || !job.endMode) {
        if (atEntry) { xy = [pe].concat(leadPts.slice(1, -1).reverse(), [start]); if (complex) uv = [te].concat(leadPts.slice(1, -1).reverse(), [topStart]); }
        else { xy = [pe, start]; if (complex) uv = [te, topStart]; }
      } else if (stay) xy = [pe];
      else { xy = [pe, end]; if (complex) uv = [te, end]; }
      emitPoly(xy, uv);
      L.push('G40'); if (complex) L.push('G75');
    };
    const lastJob = jn === jobs.length - 1;
    const endOfJob = () => { if (!lastJob) L.push(S.thread === 'auto' ? 'M20' : 'M0'); };
    const plen = pathLen(path);
    if (passes.length === 1 || pm === 'restart') {
      passes.forEach((pass, pn) => {
        const lastPass = pn === passes.length - 1; const di = dIndex(pass.d);
        passHeader(pass, pn, passes.length > 1 ? 'back to start point, lead in again' : '');
        startBlock(pn === 0);
        let a = path, ta = topPath; if (ocPiece) { a = path.concat(ocPiece.a); ta = topPath ? topPath.concat(ocPiece.ta) : null; }
        cutPass(a, ta, G, di, passMarks(pn, plen, false), false);
        if (job.slug === 'end' && pn === 0 && !(stay && lastPass)) L.push('M0');
        const pe = a[a.length - 1].p1, te = ta ? ta[ta.length - 1].p1 : null;
        endBlock(pe, te, G, job.closed, !lastPass);
      });
      endOfJob();
    } else if (pm === 'loop') { // closed: one lead-in, the loop is cut again and again
      passHeader(passes[0], 0, 'loop continues for every pass');
      startBlock(true);
      passes.forEach((pass, pn) => {
        const lastPass = pn === passes.length - 1; const di = dIndex(pass.d);
        if (pn > 0) passHeader(pass, pn, 'continues around the loop');
        let a = path, ta = topPath; if (lastPass && ocPiece) { a = path.concat(ocPiece.a); ta = topPath ? topPath.concat(ocPiece.ta) : null; }
        cutPass(a, ta, G, di, passMarks(pn, plen, false), pn > 0);
        if (job.slug === 'end' && pn === 0 && !(stay && lastPass)) L.push('M0');
        if (lastPass) { const pe = a[a.length - 1].p1, te = ta ? ta[ta.length - 1].p1 : null; endBlock(pe, te, G, true, false); }
      });
      endOfJob();
    } else { // reverse: open path, every 2nd pass goes back along the same path with G41/G42 swapped
      passHeader(passes[0], 0, 'forward');
      startBlock(true);
      const rp = pathReverse(path), rt = topPath ? pathReverse(topPath) : null;
      let atEntry = true, lastG = G;
      passes.forEach((pass, pn) => {
        const lastPass = pn === passes.length - 1; const di = dIndex(pass.d); const rev = pn % 2 === 1;
        const g = rev ? flipG(G) : G; lastG = g;
        if (pn > 0) { passHeader(pass, pn, rev ? 'BACKWARD on the same path, ' + g + ' (side swapped)' : 'forward again'); const tl = taperLine(rev); if (tl) L.push(tl); }
        cutPass(rev ? rp : path, rev ? rt : topPath, g, di, passMarks(pn, plen, rev), pn > 0);
        if (job.slug === 'end' && pn === 0 && !(stay && lastPass)) L.push('M0');
        atEntry = rev;
        if (lastPass) { const a = rev ? rp : path, ta = rev ? rt : topPath; endBlock(a[a.length - 1].p1, ta ? ta[ta.length - 1].p1 : null, g, atEntry, false); }
      });
      endOfJob();
    }
    info.jobs.push({ side, G, leadLen, length: contourLen });
  });
  L.push(S.endCode || 'M0');
  // simplify: remove adjacent duplicate comp lines
  const out = []; for (const l of L) { if (out.length && /^G4[12] D\d+/.test(l) && out[out.length - 1] === l) continue; out.push(l); }
  return { text: out.join('\r\n') + '\r\n', errors, warnings, info, dvals, origin: org };
}

// ---------------------------------------------------------------- G-code parser (for simulation / viewing .WC files)
function parseWC(text) {
  const lines = text.split(/\r\n|\r|\n/); const moves = []; const dtab = {}; const warnings = [];
  let pos = { x: 0, y: 0 }, uv = { x: 0, y: 0 }, abs = true, comp = null, dIdx = 0, modal = 1, complex = false, taper = null;
  lines.forEach((raw, ln) => {
    let line = raw; const ci = line.indexOf(';'); const comment = ci >= 0 ? line.slice(ci + 1) : ''; if (ci >= 0) line = line.slice(0, ci);
    line = line.toUpperCase().replace(/\(.*?\)/g, '').trim(); if (!line) return;
    const dm = line.match(/^D(\d+)\s*=\s*([-+]?[\d.]+)/); if (dm) { dtab[+dm[1]] = parseFloat(dm[2]); return; }
    const toks = []; const re = /([A-Z])\s*([-+]?\d*\.?\d+)/g; let m; while ((m = re.exec(line))) toks.push([m[1], parseFloat(m[2])]);
    let g = null, ug = null, X, Y, I, J, U, Vv, P, Q, inUV = false, D = null, hasMove = false, mcode = null, A = null, W = null, Z = null;
    for (const [k, v] of toks) {
      if (k === 'G') { const gi = Math.round(v); if (gi >= 100 && gi <= 103) { ug = gi; inUV = true; continue; }
        if (gi <= 3) { g = gi; modal = gi; } else if (gi === 90) abs = true; else if (gi === 91) abs = false; else if (gi === 40) comp = null; else if (gi === 41) comp = 'L'; else if (gi === 42) comp = 'R'; else if (gi === 74) complex = true; else if (gi === 75) complex = false; else if (gi === 50) taper = null; else if (gi === 51 || gi === 52) taper = { g: gi };
        continue; }
      if (k === 'X') { X = v; hasMove = true; } else if (k === 'Y') { Y = v; hasMove = true; } else if (k === 'I') I = v; else if (k === 'J') J = v;
      else if (k === 'U') { U = v; } else if (k === 'V') { Vv = v; } else if (k === 'P') P = v; else if (k === 'Q') Q = v; else if (k === 'D') D = v; else if (k === 'M') mcode = v;
      else if (k === 'A') A = v; else if (k === 'W') W = v; else if (k === 'Z') Z = v;
    }
    if (taper && A !== null) Object.assign(taper, { A, W, Z });
    if (D !== null) dIdx = Math.round(D);
    if (mcode !== null) moves.push({ type: 'stop', m: mcode, p: V.copy(pos), line: ln });
    if (!hasMove && U === undefined && Vv === undefined) return;
    const gg = g !== null ? g : modal;
    const np = { x: X === undefined ? (abs ? pos.x : 0) : X, y: Y === undefined ? (abs ? pos.y : 0) : Y }; if (!abs) { np.x += pos.x; np.y += pos.y; }
    let nuv = { x: U === undefined ? uv.x : U, y: Vv === undefined ? uv.y : Vv };
    const mv = { type: gg === 0 ? 'rapid' : 'cut', t: (gg === 2 || gg === 3) ? 'A' : 'L', p0: V.copy(pos), p1: np, comp, d: dtab[dIdx] || 0, dIdx, line: ln, complex, taper: taper ? Object.assign({}, taper) : null };
    if (mv.t === 'A') { mv.c = { x: pos.x + (I || 0), y: pos.y + (J || 0) }; mv.ccw = gg === 3; mv.r = V.dist(mv.c, pos); const r2 = V.dist(mv.c, np); if (Math.abs(r2 - mv.r) > 0.005) warnings.push('Line ' + (ln + 1) + ': arc radius mismatch ' + mv.r.toFixed(4) + ' / ' + r2.toFixed(4)); mv.full = V.dist(pos, np) < 1e-9; }
    if (complex || ug !== null) {
      mv.uv0 = V.copy(uv); mv.uv1 = nuv; mv.ut = (ug === 102 || ug === 103) ? 'A' : 'L';
      if (mv.ut === 'A') { mv.uc = { x: uv.x + (P || 0), y: uv.y + (Q || 0) }; mv.uccw = ug === 103; mv.ur = V.dist(mv.uc, uv); mv.ufull = V.dist(uv, nuv) < 1e-9; }
    }
    moves.push(mv); pos = np; uv = nuv;
  });
  const segs = moves.filter(m => m.type !== 'stop');
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  segs.forEach(m => segBBox(m.t === 'A' ? segA(m.p0, m.p1, m.c, m.ccw, m.full) : segL(m.p0, m.p1), bb));
  return { moves, dtab, warnings, bbox: bb, lines };
}
function moveSeg(m) { return m.t === 'A' ? segA(m.p0, m.p1, m.c, m.ccw, m.full) : segL(m.p0, m.p1); }
function moveTopSeg(m) { if (!m.uv0) return null; return m.ut === 'A' ? segA(m.uv0, m.uv1, m.uc, m.uccw, m.ufull) : segL(m.uv0, m.uv1); }

const WC = {
  TAU, V, angOf, normPos, onCircle,
  segL, segA, cloneSeg, sweep, segLen, pathLen, segPoint, segTan, segReverse, pathReverse, segSplit, segNearest, segBBox, segSample, pathSample,
  signedArea, pointInPath, pathNearest, pathPointAtDist, pathSplitAtDist, pathIsClosed, pathBBox, angleOnArc,
  curveInter, segInter, onSeg,
  newId, setIdBase, mkLine, mkArc, mkCircle, entSeg, segToEnt, entEnds, entBBox, entsBBox, entNearest, entLen, transformEnt, cloneEnt,
  circle3, fitPoints, parseDXF, dedupeEntities, writeDXF,
  buildGraph, Chainer, mergeCollinear, splitEntsAt, splitAtTJunctions, nearestOnEnts, offsetSeg, offsetPath,
  orientationCCW, rotateClosedTo, jobPath, jobBreaks, jobEffective, jobSide, interiorSide, topOffsetSide, taperShift, topPathFor, taperSurfaces, shapeSize, syncChains, syncChainsGeo, splitAtDists,
  entParams, setEntParams, CONS_INFO, consRows, consEntIds, solveConstraints, consResidual,
  gearSegs,
  fmtNum, splitBigArcs, pairSplitAtDist, splitPairsBig, generateProgram, parseWC, moveSeg, moveTopSeg,
};
if (typeof module !== 'undefined' && module.exports) module.exports = WC; else root.WC = WC;
})(typeof window !== 'undefined' ? window : globalThis);
