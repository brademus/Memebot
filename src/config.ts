import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { AppConfig } from './types';

const CONFIG_PATH = path.join(process.cwd(), 'config.yaml');
let current: AppConfig = load();

function load(): AppConfig {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as AppConfig;
}

// hot-reload every 60s so threshold tuning never needs a redeploy
setInterval(() => {
  try {
    current = load();
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
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  PORT: parseInt(process.env.PORT || '3000', 10),
};
