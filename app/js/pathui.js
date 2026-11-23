/* WireCAM – WIRE PATH mode
   Flow per cut:  1 start point → 2 lead-in (X/Y offset or pick point) → 3 path: choose the first line (= direction),
   choose at every junction → 4 offset LEFT / RIGHT / NONE → 5 passes (purpose + offset each) → 6 finish → 7 taper */
(function () {
'use strict';
const { V } = WC; const { S, $, $$, esc, r3, num, toast, hint, cfg } = App;
const D2R = Math.PI / 180;
const PURPOSES = ['Rough cut', 'Second cut', 'Semi-finish', 'Finish', 'Skim / polish', 'Taper cut', 'Test cut'];

function newJob() {
  const n = S.jobs.length + 1;
  return { id: Date.now() + Math.random(), name: 'Cut ' + n, color: App.JOB_COLORS[(n - 1) % App.JOB_COLORS.length], enabled: true, ordered: true,
    start: null, leadPt: null, entry: null, lead: { dx: 0, dy: 0 }, leadOut: { dx: 0, dy: -3 }, segs: null, closed: false, kind: null, side: null, dir: 'fwd',
    passes: [{ d: 0.1, purpose: 'Rough cut', e: '' }], offStart: null, breaks: [], endMode: 'start', end: null, slug: 'end', slugDist: 1, overcut: 0,
    taper: { mode: 'none', angle: 1, top: 'bigger', thick: 20, W: 0, Z: cfg.taperZ, B: 0, swap: false, topSegs: null, topEntry: null, topClosed: false } };
}
const job = () => S.jobs[S.cur] || null;
App.curJob = job;
const sideOf = (j) => j.side === 'left' ? 'L' : j.side === 'right' ? 'R' : null;
function deriveKind(j) {
  if (!j.segs || !j.segs.length) { j.kind = null; return; }
  const sd = sideOf(j);
  if (!j.closed || !sd) { j.kind = 'open'; return; }
  j.kind = WC.interiorSide(j.segs) === sd ? 'hole' : 'part';
}
App.jobReady = (j) => !!(j && j.start && j.entry && j.segs && j.segs.length && j.side && !(j.endMode === 'point' && !j.end));
App.jobMissing = (j) => !j.start ? 'start point missing' : !j.entry ? 'lead-in missing' : !(j.segs && j.segs.length) ? 'path not chosen' : !j.side ? 'offset side not chosen' : (j.endMode === 'point' && !j.end) ? 'lead-out point not set' : '';
function normaliseOld(j) { // projects saved by v1
  if (j.ordered) return;
  if (j.segs) { j.segs = WC.jobPath(Object.assign({}, j, { dir: j.dir })); j.entry = j.segs[0].p0; }
  j.ordered = true; j.side = j.side === 'auto' ? (WC.jobSide(j, j.segs) === 'L' ? 'left' : WC.jobSide(j, j.segs) === 'R' ? 'right' : 'none') : j.side;
  (j.passes || []).forEach((p, i) => { if (!p.purpose) p.purpose = i ? 'Finish' : 'Rough cut'; });
  if (j.start && j.entry) j.lead = { dx: j.entry.x - j.start.x, dy: j.entry.y - j.start.y };
  deriveKind(j);
}

// ------------------------------------------------------------------ path chaining from the lead-in end
function startPathChoice(j) {
  App.chainCancel();
  const ch = WC.Chainer.fromPoint(App.visibleEnts(), j.entry, Math.max(cfg.joinTol, 0.005));
  if (ch.error) { toast('The lead-in end point is not on the drawing. Choose a point ON a line or arc.', 'e', 5000); S.pick = 'entry'; refresh(); return; }
  S.chain = { ch, target: 'path' }; S.pick = 'path'; continueChain();
}
function continueChain() {
  const c = S.chain; if (!c) return; const r = c.ch.run(cfg.autoStraight);
  if (r.state === 'junction') { S.junction = r; showJunction(); }
  else { S.junction = null; hideJunction(); finishChain(); }
  refresh();
}
function finishChain() {
  const c = S.chain; if (!c) return; const j = job(); const segs = WC.mergeCollinear(c.ch.segs);
  if (!segs.length) { S.chain = null; toast('No line leaves the lead-in point. Pick another lead-in point.', 'e'); S.pick = 'entry'; return; }
  App.pushUndo();
  if (c.target === 'path') {
    const closed = c.ch.closed;
    if (closed) segs[segs.length - 1].p1 = V.copy(segs[0].p0);
    j.segs = segs; j.closed = closed; j.offStart = null; j.breaks = []; deriveKind(j); S.pick = null;
    toast((closed ? 'Closed path' : 'OPEN path (ends at a free end)') + ' – ' + segs.length + ' items, ' + r3(WC.pathLen(segs)) + ' mm', closed ? 'o' : 'w');
  } else {
    const closed = c.ch.closed || WC.pathIsClosed(segs, cfg.joinTol * 2);
    if (closed) segs[segs.length - 1].p1 = V.copy(segs[0].p0);
    j.taper.topSegs = segs; j.taper.topClosed = closed; j.taper.topEntry = null; S.pick = null;
    if (closed !== j.closed) toast('TOP shape must be ' + (j.closed ? 'closed' : 'open') + ' like the bottom path', 'w'); else toast('TOP shape selected – ' + segs.length + ' items', 'o');
  }
  S.chain = null; App.markChanged();
}
function topChainStart(ent) { const ch = new WC.Chainer(App.visibleEnts(), ent, cfg.joinTol); S.chain = { ch, target: 'top' }; continueChain(); }
function showJunction() {
  const b = $('#junctionBox'); const r = S.junction; const first = S.chain.target === 'path' && S.chain.ch.segs.length === 0;
  b.innerHTML = first
    ? `<h4>➜ Which way? (sets the direction)</h4><div>From the lead-in point the wire can go <b>${r.cands.length}</b> ways. Click the line/arc the wire should cut FIRST (or press ${r.cands.map((_, i) => i + 1).join(' / ')}).</div>
       <div class="btnrow row"><button class="btn danger" data-j="cancel">Cancel</button></div>`
    : `<h4>⚠ Junction – which way?</h4><div>The path splits here into <b>${r.cands.length}</b> ways. Click the line/arc to follow (or press ${r.cands.map((_, i) => i + 1).join(' / ')}).</div>
       <div class="btnrow row"><button class="btn" data-j="stop">Stop here (open end)</button><button class="btn" data-j="back">Undo last item</button><button class="btn danger" data-j="cancel">Cancel</button></div>
       <label class="chk note"><input type="checkbox" data-j="auto" ${cfg.autoStraight ? 'checked' : ''}> Next time go straight automatically</label>`;
  b.classList.remove('hidden');
  b.querySelectorAll('[data-j]').forEach(el => { const a = el.dataset.j; if (a === 'auto') el.onchange = () => { cfg.autoStraight = el.checked; App.saveCfg(); }; else el.onclick = () => { if (a === 'stop') { S.chain.ch.stopHere(); continueChain(); } if (a === 'back') { S.chain.ch.undoLast(); continueChain(); } if (a === 'cancel') App.chainCancel(); }; });
}
function hideJunction() { $('#junctionBox').classList.add('hidden'); }
App.chainCancel = () => { S.chain = null; S.junction = null; hideJunction(); if (S.pick === 'path' || S.pick === 'topShape') S.pick = null; refresh(); };
function chooseCand(i) { const r = S.junction; if (!r || i < 0 || i >= r.cands.length) return; S.chain.ch.choose(r.cands[i]); S.junction = null; continueChain(); }
function candEntList() { const ch = S.chain.ch; return S.junction.cands.map(id => (ch.ents || []).find(e => e.id === id) || S.ents.find(e => e.id === id)).filter(Boolean); }

// ------------------------------------------------------------------ start / lead-in
function onDrawing(p) { const n = WC.nearestOnEnts(App.visibleEnts(), p, 12 / S.view.scale); return n; }
function setStart(j, p) {
  App.pushUndo(); j.start = V.copy(p);
  if (j.entry) j.lead = { dx: j.entry.x - j.start.x, dy: j.entry.y - j.start.y };
  S.pick = j.entry ? null : 'entry'; App.markChanged();
}
function pathEnd(j) { if (!j.segs || !j.segs.length) return null; const e = WC.jobEffective(j).segs; return e.length ? e[e.length - 1].p1 : j.segs[j.segs.length - 1].p1; }
App.progOrigin = () => { const j = S.jobs.find(x => x.enabled !== false && x.start && (x.leadPt || x.entry)); return j ? { pt: j.leadPt || j.entry, job: j } : null; };
function hasStop(j) { return !!(j.breaks || []).find(b => b.type === 'stop'); }
async function addBreak(j, p) {
  const full = WC.jobPath(j); const n = WC.pathNearest(full, p); const L = WC.pathLen(full);
  if (n.d > 14 / S.view.scale) return toast('Click ON the wire path (the coloured line)', 'w');
  if (n.s < 1e-3 || n.s > L - 1e-3) return toast('Choose a point away from the lead-in point', 'w');
  const ans = await App.modal('Break point', `<p>Break point at <b>${r3(n.s)} mm</b> along the path (X ${r3(n.pt.x)} Y ${r3(n.pt.y)}). What should happen here?</p>
    <ul><li><b>HOLD (M0)</b> – the machine stops and waits. The operator presses RUN and the cut continues.</li>
    <li><b>STOP here</b> – the program cuts only up to this point (the rest is already machined). Then choose where the wire goes.</li></ul>`,
    [{ label: 'Cancel', value: null }, { label: '⏸ HOLD here (M0)', value: 'hold', cls: 'pri' }, { label: '■ STOP – wire stays here', value: 'stay' }, { label: '■ STOP – lead-out to a point…', value: 'point' }, { label: '■ STOP – back to start', value: 'start' }]);
  if (!ans) return;
  App.pushUndo(); j.breaks = j.breaks || [];
  if (ans === 'hold') j.breaks.push({ pt: n.pt, type: 'hold', every: false });
  else { j.breaks.forEach(b => { if (b.type === 'stop') b.type = 'hold'; }); j.breaks.push({ pt: n.pt, type: 'stop' }); j.endMode = ans; if (ans === 'point') { j.end = null; S.pick = 'end'; } }
  App.markChanged();
}
// lead-in point: ANY point. If it lies on the drawing the path starts there, otherwise the user picks where the wire joins the shape.
function setLeadPoint(j, p, typed) {
  App.pushUndo(); j.leadPt = V.copy(p); j.lead = { dx: p.x - j.start.x, dy: p.y - j.start.y };
  j.segs = null; j.closed = false; j.offStart = null; j.entry = null; deriveKind(j);
  const n = onDrawing(p); const tol = typed ? Math.max(cfg.joinTol * 2, 0.002) : 14 / S.view.scale;
  const snappedOn = !typed && S.mouse.snap && ['END', 'MID', 'INTER', 'QUAD', 'ON'].includes(S.mouse.snap.kind);
  App.markChanged();
  if (n && (n.d <= (typed ? tol : 1e-6) || snappedOn)) { j.leadPt = n.d <= 1e-6 ? j.leadPt : n.pt; j.entry = V.copy(j.leadPt); j.lead = { dx: j.leadPt.x - j.start.x, dy: j.leadPt.y - j.start.y }; startPathChoice(j); return; }
  S.pick = 'join'; refresh(); toast('Lead-in point set. Now click where the wire should JOIN the shape (or "Square to nearest line").', 'o', 5000);
}
function setJoin(j, p, strict) {
  const n = onDrawing(p); const tol = strict ? Math.max(cfg.joinTol * 2, 0.01) : 14 / S.view.scale;
  if (!n || n.d > tol) { toast('The join point must be ON a line or arc of the shape' + (n ? ' (nearest is ' + r3(n.d) + ' mm away)' : '') + '.', 'e', 5000); return false; }
  App.pushUndo(); j.entry = n.d <= 1e-6 ? V.copy(p) : n.pt; j.segs = null; j.closed = false; j.offStart = null; deriveKind(j); App.markChanged(); startPathChoice(j); return true;
}
function squareJoin(j) { const from = j.leadPt || j.start; const n = WC.nearestOnEnts(App.visibleEnts(), from, 0.05); if (!n) return toast('Drawing is empty', 'w'); setJoin(j, n.pt, true); }
function setLeadOutPoint(j, p) { App.pushUndo(); j.end = V.copy(p); j.endMode = 'point'; const pe = pathEnd(j); if (pe) j.leadOut = { dx: p.x - pe.x, dy: p.y - pe.y }; S.pick = null; App.markChanged(); }

// ------------------------------------------------------------------ path-mode handlers
const H = App.pathHandlers = {
  click(p, sx, sy) {
    const j = job(); if (!j) return;
    if (S.junction) { const e = App.pickEnt(sx, sy, 16, candEntList()); if (e) chooseCand(S.junction.cands.indexOf(e.id)); else toast('Click one of the numbered coloured lines', 'w'); return; }
    if (S.pick === 'topShape') { const e = App.pickEnt(sx, sy, 10); if (!e) return toast('Click exactly on a line or arc of the TOP shape', 'w'); topChainStart(e); return; }
    const snapped = S.mouse.snap && S.mouse.snap.kind && S.mouse.snap.kind !== 'ON' && S.mouse.snap.kind !== 'GRID';
    const nice = (q) => snapped ? V.copy(q) : { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 };
    if (S.pick === 'start') { setStart(j, nice(p)); return; }
    if (S.pick === 'entry') { setLeadPoint(j, nice(p), false); return; }
    if (S.pick === 'join') { setJoin(j, snapped ? p : { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }, false); return; }
    if (S.pick === 'break') { S.pick = null; addBreak(j, p); refresh(); return; }
    if (S.pick === 'offStart') { const n = WC.pathNearest(j.segs, S.mouse.raw); App.pushUndo(); j.offStart = n.pt; S.pick = null; App.markChanged(); return; }
    if (S.pick === 'end') { setLeadOutPoint(j, nice(p)); return; }
    const k = S.jobs.findIndex(x => x.segs && WC.pathNearest(x.segs, S.mouse.raw).d < 10 / S.view.scale); if (k >= 0 && k !== S.cur) { S.cur = k; refresh(); }
  },
  right() { if (S.junction && S.chain && S.chain.ch.segs.length) { S.chain.ch.stopHere(); continueChain(); return; } if (S.chain) { App.chainCancel(); return; } if (S.pick) { S.pick = null; refresh(); } },
  escape() { if (S.chain) { App.chainCancel(); return; } if (S.pick) { S.pick = null; refresh(); } },
  typed(str) {
    const j = job(); if (!j) return false;
    if (S.pick === 'start' || (!S.pick && !j.start)) { const v = App.parseTyped(str, null); if (!v || v.kind !== 'point') return false; setStart(j, v.p); return true; }
    if (S.pick === 'entry' || (!S.pick && j.start && !j.leadPt && !j.entry)) { const v = App.parseTyped(str.replace(/^@/, ''), null); if (!v || v.kind !== 'point') return false; setLeadPoint(j, V.add(j.start, v.p), true); return true; }
    if (S.pick === 'join') { const v = App.parseTyped(str.replace(/^@/, ''), null); if (!v || v.kind !== 'point') return false; setJoin(j, V.add(j.leadPt || j.start, v.p), true); return true; }
    if (S.pick === 'end') { const v = App.parseTyped(str.replace(/^@/, ''), null); const pe = pathEnd(j); if (!v || v.kind !== 'point' || !pe) return false; setLeadOutPoint(j, V.add(pe, v.p)); return true; }
    return false;
  },
  key(e) { if (S.junction && /^[1-9]$/.test(e.key)) { chooseCand(+e.key - 1); return true; } return false; },
  hover(sx, sy) {
    S.hover = null;
    if (S.junction) { const e = App.pickEnt(sx, sy, 16, candEntList()); S.hover = e ? e.id : null; return; }
    if (S.pick === 'topShape') { const e = App.pickEnt(sx, sy, 10); S.hover = e ? e.id : null; }
  },
  wantsSnap() { return S.pick === 'start' || S.pick === 'end' || S.pick === 'entry' || S.pick === 'join' || S.pick === 'break'; },
  draw() { drawJobs(); },
};

// ------------------------------------------------------------------ drawing
function sideTicks(segs, side, color) {
  const L = WC.pathLen(segs); if (L <= 0 || !side) return; const n = Math.max(2, Math.min(300, Math.floor(L * S.view.scale / 55))); const c = App.ctx; c.strokeStyle = color; c.lineWidth = 2; c.beginPath();
  for (let k = 0; k < n; k++) { const r = WC.pathPointAtDist(segs, (k + 0.5) * L / n); let nn = V.perpL(WC.segTan(segs[r.i], r.t)); if (side === 'R') nn = V.mul(nn, -1); const a = App.w2s(r.pt); c.moveTo(a.x + nn.x * 3, a.y - nn.y * 3); c.lineTo(a.x + nn.x * 13, a.y - nn.y * 13); }
  c.stroke();
}
function startMarker(p, color, text) { const a = App.w2s(p); const c = App.ctx; c.strokeStyle = color; c.lineWidth = 2; c.beginPath(); c.arc(a.x, a.y, 8, 0, 7); c.moveTo(a.x - 12, a.y); c.lineTo(a.x + 12, a.y); c.moveTo(a.x, a.y - 12); c.lineTo(a.x, a.y + 12); c.stroke(); App.label(p, text, '#fff', 11, -11, color); }
function drawOrigin(p) {
  const c = App.ctx; const a = App.w2s(p); c.lineWidth = 2;
  c.strokeStyle = '#ff5a5a'; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(a.x + 42, a.y); c.stroke(); App.drawArrow(App.s2w(a.x + 42, a.y), { x: 1, y: 0 }, '#ff5a5a', 7);
  c.strokeStyle = '#35c46f'; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(a.x, a.y - 42); c.stroke(); App.drawArrow(App.s2w(a.x, a.y - 42), { x: 0, y: 1 }, '#35c46f', 7);
  c.font = 'bold 11px Arial'; c.fillStyle = '#ff5a5a'; c.fillText('X', a.x + 48, a.y + 4); c.fillStyle = '#35c46f'; c.fillText('Y', a.x - 3, a.y - 50);
  c.fillStyle = '#fff'; c.beginPath(); c.arc(a.x, a.y, 5, 0, 7); c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke();
  App.label(p, 'X0 Y0 = PROGRAM ZERO', '#000', -150, 24, '#ffe14d');
}
function drawJobs() {
  const c = App.ctx;
  S.jobs.forEach((j, k) => {
    const cur = k === S.cur; c.globalAlpha = cur ? 1 : 0.45;
    const eff = j.segs && j.segs.length ? WC.jobEffective(j) : null; const segs = eff ? eff.segs : null;
    if (eff && eff.stop) { const rest = WC.pathSplitAtDist(eff.full, eff.stop.s)[1]; App.strokePath(rest, 'rgba(160,170,180,.55)', 2, [3, 5]); if (cur && rest.length) App.label(WC.segPoint(rest[Math.floor(rest.length / 2)], 0.5), 'not cut', '#aab', 6, 14); }
    if (segs) {
      const tm = j.taper && j.taper.mode; const sd = sideOf(j);
      if (tm && tm !== 'none') { try { const g = WC.taperSurfaces(j); if (!g.error) { App.strokePath(g.top, '#ff5ad1', 1.6, [7, 5]); if (cur && g.top.length) App.label(g.top[0].p0, 'TOP face', '#ff5ad1'); if (g.W > 0) { App.strokePath(g.bottom, '#8fc8ff', 1.3, [3, 4]); if (cur) App.label(g.bottom[0].p0, 'BOTTOM face', '#8fc8ff', 8, 16); } } } catch (e) { } }
      if (sd && cur) {
        const d = j.passes[0] ? j.passes[0].d : 0.1;
        const off = WC.offsetPath(segs, sd === 'L' ? d : -d, eff.closed, 'round').segs; const kerf = Math.max(1, cfg.wireDia * S.view.scale);
        App.strokePath(off, 'rgba(255,150,40,.35)', kerf); App.strokePath(off, '#ff9628', 1.2); sideTicks(segs, sd, 'rgba(255,150,40,.9)');
      }
      App.strokePath(segs, j.color, cur ? 3 : 2); App.pathArrows(segs, j.color, 110);
      const last = segs[segs.length - 1].p1;
      if (j.endMode === 'point' && j.end) { App.strokePath([WC.segL(last, j.end)], '#ff8f8f', 1.8, [6, 4]); App.drawArrow(V.lerp(last, j.end, 0.6), V.unit(V.sub(j.end, last)), '#ff8f8f', 7); }
      else if (j.endMode === 'stay') { App.dot(last, 8, '#ff5a5a', true); if (!eff.stop) App.label(last, 'END ' + (k + 1) + ' (wire stays)', '#fff', 10, 14, '#a33'); }
      else if (j.start && !(eff.closed && V.dist(last, segs[0].p0) < 1e-6)) App.strokePath([WC.segL(last, j.start)], '#ff8f8f', 1.8, [6, 4]);
      if (eff.stop) { const a = App.w2s(eff.stop.pt || last); c.fillStyle = '#ff5a5a'; c.fillRect(a.x - 7, a.y - 7, 14, 14); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.strokeRect(a.x - 7, a.y - 7, 14, 14); App.label(last, 'STOP – program ends here', '#fff', 12, -10, '#a33'); }
      eff.holds.forEach(h => { const q = WC.pathPointAtDist(eff.full, h.s).pt; App.dot(q, 7, '#ffb020'); App.label(q, '⏸ M0 HOLD' + (h.every ? ' (every pass)' : ''), '#000', 10, -8, '#ffb020'); });
      if (cur && j.offStart) { App.dot(j.offStart, 6, '#ffe14d'); App.label(j.offStart, 'offset ON', '#ffe14d'); }
      if (cur && j.slug === 'before' && eff.closed && j.slugDist > 0) { const L = WC.pathLen(segs); if (j.slugDist < L) { const r = WC.pathPointAtDist(segs, L - j.slugDist); App.dot(r.pt, 6, '#ff8f6b'); App.label(r.pt, 'STOP M0', '#ff8f6b'); } }
      if (j.endMode === 'point' && j.end) { App.dot(j.end, 7, '#ff5a5a', true); App.label(j.end, 'END ' + (k + 1), '#fff', -52, 18, '#a33'); }
    }
    if (j.start && (j.leadPt || j.entry)) {
      const pts = [j.start]; if (j.leadPt && V.dist(j.leadPt, j.start) > 1e-9 && (!j.entry || V.dist(j.leadPt, j.entry) > 1e-9)) pts.push(j.leadPt); if (j.entry) pts.push(j.entry);
      for (let q = 1; q < pts.length; q++) { App.strokePath([WC.segL(pts[q - 1], pts[q])], '#ffffff', 1.8, [6, 4]); if (V.dist(pts[q - 1], pts[q]) > 1e-9) App.drawArrow(V.lerp(pts[q - 1], pts[q], 0.6), V.unit(V.sub(pts[q], pts[q - 1])), '#fff', 7); }
      if (j.leadPt && (!j.entry || V.dist(j.leadPt, j.entry) > 1e-9)) { App.dot(j.leadPt, 5, '#fff'); if (cur) App.label(j.leadPt, 'lead-in point', '#fff', 10, 4); }
      if (j.entry) App.dot(j.entry, 6, '#2f8cff');
    }
    if (j.start) startMarker(j.start, j.color, 'START ' + (k + 1));
    c.globalAlpha = 1;
    const O = App.progOrigin(); if (O && O.job === j) drawOrigin(O.pt);
  });
  if (S.chain) {
    if (S.chain.ch.segs.length) App.strokePath(S.chain.ch.segs, '#ffe14d', 4);
    if (S.junction) {
      const cols = ['#ff5a5a', '#35c46f', '#2f8cff', '#d36cff', '#20d0d0', '#ff8f3a', '#fff'];
      S.junction.cands.forEach((id, i) => { const s = S.chain.ch.candSeg(id); const col = cols[i % cols.length]; App.strokePath([s], col, S.hover === id ? 7 : 4.5); const L = WC.segLen(s); const dpx = 46 / S.view.scale; const m = L > dpx * 1.2 ? WC.segPoint(s, dpx / L) : V.add(S.junction.p, V.mul(WC.segTan(s, 0), dpx)); App.drawArrow(WC.segPoint(s, Math.min(0.85, Math.max(0.3, (dpx * 1.6) / Math.max(L, 1e-9)))), WC.segTan(s, Math.min(0.85, Math.max(0.3, (dpx * 1.6) / Math.max(L, 1e-9)))), col, 11); App.label(m, ' ' + (i + 1) + ' ', '#000', -9, 6, col); });
      App.dot(S.junction.p, 5, '#ffb020', true);
    }
  }
  const j = job();
  if (j && S.mouse.inside) {
    if (S.pick === 'entry' && j.start) { const q = S.mouse.w; App.strokePath([WC.segL(j.start, q)], 'rgba(255,255,255,.8)', 1.5, [5, 4]); App.dot(q, 6, '#fff', true); App.label(q, 'dX ' + r3(q.x - j.start.x) + '  dY ' + r3(q.y - j.start.y) + '  L ' + r3(V.dist(j.start, q)), '#fff'); }
    if (S.pick === 'end' && j.segs) { const pe = pathEnd(j), q = S.mouse.w; App.strokePath([WC.segL(pe, q)], 'rgba(255,143,143,.9)', 1.5, [5, 4]); App.dot(q, 6, '#ff8f8f', true); App.label(q, 'dX ' + r3(q.x - pe.x) + '  dY ' + r3(q.y - pe.y) + '  L ' + r3(V.dist(pe, q)), '#ffb3b3'); }
    if (S.pick === 'join' && j.leadPt) { const from = j.leadPt; const q = S.mouse.w; const n = onDrawing(q); const ok = n && n.d <= 14 / S.view.scale; const end = ok ? n.pt : q; App.strokePath([WC.segL(from, end)], ok ? 'rgba(53,196,111,.9)' : 'rgba(255,90,90,.8)', 1.5, [5, 4]); App.dot(end, 6, ok ? '#35c46f' : '#ff5a5a', true); App.label(end, ok ? 'join here  L ' + r3(V.dist(from, end)) : 'not on the shape', ok ? '#9ff0bf' : '#ffb3b3'); }
    if (S.pick === 'break' && j.segs) { const full = WC.jobPath(j); const n = WC.pathNearest(full, S.mouse.w); const ok = n.d <= 14 / S.view.scale; App.dot(ok ? n.pt : S.mouse.w, 8, ok ? '#ffb020' : '#ff5a5a', true); App.label(ok ? n.pt : S.mouse.w, ok ? 'break here – ' + r3(n.s) + ' mm along the path' : 'not on the path', ok ? '#ffd98a' : '#ffb3b3'); }
    if (S.pick === 'offStart' && j.segs) { const n = WC.pathNearest(j.segs, S.mouse.raw); App.dot(n.pt, 7, '#ffe14d', true); }
  }
}

// ------------------------------------------------------------------ jobs
function addJob() { App.pushUndo(); App.chainCancel(); S.jobs.push(newJob()); S.cur = S.jobs.length - 1; S.pick = 'start'; App.markChanged(); }
App.addJob = addJob;
App.startNewPath = () => { const j = job(); if (!j || j.start) addJob(); else { S.pick = 'start'; refresh(); } toast('First click the START point (wire threading hole)', 'o'); };

// ------------------------------------------------------------------ panel
function nextHint(j) {
  if (!j) return 'Press "+ New cut" to make a wire path.';
  if (S.junction) return S.chain && S.chain.target === 'path' && !S.chain.ch.segs.length ? 'Click the FIRST line the wire should cut – this sets the direction (or press 1, 2…).' : 'JUNCTION: click which way the wire should go (or press 1, 2…).';
  if (S.pick === 'start') return 'STEP 1: Click the START point (wire threading hole) – or type x,y and Enter. Circle centres and corners snap.';
  if (S.pick === 'entry') return 'STEP 2: Click the LEAD-IN point (anywhere) – or type it as dX,dY from the start point (e.g. -5,0) and Enter.';
  if (S.pick === 'join') return 'Click where the wire should JOIN the shape (on a line/arc) – or type dX,dY from the lead-in point.';
  if (S.pick === 'topShape') return 'Click on the TOP shape (for different top/bottom taper).';
  if (S.pick === 'break') return 'Click a point ON the path for the BREAK point (corners, middles and crossings snap).';
  if (S.pick === 'offStart') return 'Click the point on the path where the wire OFFSET should switch ON.';
  if (S.pick === 'end') return 'Click the LEAD-OUT end point (anywhere) – or type it as dX,dY from the path end (e.g. 0,-3).';
  if (!j.start) return 'STEP 1: press "Click start point" and click the wire threading hole.';
  if (!j.leadPt && !j.entry) return 'STEP 2: set the lead-in point (X/Y offset or click any point).';
  if (!j.entry) return 'STEP 2: choose where the wire joins the shape.';
  if (!j.segs) return 'STEP 3: choose the first line from the lead-in point.';
  if (!j.side) return 'STEP 4: choose wire offset LEFT, RIGHT or NO offset.';
  return '✔ Path ready. Check passes and finish, then press MAKE PROGRAM.';
}
function effClosed(j) { return !!j.closed && !hasStop(j); }
function passMode(j) { const c = effClosed(j); let m = j.passMode || (c ? 'loop' : 'reverse'); if (c && m === 'reverse') m = 'loop'; if (!c && m === 'loop') m = 'reverse'; return m; }
function passModeHTML(j) {
  const c = effClosed(j); const m = passMode(j); const G = j.side === 'left' ? 'G41' : j.side === 'right' ? 'G42' : 'G41'; const Gf = G === 'G41' ? 'G42' : 'G41';
  const seq = j.passes.map((p, i) => { const rev = !c && m === 'reverse' && i % 2 === 1; return `<span class="pill ${rev ? 'y' : 'g'}">${i + 1}: ${rev ? '⬅ back' : '➜'} D${p.d}${j.side && j.side !== 'none' ? ' ' + (rev ? Gf : G) : ''}</span>`; }).join(' ');
  const opts = c
    ? `${opt2(m, 'loop', '<span class="big">↻</span><b>Continue around the loop</b><small>no new lead-in; next pass starts at the path start</small>', 'data-k="pmode"')}${opt2(m, 'restart', '<span class="big">↩</span><b>Back to start point</b><small>along the lead-in, then lead in again</small>', 'data-k="pmode"')}`
    : `${opt2(m, 'reverse', '<span class="big">⇄</span><b>Back on the same path</b><small>backward, side swapped ' + G + '⇄' + Gf + '</small>', 'data-k="pmode"')}${opt2(m, 'restart', '<span class="big">↩</span><b>Straight back to start</b><small>then same direction again</small>', 'data-k="pmode"')}`;
  let endTxt = '';
  if (!c && m === 'reverse') endTxt = j.passes.length % 2 === 0 ? 'After the last pass the wire is back at the START of the path.' : 'After the last pass the wire is at the END of the path.';
  if (c) endTxt = 'After the last pass the wire is at the start of the path (lead-in end).';
  return `<div style="border-top:1px solid var(--line);margin-top:6px;padding-top:6px"><b>Between passes</b> <span class="note">(${c ? 'closed loop' : 'open path'})</span>
    <div class="choice two" style="margin-top:4px">${opts}</div>
    <div class="row" style="margin-top:6px">${seq}</div>
    <div class="note">${endTxt}${!c && m === 'restart' ? ' <span style="color:var(--warn)">The straight way back must be free (it can cross the job).</span>' : ''}${!c && m === 'reverse' ? ' Going backward the wire stays on the same side of the line, so the program swaps ' + G + ' and ' + Gf + '.' : ''}</div></div>`;
}
function leadOutHTML(j, pe) { return `<div class="choice">${opt2(j.endMode || 'start', 'start', '<span class="big">↩</span><b>Back to start</b><small>' + (j.closed && !hasStop(j) ? 'along the lead-in' : 'straight line') + '</small>', 'data-k="endmode"')}${opt2(j.endMode, 'stay', '<span class="big">■</span><b>Wire stays</b><small>at the path end, no lead-out</small>', 'data-k="endmode"')}${opt2(j.endMode, 'point', '<span class="big">↘</span><b>Other point</b><small>lead-out of your choice</small>', 'data-k="endmode"')}</div>
${j.endMode === 'point' ? `<div class="row"><span class="lbl">Offset dX / dY</span><input class="fld" data-f="lodx" value="${r3(j.leadOut ? j.leadOut.dx : 0)}"><input class="fld" data-f="lody" value="${r3(j.leadOut ? j.leadOut.dy : 0)}"><button class="btn pri" data-a="applyLeadOut">Apply</button></div>
        <div class="note">dX / dY measured from the path end point (X ${r3(pe.x)} Y ${r3(pe.y)}).</div>
        <div class="row"><button class="btn ${S.pick === 'end' ? 'on' : ''}" data-a="pickEnd">👆 Pick lead-out point</button></div>
        ${j.end ? `<div class="row"><span class="lbl">End X / Y</span><input class="fld" data-f="ex" value="${r3(j.end.x)}"><input class="fld" data-f="ey" value="${r3(j.end.y)}"></div>` : '<div class="note warn">Lead-out point not set yet.</div>'}` : ''}`; }
function breakHTML(j) {
  const full = WC.jobPath(j); const L = WC.pathLen(full);
  const rows = (j.breaks || []).map((b, i) => { const sd = WC.pathNearest(full, b.pt).s; return `<div class="layer" style="flex-wrap:wrap"><b style="color:${b.type === 'stop' ? '#ff5a5a' : '#ffb020'}">${b.type === 'stop' ? '■ STOP' : '⏸ HOLD M0'}</b><span class="note">at ${r3(sd)} mm</span>
    <span style="margin-left:auto;display:flex;gap:3px"><button class="btn ${b.type === 'hold' ? 'on' : ''}" data-btype="${i}" data-v="hold" title="Machine waits, then continues">Hold</button><button class="btn ${b.type === 'stop' ? 'on' : ''}" data-btype="${i}" data-v="stop" title="Program ends here">Stop</button><button class="btn danger" data-bdel="${i}" title="Remove">✕</button></span>
    ${b.type === 'hold' ? `<label class="chk note" style="width:100%"><input type="checkbox" data-bevery="${i}" ${b.every ? 'checked' : ''}> hold on every pass (else only on pass 1)</label>` : ''}</div>`; }).join('');
  const stop = hasStop(j); const pe = pathEnd(j);
  return `<div style="border-top:1px solid var(--line);margin-top:8px;padding-top:6px"><b>Break points</b> <span class="note">(optional)</span>
    <div class="note">Pick any point on the path. <b>HOLD</b> = M0, machine waits for RUN and then continues. <b>STOP</b> = cut only up to this point, then the lead-out.</div>
    ${rows}
    <div class="row"><button class="btn ${S.pick === 'break' ? 'on' : 'pri'}" data-a="pickBreak">＋ Add break point</button></div>
    ${stop ? `<div style="background:#2a1414;border:1px solid #6a2a2a;border-radius:8px;padding:6px;margin-top:4px"><b>After the STOP point the wire goes:</b>${leadOutHTML(j, pe)}</div>` : ''}</div>`;
}
function card(n, key, title, sum, body, st, active) {
  return `<div class="card ${st || ''} ${active ? 'active' : ''}" data-card="${key}"><div class="ch"><span class="num">${st === 'done' ? '✓' : n}</span>${title}<span class="sum">${sum || ''}</span></div><div class="cb">${body}</div></div>`;
}
function opt2(cur, val, html, extra) { return `<div class="opt ${cur === val ? 'on' : ''}" data-set="${val}" ${extra || ''}>${html}</div>`; }
function renderPathPanel() {
  const P = $('#panel-path'); if (S.mode !== 'path') return;
  S.jobs.forEach(normaliseOld);
  const j = job();
  const list = S.jobs.map((x, i) => `<div class="job ${i === S.cur ? 'on' : ''}" data-job="${i}"><span class="dot" style="background:${x.color}"></span><span class="jn">${i + 1}. ${esc(x.name)}</span><span class="js">${App.jobReady(x) ? (x.kind || '').toUpperCase() + ' • ' + x.passes.length + ' pass' + (x.passes.length > 1 ? 'es' : '') : 'not finished'}${x.taper && x.taper.mode !== 'none' ? ' • TAPER' : ''}${x.enabled === false ? ' • OFF' : ''}</span></div>`).join('');
  let html = `<div class="card"><div class="ch">Cuts in this program <span class="sum">${S.jobs.length} cut(s)</span></div><div class="cb"><div class="joblist">${list || '<div class="note">No cuts yet.</div>'}</div>
    <div class="row"><button class="btn pri" data-a="addJob">${ICONS.plus} New cut</button>${j ? `<button class="btn" data-a="up" title="Cut earlier">${ICONS.up}</button><button class="btn" data-a="down" title="Cut later">${ICONS.down}</button><button class="btn danger" data-a="delJob" title="Delete this cut">${ICONS.delete}</button>` : ''}</div>
    ${j ? `<div class="row"><span class="lbl">Name</span><input class="fld wide" style="flex:1" data-f="name" value="${esc(j.name)}"></div><label class="chk note"><input type="checkbox" data-f="enabled" ${j.enabled !== false ? 'checked' : ''}> Include this cut in the program</label>` : ''}</div></div>`;
  if (!j) { P.innerHTML = html; bind(P); hint(nextHint(j)); return; }
  // 1 start
  html += card(1, 'start', 'Start point (wire threading hole)', j.start ? 'X ' + r3(j.start.x) + '  Y ' + r3(j.start.y) : '', `
    <div class="row"><button class="btn ${S.pick === 'start' ? 'on' : 'pri'}" data-a="pickStart">👆 Click start point</button></div>
    <div class="row"><span class="lbl">Start X / Y</span><input class="fld" data-f="sx" value="${j.start ? r3(j.start.x) : ''}"><input class="fld" data-f="sy" value="${j.start ? r3(j.start.y) : ''}"></div>
    <div class="note">Tip: circle centres and corners snap. Program zero <b>X0 Y0</b> will be the <b>lead-in point</b> (next step).</div>
    ${(() => { const O = App.progOrigin(); return O && j.start ? `<div class="note ok">Start point = <b>X ${r3(j.start.x - O.pt.x)}  Y ${r3(j.start.y - O.pt.y)}</b> from program zero.</div>` : ''; })()}`, j.start ? 'done' : 'need', S.pick === 'start' || !j.start);
  // 2 lead-in
  if (j.start) {
    const lp = j.leadPt || j.entry; const joinNeeded = j.leadPt && (!j.entry || V.dist(j.leadPt, j.entry) > 1e-9);
    let total = 0; if (lp) { total = V.dist(j.start, lp); if (j.entry && joinNeeded) total += V.dist(lp, j.entry); }
    html += card(2, 'lead', 'Lead-in', j.entry ? 'length ' + r3(total) + ' mm' : '', `
      <div class="note">Lead-in point = where the wire goes first from the start point. It can be ANY point.</div>
      <div class="row"><span class="lbl">Offset dX / dY</span><input class="fld" data-f="ldx" value="${r3(j.lead.dx)}"><input class="fld" data-f="ldy" value="${r3(j.lead.dy)}"><button class="btn pri" data-a="applyLead">Apply</button></div>
      <div class="row"><button class="btn ${S.pick === 'entry' ? 'on' : ''}" data-a="pickEntry">👆 Pick lead-in point</button><button class="btn" data-a="nearestEntry" title="Lead-in straight and square to the nearest line">⊥ Square to nearest line</button></div>
      ${lp ? `<div class="note">Lead-in point X ${r3(lp.x)} Y ${r3(lp.y)} (drawing)${!joinNeeded && j.entry ? ' – it is on the shape, the path starts here.' : ''}</div>` : ''}
      ${lp ? (() => { const O = App.progOrigin(); return O && O.job === j ? `<div class="msg i" style="margin-top:6px">📍<span>This lead-in point is <b>PROGRAM ZERO X0 Y0</b>. Set the machine zero here. The wire starts at X ${r3(j.start.x - lp.x)} Y ${r3(j.start.y - lp.y)}.</span></div>` : O ? `<div class="note">Program zero is the lead-in point of cut ${S.jobs.indexOf(O.job) + 1}. This lead-in point is X ${r3(lp.x - O.pt.x)} Y ${r3(lp.y - O.pt.y)} from it.</div>` : ''; })() : ''}
      ${joinNeeded ? `<div class="note ${j.entry ? '' : 'warn'}"><b>Join the shape:</b> the lead-in point is not on the shape. From there the wire goes straight to the join point (blue dot).</div>
        <div class="row"><button class="btn ${S.pick === 'join' ? 'on' : (j.entry ? '' : 'pri')}" data-a="pickJoin">👆 Pick join point</button><button class="btn" data-a="squareJoin">⊥ Square to nearest line</button></div>
        ${j.entry ? `<div class="note">Joins at X ${r3(j.entry.x)} Y ${r3(j.entry.y)}.</div>` : ''}` : ''}`, j.entry ? 'done' : 'need', S.pick === 'entry' || S.pick === 'join' || (!!j.start && !j.entry));
  }
  // 3 path
  if (j.entry) {
    const choosing = !!(S.chain && S.chain.target === 'path');
    const ccw = j.segs && j.closed ? WC.orientationCCW(j.segs) : null;
    const sum = j.segs ? (j.closed ? '<span class="pill g">closed</span> ' + (ccw ? '↺ anti-clockwise' : '↻ clockwise') : '<span class="pill y">open</span>') + ' • ' + j.segs.length + ' items' : '';
    html += card(3, 'path', 'Path & direction', sum, `
      ${choosing ? `<div class="note warn">${S.chain.ch.segs.length ? 'Junction: click which way to continue (numbered colours on the drawing).' : 'Click the FIRST line the wire should cut. This sets the direction.'}</div>` : ''}
      <div class="row"><button class="btn ${choosing ? 'on' : 'pri'}" data-a="choosePath">${j.segs ? '↺ Choose path again' : '👆 Choose first line'}</button>${j.segs && j.closed ? `<button class="btn" data-a="reverse" title="Same path, other direction">⇄ Reverse direction</button>` : ''}</div>
      ${j.segs ? `<div class="note">Length ${r3(WC.pathLen(j.segs))} mm. ${j.closed ? 'The path comes back to the lead-in point (loop closed).' : 'OPEN path – it ends at a free end (or where you stopped).'}</div>` : '<div class="note">From the lead-in point you choose the first line. At every junction you choose again.</div>'}
      ${j.segs ? breakHTML(j) : ''}`, j.segs ? 'done' : 'need', choosing || !j.segs);
  }
  if (j.segs) {
    // 4 side
    const inside = j.closed ? WC.interiorSide(j.segs) : null;
    const desc = (sd) => j.closed ? (inside === sd ? 'wire INSIDE the shape<br>(HOLE / die to size)' : 'wire OUTSIDE the shape<br>(PART / punch to size)') : 'of the cutting direction';
    let note = 'Choose on which side of the line the wire runs.';
    if (j.side === 'none') note = 'Wire runs exactly ON the line (D0, no offset).';
    else if (j.side) note = (j.side === 'left' ? 'G41 LEFT' : 'G42 RIGHT') + ': ' + desc(sideOf(j)).replace('<br>', ' ') + '. Orange line = wire centre.';
    html += card(4, 'side', 'Wire offset side', j.side ? ({ left: 'LEFT G41', right: 'RIGHT G42', none: 'no offset' })[j.side] : '', `
      <div class="choice">${opt2(j.side, 'left', '<span class="big">⬅</span><b>LEFT  G41</b><small>' + desc('L') + '</small>', 'data-k="side"')}${opt2(j.side, 'right', '<span class="big">➡</span><b>RIGHT  G42</b><small>' + desc('R') + '</small>', 'data-k="side"')}${opt2(j.side, 'none', '<span class="big">│</span><b>NO offset</b><small>wire on the line</small>', 'data-k="side"')}</div>
      <div class="note ${j.side ? 'ok' : 'warn'}" style="margin-top:6px">${note}</div>
      ${j.side && j.side !== 'none' ? `<div class="row"><span class="lbl">Offset switches on</span><button class="btn ${!j.offStart ? 'on' : ''}" data-a="offEntry">at lead-in end</button><button class="btn ${S.pick === 'offStart' || j.offStart ? 'on' : ''}" data-a="pickOff">at a point…</button></div>${j.offStart ? '<div class="note">Before the yellow point the wire cuts with NO offset (D0).</div>' : ''}` : ''}`, j.side ? 'done' : 'need', !j.side);
    // 5 passes
    const rows = j.passes.map((p, i) => `<tr><td><b>${i + 1}</b></td><td><input class="fld" list="purposeList" data-pp="${i}" value="${esc(p.purpose || '')}" style="width:118px"></td><td><input class="fld" data-pd="${i}" value="${p.d}" style="width:64px"></td><td><input class="fld" data-pe="${i}" value="${esc(p.e || '')}" placeholder="—" style="width:56px"></td><td>${j.passes.length > 1 ? `<button class="btn danger" data-delpass="${i}" title="Remove pass">✕</button>` : ''}</td></tr>`).join('');
    html += card(5, 'passes', 'Passes (cuts on the same path)', j.passes.length + ' pass' + (j.passes.length > 1 ? 'es' : '') + ' • D ' + j.passes.map(p => p.d).join(' / '), `
      <datalist id="purposeList">${PURPOSES.map(x => `<option value="${x}">`).join('')}</datalist>
      <table class="ptable"><tr><td></td><td class="note">Purpose</td><td class="note">Offset D</td><td class="note">E code</td><td></td></tr>${rows}</table>
      <div class="row"><button class="btn" data-a="addPass">${ICONS.plus} Add pass</button>${j.passes.length > 1 ? `<button class="btn" data-a="presetRF" title="Set 2 passes: rough 0.1 + finish">Rough + Finish</button>` : `<button class="btn" data-a="presetRF">Make it Rough + Finish</button>`}</div>
      ${j.passes.length > 1 ? passModeHTML(j) : ''}
      <div class="note">Each pass has its own offset D – a smaller D means the wire comes closer to the line. Offset D = wire Ø/2 + spark gap (0.18 wire + 0.01 gap → 0.10). The slug stop (M0) is on pass 1.</div>
      <div class="note">E code (optional) = machining condition number for that pass. Leave empty if not used.</div>
      ${j.side === 'none' ? '<div class="note warn">Offset side is NO offset – the D values are not used.</div>' : ''}
      ${j.passes.some((p, i) => i && p.d > j.passes[i - 1].d + 1e-9) ? '<div class="note warn">A later pass has a BIGGER offset than the pass before – it will not touch the job.</div>' : ''}`, 'done');
    // 6 lead-out & finish
    const pe = pathEnd(j); const stopNow = hasStop(j);
    const loSum = j.endMode === 'stay' ? 'wire stays at path end' : j.endMode === 'point' ? 'to other point' : 'back to start point';
    html += card(6, 'finish', 'Lead-out & finish', loSum, `
${stopNow ? `<div class="note">The lead-out is set at the <b>STOP</b> break point (card 3).</div>` : leadOutHTML(j, pe)}      ${j.passes.length > 1 && j.endMode !== 'start' ? '<div class="note">With several passes the wire goes back to the start between passes; this lead-out is used after the last pass.</div>' : ''}
      <div class="row"><span class="lbl">Machine stop (M0)</span><select class="fld" data-f="slug"><option value="end" ${j.slug === 'end' ? 'selected' : ''}>at end of path (before lead-out)</option><option value="before" ${j.slug === 'before' ? 'selected' : ''}>some mm BEFORE end (hold the slug)</option><option value="none" ${j.slug === 'none' ? 'selected' : ''}>no stop</option></select></div>
      ${j.slug === 'before' ? `<div class="row"><span class="lbl">Stop before end</span><input class="fld" data-f="slugDist" value="${j.slugDist}"> mm</div>` : ''}
      ${j.closed && !stopNow ? `<div class="row"><span class="lbl">Overcut (overlap)</span><input class="fld" data-f="overcut" value="${j.overcut || 0}"> mm</div>` : ''}`, j.endMode === 'point' && !j.end ? 'need' : 'done', S.pick === 'end');
    // 7 taper
    const tp = j.taper; const tm = tp.mode; const sh = (tp.thick || 0) * Math.tan((tp.angle || 0) * D2R);
    let tbody = `<div class="choice four">${opt2(tm, 'none', '<b>No taper</b><small>straight wire</small>', 'data-k="tmode"')}${opt2(tm, 'angle', '<b>Taper angle</b><small>G51 / G52</small>', 'data-k="tmode"')}${opt2(tm, 'angle4', '<b>Taper angle 4-axis</b><small>G74  XY + UV</small>', 'data-k="tmode"')}${opt2(tm, 'shape', '<b>Different TOP shape</b><small>G74  XY + UV</small>', 'data-k="tmode"')}</div>`;
    if (tm !== 'none') {
      const ec = effClosed(j);
      tbody += `<div class="row"><span class="lbl">Job thickness T</span><input class="fld" data-t="thick" value="${tp.thick}"> mm</div>`;
      if (tm !== 'shape') {
        tbody += `<div class="row"><span class="lbl">Taper angle</span><input class="fld" data-t="angle" value="${tp.angle}"> °  <span class="note">= ${r3(sh)} mm over T</span></div>
        <div class="row"><span class="lbl">${ec ? 'Top face is' : 'Top leans to'}</span>${ec ? `<button class="btn ${tp.top !== 'smaller' ? 'on' : ''}" data-tt="bigger">BIGGER ▲</button><button class="btn ${tp.top === 'smaller' ? 'on' : ''}" data-tt="smaller">SMALLER ▼</button>` : `<button class="btn ${tp.top !== 'right' ? 'on' : ''}" data-tt="left">⬅ LEFT</button><button class="btn ${tp.top === 'right' ? 'on' : ''}" data-tt="right">RIGHT ➡</button>`}</div>`;
        if (!ec) tbody += `<div class="note">LEFT / RIGHT = seen in the cutting direction (arrows).</div>`;
      }
      if (tm === 'angle') tbody += `<div class="row"><span class="lbl">Drawn size is at</span><button class="btn ${!(tp.W > 0) ? 'on' : ''}" data-tw="0">BOTTOM face</button><button class="btn ${tp.W > 0 && Math.abs(tp.W - tp.thick) < 1e-9 ? 'on' : ''}" data-tw="T">TOP face</button></div>
        <div class="row"><span class="lbl">W (height of drawn size)</span><input class="fld" data-t="W" value="${tp.W}"><span class="note">mm above bottom</span></div><div class="row"><span class="lbl">Z (guide distance)</span><input class="fld" data-t="Z" value="${tp.Z}"></div>
        <label class="chk note"><input type="checkbox" data-t="swap" ${tp.swap ? 'checked' : ''}> Swap G51 ⇄ G52 (if the test cut tapers the wrong way)</label>`;
      if (tm === 'angle4' || tm === 'shape') tbody += `<div class="row"><span class="lbl">G74 Z / B</span><input class="fld" data-t="Z" value="${tp.Z}"><input class="fld" data-t="B" value="${tp.B}"></div><div class="note">G74 Z${tp.Z} B${tp.B} T${tp.thick}. Drawn shape = bottom face (XY), top face = UV.</div>`;
      if (tm === 'shape') tbody += `<div class="row"><button class="btn ${S.pick === 'topShape' ? 'on' : 'pri'}" data-a="pickTop">👆 ${tp.topSegs ? 'Pick TOP shape again' : 'Pick TOP shape'}</button></div><div class="note">${tp.topSegs ? 'TOP shape: ' + tp.topSegs.length + ' items. ' : ''}Bottom and top are matched automatically.</div>`;
      const ti = App.taperInfo ? App.taperInfo(j) : { error: '' };
      if (!ti.error) tbody += `<div class="msg i" style="display:block;margin-top:6px"><b>RESULT:</b> bottom face <b>${ti.bottom}</b> &nbsp;→&nbsp; top face <b>${ti.top}</b>${ec ? ` &nbsp;(${ti.diff >= 0 ? '+' : ''}${r3(ti.diff)} mm per side)` : ''}${ti.prog ? `<br>drawn size ${ti.prog} at W = ${r3(ti.W)} mm` : ''}<br>${j.kind === 'part' ? 'Kept piece = PART (green)' : j.kind === 'hole' ? 'Kept piece = plate with HOLE (blue walls)' : 'Cut surface shown in orange'}, thickness ${r3(ti.T)} mm.</div>`;
      else tbody += `<div class="note warn">${esc(ti.error)}</div>`;
      tbody += `<canvas id="taper3d" style="width:100%;height:250px;display:block;border-radius:8px;margin-top:6px;cursor:grab;background:#0b0e12"></canvas>${App.taper3DControls ? App.taper3DControls('panel') : ''}
        <div class="note">3D view: drag = turn, wheel = zoom, double-click = reset. <span style="color:#8fc8ff">Blue = bottom</span>, <span style="color:#ff8ae0">pink = top</span>, yellow = wire.</div>`;
      tbody += `<div class="note warn">Make the first taper job a test cut and check the direction.</div>`;
    }
    html += card(7, 'taper', 'Taper (optional)', tm === 'none' ? 'none' : ({ angle: 'angle ' + tp.angle + '°', angle4: '4-axis ' + tp.angle + '°', shape: 'top shape' })[tm], tbody, 'done');
  }
  const ready = App.jobReady(j);
  html += `<div class="row" style="margin:10px 0 30px"><button class="btn big ${ready ? 'ok' : ''}" data-a="toProgram" ${ready ? '' : 'disabled'} style="flex:1;justify-content:center">MAKE PROGRAM ➜</button></div>`;
  P.innerHTML = html; bind(P); hint(nextHint(j), !!S.junction);
}
function bind(P) {
  const j = job();
  P.querySelectorAll('[data-job]').forEach(el => el.onclick = () => { App.chainCancel(); S.cur = +el.dataset.job; S.pick = null; refresh(); });
  P.querySelectorAll('[data-a]').forEach(el => el.onclick = () => act(el.dataset.a));
  P.querySelectorAll('[data-btype]').forEach(el => el.onclick = () => { App.pushUndo(); const i = +el.dataset.btype; const v = el.dataset.v; if (v === 'stop') { j.breaks.forEach(b => { if (b.type === 'stop') b.type = 'hold'; }); if (j.endMode === 'start') j.endMode = 'stay'; } j.breaks[i].type = v; App.markChanged(); });
  P.querySelectorAll('[data-bdel]').forEach(el => el.onclick = () => { App.pushUndo(); j.breaks.splice(+el.dataset.bdel, 1); App.markChanged(); });
  P.querySelectorAll('[data-bevery]').forEach(el => el.onchange = () => { App.pushUndo(); j.breaks[+el.dataset.bevery].every = el.checked; App.markChanged(); });
  P.querySelectorAll('[data-k="endmode"]').forEach(el => el.onclick = () => { App.pushUndo(); j.endMode = el.dataset.set; if (j.endMode === 'point' && !j.end) S.pick = 'end'; else if (S.pick === 'end') S.pick = null; App.markChanged(); });
  P.querySelectorAll('[data-k="pmode"]').forEach(el => el.onclick = () => { App.pushUndo(); j.passMode = el.dataset.set; App.markChanged(); });
  P.querySelectorAll('[data-k="side"]').forEach(el => el.onclick = () => { App.pushUndo(); j.side = el.dataset.set; deriveKind(j); App.markChanged(); });
  P.querySelectorAll('[data-k="tmode"]').forEach(el => el.onclick = () => { App.pushUndo(); j.taper.mode = el.dataset.set; if (j.taper.mode === 'shape' && !j.taper.topSegs) S.pick = 'topShape'; App.markChanged(); });
  P.querySelectorAll('[data-tw]').forEach(el => el.onclick = () => { App.pushUndo(); j.taper.W = el.dataset.tw === 'T' ? (+j.taper.thick || 0) : 0; App.markChanged(); });
  { const cv = P.querySelector('#taper3d'); if (cv && App.render3D) { App.bind3D(cv, job); App.bind3DControls(P, cv, job); requestAnimationFrame(() => App.render3D(cv, job())); } }
  P.querySelectorAll('[data-tt]').forEach(el => el.onclick = () => { App.pushUndo(); j.taper.top = el.dataset.tt; App.markChanged(); });
  P.querySelectorAll('[data-t]').forEach(el => el.onchange = () => { App.pushUndo(); const k = el.dataset.t; if (el.type === 'checkbox') j.taper[k] = el.checked; else j.taper[k] = num(el.value, j.taper[k]); if (k === 'Z') { cfg.taperZ = j.taper.Z; App.saveCfg(); } App.markChanged(); });
  P.querySelectorAll('[data-pp]').forEach(el => el.onchange = () => { App.pushUndo(); j.passes[+el.dataset.pp].purpose = el.value.trim(); App.markChanged(); });
  P.querySelectorAll('[data-pd]').forEach(el => el.onchange = () => { App.pushUndo(); const i = +el.dataset.pd; j.passes[i].d = Math.max(0, num(el.value, j.passes[i].d)); App.markChanged(); });
  P.querySelectorAll('[data-pe]').forEach(el => el.onchange = () => { App.pushUndo(); j.passes[+el.dataset.pe].e = el.value.replace(/[^0-9]/g, ''); App.markChanged(); });
  P.querySelectorAll('[data-delpass]').forEach(el => el.onclick = () => { App.pushUndo(); j.passes.splice(+el.dataset.delpass, 1); App.markChanged(); });
  P.querySelectorAll('[data-f]').forEach(el => {
    const k = el.dataset.f;
    el.onchange = () => {
      if (k === 'ldx' || k === 'ldy' || k === 'lodx' || k === 'lody') return; // applied with the Apply button / Enter
      if (k === 'sx' || k === 'sy') { const x = num(P.querySelector('[data-f="sx"]').value, NaN), y = num(P.querySelector('[data-f="sy"]').value, NaN); if (isFinite(x) && isFinite(y)) setStart(j, { x, y }); return; }
      App.pushUndo();
      if (k === 'name') j.name = el.value; else if (k === 'enabled') j.enabled = el.checked;
      else if (k === 'ex' || k === 'ey') { const x = num(P.querySelector('[data-f="ex"]').value, NaN), y = num(P.querySelector('[data-f="ey"]').value, NaN); if (isFinite(x) && isFinite(y)) { j.end = { x, y }; const q = pathEnd(j); if (q) j.leadOut = { dx: x - q.x, dy: y - q.y }; } }
      else if (k === 'slug') j.slug = el.value; else if (k === 'slugDist') j.slugDist = Math.max(0, num(el.value, 1)); else if (k === 'overcut') j.overcut = Math.max(0, num(el.value, 0));
      App.markChanged(); };
    if (k === 'ldx' || k === 'ldy') el.onkeydown = (e) => { if (e.key === 'Enter') act('applyLead'); e.stopPropagation(); };
    if (k === 'lodx' || k === 'lody') el.onkeydown = (e) => { if (e.key === 'Enter') act('applyLeadOut'); e.stopPropagation(); };
  });
}
function act(a) {
  const j = job();
  if (a === 'addJob') { addJob(); return; }
  if (!j) return;
  if (a === 'delJob') { App.modal('Delete cut', `<p>Delete <b>${esc(j.name)}</b>?</p>`, [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, cls: 'pri' }]).then(ok => { if (!ok) return; App.pushUndo(); App.chainCancel(); S.jobs.splice(S.cur, 1); S.cur = Math.min(S.cur, S.jobs.length - 1); S.pick = null; App.markChanged(); }); return; }
  if (a === 'up' && S.cur > 0) { App.pushUndo(); const t = S.jobs[S.cur]; S.jobs[S.cur] = S.jobs[S.cur - 1]; S.jobs[S.cur - 1] = t; S.cur--; App.markChanged(); return; }
  if (a === 'down' && S.cur < S.jobs.length - 1) { App.pushUndo(); const t = S.jobs[S.cur]; S.jobs[S.cur] = S.jobs[S.cur + 1]; S.jobs[S.cur + 1] = t; S.cur++; App.markChanged(); return; }
  if (a === 'pickStart') { App.chainCancel(); S.pick = 'start'; refresh(); return; }
  if (a === 'pickEntry') { App.chainCancel(); S.pick = 'entry'; refresh(); return; }
  if (a === 'nearestEntry') { App.chainCancel(); const n = WC.nearestOnEnts(App.visibleEnts(), j.start, 0.05); if (!n) return toast('Drawing is empty', 'w'); setLeadPoint(j, n.pt, true); return; }
  if (a === 'pickJoin') { App.chainCancel(); S.pick = 'join'; refresh(); return; }
  if (a === 'squareJoin') { App.chainCancel(); squareJoin(j); return; }
  if (a === 'applyLeadOut') { const P = $('#panel-path'); const dx = num(P.querySelector('[data-f="lodx"]').value, NaN), dy = num(P.querySelector('[data-f="lody"]').value, NaN); if (!isFinite(dx) || !isFinite(dy)) return toast('Type numbers for dX and dY', 'w'); setLeadOutPoint(j, V.add(pathEnd(j), { x: dx, y: dy })); return; }
  if (a === 'applyLead') { const P = $('#panel-path'); const dx = num(P.querySelector('[data-f="ldx"]').value, NaN), dy = num(P.querySelector('[data-f="ldy"]').value, NaN); if (!isFinite(dx) || !isFinite(dy)) return toast('Type numbers for dX and dY', 'w'); App.chainCancel(); setLeadPoint(j, V.add(j.start, { x: dx, y: dy }), true); return; }
  if (a === 'choosePath') { startPathChoice(j); return; }
  if (a === 'reverse') { App.pushUndo(); j.segs = WC.pathReverse(j.segs); j.offStart = null; deriveKind(j); App.markChanged(); toast('Direction reversed', 'o'); return; }
  if (a === 'pickTop') { App.chainCancel(); S.pick = 'topShape'; refresh(); return; }
  if (a === 'pickOff') { S.pick = 'offStart'; refresh(); return; }
  if (a === 'pickBreak') { App.chainCancel(); S.pick = 'break'; refresh(); return; }
  if (a === 'offEntry') { App.pushUndo(); j.offStart = null; App.markChanged(); return; }
  if (a === 'pickEnd') { S.pick = 'end'; refresh(); return; }
  if (a === 'addPass') { App.pushUndo(); const last = j.passes[j.passes.length - 1]; if (j.passes.length >= 2 && /finish/i.test(last.purpose || '')) last.purpose = j.passes.length === 2 ? 'Second cut' : 'Semi-finish'; j.passes.push({ d: Math.max(0, Math.round((last.d - 0.02) * 1000) / 1000), purpose: 'Finish', e: '' }); App.markChanged(); return; }
  if (a === 'presetRF') { App.pushUndo(); j.passes = [{ d: j.passes[0].d || 0.1, purpose: 'Rough cut', e: j.passes[0].e || '' }, { d: Math.max(0, Math.round(((j.passes[0].d || 0.1) - 0.02) * 1000) / 1000), purpose: 'Finish', e: '' }]; App.markChanged(); return; }
  if (a === 'toProgram') { App.setMode('program'); return; }
}
function refresh() { if (S.mode !== 'path') return; renderPathPanel(); App.redraw(); }
App.refreshPath = refresh;
App.renderPathPanel = renderPathPanel;
App.enterPathMode = () => { if (!S.jobs.length) { S.jobs.push(newJob()); S.cur = 0; S.pick = 'start'; } if (S.cur < 0) S.cur = 0; const j = job(); if (j && !j.start && !S.pick) S.pick = 'start'; App.setCmdPlaceholder('x,y  (lead-in: dX,dY)'); refresh(); };
})();
