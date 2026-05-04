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
// Supports nested sub-fields and secret marking.
//
// File Version: 2.0.0

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
    persona_type: 'character',
    prompt_settings_override: {},
    tracked_field_additions: [],
};

// Persona type definitions
const PERSONA_TYPES = [
    {
        value: 'character',
        label: 'Character',
        icon: 'fa-solid fa-user',
        description: 'The persona is treated as a character in the story. Other characters will interact with them naturally as a peer participant.',
    },
    {
        value: 'narrator',
        label: 'Narrator',
        icon: 'fa-solid fa-book-open',
        description: 'The persona describes what happens in broad strokes, setting scenes and guiding the narrative. Characters treat the persona\'s input as suggestions to play out.',
    },
    {
        value: 'system',
        label: 'System',
        icon: 'fa-solid fa-microchip',
        description: 'The persona gives direct instructions that characters treat as orders. For example, telling a character to do something and that character will follow through.',
    },
    {
        value: 'observer',
        label: 'Observer',
        icon: 'fa-solid fa-eye',
        description: 'The persona watches and comments on events without directly influencing the narrative. Characters are aware of the persona but don\'t act on their input.',
    },
];

// #############################################
// # Array <-> Object Migration
// #############################################

/**
 * Migrate old object-format tracked_field_additions to new array format.
 * Supports nested sub-groups and secret field.
 */
function migrateTFAdditionsToArray(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj || [];
    return Object.entries(obj).map(([name, field]) => {
        if (field && field.fields !== undefined) {
            const group = {
                name: name,
                description: field.description || '',
                is_dynamic: field.is_dynamic || false,
                secret: field.secret || false,
                fields: migrateTFAdditionsToArray(field.fields),
            };
            if (field.extends_only) group.extends_only = true;
            if (field.required) group.required = true;
            if (field.immutable) group.immutable = true;
            return group;
        }
        const simple = {
            name: name,
            type: field.type || 'string',
            hint: field.hint || '',
            extends_only: field.extends_only || false,
            secret: field.secret || false,
        };
        if (field.is_dynamic) simple.is_dynamic = true;
        if (field.required) simple.required = true;
        if (field.immutable) simple.immutable = true;
        return simple;
    });
}

/**
 * Convert array-format tracked_field_additions to object format
 * for the Agent init payload. Supports arbitrary nesting and secret field.
 */
function tfAdditionsArrayToObject(additions) {
    if (!Array.isArray(additions)) return additions || null;
    if (additions.length === 0) return null;

    const obj = {};
    for (const entry of additions) {
        const name = entry.name || '';
        if (!name) continue;

        if (entry.fields !== undefined) {
            const subFields = tfAdditionsArrayToObject(entry.fields);
            obj[name] = {
                description: entry.description || '',
                is_dynamic: entry.is_dynamic || false,
                fields: subFields || {},
            };
            if (entry.extends_only) obj[name].extends_only = true;
            if (entry.secret) obj[name].secret = true;
            if (entry.required) obj[name].required = true;
            if (entry.immutable) obj[name].immutable = true;
        } else {
            obj[name] = {
                type: entry.type || 'string',
                hint: entry.hint || '',
                extends_only: entry.extends_only || false,
            };
            if (entry.is_dynamic) obj[name].is_dynamic = true;
            if (entry.secret) obj[name].secret = true;
            if (entry.required) obj[name].required = true;
            if (entry.immutable) obj[name].immutable = true;
        }
    }
    return Object.keys(obj).length > 0 ? obj : null;
}

// #############################################
// # Persona Identification
// #############################################

function getCurrentPersonaAvatar() {
    const pu = state.context.powerUserSettings;
    if (!pu) return null;

    const currentName = state.context.name1 || '';
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
    return state.context.name1 || 'Unknown Persona';
}

// #############################################
// # Config Read / Write
// #############################################

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

    let tfAdditions = stored.tracked_field_additions;
    if (tfAdditions && !Array.isArray(tfAdditions) && typeof tfAdditions === 'object') {
        tfAdditions = migrateTFAdditionsToArray(tfAdditions);
    }

    return {
        persona_type: stored.persona_type || 'character',
        prompt_settings_override: stored.prompt_settings_override || {},
        tracked_field_additions: Array.isArray(tfAdditions)
            ? JSON.parse(JSON.stringify(tfAdditions))
            : [],
    };
}

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
        persona_type: config.persona_type || 'character',
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
            width: 780px;
            max-width: 92vw;
            max-height: 85vh;
            overflow-y: auto;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            animation: ass-brain-slide-in 0.2s ease-out;
        }

        /* Icon toggle buttons (for brain-tf-additions) */
        .ass-btf-icon-toggle {
            background: none;
            border: none;
            padding: 2px 4px;
            cursor: pointer;
            color: var(--fg_dim);
            opacity: 0.35;
            font-size: 13px;
            transition: opacity 0.2s, color 0.2s;
            flex-shrink: 0;
            line-height: 1;
        }
        .ass-btf-icon-toggle:hover {
            opacity: 0.7;
        }
        .ass-btf-icon-toggle.active {
            opacity: 1;
        }
        .ass-btf-secret-toggle.active {
            color: #9b59b6;
        }
        .ass-btf-required-toggle.active {
            color: #e67e22;
        }
        .ass-btf-immutable-toggle.active {
            color: #e74c3c;
        }
        .ass-btf-extend-toggle.active {
            color: #3498db;
        }
        .ass-btf-dynamic-toggle.active {
            color: #2ecc71;
        }

        /* Persona type selector */
        .ass-persona-type-section {
            margin-bottom: 16px;
        }
        .ass-persona-type-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 8px;
        }
        .ass-persona-type-row select {
            flex: 1;
        }
        .ass-persona-type-icon {
            font-size: 18px;
            width: 24px;
            text-align: center;
            transition: color 0.2s;
        }
        .ass-persona-type-icon.type-character { color: #9b59b6; }
        .ass-persona-type-icon.type-narrator { color: #3498db; }
        .ass-persona-type-icon.type-system { color: #e74c3c; }
        .ass-persona-type-icon.type-observer { color: #f0ad4e; }
        .ass-persona-type-desc {
            font-size: 12px;
            color: var(--fg_dim);
            line-height: 1.5;
            padding: 8px 10px;
            background: rgba(128, 128, 128, 0.06);
            border: 1px solid rgba(128, 128, 128, 0.12);
            border-radius: 4px;
            transition: background 0.2s;
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
            <div class="ass-persona-type-section">
                <div class="ass-brain-section-title">
                    <i class="fa-solid fa-masks-theater"></i> Persona Type
                </div>
                <div class="ass-persona-type-row">
                    <i id="ass-persona-type-icon" class="ass-persona-type-icon type-${config.persona_type} ${getPersonaTypeIcon(config.persona_type)}"></i>
                    <select id="ass-persona-type" class="text_pole wide">
                        ${PERSONA_TYPES.map(t =>
                            `<option value="${t.value}" ${t.value === config.persona_type ? 'selected' : ''}>${t.label}</option>`
                        ).join('')}
                    </select>
                </div>
                <div id="ass-persona-type-desc" class="ass-persona-type-desc">
                    ${getPersonaTypeDescription(config.persona_type)}
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
                <div style="margin-top:6px; display:flex; gap:6px;">
                    <button id="ass-brain-add-tf" class="menu_button" type="button">
                        <i class="fa-solid fa-plus"></i> Add Field
                    </button>
                    <button id="ass-brain-add-tf-group" class="menu_button" type="button">
                        <i class="fa-solid fa-folder-plus"></i> Add Group Field
                    </button>
                </div>
                <div class="ass-brain-info">
                    Add persona-specific fields to track in the state database.<br>
                    These are merged with the global tracked fields when sending to the Agent.<br>
                    <i class="fa-solid fa-eye-slash" style="color:#9b59b6;"></i> <b>Secret</b> — only sent to the character it belongs to.
                    &nbsp;&nbsp;
                    <i class="fa-solid fa-asterisk" style="color:#e67e22;"></i> <b>Required</b> — this field must be filled in.
                    &nbsp;&nbsp;
                    <i class="fa-solid fa-lock" style="color:#e74c3c;"></i> <b>Immutable</b> — will only be written during initialization.
                    &nbsp;&nbsp;
                    <i class="fa-solid fa-code-merge" style="color:#3498db;"></i> <b>Extend</b> — only adds to this field, never overwrites.
                    &nbsp;&nbsp;
                    <i class="fa-solid fa-diagram-project" style="color:#2ecc71;"></i> <b>Dynamic</b> — creates per-character entries (e.g. relationships).
                </div>
            </div>

        </div>
    </div>`;

    $('body').append(html);

    // --- Bind events ---
    $('#ass-persona-close').on('click', closePersonaConfigPanel);
    $('#ass-persona-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-persona-overlay')) closePersonaConfigPanel();
    });
    $(document).on('keydown.persona-panel', function (e) {
        if (e.key === 'Escape') closePersonaConfigPanel();
    });

    // Persona type dropdown — update icon + description on change
    $('#ass-persona-type').on('change', function () {
        const type = $(this).val();
        const $icon = $('#ass-persona-type-icon');
        $icon.attr('class', `ass-persona-type-icon type-${type} ${getPersonaTypeIcon(type)}`);
        $('#ass-persona-type-desc').html(getPersonaTypeDescription(type));
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
    return {
        persona_type: $('#ass-persona-type').val() || 'character',
        prompt_settings_override: readCharPromptOverridesFromUI('#ass-persona-panel'),
        tracked_field_additions: readTFAdditionsFromUI('#ass-persona-panel'),
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
 * Returns 'character' by default.
 */
export function getPersonaType() {
    const config = readPersonaConfig();
    return config.persona_type || 'character';
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

/**
 * Get the icon class for a persona type.
 */
function getPersonaTypeIcon(type) {
    const def = PERSONA_TYPES.find(t => t.value === type);
    return def ? def.icon : 'fa-solid fa-user';
}

/**
 * Get the description for a persona type.
 */
function getPersonaTypeDescription(type) {
    const def = PERSONA_TYPES.find(t => t.value === type);
    return def ? def.description : '';
}

export function initPersonaConfig() {
    injectPersonaCSS();
    injectPersonaBrainButton();
    console.log(`[${EXTENSION_NAME}] Persona config module loaded.`);
}