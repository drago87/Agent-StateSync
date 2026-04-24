// index.js — Agent-StateSync Entry Point
//
// Webpack entry. Imports and initializes the extension.
// manifest.json points to dist/index.js (the built output).
// File Version: 1.0.3

import defaultConfig from './default-config.js';
import { init } from './ui.js';
import { registerSlashCommands } from './commands.js';
import { setupChatRenameListener } from './listeners.js';

(async function main() {
    let config = { ...defaultConfig };

    try {
        // Try multiple strategies to find and load config.json.
        // import.meta.url gives the URL of this module (works in webpack ES modules).
        // We derive the base directory and look for config.json there.
        // ST doesn't expose extension files via direct HTTP, so we need
        // to match the URL pattern ST uses for serving extension scripts.
        let loaded = false;

        // Strategy 1: import.meta.url (ES module URL)
        if (!loaded && typeof import.meta !== 'undefined' && import.meta.url) {
            try {
                const metaUrl = new URL(import.meta.url);
                const baseUrl = metaUrl.pathname.substring(0, metaUrl.pathname.lastIndexOf('/') + 1);
                // Try both the script directory and one level up (dist/ vs extension root)
                for (const path of [`${baseUrl}config.json`, `${baseUrl}../config.json`]) {
                    const r = await fetch(path + '?_=' + Date.now());
                    if (r.ok) {
                        const overrides = await r.json();
                        config = { ...config, ...overrides };
                        console.log(`[ASS] config.json loaded via import.meta.url: ${path}`);
                        loaded = true;
                        break;
                    }
                }
            } catch (e) {
                console.warn('[ASS] import.meta.url strategy failed:', e.message);
            }
        }

        // Strategy 2: document.currentScript (may not work in webpack bundles)
        if (!loaded && document.currentScript?.src) {
            try {
                const scriptSrc = document.currentScript.src;
                const baseUrl = scriptSrc.substring(0, scriptSrc.lastIndexOf('/') + 1);
                const r = await fetch(`${baseUrl}config.json?_=${Date.now()}`);
                if (r.ok) {
                    const overrides = await r.json();
                    config = { ...config, ...overrides };
                    console.log(`[ASS] config.json loaded via document.currentScript: ${baseUrl}config.json`);
                    loaded = true;
                }
            } catch (e) {
                console.warn('[ASS] document.currentScript strategy failed:', e.message);
            }
        }

        // Strategy 3: look for all script tags and find our extension's script
        if (!loaded) {
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