// settings.js — Agent-StateSync Constants, Settings, and Utilities
//
// All constant definitions, default settings, settings CRUD operations,
// and small utility functions (hashing, status text, debug output).
//
// LLM settings (URLs, templates, backends) are now managed by the Agent.
// STe only sends non-LLM settings via POST /api/config.
// LLM health and config are fetched from GET /api/backends/health.
// File Version: 2.1.0

import state from './state.js';
import defaultConfig from './default-config.js';

// #############################################
// # 1. Constants & Default Settings
// #############################################

export const EXTENSION_NAME = 'Agent-StateSync';
export const SETTINGS_KEY = 'agent_statesync_settings';
export const META_KEY_SESSION = 'world_session_id';
export const META_KEY_COUNTER = 'ass_msg_counter';
export const META_KEY_INITIALIZED = 'ass_session_initialized';
export const PROMPT_SETTINGS_KEY = 'agent_statesync_prompt_settings';

// Key used to store character config data inside the character card's
// data.extensions object.  Persists with the card on export/import.
export const CHAR_CONFIG_EXT_KEY = 'agent_statesync';

export const THINKING_OPTIONS = [
    { value: 0, label: '0 (Disabled)' },
    { value: 1, label: '1 (Fast)' },
    { value: 2, label: '2 (Thorough)' },
];

export const REFINEMENT_OPTIONS = [
    { value: 0, label: '0 (Disabled)' },
    { value: 1, label: '1 (Single Pass)' },
];

export const HISTORY_OPTIONS = [
    { value: 2, label: '2 messages (minimal context)' },
    { value: 4, label: '4 messages' },
    { value: 6, label: '6 messages' },
    { value: 8, label: '8 messages' },
    { value: 0, label: '0 (send all - no trimming)' },
];

export const HEALTH_CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
export const HEALTH_CHECK_TIMEOUT_MS = 5000;   // 5 second timeout per check

// LLM settings have been moved to the Agent side. STe only stores non-LLM settings.
export const defaultSettings = {
    enabled: false,
    bypassMode: false,          // When true, don't connect to Agent — return dummy responses
    thinkingSteps: 0,
    refinementSteps: 0,
    historyCount: 2,
};

/**
 * Load prompt settings from ST extensionSettings, falling back to defaults.
 */
export function loadPromptSettings() {
    const saved = state.context.extensionSettings?.[PROMPT_SETTINGS_KEY];
    if (saved && typeof saved === 'object') return saved;
    return JSON.parse(JSON.stringify(defaultConfig.prompt_settings));
}

/**
 * Save prompt settings to ST extensionSettings.
 */
export function savePromptSettings(settings) {
    state.context.extensionSettings[PROMPT_SETTINGS_KEY] = settings;
    state.context.saveSettingsDebounced();
}

/**
 * Build the final prompt_settings payload for the Agent.
 * Merges global defaults with per-character overrides.
 * Per-character overrides only exist for the 8 character-specific settings.
 *
 * @param {object|null} charOverrides - From char card extensions, or null
 * @returns {object} Merged prompt_settings for the init payload
 */
export function buildPromptSettingsPayload(charOverrides) {
    const global = loadPromptSettings();
    const result = { ...global };

    if (charOverrides && typeof charOverrides === 'object') {
        // Only the 8 per-character settings can be overridden
        const overridableKeys = [
            'perspective', 'tense', 'tone', 'content_rating',
            'extraction_strictness', 'detail_level', 'language', 'relationship_depth',
        ];
        for (const key of overridableKeys) {
            if (charOverrides[key] !== undefined && charOverrides[key] !== null && charOverrides[key] !== '' && charOverrides[key] !== 'global_default') {
                result[key] = charOverrides[key];
            }
        }
    }

    return result;
}

// Debug command definitions for the debug panel dropdown
export const DEBUG_COMMANDS = [
    { value: '', label: '-- Select debug command --' },
    { value: 'chat_mode', label: 'Chat Mode Detection' },
    { value: 'context_dump', label: 'Dump ST Context' },
    { value: 'chat_ids', label: 'Chat ID & Group ID' },
    { value: 'load_groups', label: 'Load & Dump Groups' },
    { value: 'find_group', label: 'Find Active Group' },
    { value: 'group_members', label: 'Group Members / Single Char' },
    { value: 'preview_meta', label: 'Preview SYSTEM_META' },
    { value: 'init_payload', label: 'Preview Init Payload' },
    { value: 'session_lookup', label: 'Session Metadata' },
    { value: 'last_intercept', label: 'Last Intercepted Request' },
    { value: 'persona', label: 'Persona Search' },
];

// #############################################
// # 2. Settings Get/Save/Sync
// #############################################

export function getSettings() {
    const stored = state.context.extensionSettings[SETTINGS_KEY];
    const merged = { ...defaultSettings, ...(stored || {}) };
    return merged;
}

export function isBypassMode() {
    // When debug mode is off, bypass is always off regardless of saved setting.
    // When debug mode is on, bypass depends on the bypassMode toggle.
    if (!state.debug) return false;
    return getSettings().bypassMode;
}

export function saveSettings(settings) {
    state.context.extensionSettings[SETTINGS_KEY] = settings;
    state.context.saveSettingsDebounced();
}

/**
 * Store LLM config from Agent's /api/backends/health response into state.
 * Dispatches 'ass-llm-config-changed' so agent-url.js can update the display.
 *
 * Expected /api/backends/health response format:
 * {
 *   "last_changed": "2026-05-02@23h-54m-56s-787ms",
 *   "rp_llm": { "alias": "localhost:5001", "health": "Healthy" },
 *   "instruct_backends": [
 *     { "alias": "PC", "health": "Healthy" },
 *     { "alias": "192.168.0.51:5000", "health": "unknown" }
 *   ]
 * }
 *
 * Health values: "Healthy" | "unknown" | "Unhealthy" | "Disabled"
 */
export function storeLlmConfig(data) {
    let changed = false;

    if (data.rp_llm) {
        state.agentLlmConfig.rp_llm = {
            alias: data.rp_llm.alias || '',
            health: data.rp_llm.health || 'unknown',
        };
        changed = true;
    }
    if (Array.isArray(data.instruct_backends)) {
        state.agentLlmConfig.instruct_backends = data.instruct_backends.map(b => ({
            alias: b.alias || '',
            health: b.health || 'unknown',
        }));
        changed = true;
    }

    // Track last_changed timestamp
    if (data.last_changed !== undefined) {
        const prevChanged = state.lastChanged;
        state.lastChanged = data.last_changed;
        // If the timestamp changed, config was updated on the Agent side
        if (prevChanged !== null && prevChanged !== data.last_changed) {
            console.log(`[${EXTENSION_NAME}] Agent LLM config changed at ${data.last_changed}`);
        }
    }

    if (changed) {
        // Notify agent-url.js to update the read-only LLM displays.
        // Using a custom event avoids circular dependency between
        // settings.js and agent-url.js.
        window.dispatchEvent(new CustomEvent('ass-llm-config-changed'));
    }
}

/**
 * Check if the RP LLM is healthy enough to generate messages.
 * RP LLM must be "Healthy" for message generation.
 */
export function isRpLlmHealthy() {
    return state.agentLlmConfig.rp_llm.health === 'Healthy';
}

/**
 * Check if at least one instruct backend is healthy.
 * At least one instruct backend must be "Healthy" to do init.
 */
export function hasHealthyInstructBackend() {
    return state.agentLlmConfig.instruct_backends.some(b => b.health === 'Healthy');
}

/**
 * Push non-LLM settings to the Agent.
 * The Agent may respond with its LLM config for STe to apply.
 *
 * @param {object} settings - The current settings object
 * @param {string|null} originOverride - Agent origin URL (optional)
 */
export async function syncConfigToAgent(settings, originOverride) {
    if (!settings.enabled) return;
    if (isBypassMode()) {
        console.log(`[${EXTENSION_NAME}] [BYPASS] Config sync skipped. Would have sent:`, {
            thinking_steps: settings.thinkingSteps,
            refinement_steps: settings.refinementSteps,
        });
        state.configSynced = true;
        return;
    }

    // Resolve origin — use override if provided, otherwise read from ST context
    let origin = originOverride;
    if (!origin) {
        try {
            const customUrl = state.context.chatCompletionSettings?.custom_url;
            if (customUrl) {
                origin = new URL(customUrl).origin;
            }
        } catch (e) {
            // ST setting not a valid URL or not set
        }
    }

    if (!origin) {
        console.warn(`[${EXTENSION_NAME}] Cannot sync config - no Agent URL available yet. Will sync on first request.`);
        return;
    }

    // STe only sends non-LLM settings.
    const configPayload = {
        thinking_steps: settings.thinkingSteps,
        refinement_steps: settings.refinementSteps,
    };

    try {
        const resp = await fetch(`${origin}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configPayload),
        });

        if (resp.ok) {
            state.configSynced = true;
            console.log(`[${EXTENSION_NAME}] Config synced to Agent.`, Object.keys(configPayload));

            // The Agent may respond with LLM config — parse and store it.
            try {
                const data = await resp.json();
                if (data && (data.rp_llm || data.instruct_backends)) {
                    storeLlmConfig(data);
                }
            } catch (e) {
                // Response may not include LLM config — that's OK
            }
        } else {
            console.warn(`[${EXTENSION_NAME}] Agent config sync returned ${resp.status}. Will retry.`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Agent config sync failed (Agent may not be running yet):`, err.message);
    }
}

// #############################################
// # 11. Utility Functions
// #############################################

/**
 * Simple string hash for comparing message content across requests.
 * NOTE: pipeline.js keeps its own private copy to avoid a circular
 * dependency chain (pipeline → session → settings → pipeline).
 */
export function hashStr(str) {
    let hash = 0;
    const s = str || '';
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(36);
}

/**
 * Update the small status text in the settings panel.
 */
export function updateStatus(text, color) {
    const el = $('#ass-status');
    if (el.length) {
        el.text('Status: ' + text).css('color', color || 'var(--fg_dim)');
    }
}

/**
 * Write text to the debug output textbox.
 */
export function setDebugOutput(text) {
    const $box = $('#ass-debug-output');
    if ($box.length) {
        $box.val(text);
        // Auto-scroll to top
        $box.scrollTop(0);
    }
}