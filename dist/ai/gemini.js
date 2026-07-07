"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gemini = gemini;
const config_1 = require("../config");
// Gemini REST helper. One function, model passed per call so the analyst (Flash)
// and the reviewer (Pro) share it. No key = null, callers skip gracefully.
async function gemini(prompt, model, maxTokens = 300) {
    if (!config_1.env.GEMINI_API_KEY)
        return null;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config_1.env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
            }),
        });
        if (!res.ok) {
            console.error('[gemini]', model, res.status, (await res.text()).slice(0, 200));
            return null;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts
            ?.map((p) => p.text || '').join(' ').trim();
        return text || null;
    }
    catch (e) {
        console.error('[gemini]', e.message);
        return null;
    }
}
