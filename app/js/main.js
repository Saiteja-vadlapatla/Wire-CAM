/* WireCAM – mode router, toolbar, settings, help, start-up */
(function () {
'use strict';
const { S, $, $$, esc, toast, cfg } = App;

// icons into buttons
$$('[data-icon]').forEach(b => { const svg = ICONS[b.dataset.icon]; if (svg) b.innerHTML = svg + '<span>' + b.textContent + '</span>'; });

// ------------------------------------------------------------------ mode router
const handlers = () => S.mode === 'draw' ? App.drawHandlers : S.mode === 'path' ? App.pathHandlers : App.progHandlers;
App.onClick = (p, sx, sy, d) => handlers().click(p, sx, sy, d);
App.onDragSelect = (x0, y0, x1, y1, d) => { if (S.mode === 'draw') App.drawHandlers.dragSelect(x0, y0, x1, y1, d); };
App.onRightClick = () => handlers().right();
App.onEscape = () => handlers().escape();
App.onTyped = (str) => handlers().typed(str);
App.onKey = (e) => handlers().key(e);
App.onHover = (sx, sy) => handlers().hover(sx, sy);
App.wantsSnap = () => handlers().wantsSnap();
App.drawTool = () => App.drawHandlers.draw();
App.drawPathMode = () => App.pathHandlers.draw();
App.drawProgramMode = () => App.progHandlers.draw();
App.extraSnapPts = () => { if (S.mode !== 'path') return []; const out = []; S.jobs.forEach(j => { if (j.start) out.push({ p: j.start, kind: 'POINT' }); }); return out; };

App.setMode = function (m) {
  if (S.mode === 'path' && m !== 'path') { App.chainCancel(); S.pick = null; }
  if (S.mode !== m) $('#panel').scrollTop = 0;
  S.mode = m; S.hover = null;
  $$('.mode').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $$('.ppage').forEach(p => p.classList.toggle('on', p.id === 'panel-' + m));
  $('#tools').classList.toggle('disabled', m !== 'draw');
  $('#consbar').classList.toggle('hidden', m !== 'draw');
  $('#cmdwrap').style.visibility = m === 'program' ? 'hidden' : 'visible';
  if (m === 'draw') { App.setTool(S.tool || 'select'); }
  if (m === 'path') { S.sel.clear(); App.enterPathMode(); }
  if (m === 'program') { App.enterProgramMode(); }
  App.redraw();
};
App.refreshPanels = function () {
  if (S.mode === 'draw') App.refreshDraw(); else if (S.mode === 'path') App.refreshPath(); else App.renderProgramPanel();
};
$$('.mode').forEach(b => b.onclick = () => App.setMode(b.dataset.mode));
$$('.tool, .cbtn[data-tool]').forEach(b => b.onclick = () => { if (S.mode !== 'draw') App.setMode('draw'); App.setTool(b.dataset.tool); });
$$('.cbtn[data-act2]').forEach(b => b.onclick = () => { if (S.mode !== 'draw') App.setMode('draw'); App.autoConstrain(); });

// ------------------------------------------------------------------ top bar
App.newJob = async function () {
  if (S.ents.length || S.jobs.length) { const ok = await App.modal('New', '<p>Clear the drawing and all wire paths and start new?</p><p class="note">(Save first if you need this work. You can also Undo.)</p>', [{ label: 'Cancel', value: false }, { label: 'Start new', value: true, cls: 'pri' }]); if (!ok) return; }
  App.pushUndo(); S.ents = []; S.cons = []; S.jobs = []; S.cur = -1; S.hidden.clear(); S.sel.clear(); S.viewer = null; S.fileName = ''; S.prog = { name: 'EMT0001', title: '', notes: '' };
  App.markChanged(); App.setMode('draw'); App.fit();
};
const acts = {
  new: () => App.newJob(), open: () => App.openAny(), saveProject: () => App.saveProject(), exportDxf: () => App.exportDxf(),
  undo: () => App.undo(), redo: () => App.redo(), fit: () => App.fit(), settings: () => showSettings(), help: () => App.showHelp(),
};
$$('[data-act]').forEach(b => b.onclick = () => acts[b.dataset.act] && acts[b.dataset.act]());

// ------------------------------------------------------------------ settings
function applyUiScale() { document.body.style.zoom = (cfg.uiScale || 100) / 100; setTimeout(App.resize, 50); }
async function showSettings() {
  const f = (k, label, note, w) => `<div class="row"><span class="lbl" style="min-width:230px">${label}</span><input class="fld" data-k="${k}" value="${esc(cfg[k])}" style="width:${w || 90}px"><span class="note">${note || ''}</span></div>`;
  const html = `<div>
    <h3 style="margin:4px 0">Wire</h3>
    ${f('wireDia', 'Wire diameter (mm)', 'molybdenum 0.18')}${f('gap', 'Spark gap per side (mm)', '0.01 – 0.02')}
    <div class="note">Offset D = wire Ø / 2 + gap. With 0.18 and 0.01 → D = 0.10 (slot width 0.20).</div>
    ${f('leadLen', 'Automatic lead-in length (mm)', 'distance start hole → shape')}
    <h3 style="margin:12px 0 4px">Program output</h3>
    ${f('decimals', 'Decimals in program', '3 – 6')}${f('maxArc', 'Split arcs bigger than (degrees)', '180 = full circles in 2 halves')}
    ${f('taperZ', 'Default guide distance Z for taper', '')}
    <h3 style="margin:12px 0 4px">Drawing</h3>
    ${f('joinTol', 'Join tolerance for shapes (mm)', 'ends closer than this are connected')}${f('fitTol', 'Spline / ellipse accuracy (mm)', '')}
    <div class="row"><span class="lbl" style="min-width:230px">Screen text size</span><select class="fld" data-k="uiScale">${[90, 100, 115, 130, 150].map(v => `<option value="${v}" ${+cfg.uiScale === v ? 'selected' : ''}>${v}%</option>`).join('')}</select></div>
    <div class="row"><button class="btn danger" id="resetCfg">Reset all settings</button></div></div>`;
  const p = App.modal('Settings', html, [{ label: 'Close', value: true, cls: 'pri' }]);
  $$('#mbody [data-k]').forEach(el => el.onchange = () => { const k = el.dataset.k; const v = parseFloat(String(el.value).replace(',', '.')); if (isFinite(v) && v >= 0) cfg[k] = k === 'decimals' ? Math.max(3, Math.min(6, Math.round(v))) : v; App.saveCfg(); if (k === 'uiScale') applyUiScale(); App.markChanged(); });
  $('#resetCfg').onclick = () => { Object.assign(cfg, App.DEFAULT_CFG); App.saveCfg(); applyUiScale(); App.closeModal(); toast('Settings reset', 'o'); App.markChanged(); };
  await p;
}

// ------------------------------------------------------------------ help
App.showHelp = function () {
  const html = `<div class="help">
  <p><b>WireCAM</b> makes wire-cut programs (.WC) for the machine in 3 simple steps. The steps are the buttons at the top: <b>1 DRAW → 2 WIRE PATH → 3 PROGRAM</b>. The yellow line at the bottom always tells you what to do next.</p>
  <h3>1 DRAW</h3><ol>
   <li><b>Open</b> a DXF drawing, or draw with the tools on the left: Line, Rectangle (with corner radius), Circle, Arcs, Polygon, <b>Slot</b>, <b>Gear</b> (involute spur gear from module and teeth).</li>
   <li>To type exact sizes: just start typing numbers. Examples: <kbd>10,20</kbd> = point X10 Y20, <kbd>@5,0</kbd> = 5 mm to the right, <kbd>@25&lt;45</kbd> = 25 mm at 45°, <kbd>25</kbd> = length 25 in the mouse direction, <kbd>d10</kbd> = diameter 10.</li>
   <li><b>MODIFY</b>: Trim (click the piece to cut away), <b>Extend</b> (click near the end – it grows to the next line, or by a length you type), Fillet, Chamfer, Break, <b>Join</b> (pieces into one line/arc), Offset.</li>
   <li><b>ARRANGE</b>: Move, Copy, Rotate, Mirror, <b>Scale</b>, <b>Array</b> (rows / columns or around a centre), Delete.</li>
   <li><b>Edit by dragging</b>: select a line or arc – blue squares appear. Drag them to move an end, the centre or the whole line. Snap works while dragging.</li>
   <li>Click a line to see and change its size in the right panel.</li>
   <li><b>Snaps</b>: end, middle, centre, quadrant, crossing, on-line, and while drawing from a point also <b>perpendicular</b> and <b>tangent</b>.</li>
   <li><b>Check drawing → Show open ends</b> finds gaps. A shape must be closed to cut a PART or HOLE.</li></ol>
  <h3>RULES (constraints) – purple bar above the drawing</h3><ul>
   <li><b>Join pts</b> (coincident), <b>On line</b>, <b>Middle</b>, <b>Horizontal</b>, <b>Vertical</b>, <b>Parallel</b>, <b>Square</b> (perpendicular), <b>Tangent</b>, <b>Equal</b>, <b>Same centre</b> (concentric), <b>Symmetric</b>, <b>Fix</b> (lock).</li>
   <li>For two items: click the item that should STAY first, then the one that should MOVE.</li>
   <li><b>Size</b> (dimension): click a line (length), arc (radius) or circle (diameter) – or choose distance / angle in the panel. Type a new value: the shape follows and keeps all rules.</li>
   <li><b>Auto</b> adds rules automatically: joined corners, horizontal / vertical lines, tangent joints (for the selection, or the whole drawing).</li>
   <li>Rules are shown as small purple tags. Click a tag and press <kbd>Del</kbd>, or remove it in the list on the right. If a change breaks a rule, WireCAM tells you and undoes it.</li></ul>
  <h3>2 WIRE PATH</h3><ol>
   <li><b>Start point</b>: click the wire threading hole (circle centres and corners snap) or type <kbd>x,y</kbd>.</li>
   <li><b>Lead-in</b>: type the lead-in point as X / Y offset from the start point (e.g. dX <kbd>-5</kbd> dY <kbd>0</kbd>) or click ANY point. <b>The lead-in point is PROGRAM ZERO X0 Y0</b> (yellow label and X/Y arrows on the drawing) – set the machine zero there. If that point is not on the shape, you then pick where the wire <b>joins</b> the shape.</li>
   <li><b>Path &amp; direction</b>: numbered colours show the lines that leave the lead-in point. Click the line the wire should cut FIRST – this sets the direction. At every junction choose again (or press <kbd>1</kbd>, <kbd>2</kbd>…). The path ends when it comes back to the lead-in point or at a free end.</li>
   <li><b>Break points</b> (in the Path card): click any point on the path. <b>HOLD</b> = M0, the machine waits until you press RUN, then continues (pass 1, or every pass). <b>STOP</b> = the program cuts only up to that point (the rest is already machined); then choose the lead-out right there: wire stays, back to start, or to another point.</li>
   <li><b>Wire offset side</b>: LEFT (G41), RIGHT (G42) or NO offset. For a closed path the buttons tell you which side is INSIDE / OUTSIDE. The <span style="color:#ff9628">orange line</span> shows the wire centre.</li>
   <li><b>Passes</b>: default 1 pass, D 0.1. Add passes and give each a purpose (Rough cut, Finish …) and its own offset D (and E code if you use one). <b>Between passes</b>: a CLOSED loop simply continues around the loop (or goes back to the start point and leads in again). An OPEN path goes back BACKWARD on the same path with G41/G42 swapped (the wire stays on the same side), or goes straight back to the start point and cuts again in the same direction.</li>
   <li><b>Lead-out &amp; finish</b>: <b>Back to start</b> (along the lead-in), <b>Stop at path end</b> (no lead-out) or <b>Other point</b> – type dX / dY from the path end or click any point. Also the machine stop (M0) to hold the slug and overcut.</li>
   <li><b>Taper</b> (optional): angle (G51/G52) or 4-axis XY/UV (G74), or a different TOP shape. Enter job thickness and angle, choose top BIGGER/SMALLER (closed) or leaning LEFT/RIGHT (open). The <b>RESULT</b> line shows the size on the bottom and top face (e.g. Ø10.000 → Ø10.698) and the <b>3D view</b> shows the job, both faces, the cut surface and the wire (drag to turn, ⤢ = big view).</li>
   <li>More profiles in one program: <b>+ New cut</b>. The machine stops (M0) between cuts to cut and thread the wire.</li></ol>
  <h3>3 PROGRAM</h3><ol>
   <li>The program is made and checked automatically. <span style="color:#ff5a5a">Red</span> = must fix, <span style="color:#ffb020">yellow</span> = please check.</li>
   <li>Press <b>Play</b> to watch the wire move. Click a program line to jump there.</li>
   <li>Set the program name (e.g. EMT0001) and press <b>SAVE PROGRAM</b>.</li>
   <li>You can also <b>Open</b> an existing .WC file to view and simulate it.</li></ol>
  <h3>Program format (Electronica / ELCam style)</h3>
  <ul><li>Program zero <b>X0 Y0</b> = start hole of the first cut. Header G71 G9 G27 G40 G47 G50 G90 G75, offset table D0=0, D1=…</li>
   <li>Arcs: <kbd>G2</kbd> clockwise / <kbd>G3</kbd> anti-clockwise with end point X Y and centre <b>I J measured from the arc START point</b>.</li>
   <li>Offset: lead-in with <kbd>G41/G42 D0</kbd>, offset switched on with <kbd>D1</kbd> on the shape, off again (<kbd>D0</kbd>) for the lead-out, then <kbd>G40</kbd>.</li>
   <li>4-axis taper: <kbd>G74 Z B T</kbd>, XY moves with UV moves on the same line: <kbd>G101</kbd> line, <kbd>G102/G103</kbd> arc with centre <b>P Q</b> from the UV start point, end with <kbd>G75</kbd>.</li></ul>
  <h3>Mouse and keys</h3>
  <table><tr><td>Mouse wheel</td><td>zoom at the mouse</td></tr><tr><td>Hold wheel or right button + move</td><td>move the view</td></tr><tr><td>Right click</td><td>finish / go back one step</td></tr>
  <tr><td><kbd>F</kbd> / double-click</td><td>fit drawing</td></tr><tr><td><kbd>Esc</kbd></td><td>cancel</td></tr><tr><td><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></td><td>undo / redo</td></tr>
  <tr><td><kbd>Shift</kbd> or <kbd>F8</kbd></td><td>straight (horizontal / vertical) lines</td></tr><tr><td><kbd>F3</kbd></td><td>snap on / off</td></tr><tr><td><kbd>L C R A T E M</kbd></td><td>Line, Circle, Rectangle, Arc, Trim, Extend, Move</td></tr>
  <tr><td><kbd>1</kbd>–<kbd>9</kbd></td><td>choose the first line / the way at a junction</td></tr><tr><td><kbd>Space</kbd></td><td>play / pause simulation</td></tr></table>
  <p class="note">Your work is saved automatically in the background. If the PC switches off, WireCAM offers to restore it at the next start.</p></div>`;
  App.modal('How to use WireCAM', html, [{ label: 'OK', value: true, cls: 'pri' }]);
};

const sb = $('#sampleBtn'); if (sb) sb.onclick = () => window.SAMPLE_DXF && App.importDXF(window.SAMPLE_DXF, 'Demo punch.dxf');
// ------------------------------------------------------------------ start-up
App.resize();
applyUiScale();
App.setMode('draw');
App.fit();
if (window.native && window.native.onOpenFile) window.native.onOpenFile(f => App.handleFile(f));
if (window.native && window.native.onBeforeClose) window.native.onBeforeClose(async () => {
  if (!S.dirty) return true;
  const a = await App.modal('Close WireCAM', '<p>You have changes that are not saved in a project file.</p><p class="note">(A backup is kept and offered at next start.)</p>', [{ label: 'Cancel', value: 'cancel' }, { label: 'Close without saving', value: 'close' }, { label: 'Save project', value: 'save', cls: 'pri' }]);
  if (a === 'save') { await App.saveProject(); return !S.dirty; }
  return a === 'close';
});
(async function restore() {
  let o = null; try { o = JSON.parse(localStorage.getItem('wirecam.autosave') || 'null'); } catch (e) { }
  if (o && ((o.ents && o.ents.length) || (o.jobs && o.jobs.length))) {
    const when = o.savedAt ? new Date(o.savedAt).toLocaleString() : '';
    const a = await App.modal('Continue last work?', `<p>WireCAM found your last work (${o.ents.length} drawing items, ${o.jobs.length} cut(s)) from <b>${esc(when)}</b>.</p>`, [{ label: 'Start empty', value: false }, { label: 'Continue last work', value: true, cls: 'pri' }]);
    if (a) { App.loadProjectData(o); S.fileName = o.fileName || ''; App.setMode(S.jobs.length ? 'path' : 'draw'); App.fit(); S.dirty = false; return; }
  }
  App.hint('Open a DXF drawing (Open) or draw your shape. Then go to 2 WIRE PATH.');
})();
})();
