import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { AppConfig } from './types';

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');

// LEARNED OVERRIDES — the filter learner (tuning/filtertune.ts) persists threshold
// adjustments to Postgres so they survive redeploys (config.yaml on Railway resets
// with every deploy). They overlay the yaml baseline here; yaml stays the human's
// document, the DB holds what the bot learned.
let overrides: Record<string, number> = {};
let weightOverrides: Record<string, number> = {};
export function setConfigOverrides(o: Record<string, number>) {
  // MERGE, don't replace. Both the filter learner and the scoring calibrator call
  // this with their OWN paths; a wholesale `overrides = o` meant whichever ran last
  // wiped the other's keys — in practice the filter learner (gates.*) kept erasing
  // the calibrator's states.trigger_score_min, snapping the trigger floor back to
  // the yaml default of 65 and silently blocking every trigger. Merge per key.
  overrides = { ...overrides, ...o };
  try { current = withOverrides(load()); } catch {}
}
// learned scoring weights (component -> value), applied under weights.* — kept
// separate from filter overrides so the two learners never clobber each other.
let directions: Record<string, number> = {};
// which score components are INVERTED (winners score LOW on them). The score
// reads this to flip a component's contribution. Learned by the calibrator.
export function setDirections(d: Record<string, number>) { directions = d; }
export function getDirection(key: string): number { return directions[key] ?? 1; }

export function setWeightOverrides(o: Record<string, number>) {
  weightOverrides = o;
  try { current = withOverrides(load()); } catch {}
}
function withOverrides(base: AppConfig): AppConfig {
  for (const [p, v] of Object.entries(overrides)) {
    const keys = p.split('.');
    let node: any = base;
    for (let i = 0; i < keys.length - 1 && node; i++) node = node[keys[i]];
    if (node && typeof node[keys[keys.length - 1]] === 'number') node[keys[keys.length - 1]] = v;
  }
  const wnode: any = (base as any).weights;
  if (wnode) for (const [k, v] of Object.entries(weightOverrides))
    if (typeof wnode[k] === 'number') wnode[k] = v;
  return base;
}

let current: AppConfig = withOverrides(load());

function load(): AppConfig {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as AppConfig;
}

// hot-reload every 60s so threshold tuning never needs a redeploy
setInterval(() => {
  try {
    current = withOverrides(load());
  } catch (e) {
    console.error('[config] reload failed, keeping previous:', (e as Error).message);
  }
}, 60_000);

export const cfg = () => current;
export const env = {
  DATABASE_URL: process.env.DATABASE_URL || '',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || '',
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  PORT: parseInt(process.env.PORT || '3000', 10),
};
