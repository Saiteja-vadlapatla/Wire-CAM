/* WireCAM UI – shared state, view, rendering, snapping, input routing, undo, files */
(function () {
'use strict';
const { V } = WC;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
const num = (v, d) => { const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : d; };

const DEFAULT_CFG = { wireDia: 0.18, gap: 0.01, leadLen: 3, joinTol: 0.005, fitTol: 0.002, autoStraight: false, uiScale: 100, decimals: 6, endCode: 'M0', thread: 'manual', maxArc: 180, taperZ: 225, eCode: '' };
let cfg = Object.assign({}, DEFAULT_CFG);
try { Object.assign(cfg, JSON.parse(localStorage.getItem('wirecam.cfg') || '{}')); } catch (e) { }
const saveCfg = () => { try { localStorage.setItem('wirecam.cfg', JSON.stringify(cfg)); } catch (e) { } };

const JOB_COLORS = ['#35c46f', '#2f8cff', '#ff8f3a', '#d36cff', '#20d0d0', '#ff5a8a', '#c4d63a', '#ffb020'];
const LAYER_COLORS = ['#e8edf2', '#7fc4ff', '#ffd27f', '#9ff0bf', '#ff9fb0', '#c9a7ff', '#80e0e0', '#ffb380'];

const S = {
  ents: [], cons: [], showCons: true, hidden: new Set(), sel: new Set(), layerOrder: [],
  jobs: [], cur: -1,
  prog: { name: 'EMT0001', title: '', notes: '' },
  mode: 'draw', tool: 'select', ts: {},
  view: { scale: 4, ox: 300, oy: 300 },
  mouse: { sx: 0, sy: 0, w: { x: 0, y: 0 }, raw: { x: 0, y: 0 }, snap: null, inside: false, shift: false },
  hover: null, dirty: false, fileName: '',
  pick: null, chain: null, junction: null,
  gen: null, viewer: null, sim: { idx: 0, frac: 0, playing: false, speed: 1 },
};
const App = window.App = { S, cfg, saveCfg, $, $$, esc, r3, num, JOB_COLORS, DEFAULT_CFG };

// ------------------------------------------------------------------ canvas & view
const cv = $('#view'); const ctx = cv.getContext('2d'); let dpr = 1; App.ctx = ctx;
let lastSize = null;
function resize() { const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; cv.width = Math.max(10, r.width * dpr); cv.height = Math.max(10, r.height * dpr); if (lastSize && r.width > 10 && r.height > 10) { S.view.ox += (r.width - lastSize.w) / 2; S.view.oy += (r.height - lastSize.h) / 2; } if (r.width > 10) lastSize = { w: r.width, h: r.height }; redraw(); }
const w2s = (p) => ({ x: S.view.ox + p.x * S.view.scale, y: S.view.oy - p.y * S.view.scale });
const s2w = (x, y) => ({ x: (x - S.view.ox) / S.view.scale, y: (S.view.oy - y) / S.view.scale });
App.w2s = w2s; App.s2w = s2w;
function viewSize() { const r = cv.getBoundingClientRect(); return { w: r.width, h: r.height }; }
function fitBox(bb, pad) {
  const { w, h } = viewSize(); if (!isFinite(bb.x0)) { S.view.scale = 4; S.view.ox = w / 2; S.view.oy = h / 2; redraw(); return; }
  const bw = Math.max(bb.x1 - bb.x0, 1e-3), bh = Math.max(bb.y1 - bb.y0, 1e-3); pad = pad || 40;
  S.view.scale = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh); S.view.scale = Math.max(1e-3, Math.min(S.view.scale, 5000));
  S.view.ox = w / 2 - (bb.x0 + bw / 2) * S.view.scale; S.view.oy = h / 2 + (bb.y0 + bh / 2) * S.view.scale; redraw();
}
function allBBox() {
  const bb = WC.entsBBox(visibleEnts());
  const inc = (p) => { if (!p) return; bb.x0 = Math.min(bb.x0, p.x); bb.y0 = Math.min(bb.y0, p.y); bb.x1 = Math.max(bb.x1, p.x); bb.y1 = Math.max(bb.y1, p.y); };
  S.jobs.forEach(j => { inc(j.start); inc(j.end); });
  if (S.mode === 'program' && S.viewer) { const b = S.viewer.parsed.bbox; inc({ x: b.x0, y: b.y0 }); inc({ x: b.x1, y: b.y1 }); }
  return bb;
}
App.fit = () => fitBox(allBBox());
App.fitBox = fitBox;
function zoomAt(sx, sy, f) { const w = s2w(sx, sy); S.view.scale = Math.max(1e-3, Math.min(S.view.scale * f, 20000)); S.view.ox = sx - w.x * S.view.scale; S.view.oy = sy + w.y * S.view.scale; redraw(); }

// ------------------------------------------------------------------ helpers
const visibleEnts = () => S.ents.filter(e => !S.hidden.has(e.layer));
App.visibleEnts = visibleEnts;
function layerColor(l) { let i = S.layerOrder.indexOf(l); if (i < 0) { S.layerOrder.push(l); i = S.layerOrder.length - 1; } return LAYER_COLORS[i % LAYER_COLORS.length]; }
App.layerColor = layerColor;
function pickEnt(sx, sy, px, list) {
  const w = s2w(sx, sy); const tol = (px || 9) / S.view.scale; let best = null, bd = Infinity;
  for (const e of (list || visibleEnts())) { const n = WC.entNearest(e, w); if (n.d < tol && n.d < bd) { bd = n.d; best = e; } }
  return best;
}
App.pickEnt = pickEnt;

// ------------------------------------------------------------------ snapping
function computeSnap(sx, sy, opts) {
  opts = opts || {}; const w = s2w(sx, sy); const tol = 12 / S.view.scale;
  const excl = App.snapExclude ? App.snapExclude() : null;
  const near = visibleEnts().filter(e => { if (excl && excl.has(e.id)) return false; const b = WC.entBBox(e); return w.x > b.x0 - tol && w.x < b.x1 + tol && w.y > b.y0 - tol && w.y < b.y1 + tol; });
  const extra = opts.extraPts || [];
  if (!$('#snapOn').checked && !opts.force) return gridSnap(w);
  const cands = [];
  const addC = (p, kind, pri) => { const d = V.dist(p, w); if (d <= tol) cands.push({ p, kind, pri, d }); };
  for (const e of near) {
    if (e.type !== 'circle') WC.entEnds(e).forEach(p => addC(p, 'END', 0));
    if (e.type !== 'line') { addC(e.c, 'CENTRE', 1); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; if (e.type === 'circle' || WC.angleOnArc(WC.entSeg(e), a)) addC(WC.onCircle(e.c, e.r, a), 'QUAD', 2); } }
    const sg = WC.entSeg(e); addC(WC.segPoint(sg, 0.5), 'MID', 2);
  }
  extra.forEach(x => addC(x.p, x.kind || 'POINT', 0));
  const base = App.snapBase ? App.snapBase() : null;
  if (base) for (const e of near) {
    if (e.type === 'line') { const d = V.sub(e.b, e.a), L2 = V.dot(d, d); if (L2 > 1e-12) { const t = V.dot(V.sub(base, e.a), d) / L2; if (t > -1e-9 && t < 1 + 1e-9) addC(V.add(e.a, V.mul(d, t)), 'PERP', 1); } }
    else { const dc = V.dist(base, e.c); if (dc > 1e-9) { const u = V.unit(V.sub(base, e.c)); [1, -1].forEach(sg => { const q = V.add(e.c, V.mul(u, sg * e.r)); if (e.type === 'circle' || WC.angleOnArc(WC.entSeg(e), WC.angOf(e.c, q))) addC(q, 'PERP', 1); });
      if (dc > e.r + 1e-9) { const b = Math.acos(e.r / dc), a0 = WC.angOf(e.c, base); [b, -b].forEach(db => { const q = WC.onCircle(e.c, e.r, a0 + db); if (e.type === 'circle' || WC.angleOnArc(WC.entSeg(e), a0 + db)) addC(q, 'TAN', 1); }); } } }
  }
  if (near.length < 40) for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) WC.segInter(WC.entSeg(near[i]), WC.entSeg(near[j]), 1e-6).forEach(p => addC(p, 'INTER', 0));
  if (cands.length) { cands.sort((a, b) => (a.pri - b.pri) || (a.d - b.d)); const c = cands[0]; return { p: c.p, kind: c.kind }; }
  // on entity
  let best = null, bd = Infinity; for (const e of near) { const n = WC.entNearest(e, w); if (n.d < tol * 0.75 && n.d < bd) { bd = n.d; best = n.pt; } }
  if (best) return { p: best, kind: 'ON' };
  return gridSnap(w);
}
function gridStep() { const target = 28 / S.view.scale; const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]; for (const s of steps) if (s >= target) return s; return 1000; }
function gridSnap(w) { if ($('#gridSnap').checked) { const g = gridStep(); return { p: { x: Math.round(w.x / g) * g, y: Math.round(w.y / g) * g }, kind: 'GRID' }; } return { p: w, kind: null }; }
App.computeSnap = computeSnap;
App.ortho = (base, p) => { if (!base || !($('#orthoOn').checked || S.mouse.shift)) return p; const dx = p.x - base.x, dy = p.y - base.y; return Math.abs(dx) > Math.abs(dy) ? { x: p.x, y: base.y } : { x: base.x, y: p.y }; };

// ------------------------------------------------------------------ undo / redo
const undoStack = [], redoStack = [];
function snapshot() { return JSON.stringify({ ents: S.ents, cons: S.cons, jobs: S.jobs, cur: S.cur }); }
function restore(js) { const o = JSON.parse(js); S.ents = o.ents; S.cons = o.cons || []; S.jobs = o.jobs; S.cur = o.cur; S.sel.clear(); WC.setIdBase(maxId()); App.chainCancel && App.chainCancel(); markChanged(); }
function maxId() { let m = 0; S.ents.forEach(e => { if (e.id > m) m = e.id; }); return m; }
App.pushUndo = () => { undoStack.push(snapshot()); if (undoStack.length > 300) undoStack.shift(); redoStack.length = 0; };
App.undo = () => { if (!undoStack.length) return toast('Nothing to undo'); redoStack.push(snapshot()); restore(undoStack.pop()); toast('Undo'); };
App.dropUndo = () => { undoStack.pop(); };
App.revertLast = () => { if (!undoStack.length) return; restore(undoStack.pop()); };
App.redo = () => { if (!redoStack.length) return toast('Nothing to redo'); undoStack.push(snapshot()); restore(redoStack.pop()); toast('Redo'); };
App.maxId = maxId;

// ------------------------------------------------------------------ change tracking / autosave
let autosaveT = null;
function markChanged() {
  S.dirty = true; if (window.native) window.native.setDirty(true);
  App.invalidateProgram && App.invalidateProgram();
  clearTimeout(autosaveT); autosaveT = setTimeout(autosave, 800);
  App.refreshPanels && App.refreshPanels(); redraw();
}
App.markChanged = markChanged;
function projectData() { return { app: 'WireCAM', version: 1, ents: S.ents, cons: S.cons, hidden: [...S.hidden], jobs: S.jobs, prog: S.prog, cur: S.cur }; }
function loadProjectData(o) {
  S.ents = o.ents || []; S.cons = o.cons || []; S.hidden = new Set(o.hidden || []); S.jobs = o.jobs || []; S.prog = Object.assign({ name: 'EMT0001', title: '', notes: '' }, o.prog || {}); S.cur = Math.min(o.cur || 0, S.jobs.length - 1);
  S.sel.clear(); S.layerOrder = []; WC.setIdBase(maxId()); S.viewer = null;
}
function autosave() { try { localStorage.setItem('wirecam.autosave', JSON.stringify(Object.assign(projectData(), { savedAt: Date.now(), fileName: S.fileName }))); } catch (e) { } }
App.projectData = projectData; App.loadProjectData = loadProjectData;

// ------------------------------------------------------------------ toast / modal / hint
let toastT = null;
function toast(msg, kind, ms) { const t = $('#toast'); t.textContent = msg; t.className = 'show ' + (kind || ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', ms || 2600); }
App.toast = toast;
function modal(title, html, buttons) {
  $('#mtitle').textContent = title; $('#mbody').innerHTML = html; const f = $('#mfoot'); f.innerHTML = '';
  return new Promise(res => {
    const close = (v) => { $('#modal').classList.add('hidden'); document.removeEventListener('keydown', kd, true); res(v); };
    (buttons || []).forEach(b => { const el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label; el.onclick = () => close(b.value); f.appendChild(el); });
    $('#mclose').onclick = () => close(null);
    const kd = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', kd, true);
    $('#modal').classList.remove('hidden');
  });
}
App.modal = modal;
App.closeModal = () => $('#modal').classList.add('hidden');
function hint(text, warn) { $('#hintText').textContent = text; $('#hint').classList.toggle('warn', !!warn); }
App.hint = hint;
App.setCmdPlaceholder = (t) => { $('#cmd').placeholder = t || 'Type values here and press Enter'; };

// ------------------------------------------------------------------ rendering
let rafPending = false;
function redraw() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); } }
App.redraw = redraw;
function strokeSeg(s) {
  const a = w2s(s.p0);
  if (s.t === 'L') { const b = w2s(s.p1); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); return; }
  const c = w2s(s.c), r = s.r * S.view.scale; const a0 = -WC.angOf(s.c, s.p0); const w = WC.sweep(s);
  ctx.moveTo(a.x, a.y);
  if (r > 2e6) { const b = w2s(s.p1); ctx.lineTo(b.x, b.y); return; }
  ctx.arc(c.x, c.y, r, a0, s.ccw ? a0 - w : a0 + w, s.ccw);
}
App.strokeSeg = strokeSeg;
function strokePath(segs, color, width, dash) { ctx.beginPath(); segs.forEach(strokeSeg); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); }
App.strokePath = strokePath;
function drawArrow(p, dir, color, size) {
  const a = w2s(p); const ang = Math.atan2(-dir.y, dir.x); size = size || 9;
  ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(size, 0); ctx.lineTo(-size * 0.7, size * 0.6); ctx.lineTo(-size * 0.4, 0); ctx.lineTo(-size * 0.7, -size * 0.6); ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.restore();
}
App.drawArrow = drawArrow;
function pathArrows(segs, color, spacingPx) {
  const L = WC.pathLen(segs); if (L <= 0) return; const sp = (spacingPx || 120) / S.view.scale; const n = Math.max(1, Math.min(200, Math.floor(L / sp)));
  for (let k = 0; k < n; k++) { const d = (k + 0.5) * L / n; const r = WC.pathPointAtDist(segs, d); drawArrow(r.pt, WC.segTan(segs[r.i], r.t), color, 8); }
}
App.pathArrows = pathArrows;
function label(p, text, color, dx, dy, bg) {
  const a = w2s(p); ctx.font = 'bold 12px Segoe UI, Arial'; const w = ctx.measureText(text).width;
  const x = a.x + (dx || 8), y = a.y + (dy || -8);
  ctx.fillStyle = bg || 'rgba(0,0,0,.65)'; ctx.fillRect(x - 3, y - 12, w + 6, 16); ctx.fillStyle = color || '#fff'; ctx.fillText(text, x, y);
}
App.label = label;
function dot(p, r, color, ring) { const a = w2s(p); ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2); if (ring) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); } else { ctx.fillStyle = color; ctx.fill(); } }
App.dot = dot;
function drawGrid() {
  const { w, h } = viewSize(); const g = gridStep(); const tl = s2w(0, 0), br = s2w(w, h);
  const nx = (br.x - tl.x) / g, ny = (tl.y - br.y) / g; if (nx > 400 || ny > 400) return;
  ctx.lineWidth = 1;
  for (let i = Math.floor(tl.x / g); i <= Math.ceil(br.x / g); i++) { const x = Math.round(w2s({ x: i * g, y: 0 }).x) + 0.5; ctx.strokeStyle = i % 5 === 0 ? '#1f2833' : '#161c23'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let j = Math.floor(br.y / g); j <= Math.ceil(tl.y / g); j++) { const y = Math.round(w2s({ x: 0, y: j * g }).y) + 0.5; ctx.strokeStyle = j % 5 === 0 ? '#1f2833' : '#161c23'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  // axes
  const o = w2s({ x: 0, y: 0 }); ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,90,90,.55)'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x + 60, o.y); ctx.stroke();
  ctx.strokeStyle = 'rgba(80,220,120,.55)'; ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(o.x, o.y - 60); ctx.stroke();
  ctx.fillStyle = 'rgba(255,90,90,.8)'; ctx.font = '11px Arial'; ctx.fillText('X', o.x + 62, o.y + 4); ctx.fillStyle = 'rgba(80,220,120,.8)'; ctx.fillText('Y', o.x - 3, o.y - 64);
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(o.x, o.y, 4, 0, 7); ctx.stroke();
}
function render() {
  const { w, h } = viewSize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0f1318'; ctx.fillRect(0, 0, w, h);
  drawGrid();
  const viewing = S.mode === 'program' && S.viewer;
  // entities
  const dimEnts = S.mode !== 'draw';
  if (!viewing) for (const e of visibleEnts()) {
    const sel = S.sel.has(e.id), hov = S.hover === e.id;
    ctx.beginPath(); strokeSeg(WC.entSeg(e));
    ctx.strokeStyle = sel ? '#ffe14d' : hov ? '#5fe0ff' : layerColor(e.layer); ctx.globalAlpha = dimEnts && !hov ? 0.55 : 1;
    ctx.lineWidth = sel || hov ? 2.6 : 1.4; ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (S.mode === 'draw' && App.drawTool) App.drawTool(ctx);
  if (S.mode === 'path' && App.drawPathMode) App.drawPathMode(ctx);
  if (S.mode === 'program' && App.drawProgramMode) App.drawProgramMode(ctx);
  // snap marker
  const sn = S.mouse.snap; if (sn && sn.kind && S.mouse.inside) {
    const a = w2s(sn.p); ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2; ctx.beginPath();
    if (sn.kind === 'END' || sn.kind === 'POINT') ctx.rect(a.x - 6, a.y - 6, 12, 12); else if (sn.kind === 'MID') { ctx.moveTo(a.x, a.y - 7); ctx.lineTo(a.x + 7, a.y + 5); ctx.lineTo(a.x - 7, a.y + 5); ctx.closePath(); }
    else if (sn.kind === 'CENTRE') ctx.arc(a.x, a.y, 6, 0, 7); else if (sn.kind === 'INTER') { ctx.moveTo(a.x - 6, a.y - 6); ctx.lineTo(a.x + 6, a.y + 6); ctx.moveTo(a.x + 6, a.y - 6); ctx.lineTo(a.x - 6, a.y + 6); }
    else if (sn.kind === 'QUAD') { ctx.moveTo(a.x, a.y - 7); ctx.lineTo(a.x + 7, a.y); ctx.lineTo(a.x, a.y + 7); ctx.lineTo(a.x - 7, a.y); ctx.closePath(); }
    else if (sn.kind === 'PERP') { ctx.moveTo(a.x - 7, a.y + 6); ctx.lineTo(a.x + 7, a.y + 6); ctx.moveTo(a.x - 4, a.y + 6); ctx.lineTo(a.x - 4, a.y - 7); ctx.moveTo(a.x - 4, a.y); ctx.lineTo(a.x + 2, a.y); ctx.lineTo(a.x + 2, a.y + 6); }
    else if (sn.kind === 'TAN') { ctx.arc(a.x, a.y, 6, 0, 7); ctx.moveTo(a.x - 8, a.y - 6); ctx.lineTo(a.x + 8, a.y - 6); }
    else if (sn.kind === 'ON') { ctx.moveTo(a.x - 6, a.y + 6); ctx.lineTo(a.x + 6, a.y - 6); ctx.moveTo(a.x - 6, a.y - 6); ctx.lineTo(a.x + 6, a.y - 6); }
    else ctx.rect(a.x - 3, a.y - 3, 6, 6);
    ctx.stroke();
  }
  $('#snapBadge').textContent = sn && sn.kind && S.mouse.inside ? ({ END: 'END POINT', MID: 'MIDDLE', CENTRE: 'CENTRE', INTER: 'CROSSING', QUAD: 'QUADRANT', ON: 'ON LINE', GRID: 'GRID', POINT: 'POINT', PERP: 'PERPENDICULAR', TAN: 'TANGENT' }[sn.kind] || sn.kind) : '';
  $('#emptyHint').classList.toggle('hidden', S.ents.length > 0 || !!viewing);
}

// ------------------------------------------------------------------ mouse
let drag = null;
cv.addEventListener('contextmenu', e => e.preventDefault());
cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2); }, { passive: false });
cv.addEventListener('mousedown', e => {
  const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
  document.activeElement && document.activeElement.blur && document.activeElement !== document.body && document.activeElement.id !== 'cmd' && document.activeElement.blur();
  if (e.button === 1 || e.button === 2) { drag = { kind: 'pan', sx, sy, ox: S.view.ox, oy: S.view.oy, btn: e.button, moved: false }; cv.classList.add('pan'); e.preventDefault(); return; }
  if (e.button === 0) { if (App.gripDown && App.gripDown(sx, sy)) { drag = { kind: 'grip' }; return; } drag = { kind: 'left', sx, sy, moved: false, shift: e.shiftKey, ctrl: e.ctrlKey }; }
});
window.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
  S.mouse.sx = sx; S.mouse.sy = sy; S.mouse.shift = e.shiftKey;
  S.mouse.inside = sx >= 0 && sy >= 0 && sx <= r.width && sy <= r.height;
  if (drag && drag.kind === 'pan') { if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true; S.view.ox = drag.ox + sx - drag.sx; S.view.oy = drag.oy + sy - drag.sy; redraw(); return; }
  if (drag && drag.kind === 'left' && Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 5) drag.moved = true;
  S.dragBox = drag && drag.kind === 'left' && drag.moved ? { x0: drag.sx, y0: drag.sy, x1: sx, y1: sy } : null;
  if (!S.mouse.inside && !drag) { redraw(); return; }
  S.mouse.raw = s2w(sx, sy);
  const wantSnap = App.wantsSnap ? App.wantsSnap() : true;
  S.mouse.snap = wantSnap ? computeSnap(sx, sy, { extraPts: App.extraSnapPts ? App.extraSnapPts() : [] }) : { p: S.mouse.raw, kind: null };
  S.mouse.w = S.mouse.snap.p;
  if (drag && drag.kind === 'grip') { App.gripMove(App.ortho(App.snapBase ? App.snapBase() : null, S.mouse.w)); }
  const sh = S.mouse.w; const O = S.mode !== 'draw' && App.progOrigin ? App.progOrigin() : null; $('#coord').textContent = O ? 'PROG  X ' + r3(sh.x - O.pt.x).padStart(9) + '   Y ' + r3(sh.y - O.pt.y).padStart(9) : 'X ' + r3(sh.x).padStart(9) + '   Y ' + r3(sh.y).padStart(9);
  App.onHover && App.onHover(sx, sy, e);
  redraw();
});
window.addEventListener('mouseup', e => {
  const r = cv.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (!drag) return; const d = drag; drag = null; S.dragBox = null; cv.classList.remove('pan');
  if (d.kind === 'pan') { if (!d.moved && d.btn === 2) App.onRightClick && App.onRightClick(); return; }
  if (d.kind === 'grip') { App.gripUp && App.gripUp(); return; }
  if (d.kind === 'left') {
    if (d.moved && App.onDragSelect) App.onDragSelect(d.sx, d.sy, sx, sy, d);
    else App.onClick && App.onClick(S.mouse.w, sx, sy, d);
  }
});
cv.addEventListener('mouseleave', () => { S.mouse.inside = false; redraw(); });
cv.addEventListener('dblclick', () => App.fit());

// ------------------------------------------------------------------ typed input
function parseTyped(str, base) {
  str = String(str).trim().replace(/;/g, ',').replace(/\s+/g, ' '); if (!str) return null;
  const n = (s) => { const v = parseFloat(s); return isFinite(v) ? v : NaN; };
  let rel = false; if (str[0] === '@') { rel = true; str = str.slice(1).trim(); }
  let m = str.match(/^([-+]?[\d.]+)\s*<\s*([-+]?[\d.]+)$/);
  if (m) { const L = n(m[1]), A = n(m[2]) * Math.PI / 180; const b = base || { x: 0, y: 0 }; return { kind: 'point', p: { x: b.x + L * Math.cos(A), y: b.y + L * Math.sin(A) }, polar: true }; }
  m = str.match(/^([-+]?[\d.]+)\s*[, ]\s*([-+]?[\d.]+)$/);
  if (m) { const x = n(m[1]), y = n(m[2]); if (isNaN(x) || isNaN(y)) return null; if (rel) { const b = base || { x: 0, y: 0 }; return { kind: 'point', p: { x: b.x + x, y: b.y + y }, rel: true }; } return { kind: 'point', p: { x, y } }; }
  m = str.match(/^[rR]\s*([\d.]+)$/); if (m) return { kind: 'radius', v: n(m[1]) };
  m = str.match(/^[dDØø]\s*([\d.]+)$/); if (m) return { kind: 'diameter', v: n(m[1]) };
  m = str.match(/^([-+]?[\d.]+)$/); if (m) return { kind: 'number', v: n(m[1]) };
  return null;
}
App.parseTyped = parseTyped;
function submitCmd() {
  const v = $('#cmd').value; if (!v.trim()) return;
  const ok = App.onTyped ? App.onTyped(v) : false;
  if (ok !== false) $('#cmd').value = ''; else toast('Could not understand "' + v + '". Examples: 10,20   @5,0   @25<45   12', 'w');
}
$('#cmd').addEventListener('keydown', e => { if (S.junction && /^[1-9]$/.test(e.key) && !$('#cmd').value) { e.preventDefault(); e.stopPropagation(); App.onKey && App.onKey(e); return; } if (e.key === 'Enter') { e.preventDefault(); submitCmd(); } if (e.key === 'Escape') { $('#cmd').value = ''; $('#cmd').blur(); App.onEscape && App.onEscape(); } e.stopPropagation(); });
$('#cmdGo').onclick = submitCmd;

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
  if (!$('#modal').classList.contains('hidden')) return;
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { if (!inField) { e.preventDefault(); App.undo(); } return; }
  if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { if (!inField) { e.preventDefault(); App.redo(); } return; }
  if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); App.saveProject(); return; }
  if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); App.openAny(); return; }
  if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); App.newJob(); return; }
  if (e.key === 'F1') { e.preventDefault(); App.showHelp(); return; }
  if (inField) return;
  if (e.key === 'Escape') { App.onEscape && App.onEscape(); return; }
  if (e.key === 'f' || e.key === 'F' || e.key === 'Home') { App.fit(); return; }
  if (e.key === 'F3') { e.preventDefault(); $('#snapOn').checked = !$('#snapOn').checked; toast('Snap ' + ($('#snapOn').checked ? 'ON' : 'OFF')); return; }
  if (e.key === 'F8') { e.preventDefault(); $('#orthoOn').checked = !$('#orthoOn').checked; toast('Ortho ' + ($('#orthoOn').checked ? 'ON' : 'OFF')); return; }
  if (e.key === 'Shift') { S.mouse.shift = true; redraw(); }
  if (App.onKey && App.onKey(e) === true) { e.preventDefault(); return; }
  // typing a number / coordinate starts the command line
  if (/^[0-9@.\-rRdD]$/.test(e.key) && !e.ctrlKey && !e.altKey) { const c = $('#cmd'); c.focus(); }
});
window.addEventListener('keyup', e => { if (e.key === 'Shift') { S.mouse.shift = false; redraw(); } });

// ------------------------------------------------------------------ files
const fileInput = $('#fileInput');
function readFileObj(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ name: f.name, text: r.result }); r.onerror = rej; r.readAsText(f, 'latin1'); }); }
App.pickFile = (accept) => {
  if (window.native) return window.native.openFile(accept);
  return new Promise(res => { fileInput.accept = accept || ''; fileInput.value = ''; fileInput.onchange = () => { const f = fileInput.files[0]; if (!f) return res(null); readFileObj(f).then(res); }; fileInput.click(); });
};
App.saveText = async (defName, text, kind) => {
  if (window.native) return window.native.saveFile(defName, text, kind);
  const blob = new Blob([text], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = defName; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); return defName;
};
async function handleFile(f) {
  if (!f) return; const ext = (f.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'dxf') return App.importDXF(f.text, f.name);
    if (ext === 'wcam' || ext === 'json') { const o = JSON.parse(f.text); if (!o || o.app !== 'WireCAM') throw new Error('Not a WireCAM project'); App.pushUndo(); loadProjectData(o); S.fileName = f.path || f.name; S.dirty = false; window.native && window.native.setDirty(false); App.setMode('path'); markChanged(); S.dirty = false; App.fit(); toast('Project opened: ' + f.name, 'o'); return; }
    if (/^(wc|nc|txt|iso|cnc|tap)$/.test(ext) || /^\s*;/.test(f.text) || /G0?[0-3]\s/.test(f.text)) return App.viewProgramFile(f.name, f.text);
    if (f.text.indexOf('GLineSeg') >= 0 || f.text.indexOf('GArc') >= 0) { toast('This is an ELCam internal file (.prf). Please export it as DXF from ELCam, then open the DXF.', 'w', 6000); return; }
    toast('Unknown file type: ' + f.name, 'e');
  } catch (err) { console.error(err); toast('Could not open ' + f.name + ': ' + err.message, 'e', 6000); }
}
App.handleFile = handleFile;
App.openAny = async () => { const f = await App.pickFile('.dxf,.DXF,.wcam,.WC,.wc,.nc,.txt'); if (f) handleFile(f); };
App.saveProject = async () => {
  const name = (S.fileName ? S.fileName.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : (S.prog.name || 'job')) + '.wcam';
  const p = await App.saveText(name, JSON.stringify(projectData(), null, 1), 'project');
  if (p) { S.fileName = p; S.dirty = false; window.native && window.native.setDirty(false); toast('Saved: ' + p.split(/[\\/]/).pop(), 'o'); }
};
App.exportDxf = async () => { if (!S.ents.length) return toast('Drawing is empty', 'w'); const p = await App.saveText((S.prog.name || 'drawing') + '.dxf', WC.writeDXF(visibleEnts()), 'dxf'); if (p) toast('DXF saved', 'o'); };
// drag & drop
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop', async e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { const o = await readFileObj(f); o.path = f.path; handleFile(o); } });

window.addEventListener('resize', resize);
App.resize = resize;
App.render = render;
})();
