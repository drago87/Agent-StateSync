// persona-config.js — Agent-StateSync Persona Config Panel
//
// Brain button in the Persona controls button bar.
// Opens a panel where the user can configure per-persona:
//   - Prompt Configs Override
//   - Database Tracked Fields Additions
//
// Stored in extensionSettings, keyed by persona avatar filename.
// Each persona gets its own independent overrides.
//
// File Version: 1.0.1

import state from './state.js';
import { EXTENSION_NAME } from './settings.js';
import {
    renderCharPromptOverrides, readCharPromptOverridesFromUI,
    bindCharPromptOverrideEvents,
} from './prompt-settings.js';
import {
    renderTFAdditions, readTFAdditionsFromUI,
    bindTFAdditionEvents,
} from './brain-tf-additions.js';

// #############################################
// # Constants & Defaults
// #############################################

const PERSONA_CONFIG_KEY = 'agent_statesync_persona_configs';

const DEFAULT_PERSONA_CONFIG = {
    prompt_settings_override: {},
    tracked_field_additions: [],
};

// #############################################
// # Array <-> Object Migration
// #############################################

/**
 * Migrate old object-format tracked_field_additions to new array format.
 */
function migrateTFAdditionsToArray(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj || [];
    return Object.entries(obj).map(([name, field]) => {
        if (field && field.fields !== undefined) {
            return {
                name: name,
                description: field.description || '',
                is_dynamic: field.is_dynamic || false,
                fields: Object.entries(field.fields || {}).map(([subName, subField]) => ({
                    name: subName,
                    type: subField.type || 'string',
                    hint: subField.hint || '',
                    extends_only: subField.extends_only || false,
                })),
            };
        }
        return {
            name: name,
            type: field.type || 'string',
            hint: field.hint || '',
            extends_only: field.extends_only || false,
        };
    });
}

/**
 * Convert array-format tracked_field_additions to object format
 * for the Agent init payload.
 */
function tfAdditionsArrayToObject(additions) {
    if (!Array.isArray(additions)) return additions || null;
    if (additions.length === 0) return null;

    const obj = {};
    for (const entry of additions) {
        const name = entry.name || '';
        if (!name) continue;

        if (entry.fields !== undefined) {
            const subFields = {};
            for (const sub of (entry.fields || [])) {
                const subName = sub.name || '';
                if (!subName) continue;
                subFields[subName] = {
                    type: sub.type || 'string',
                    hint: sub.hint || '',
                    extends_only: sub.extends_only || false,
                };
            }
            obj[name] = {
                description: entry.description || '',
                is_dynamic: entry.is_dynamic || false,
                fields: subFields,
            };
        } else {
            obj[name] = {
                type: entry.type || 'string',
                hint: entry.hint || '',
                extends_only: entry.extends_only || false,
            };
        }
    }
    return Object.keys(obj).length > 0 ? obj : null;
}

// #############################################
// # Persona Identification
// #############################################

/**
 * Find the avatar filename of the currently active persona.
 * Matches by description first (unique), then by name.
 */
function getCurrentPersonaAvatar() {
    const pu = state.context.powerUserSettings;
    if (!pu) return null;

    const currentName = state.context.name1 || '';
    const currentDesc = pu.persona_description || '';

    if (!currentName && !currentDesc) return null;

    const descs = pu.persona_descriptions || {};

    // Match by description (most reliable — descriptions are usually unique)
    if (currentDesc) {
        for (const [avatar, data] of Object.entries(descs)) {
            if (data.description === currentDesc) return avatar;
        }
    }

    // Fallback: match by name
    if (currentName) {
        const personas = pu.personas || {};
        for (const [avatar, name] of Object.entries(personas)) {
            if (name === currentName) return avatar;
        }
    }

    return null;
}

/**
 * Get a human-readable label for the current persona.
 */
function getCurrentPersonaLabel() {
    return state.context.name1 || 'Unknown Persona';
}

// #############################################
// # Config Read / Write
// #############################################

/**
 * Read the stored persona config for the active persona.
 * Returns a validated copy, or the defaults.
 */
function readPersonaConfig() {
    const avatar = getCurrentPersonaAvatar();
    if (!avatar) {
        return { ...DEFAULT_PERSONA_CONFIG, prompt_settings_override: {}, tracked_field_additions: [] };
    }

    const configs = state.context.extensionSettings?.[PERSONA_CONFIG_KEY] || {};
    const stored = configs[avatar];

    if (!stored) {
        return { ...DEFAULT_PERSONA_CONFIG, prompt_settings_override: {}, tracked_field_additions: [] };
    }

    // Migrate tracked_field_additions from object to array format if needed
    let tfAdditions = stored.tracked_field_additions;
    if (tfAdditions && !Array.isArray(tfAdditions) && typeof tfAdditions === 'object') {
        tfAdditions = migrateTFAdditionsToArray(tfAdditions);
    }

    return {
        prompt_settings_override: stored.prompt_settings_override || {},
        tracked_field_additions: Array.isArray(tfAdditions)
            ? JSON.parse(JSON.stringify(tfAdditions))
            : [],
    };
}

/**
 * Write persona config for the active persona to extensionSettings.
 */
function writePersonaConfig(config) {
    const avatar = getCurrentPersonaAvatar();
    if (!avatar) {
        console.warn(`[${EXTENSION_NAME}] No active persona — cannot save persona config`);
        return;
    }

    if (!state.context.extensionSettings) state.context.extensionSettings = {};
    if (!state.context.extensionSettings[PERSONA_CONFIG_KEY]) {
        state.context.extensionSettings[PERSONA_CONFIG_KEY] = {};
    }

    state.context.extensionSettings[PERSONA_CONFIG_KEY][avatar] = {
        prompt_settings_override: config.prompt_settings_override || {},
        tracked_field_additions: Array.isArray(config.tracked_field_additions)
            ? config.tracked_field_additions
            : [],
    };

    state.context.saveSettingsDebounced();
    console.log(`[${EXTENSION_NAME}] Persona config saved for "${getCurrentPersonaLabel()}" (${avatar})`);
}

// #############################################
// # CSS Injection
// #############################################

function injectPersonaCSS() {
    if ($('#ass-persona-css').length) return;

    const css = `
    <style id="ass-persona-css">
        /* Persona brain button */
        #ass-persona-btn {
            cursor: pointer;
            color: var(--fg_dim);
            transition: color 0.2s;
        }
        #ass-persona-btn:hover {
            color: #9b59b6;
        }

        /* Overlay and panel reuse the same classes as char-config */
        .ass-persona-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: ass-brain-fade-in 0.15s ease-out;
        }
        .ass-persona-panel {
            background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.97));
            border: 1px solid rgba(128, 128, 128, 0.3);
            border-radius: 10px;
            width: 480px;
            max-width: 90vw;
            max-height: 85vh;
            overflow-y: auto;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            animation: ass-brain-slide-in 0.2s ease-out;
        }
    </style>`;

    $('head').append(css);
}

// #############################################
// # Button Injection
// #############################################

function injectPersonaBrainButton() {
    if ($('#ass-persona-btn').length) return;

    const $btn = $('<div id="ass-persona-btn" class="menu_button fa-solid fa-brain interactable" title="Agent Persona Config" tabindex="0" role="button"></div>');

    const $bar = $('.persona_controls_buttons_block.buttons_block');
    if ($bar.length) {
        $bar.append($btn);
        $btn.on('click', togglePersonaConfigPanel);
        console.log(`[${EXTENSION_NAME}] Persona brain button injected`);
        return;
    }

    // ST not ready yet — retry
    setTimeout(injectPersonaBrainButton, 1000);
}

// #############################################
// # Panel Toggle
// #############################################

function togglePersonaConfigPanel() {
    if ($('#ass-persona-overlay').length) {
        closePersonaConfigPanel();
    } else {
        openPersonaConfigPanel();
    }
}

function openPersonaConfigPanel() {
    if ($('#ass-persona-overlay').length) return;

    const config = readPersonaConfig();
    const label = getCurrentPersonaLabel();

    const html = `
    <div id="ass-persona-overlay" class="ass-persona-overlay">
        <div class="ass-persona-panel">

            <div class="ass-brain-header">
                <h3><i class="fa-solid fa-brain"></i> Agent Persona Config</h3>
                <button id="ass-persona-close" class="ass-brain-close" type="button">&times;</button>
            </div>

            <div style="margin-bottom:14px; font-size:12px; color:var(--fg_dim);">
                Config for persona: <b style="color:var(--fg);">${label}</b>
            </div>

            <!-- Section 1: Prompt Configs Override -->
            <div class="ass-brain-section">
                <div class="ass-brain-section-title">
                    <i class="fa-solid fa-sliders"></i> Prompt Configs Override
                </div>
                <div id="ass-brain-prompt-overrides">
                    ${renderCharPromptOverrides(config.prompt_settings_override)}
                </div>
                <div class="ass-brain-info">
                    Override global prompt settings for this persona only.<br>
                    Select <b>Global Default</b> to use the value from the main settings.
                </div>
            </div>

            <!-- Section 2: Database Tracked Fields Additions -->
            <div class="ass-brain-section">
                <div class="ass-brain-section-title">
                    <i class="fa-solid fa-database"></i> Database Tracked Fields Additions
                </div>
                <div id="ass-brain-tf-additions">
                    ${renderTFAdditions(config.tracked_field_additions)}
                </div>
                <div style="margin-top:6px;">
                    <button id="ass-brain-add-tf" class="menu_button" type="button">
                        <i class="fa-solid fa-plus"></i> Add Field
                    </button>
                </div>
                <div class="ass-brain-info">
                    Add persona-specific fields to track in the state database.<br>
                    These are merged with the global tracked fields when sending to the Agent.
                </div>
            </div>

        </div>
    </div>`;

    $('body').append(html);

    // --- Bind events ---

    // Close button
    $('#ass-persona-close').on('click', closePersonaConfigPanel);

    // Click outside panel to close
    $('#ass-persona-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-persona-overlay')) {
            closePersonaConfigPanel();
        }
    });

    // Escape key to close
    $(document).on('keydown.persona-panel', function (e) {
        if (e.key === 'Escape') closePersonaConfigPanel();
    });

    // Bind prompt override events
    bindCharPromptOverrideEvents();

    // Bind tracked field addition events (handles Add Field, Add Sub-field, etc.)
    bindTFAdditionEvents();
}

function closePersonaConfigPanel() {
    const config = readCurrentPersonaConfig();
    writePersonaConfig(config);

    $('#ass-persona-overlay').remove();
    $(document).off('keydown.persona-panel');
    $(document).off('change.ass-ps-override');
}

function readCurrentPersonaConfig() {
    return {
        prompt_settings_override: readCharPromptOverridesFromUI(),
        tracked_field_additions: readTFAdditionsFromUI(),
    };
}

// #############################################
// # Public API — for session.js / pipeline.js
// #############################################

/**
 * Get prompt settings overrides for the active persona.
 * Returns null if no overrides exist.
 */
export function getPersonaPromptOverrides() {
    const config = readPersonaConfig();
    const overrides = config.prompt_settings_override;
    if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return null;
    return overrides;
}

/**
 * Get tracked field additions for the active persona.
 * Converts array storage to object format for the payload.
 * Returns null if no additions exist.
 */
export function getPersonaTrackedFieldAdditions() {
    const config = readPersonaConfig();
    return tfAdditionsArrayToObject(config.tracked_field_additions);
}

// #############################################
// # Initialization
// #############################################

export function initPersonaConfig() {
    injectPersonaCSS();
    injectPersonaBrainButton();
    console.log(`[${EXTENSION_NAME}] Persona config module loaded.`);
}