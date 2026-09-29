// Parser for army lists exported as text from the official Warhammer 40,000 app, e.g.
//
//   August RTT (2,000 Points)
//
//   Chaos Space Marines
//   Renegade Raiders (3 Detachment Points)
//   Reconnaissance
//   Strike Force (2,000 Points)
//
//   ATTACHED UNITS
//
//   Attached unit 1
//
//   Huron Blackheart (130 Points)
//   • Attached as: Leader (Character)
//   • Warlord
//   • 1x Tyrant’s Claw heavy flamer
//   ...
//   Chosen (135 Points)
//   • Attached as: Bodyguard
//   • 4x Chosen
//   ◦ 2x Accursed weapon
//
//   Exported with App Version: v2.4.0 (1), Data Version: v925

const num = (s) => Number(String(s).replace(/[,\s]/g, ''));

const HEADING = /^[A-Z][A-Z0-9 '&,/-]*$/; // e.g. "CHARACTERS", "OTHER DATASHEETS"
const UNIT = /^(.+?)\s*\((\d[\d,]*)\s*Points?\)$/i;
const DETACHMENT = /^(.+?)\s*\((\d+)\s*Detachment Points?\)$/i;
const ITEM = /^(\d+)\s*x\s+(.+)$/i;
const BULLET = /^[•·●▪*-]\s*/;
const SUB_BULLET = /^[◦○▫‣]\s*/;

/**
 * @returns {{
 *   name: string|null, pointsLimit: number|null, faction: string|null,
 *   detachments: {name:string, dp:number}[], forceDisposition: string|null,
 *   battleSize: {name:string, points:number}|null,
 *   units: {name:string, points:number, section:string|null, attachedGroup:number|null,
 *           role:string|null, warlord:boolean, enhancements:string[],
 *           items:{count:number, name:string, children:{count:number, name:string}[]}[]}[],
 *   footer: string|null
 * }}
 */
export function parseGwAppText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const out = { name: null, pointsLimit: null, faction: null, detachments: [], forceDisposition: null, battleSize: null, units: [], footer: null };

  let i = 0;
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };

  // Title: "Name (2,000 Points)"
  skipBlank();
  const title = UNIT.exec((lines[i] || '').trim());
  if (title) { out.name = title[1].trim(); out.pointsLimit = num(title[2]); i++; } else if (lines[i]) { out.name = lines[i].trim(); i++; }

  // Header block: faction, detachment(s), force disposition, battle size (until the first heading/unit).
  const header = [];
  skipBlank();
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l && (HEADING.test(l) || /^Attached unit \d+$/i.test(l))) break;
    if (l && UNIT.test(l) && header.length >= 2 && !DETACHMENT.test(l)) {
      // A "(N Points)" line directly after the header lines is the battle size; a unit comes later.
      const next = (lines.slice(i + 1).find((x) => x.trim()) || '').trim();
      if (BULLET.test(next)) break;
    }
    if (l) header.push(l);
    i++;
  }
  for (const l of header) {
    const det = DETACHMENT.exec(l);
    const size = UNIT.exec(l);
    if (det) out.detachments.push({ name: det[1].trim(), dp: num(det[2]) });
    else if (size) out.battleSize = { name: size[1].trim(), points: num(size[2]) };
    else if (!out.faction) out.faction = l;
    else if (!out.forceDisposition) out.forceDisposition = l;
  }

  // Body: sections, attached-unit blocks and units.
  let section = null;
  let group = null;
  let unit = null;
  let lastItem = null;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    if (!l) continue;
    if (/^Exported with /i.test(l)) { out.footer = l; break; }
    let m;
    if (SUB_BULLET.test(l)) {
      const body = l.replace(SUB_BULLET, '');
      m = ITEM.exec(body);
      const child = m ? { count: Number(m[1]), name: m[2].trim() } : { count: 1, name: body };
      if (lastItem) lastItem.children.push(child);
      else if (unit) unit.items.push({ ...child, children: [] });
      continue;
    }
    if (BULLET.test(l)) {
      if (!unit) continue;
      const body = l.replace(BULLET, '').trim();
      if ((m = /^Attached as:\s*(.+)$/i.exec(body))) { unit.role = m[1].trim(); lastItem = null; continue; }
      if (/^Warlord$/i.test(body)) { unit.warlord = true; lastItem = null; continue; }
      if ((m = /^Enhancements?:\s*(.+)$/i.exec(body))) { unit.enhancements.push(m[1].trim()); lastItem = null; continue; }
      m = ITEM.exec(body);
      lastItem = m ? { count: Number(m[1]), name: m[2].trim(), children: [] } : { count: 1, name: body, children: [] };
      unit.items.push(lastItem);
      continue;
    }
    if ((m = /^Attached unit (\d+)$/i.exec(l))) { group = Number(m[1]); unit = null; lastItem = null; continue; }
    if ((m = UNIT.exec(l))) {
      unit = { name: m[1].trim(), points: num(m[2]), section, attachedGroup: group, role: null, warlord: false, enhancements: [], items: [] };
      out.units.push(unit);
      lastItem = null;
      continue;
    }
    if (HEADING.test(l)) { section = l; group = /ATTACHED/i.test(l) ? group : null; unit = null; lastItem = null; continue; }
  }
  return out;
}

/** Quick check used by the UI to tell app exports apart from other text. */
export function looksLikeGwAppText(text) {
  const p = parseGwAppText(text);
  return p.units.length > 0 && (!!p.footer || !!p.battleSize || p.detachments.length > 0);
}
