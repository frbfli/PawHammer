// Downloads a few BSData/wh40k-11e files into tests/fixtures for the engine tests.
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const base = 'https://raw.githubusercontent.com/BSData/wh40k-11e/main/';
const files = [
  'Warhammer 40,000.json', 'Necrons.json', 'Unaligned Forces.json',
  'Imperium - Space Marines.json', 'Imperium - Agents of the Imperium.json', 'Library - Titans.json',
  'Imperium - Imperial Knights - Library.json', 'Library - Astartes Heresy Legends.json',
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`${url}: HTTP ${res.statusCode}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

fs.mkdirSync(dir, { recursive: true });
for (const f of files) {
  const buf = await get(base + encodeURIComponent(f));
  fs.writeFileSync(path.join(dir, f), buf);
  console.log(`${f}: ${buf.length} bytes`);
}
