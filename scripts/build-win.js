// Builds the portable Windows app: dist/WireCAM-win32-x64/WireCAM.exe
// Usage: npm run build:win   (works on Windows, Linux and macOS – no Wine needed)
const { packager } = require('@electron/packager');
const ResEdit = require('resedit');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

// PE checksum (Windows does not require it, but keeps the file tidy after editing resources)
function peChecksum(buf) {
  const peOff = buf.readUInt32LE(0x3c); const csOff = peOff + 24 + 64; let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (i === csOff || i === csOff + 2) continue;
    const w = i + 1 < buf.length ? buf.readUInt16LE(i) : buf[i];
    sum += w; sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  buf.writeUInt32LE((sum + buf.length) >>> 0, csOff);
}

(async () => {
  const out = await packager({
    dir: root, out: path.join(root, 'dist'), platform: 'win32', arch: 'x64', overwrite: true, asar: true,
    name: pkg.productName, executableName: pkg.productName, appVersion: pkg.version,
    prune: false, // the app has no runtime dependencies – keep node_modules out completely
    ignore: [/^\/node_modules($|\/)/, /^\/dist($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/docs($|\/)/, /^\/\.git/, /\.log$/, /^\/assets\/icon\.ico$/, /^\/assets\/icon-source\.html$/, /^\/README\.md$/, /^\/CHANGELOG\.md$/],
  });
  const dir = out[0]; const exe = path.join(dir, pkg.productName + '.exe');
  // icon + version information
  const exeObj = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exeObj);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: pkg.productName, FileDescription: 'WireCAM - wire-cut programming', CompanyName: pkg.author, OriginalFilename: pkg.productName + '.exe', InternalName: pkg.productName, LegalCopyright: pkg.author });
  vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
  vi.outputToResourceEntries(res.entries); res.outputResource(exeObj);
  const buf = Buffer.from(exeObj.generate()); peChecksum(buf); fs.writeFileSync(exe, buf);
  fs.copyFileSync(path.join(root, 'docs', 'READ-ME-FIRST.txt'), path.join(dir, 'READ ME FIRST.txt'));
  console.log('Built ' + exe + '  (version ' + pkg.version + ')');
  console.log('Zip the folder "' + path.basename(dir) + '" to share it. Users unzip and double-click ' + pkg.productName + '.exe');
})().catch(e => { console.error(e); process.exit(1); });
