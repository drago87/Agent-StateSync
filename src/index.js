// index.js — Agent-StateSync Entry Point
//
// Webpack entry. Imports and initializes the extension.
// manifest.json points to dist/index.js (the built output).
// File Version: 1.0.1

import defaultConfig from './default-config.js';
import { init } from './ui.js';
import { registerSlashCommands } from './commands.js';

(async function main() {
    let config = { ...defaultConfig };
    try {
        const scriptSrc = document.currentScript?.src;
        if (scriptSrc) {
            const baseUrl = scriptSrc.substring(0, scriptSrc.lastIndexOf('/') + 1);
            const resp = await fetch(`${baseUrl}config.json?_=${Date.now()}`);
            if (resp.ok) {
                const overrides = await resp.json();
                config = { ...config, ...overrides };
            }
        }
    } catch (e) {}
    await init(config.debug === true);
    registerSlashCommands();
})();
