// Builds a single self-contained HTML file (dist/WireCAM-web.html) – handy for a quick look in a browser.
// Saving files needs the desktop app; the web file uses browser downloads instead.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..'); const app = path.join(root, 'app');
let s = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
s = s.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '');
s = s.replace('<link rel="stylesheet" href="css/app.css">', () => '<style>\n' + fs.readFileSync(path.join(app, 'css', 'app.css'), 'utf8') + '\n</style>');
s = s.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => '<script>\n' + fs.readFileSync(path.join(app, src), 'utf8').replace(/<\/script/g, '<\\/script') + '\n</script>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'WireCAM-web.html'), s);
console.log('Built dist/WireCAM-web.html');
