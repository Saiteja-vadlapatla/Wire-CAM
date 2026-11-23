/* WireCAM – small 3D view of a taper cut (bottom contour, top contour, cut surface, wire, job block) */
(function () {
'use strict';
const { V } = WC; const { S, r3, esc } = App;
const st = { yaw: -0.75, pitch: 0.62, zoom: 1, t: 0.15 };

function sampleSurf(g) {
  const B = [], Tp = [];
  g.bottom.forEach((b, k) => { const t = g.top[k]; const n = Math.max(1, Math.ceil(Math.max(WC.sweep(b), WC.sweep(t)) / 0.12)); for (let i = (k ? 1 : 0); i <= n; i++) { B.push(WC.segPoint(b, i / n)); Tp.push(WC.segPoint(t, i / n)); } });
  return { B, Tp };
}
function sizeText(segs, closed) { const z = WC.shapeSize(segs, closed); return z.circle ? 'Ø' + r3(z.d) : r3(z.w) + ' × ' + r3(z.h); }
App.taperInfo = function (j) {
  const g = WC.taperSurfaces(j); if (g.error) return { error: g.error };
  const out = { closed: g.closed, T: g.T, W: g.W, bottom: sizeText(g.bottom, g.closed), top: sizeText(g.top, g.closed) };
  const zb = WC.shapeSize(g.bottom, g.closed), zt = WC.shapeSize(g.top, g.closed);
  out.diff = zb.circle && zt.circle ? (zt.d - zb.d) / 2 : ((zt.w - zb.w) + (zt.h - zb.h)) / 4;
  if (g.W > 0) out.prog = sizeText(g.programmed, g.closed);
  if (!g.closed) { const tp = j.taper; let sh = 0, dirTxt = ''; if (tp.mode === 'shape') { out.top = 'TOP shape'; out.bottom = 'drawn path'; } else { sh = g.T * Math.tan((+tp.angle || 0) * Math.PI / 180); dirTxt = j.closed ? (WC.topOffsetSide(j, WC.jobPath(j)) === 'L' ? 'LEFT' : 'RIGHT') : (tp.top === 'right' ? 'RIGHT' : 'LEFT'); out.bottom = 'drawn line'; out.top = 'shifted ' + r3(sh) + ' mm to the ' + dirTxt; } out.openShift = sh; }
  return out;
};
App.render3D = function (cv, j) {
  if (!cv) return; const ctx = cv.getContext('2d'); const dpr = window.devicePixelRatio || 1; const Wd = cv.clientWidth, Hd = cv.clientHeight;
  cv.width = Wd * dpr; cv.height = Hd * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b0e12'; ctx.fillRect(0, 0, Wd, Hd);
  const g = WC.taperSurfaces(j); if (g.error) { ctx.fillStyle = '#ffb020'; ctx.font = '13px Segoe UI, Arial'; ctx.fillText(g.error, 12, 24); return; }
  const { B, Tp } = sampleSurf(g); const T = g.T;
  const all = B.concat(Tp); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; all.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
  const span = Math.max(x1 - x0, y1 - y0, T, 1e-3); const m = span * 0.22; const bx0 = x0 - m, by0 = y0 - m, bx1 = x1 + m, by1 = y1 + m;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = T / 2;
  const cy_ = Math.cos(st.yaw), sy_ = Math.sin(st.yaw), cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
  const proj0 = (p, z) => { const x = p.x - cx, y = p.y - cy, zz = z - cz; const xr = x * cy_ - y * sy_, yr = x * sy_ + y * cy_; return { x: xr, y: -(zz * cp + yr * sp), d: yr * cp - zz * sp }; };
  // fit
  const corners = []; [bx0, bx1].forEach(x => [by0, by1].forEach(y => [0, T].forEach(z => corners.push(proj0({ x, y }, z))))); const ext = T * 0.9;
  [-ext, T + ext].forEach(z => corners.push(proj0({ x: cx, y: cy }, z)));
  let px0 = Infinity, px1 = -Infinity, py0 = Infinity, py1 = -Infinity; corners.forEach(q => { px0 = Math.min(px0, q.x); px1 = Math.max(px1, q.x); py0 = Math.min(py0, q.y); py1 = Math.max(py1, q.y); });
  const sc = Math.min((Wd - 30) / (px1 - px0), (Hd - 30) / (py1 - py0)) * st.zoom; const ox = Wd / 2 - (px0 + px1) / 2 * sc, oy = Hd / 2 - (py0 + py1) / 2 * sc;
  const P = (p, z) => { const q = proj0(p, z); return { x: ox + q.x * sc, y: oy + q.y * sc, d: q.d }; };
  const poly = (pts, fill, stroke, lw) => { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); } };
  const line = (a, b, col, lw, dash) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = col; ctx.lineWidth = lw || 1; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); };
  // job block (table + block)
  const blk = [{ x: bx0, y: by0 }, { x: bx1, y: by0 }, { x: bx1, y: by1 }, { x: bx0, y: by1 }];
  poly(blk.map(p => P(p, 0)), 'rgba(120,140,160,.10)', 'rgba(150,170,190,.5)', 1);
  poly(blk.map(p => P(p, T)), 'rgba(120,140,160,.06)', 'rgba(150,170,190,.35)', 1);
  blk.forEach(p => line(P(p, 0), P(p, T), 'rgba(150,170,190,.35)', 1));
  // cut surface (ruled) – painter's algorithm
  const faces = []; const n = B.length;
  for (let i = 0; i < n - 1; i++) { const q = [P(B[i], 0), P(B[i + 1], 0), P(Tp[i + 1], T), P(Tp[i], T)]; const d = (q[0].d + q[1].d + q[2].d + q[3].d) / 4;
    const e1 = { x: q[1].x - q[0].x, y: q[1].y - q[0].y }, e2 = { x: q[3].x - q[0].x, y: q[3].y - q[0].y }; const facing = e1.x * e2.y - e1.y * e2.x; faces.push({ q, d, facing }); }
  faces.sort((a, b) => b.d - a.d);
  const part = j.kind === 'part'; const base = part ? [53, 196, 111] : j.kind === 'hole' ? [47, 140, 255] : [255, 150, 40];
  faces.forEach(f => { const k = f.facing > 0 ? 1 : 0.6; poly(f.q, `rgba(${base[0] * k | 0},${base[1] * k | 0},${base[2] * k | 0},.42)`, null); });
  // contour lines
  const pl = (pts, z, col, lw) => { ctx.beginPath(); pts.forEach((p, i) => { const q = P(p, z); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); };
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 24))) line(P(B[i], 0), P(Tp[i], T), 'rgba(255,255,255,.18)', 1);
  pl(B, 0, '#5fb0ff', 2.4); pl(Tp, T, '#ff5ad1', 2.4);
  if (g.W > 0 && g.W < T) { const prog = []; g.programmed.forEach((sg, k) => { const nn = Math.max(1, Math.ceil(WC.sweep(sg) / 0.12)); for (let i = (k ? 1 : 0); i <= nn; i++) prog.push(WC.segPoint(sg, i / nn)); }); pl(prog, g.W, '#ffe14d', 1.2); }
  // direction arrows on bottom contour
  const arrowAt = (i, z, pts, col) => { if (i + 1 >= pts.length) return; const a = P(pts[i], z), b = P(pts[i + 1], z); const ang = Math.atan2(b.y - a.y, b.x - a.x); ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, 5); ctx.lineTo(-5, -5); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); ctx.restore(); };
  [0.2, 0.5, 0.8].forEach(fz => arrowAt(Math.floor(fz * (n - 1)), 0, B, '#5fb0ff'));
  // wire at position t
  const wi = Math.min(n - 1, Math.max(0, Math.round(st.t * (n - 1)))); const wb = B[wi], wt = Tp[wi];
  const dir = { x: wt.x - wb.x, y: wt.y - wb.y }; const lo = { x: wb.x - dir.x * 0.6, y: wb.y - dir.y * 0.6 }, hi = { x: wt.x + dir.x * 0.6, y: wt.y + dir.y * 0.6 };
  const a = P(lo, -T * 0.6), b = P(hi, T * 1.6); line(a, b, '#ffe14d', 2.5);
  ctx.fillStyle = '#c0c8d0'; [a, b].forEach(q => { ctx.fillRect(q.x - 9, q.y - 6, 18, 12); });
  ctx.font = 'bold 10px Arial'; ctx.fillStyle = '#c0c8d0'; ctx.fillText('upper guide', b.x + 12, b.y + 4); ctx.fillText('lower guide', a.x + 12, a.y + 4);
  const pb = P(wb, 0), pt = P(wt, T); ctx.fillStyle = '#ffe14d'; [pb, pt].forEach(q => { ctx.beginPath(); ctx.arc(q.x, q.y, 3.5, 0, 7); ctx.fill(); });
  // labels
  const info = App.taperInfo(j);
  const lab = (q, txt, col) => { ctx.font = 'bold 12px Segoe UI, Arial'; const w = ctx.measureText(txt).width + 8; let x = q.x; if (x + w > Wd - 4) x = Math.max(4, Wd - 4 - w); const y = Math.max(14, Math.min(Hd - 6, q.y)); ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(x, y - 12, w, 17); ctx.fillStyle = col; ctx.fillText(txt, x + 4, y + 1); };
  let iT = 0, iB = 0, best = -Infinity, bestB = -Infinity; Tp.forEach((p, i) => { const q = P(p, T); if (q.x > best) { best = q.x; iT = i; } }); B.forEach((p, i) => { const q = P(p, 0); if (q.x > bestB) { bestB = q.x; iB = i; } });
  const qt = P(Tp[iT], T), qb = P(B[iB], 0); lab({ x: qt.x + 8, y: qt.y - 6 }, 'TOP (UV) ' + info.top, '#ff8ae0'); lab({ x: qb.x + 8, y: qb.y + 14 }, 'BOTTOM (XY) ' + info.bottom, '#8fc8ff');
  // thickness dimension on block corner
  const c0 = P({ x: bx0, y: by1 }, 0), c1 = P({ x: bx0, y: by1 }, T); line(c0, c1, '#9aa7b4', 1); lab({ x: c0.x - 64, y: (c0.y + c1.y) / 2 + 4 }, 'T ' + r3(T), '#cfd8e0');
  // axes
  const o = P({ x: bx0, y: by0 }, 0), axl = span * 0.18; const ax = P({ x: bx0 + axl, y: by0 }, 0), ay = P({ x: bx0, y: by0 + axl }, 0), az = P({ x: bx0, y: by0 }, axl);
  line(o, ax, '#ff5a5a', 2); line(o, ay, '#35c46f', 2); line(o, az, '#2f8cff', 2); ctx.font = 'bold 11px Arial'; ctx.fillStyle = '#ff5a5a'; ctx.fillText('X', ax.x + 3, ax.y); ctx.fillStyle = '#35c46f'; ctx.fillText('Y', ay.x + 3, ay.y); ctx.fillStyle = '#2f8cff'; ctx.fillText('Z', az.x + 3, az.y);
};
// orbit / zoom interaction for a canvas (one set of window listeners for all canvases)
let drag3 = null;
window.addEventListener('mousemove', e => { if (!drag3 || !drag3.cv.isConnected) return; st.yaw = drag3.yaw + (e.clientX - drag3.x) * 0.01; st.pitch = Math.max(0.05, Math.min(1.55, drag3.pitch + (e.clientY - drag3.y) * 0.01)); App.render3D(drag3.cv, drag3.get()); });
window.addEventListener('mouseup', () => { drag3 = null; });
App.bind3D = function (cv, get) {
  if (!cv) return;
  cv.onmousedown = (e) => { drag3 = { cv, get, x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch }; e.preventDefault(); };
  cv.onwheel = (e) => { e.preventDefault(); st.zoom = Math.max(0.3, Math.min(6, st.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); App.render3D(cv, get()); };
  cv.ondblclick = () => { st.yaw = -0.75; st.pitch = 0.62; st.zoom = 1; App.render3D(cv, get()); };
};
App.view3dState = st;
App.taper3DControls = function (prefix) {
  return `<div class="row" style="gap:4px"><span class="note">Wire position</span><input type="range" min="0" max="1000" value="${Math.round(st.t * 1000)}" data-3d="t" style="flex:1"><button class="btn" data-3d="iso" title="3D view">3D</button><button class="btn" data-3d="front" title="Side view">Side</button><button class="btn" data-3d="topv" title="Look from top">Top</button>${prefix === 'panel' ? '<button class="btn" data-3d="big" title="Bigger view">⤢</button>' : ''}</div>`;
};
App.bind3DControls = function (root, cv, getJob) {
  root.querySelectorAll('[data-3d]').forEach(el => {
    const k = el.dataset['3d'];
    if (k === 't') el.oninput = () => { st.t = el.value / 1000; App.render3D(cv, getJob()); };
    else el.onclick = () => {
      if (k === 'iso') { st.yaw = -0.75; st.pitch = 0.62; } if (k === 'front') { st.yaw = 0; st.pitch = 0.05; } if (k === 'topv') { st.yaw = 0; st.pitch = 1.55; }
      if (k === 'big') { App.open3DBig(getJob); return; }
      App.render3D(cv, getJob());
    };
  });
};
App.open3DBig = function (getJob) {
  const j = getJob(); const info = App.taperInfo(j);
  App.modal('Taper 3D view – ' + esc(j.name), `<canvas id="big3d" style="width:100%;height:56vh;display:block;border-radius:8px;cursor:grab"></canvas>${App.taper3DControls('big')}
    <div class="note">Drag = turn the view, wheel = zoom, double-click = reset. <span style="color:#8fc8ff">Blue = bottom (XY)</span>, <span style="color:#ff8ae0">pink = top (UV)</span>, yellow = wire.</div>
    ${info.error ? '' : `<div class="kv" style="margin-top:6px"><span>Bottom face</span><span>${info.bottom}</span><span>Top face</span><span>${info.top}</span><span>Thickness</span><span>${r3(info.T)} mm</span></div>`}`, [{ label: 'Close', value: true, cls: 'pri' }]);
  setTimeout(() => { const cv = document.getElementById('big3d'); App.bind3D(cv, getJob); App.bind3DControls(document.getElementById('mbody'), cv, getJob); App.render3D(cv, getJob()); }, 30);
};
})();
