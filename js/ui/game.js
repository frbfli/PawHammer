// Game tracker for Play Mode: battle round, whose turn and which phase, Command Points, and
// per-unit wounds, Destroyed, Below Half-strength and Battle-shock. Plain JSON state with pure
// functions, so it can be saved per roster and tested without the UI.
//
// Turn sequence: each turn runs Command -> Movement -> Shooting -> Charge -> Fight. At the start
// of every Command phase both players gain 1CP. At the start of your Command phase every unit
// that is Below Half-strength or already Battle-shocked (11th edition) must take a Battle-shock
// test; it stays highlighted until marked passed (no longer Battle-shocked) or failed.

export const PHASES = ['Command', 'Movement', 'Shooting', 'Charge', 'Fight'];

/** The battle ends at the end of battle round 5 (11th edition). */
export const LAST_ROUND = 5;

export function newGame() {
  return { started: false, over: false, first: 'mine', round: 1, turn: 'mine', phase: 0, cp: 0, units: {} };
}

/** Per-unit tracker state (created on first use). */
export function unitState(game, id) {
  if (!game.units[id]) game.units[id] = { damage: {}, destroyed: false, belowHalf: false, shocked: false, test: false };
  return game.units[id];
}

/**
 * Wounds and strength of a unit from its model groups ([{ key, name, count, w }]) and the damage
 * taken by each group. Damage goes to the model already wounded first, so a group's damage `d`
 * means floor(d / w) models are dead and the next one has lost d % w wounds.
 */
export function strength(game, id, groups) {
  const st = game.units[id] || {};
  const damage = st.damage || {};
  let start = 0, alive = 0, totalW = 0, lost = 0;
  const out = groups.map((g) => {
    const w = Math.max(1, g.w || 1);
    const dmg = Math.min(damage[g.key] || 0, g.count * w);
    const dead = Math.floor(dmg / w);
    start += g.count;
    alive += g.count - dead;
    totalW += g.count * w;
    lost += dmg;
    return { ...g, w, dmg, dead, alive: g.count - dead, hurt: dead < g.count ? dmg % w : 0 };
  });
  const destroyed = !!st.destroyed || (start > 0 && alive === 0);
  // Starting Strength 1: below half when fewer than half its wounds remain; otherwise models.
  const autoHalf = start === 1 ? (totalW - lost) * 2 < totalW : alive * 2 < start;
  return { groups: out, start, alive, totalW, remainingW: totalW - lost, destroyed, belowHalf: !destroyed && (!!st.belowHalf || autoHalf) };
}

/** Apply `n` wounds to a group (negative heals), clamped to the group's total wounds. */
export function wound(game, id, group, n) {
  const st = unitState(game, id);
  const max = group.count * Math.max(1, group.w || 1);
  st.damage[group.key] = Math.max(0, Math.min(max, (st.damage[group.key] || 0) + n));
}

/** Start the battle: round 1, Command phase of whoever goes first. */
export function start(game, first, units) {
  Object.assign(game, { started: true, over: false, first, round: 1, turn: first, phase: 0, cp: 0, units: {} });
  beginCommand(game, units);
}

/**
 * Advance to the next phase. `units` is [{ id, belowHalf, destroyed }] for the player's army,
 * used to flag Battle-shock tests when the player's Command phase begins.
 */
export function nextPhase(game, units) {
  if (game.over) return;
  if (game.phase < PHASES.length - 1) { game.phase++; return; }
  const turn = game.turn === 'mine' ? 'theirs' : 'mine';
  // Both players have had their turn in the last battle round: the battle is over.
  if (turn === game.first && game.round >= LAST_ROUND) { game.over = true; return; }
  game.phase = 0;
  game.turn = turn;
  if (game.turn === game.first) game.round++;
  beginCommand(game, units);
}

/** Step back one phase (for mistakes); start-of-phase effects are not undone or repeated. */
export function prevPhase(game) {
  if (game.over) { game.over = false; return; }
  if (game.phase > 0) { game.phase--; return; }
  if (game.round === 1 && game.turn === game.first) return;
  if (game.turn === game.first) game.round--;
  game.turn = game.turn === 'mine' ? 'theirs' : 'mine';
  game.phase = PHASES.length - 1;
}

/**
 * Start of a Command phase: +1CP. On the player's turn, units Below Half-strength or still
 * Battle-shocked must test; a Battle-shocked unit stays so until it passes.
 */
export function beginCommand(game, units) {
  game.cp++;
  if (game.turn !== 'mine') return;
  for (const u of units) {
    const st = unitState(game, u.id);
    st.test = !u.destroyed && (u.belowHalf || st.shocked);
  }
}

/** Resolve a pending Battle-shock test. */
export function resolveTest(game, id, passed) {
  const st = unitState(game, id);
  st.test = false;
  st.shocked = !passed;
}

/** Units still waiting for their Battle-shock test result. */
export const pendingTests = (game) => Object.entries(game.units).filter(([, u]) => u.test).map(([id]) => id);
