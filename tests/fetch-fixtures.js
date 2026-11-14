// Downloads the 40kdc-data files the engine tests use into tests/fixtures/40kdc (same layout as
// the repository's data/ folder) plus files.json, the listing the test source reads.
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', '40kdc');
const repo = 'wn-mitch/40kdc-data';
const branch = 'main';
// Factions the tests build armies from (sub-factions need their parent, e.g. ultramarines).
const factions = ['necrons', 'adeptus-astartes', 'ultramarines', 'blood-angels', 'adepta-sororitas', 'chaos-space-marines'];
const shared = ['core/force-dispositions.json', 'core/weapon-keywords.json', 'core/unit-keywords.json', 'core/stratagems.json', 'enrichment/_core/abilities.json'];

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pawhammer-tests', ...headers } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`${url}: HTTP ${res.statusCode}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

const tree = JSON.parse(await get(`https://api.github.com/repos/${repo}/git/trees/${branch}:data?recursive=1`, { Accept: 'application/vnd.github+json' }));
const all = tree.tree.filter((f) => f.type === 'blob' && f.path.endsWith('.json'));
const wanted = all.filter((f) =>
  shared.includes(f.path) ||
  /^core\/[^/]+\/factions\.json$/.test(f.path) || // every faction's header, for the faction list
  factions.some((id) => f.path.startsWith(`core/${id}/`) || f.path === `enrichment/${id}/abilities.json`));

const listing = {};
for (const f of wanted) {
  const target = path.join(dir, 'data', f.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buf = await get(`https://raw.githubusercontent.com/${repo}/${branch}/data/${f.path.split('/').map(encodeURIComponent).join('/')}`);
  fs.writeFileSync(target, buf);
  listing['data/' + f.path] = { version: f.sha, size: buf.length };
}
fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(listing, null, 1));
console.log(`${wanted.length} files from ${repo}@${branch} in ${dir}`);
