/** Copies templates + static into public/ for Netlify. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

fs.mkdirSync(publicDir, { recursive: true });
copyRecursive(path.join(root, 'static'), path.join(publicDir, 'static'));
fs.copyFileSync(path.join(root, 'templates', 'index.html'), path.join(publicDir, 'index.html'));
console.log('Build OK → public/');
