// WireCAM – Electron main process
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null; let dirty = false; let forceClose = false;
const cfgFile = () => path.join(app.getPath('userData'), 'paths.json');
function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) { return {}; } }
function writeCfg(o) { try { fs.writeFileSync(cfgFile(), JSON.stringify(o)); } catch (e) { } }

const FILTERS = {
  wc: [{ name: 'Wire-cut program', extensions: ['WC', 'wc'] }, { name: 'All files', extensions: ['*'] }],
  project: [{ name: 'WireCAM project', extensions: ['wcam'] }],
  dxf: [{ name: 'DXF drawing', extensions: ['dxf'] }],
  open: [{ name: 'Drawings, programs, projects', extensions: ['dxf', 'DXF', 'wcam', 'WC', 'wc', 'nc', 'txt'] }, { name: 'All files', extensions: ['*'] }],
};

function readForRenderer(p) { const buf = fs.readFileSync(p); return { name: path.basename(p), path: p, text: buf.toString('latin1') }; }

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680, show: false, backgroundColor: '#1b2027', title: 'WireCAM',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && input.control && input.shift) win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5') { e.preventDefault(); }
  });
  win.on('close', (e) => {
    if (forceClose || !dirty) return;
    e.preventDefault();
    win.webContents.send('before-close');
  });
  // file passed on command line (e.g. "Open with WireCAM")
  win.webContents.once('did-finish-load', () => {
    const arg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => /\.(dxf|wc|wcam|nc)$/i.test(a) && fs.existsSync(a));
    if (arg) setTimeout(() => win.webContents.send('open-file', readForRenderer(arg)), 800);
  });
}

ipcMain.handle('open-file', async (e, accept) => {
  const c = readCfg();
  const r = await dialog.showOpenDialog(win, { title: 'Open', defaultPath: c.lastOpenDir || app.getPath('documents'), properties: ['openFile'], filters: FILTERS.open });
  if (r.canceled || !r.filePaths.length) return null;
  c.lastOpenDir = path.dirname(r.filePaths[0]); writeCfg(c);
  return readForRenderer(r.filePaths[0]);
});
ipcMain.handle('save-file', async (e, defName, text, kind) => {
  const c = readCfg(); const key = 'lastSaveDir_' + (kind || 'any');
  const dir = c[key] || c.lastOpenDir || app.getPath('documents');
  const r = await dialog.showSaveDialog(win, { title: kind === 'wc' ? 'Save wire-cut program' : 'Save', defaultPath: path.join(dir, defName), filters: FILTERS[kind] || FILTERS.open });
  if (r.canceled || !r.filePath) return null;
  try {
    // keep a backup of an existing file before overwriting
    if (fs.existsSync(r.filePath)) { try { fs.copyFileSync(r.filePath, r.filePath + '.bak'); } catch (err) { } }
    fs.writeFileSync(r.filePath, text, kind === 'wc' ? 'latin1' : 'utf8');
  } catch (err) { dialog.showErrorBox('Could not save', String(err.message || err)); return null; }
  c[key] = path.dirname(r.filePath); writeCfg(c);
  return r.filePath;
});
ipcMain.on('set-dirty', (e, v) => { dirty = !!v; if (win) win.setTitle('WireCAM' + (dirty ? ' •' : '')); });
ipcMain.on('close-now', () => { forceClose = true; if (win) win.close(); });

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', (e, argv) => {
    if (!win) return; if (win.isMinimized()) win.restore(); win.focus();
    const arg = argv.find(a => /\.(dxf|wc|wcam|nc)$/i.test(a) && fs.existsSync(a)); if (arg) win.webContents.send('open-file', readForRenderer(arg));
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
