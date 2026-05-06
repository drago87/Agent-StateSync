// index.js — Agent-StateSync Entry Point
// File Version: 1.0.4
//
// Webpack entry. Imports and initializes the extension.
// manifest.json points to dist/index.js (the built output).

import defaultConfig from './default-config.js';
import { init } from './ui.js';
import { registerSlashCommands } from './commands.js';
import { setupChatRenameListener } from './listeners.js';

(async function main() {
    let config = { ...defaultConfig };

    try {
        // Find and load config.json by scanning script tags.
        // This is the only strategy that reliably works with
        // SillyTavern's extension loading (import.meta.url may point
        // to dist/ subdir, and document.currentScript is null in ES modules).
        let loaded = false;

        try {
            const scripts = document.querySelectorAll('script[src]');
            for (const script of scripts) {
                const src = script.src || '';
                if (src.includes('agent-statesync') || src.includes('index.js')) {
                    const baseUrl = src.substring(0, src.lastIndexOf('/') + 1);
                    const r = await fetch(`${baseUrl}config.json?_=${Date.now()}`);
                    if (r.ok) {
                        const overrides = await r.json();
                        config = { ...config, ...overrides };
                        console.log(`[ASS] config.json loaded via script tag scan: ${baseUrl}config.json`);
                        loaded = true;
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn('[ASS] script tag scan strategy failed:', e.message);
        }

        if (!loaded) {
            console.warn('[ASS] Could not load config.json — using default config. debug:', config.debug);
        }
    } catch (e) {
        console.warn('[ASS] config.json loading error:', e);
    }

    await init(config.debug === true);
    registerSlashCommands();
        setupChatRenameListener();
})();
