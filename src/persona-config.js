// persona-config.js — Agent-StateSync Persona Config Panel
// File Version: 3.1.0
//
// Brain button in the Persona controls button bar.
// Opens a panel where the user can configure per-persona:
//   - Prompt Configs Override
//   - Database Tracked Fields Additions
//
// Stored in extensionSettings, keyed by persona avatar filename.
// Each persona gets its own independent overrides.
//
// tracked_field_additions uses CATEGORIZED ARRAY storage format (v3):
//   { character: [{ name, type, hint, ... }], scenario: [...], shared: [...] }
//   Payload format: { character: {...}, scenario: {...}, shared: {...} }
//   Empty categories are excluded from payload.
//

import state from './state.js';
import { EXTENSION_NAME } from './settings.js';
import {
    renderCharPromptOverrides, readCharPromptOverridesFromUI,
    bindCharPromptOverrideEvents,
} from './prompt-settings.js';
import {
    renderTFAdditions, readTFAdditionsFromUI,
    bindTFAdditionEvents,
    normalizeAdditions, injectBtfCSS,
} from './brain-tf-additions.js';
import { tfAdditionsCategorizedToPayload } from './char-config.js';
import { getFreshContext } from './groups.js';

// #############################################
// # Constants & Defaults
// #############################################

const PERSONA_CONFIG_KEY = 'agent_statesync_persona_configs';

const DEFAULT_PERSONA_CONFIG = {
    prompt_settings_override: {},
    tracked_field_additions: { character: [], scenario: [], shared: [] },  // CATEGORIZED arrays (v3)
    persona_type: 'Character',  // Character | Narrator | System | Observer
};

const VALID_PERSONA_TYPES = ['Character', 'Narrator', 'System', 'Observer'];

// #############################################
// # Array <-> Object Conversion (local helpers)
// #############################################

/**
 * Migrate old object-format tracked_field_additions to array format.
 * Supports nested sub-groups and secret field.
 */
function migrateTFAdditionsToArray(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj || [];
    return Object.entries(obj).map(([name, field]) => {
        if (field && field.fields !== undefined) {
            const entry = {
                name: name,
                description: field.description || '',
                fields: migrateTFAdditionsToArray(field.fields),
            };
            if (field.is_dynamic) entry.is_dynamic = field.is_dynamic;
            if (field.extends_only) entry.extends_only = true;
            if (field.secret) entry.secret = true;
            if (field.required) entry.required = true;
            if (field.immutable) entry.immutable = true;
            return entry;
        }
        const entry = {
            name: name,
            type: field.type || 'string',
            hint: field.hint || '',
        };
        if (field.extends_only) entry.extends_only = true;
        if (field.is_dynamic) entry.is_dynamic = field.is_dynamic;
        if (field.secret) entry.secret = true;
        if (field.required) entry.required = true;
        if (field.immutable) entry.immutable = true;
        return entry;
    });
}

// #############################################
// # Persona Identification
// #############################################

function getCurrentPersonaAvatar() {
    const ctx = getFreshContext();
    const pu = ctx.powerUserSettings;
    if (!pu) return null;

    const currentName = ctx.name1 || '';
    const currentDesc = pu.persona_description || '';

    if (!currentName && !currentDesc) return null;

    const descs = pu.persona_descriptions || {};

    if (currentDesc) {
        for (const [avatar, data] of Object.entries(descs)) {
            if (data.description === currentDesc) return avatar;
        }
    }

    if (currentName) {
        const personas = pu.personas || {};
        for (const [avatar, name] of Object.entries(personas)) {
            if (name === currentName) return avatar;
        }
    }

    return null;
}

function getCurrentPersonaLabel() {
    return getFreshContext().name1 || 'Unknown Persona';
}

// #############################################
// # Config Read / Write
// #############################################

function readPersonaConfig() {
    const avatar = getCurrentPersonaAvatar();
    if (!avatar) {
        return { ...DEFAULT_PERSONA_CONFIG, prompt_settings_override: {},
            tracked_field_additions: { character: [], scenario: [], shared: [] } };
    }

    const ctx = getFreshContext();
    const configs = ctx.extensionSettings?.[PERSONA_CONFIG_KEY] || {};
    const stored = configs[avatar];

    if (!stored) {
        return { ...DEFAULT_PERSONA_CONFIG, prompt_settings_override: {},
            tracked_field_additions: { character: [], scenario: [], shared: [] } };
    }

    // Normalize tracked_field_additions to categorized format (v3)
    const tfAdditions = normalizeAdditions(stored.tracked_field_additions);

    // Persona type
    let personaType = stored.persona_type || 'Character';
    if (!VALID_PERSONA_TYPES.includes(personaType)) personaType = 'Character';

    return {
        prompt_settings_override: stored.prompt_settings_override || {},
        tracked_field_additions: JSON.parse(JSON.stringify(tfAdditions)),
        persona_type: personaType,
    };
}

function writePersonaConfig(config) {
    const avatar = getCurrentPersonaAvatar();
    if (!avatar) {
        console.warn(`[${EXTENSION_NAME}] No active persona — cannot save persona config`);
        return;
    }

    const ctx = getFreshContext();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    if (!ctx.extensionSettings[PERSONA_CONFIG_KEY]) {
        ctx.extensionSettings[PERSONA_CONFIG_KEY] = {};
    }

    // Normalize additions before saving
    const normalizedAdditions = normalizeAdditions(config.tracked_field_additions);

    // Validate persona type
    let personaType = config.persona_type || 'Character';
    if (!VALID_PERSONA_TYPES.includes(personaType)) personaType = 'Character';

    ctx.extensionSettings[PERSONA_CONFIG_KEY][avatar] = {
        prompt_settings_override: config.prompt_settings_override || {},
        tracked_field_additions: normalizedAdditions,
        persona_type: personaType,
    };

    // Use state.context for saveSettingsDebounced since it's a function reference
    // that still works even on stale objects
    if (typeof state.context.saveSettingsDebounced === 'function') {
        state.context.saveSettingsDebounced();
    }
    console.log(`[${EXTENSION_NAME}] Persona config saved for "${getCurrentPersonaLabel()}" (${avatar})`);
}

// #############################################
// # CSS Injection
// #############################################

function injectPersonaCSS() {
    if ($('#ass-persona-css').length) return;

    const css = `
    <style id="ass-persona-css">
        #ass-persona-btn {
            cursor: pointer;
            color: var(--fg_dim);
            transition: color 0.2s;
        }
        #ass-persona-btn:hover {
            color: #9b59b6;
        }

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
            min-width: 1000px !important;
            width: 1000px !important;
            max-width: 95vw;
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
        <div id="ass-persona-panel" class="ass-persona-panel">

            <div class="ass-brain-header">
                <h3><i class="fa-solid fa-brain"></i> Agent Persona Config</h3>
                <button id="ass-persona-close" class="ass-brain-close" type="button">&times;</button>
            </div>

            <div style="margin-bottom:14px; font-size:12px; color:var(--fg_dim);">
                Config for persona: <b style="color:var(--fg);">${label}</b>
            </div>

            <!-- Section 0: Persona Type -->
            <div class="ass-brain-section">
                <div class="ass-brain-section-title">
                    <i class="fa-solid fa-user-tag"></i> Persona Type
                </div>
                <div class="ass-brain-field">
                    <select id="ass-persona-type" class="text_pole wide">
                        ${VALID_PERSONA_TYPES.map(t =>
                            `<option value="${t}" ${config.persona_type === t ? 'selected' : ''}>${t}</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="ass-brain-info">
                    How the Agent treats this persona.<br>
                    <b>Character</b> — the persona is a participant in the roleplay.<br>
                    <b>Narrator</b> — the persona narrates the story from a third-person perspective.<br>
                    <b>System</b> — the persona provides system-level instructions or guidance.<br>
                    <b>Observer</b> — the persona observes without directly participating.
                </div>
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
                ${renderTFAdditions(config.tracked_field_additions, { allowSecret: true })}
                <div class="ass-brain-info">
                    Add persona-specific fields to track in the state database.
                    These are merged with the global tracked fields when sending to the Agent.
                    <br>
                    <i class="fa-solid fa-eye-slash" style="color:#9b59b6;"></i> = Secret — hidden from other characters (Character category only).
                    <i class="fa-solid fa-asterisk" style="color:#e67e22;"></i> = Required — must be provided.
                    <i class="fa-solid fa-lock" style="color:#e74c3c;"></i> = Immutable — will only be written during initialization.
                    <i class="fa-solid fa-maximize" style="color:#3498db;"></i> = Extend — only extends, will not overwrite.
                    <i class="fa-solid fa-shuffle" style="color:#27ae60;"></i> = Dynamic — entries keyed by name (click for options).
                    <br>
                    <i class="fa-solid fa-sitemap" style="opacity:0.7;"></i> = Convert to group with sub-fields.
                </div>
            </div>

        </div>
    </div>`;

    $('body').append(html);

    // Inject BTF CSS for category styles
    injectBtfCSS();

    // --- Bind events ---
    $('#ass-persona-close').on('click', closePersonaConfigPanel);
    $('#ass-persona-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-persona-overlay')) closePersonaConfigPanel();
    });
    $(document).on('keydown.persona-panel', function (e) {
        if (e.key === 'Escape') closePersonaConfigPanel();
    });

    bindCharPromptOverrideEvents('#ass-persona-panel');
    bindTFAdditionEvents('#ass-persona-panel');
}

function closePersonaConfigPanel() {
    const config = readCurrentPersonaConfig();
    writePersonaConfig(config);

    $('#ass-persona-overlay').remove();
    $(document).off('keydown.persona-panel');
    $(document).off('change.ass-ps-override');
}

function readCurrentPersonaConfig() {
    const personaType = $('#ass-persona-type').val() || 'Character';
    return {
        prompt_settings_override: readCharPromptOverridesFromUI('#ass-persona-panel'),
        tracked_field_additions: readTFAdditionsFromUI('#ass-persona-panel'),
        persona_type: VALID_PERSONA_TYPES.includes(personaType) ? personaType : 'Character',
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
 * Get the persona type for the active persona.
 * Returns one of: 'Character', 'Narrator', 'System', 'Observer'
 */
export function getPersonaType() {
    const config = readPersonaConfig();
    return config.persona_type || 'Character';
}

/**
 * Get tracked field additions for the active persona in payload format.
 * Converts categorized arrays to categorized dicts.
 * Returns null if no additions exist in any category.
 */
export function getPersonaTrackedFieldAdditions() {
    const avatar = getCurrentPersonaAvatar();
    const config = readPersonaConfig();
    const result = tfAdditionsCategorizedToPayload(config.tracked_field_additions);
    console.log(`[${EXTENSION_NAME}] getPersonaTrackedFieldAdditions: avatar="${avatar}", additions=${JSON.stringify(config.tracked_field_additions)}, result=${result ? JSON.stringify(result) : 'null'}`);
    return result;
}

// #############################################
// # Initialization
// #############################################

export function initPersonaConfig() {
    injectPersonaCSS();
    injectBtfCSS();
    injectPersonaBrainButton();
    console.log(`[${EXTENSION_NAME}] Persona config module loaded.`);
}