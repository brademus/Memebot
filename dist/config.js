"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = exports.cfg = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const CONFIG_PATH = path_1.default.join(process.cwd(), 'config.yaml');
let current = load();
function load() {
    return js_yaml_1.default.load(fs_1.default.readFileSync(CONFIG_PATH, 'utf8'));
}
// hot-reload every 60s so threshold tuning never needs a redeploy
setInterval(() => {
    try {
        current = load();
    }
    catch (e) {
        console.error('[config] reload failed, keeping previous:', e.message);
    }
}, 60_000);
const cfg = () => current;
exports.cfg = cfg;
exports.env = {
    DATABASE_URL: process.env.DATABASE_URL || '',
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    ADMIN_KEY: process.env.ADMIN_KEY || '',
    PORT: parseInt(process.env.PORT || '3000', 10),
};
