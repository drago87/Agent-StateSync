// char-config.js — Agent-StateSync Character Config Panel
//
// Brain button in the Character Sheet Bar (star/skull row).
// Opens a panel where the user defines how the Agent should parse
// the character card: as a single character, multiple characters,
// or a scenario.  Stored per-character in the card's data.extensions
// so it persists on export/import.
//
// Also contains:
//   - Prompt Configs Override (per-character prompt settings)
//   - Database Tracked Fields Additions (via brain-tf-additions.js)
//
// tracked_field_additions uses ARRAY storage format (v2):
//   [{ name: "FieldName", type, hint, extends_only, secret }, ...]
//   Arrays replace entirely on merge — no ghost fields after F5.
//
// Supports nested sub-fields and secret marking.
//
// File Version: 2.0.0

import state from './state.js';
import { EXTENSION_NAME, CHAR_CONFIG_EXT_KEY } from './settings.js';
import {
    renderCharPromptOverrides, readCharPromptOverridesFromUI,
    bindCharPromptOverrideEvents,
} from './prompt-settings.js';
import {
    renderTFAdditions, readTFAdditionsFromUI,
    renderTFContainer, bindTFAdditionEvents,
} from './brain-tf-additions.js';

// #############################################
// # Default Config
// #############################################

const DEFAULT_CHAR_CONFIG = {
    mode: 'characters',   // 'characters' | 'scenario'
    names: [''],          // array of character name strings
    prompt_settings_override: {},  // per-character prompt overrides
    tracked_field_additions: [],  // ARRAY of field entries (v2 format)
};

// #############################################
// # Panel Character Resolution
// #############################################

// Captured character ID when panel opens (needed for group chat character editing)
let panelCharId = null;

/**
 * Find the character ID by matching the avatar image filename
 * in the character editing view against state.context.characters.
 * This works in group chat where state.context.characterId is null,
 * and handles duplicate character names correctly since avatar filenames
 * are always unique (Belle.png, Belle_1.png, etc.).
 */
function findCharIdByAvatar() {
    let avatarImg = null;

    avatarImg = document.querySelector('#avatar_div img, #avatar_div .avatar img');

    if (!avatarImg?.src) {
        const panelThumb = $('#ass-brain-avatar-preview img').first();
        if (panelThumb.length && panelThumb.attr('src')) {
            avatarImg = panelThumb[0];
        }
    }

    if (!avatarImg?.src) return null;

    try {
        const url = new URL(avatarImg.src);
        const file = url.searchParams.get('file');
        if (!file) return null;
        if (!state.context.characters) return null;
        for (const [id, char] of Object.entries(state.context.characters)) {
            if (char.avatar === file) return id;
        }
    } catch (e) {
        // URL parse failed
    }
    return null;
}

// #############################################
// # Array <-> Object Migration
// #############################################

/**
 * Migrate old object-format tracked_field_additions to new array format.
 * Old: { "FieldName": { type, hint, extends_only } }
 * New: [{ name: "FieldName", type, hint, extends_only, secret }]
 * Also migrates group sub-fields from object to array, with nesting.
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
 * Array: [{ name: "X", ... }, ...]
 * Object: { "X": { ... } }
 */
function tfAdditionsArrayToObject(additions) {
    if (!Array.isArray(additions)) return additions || null;
    if (additions.length === 0) return null;

    const obj = {};
    for (const entry of additions) {
        const name = entry.name || '';
        if (!name) continue;

        if (entry.fields !== undefined) {
            // Group — recursively convert sub-fields
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
// # Character Data Access
// #############################################

/**
 * Read the stored character config from the active character's card data.
 * Returns a validated copy of the stored config, or the defaults.
 * Migrates old object-format tracked_field_additions to array on read.
 */
function readCharConfig() {
    const charId = panelCharId ?? state.context.characterId;
    const char = charId != null ? state.context.characters?.[charId] : null;

    if (char?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]) {
        const stored = char.data.extensions[CHAR_CONFIG_EXT_KEY];

        // Migrate tracked_field_additions from object to array format (one-time)
        let tfAdditions = stored.tracked_field_additions;
        if (tfAdditions && !Array.isArray(tfAdditions) && typeof tfAdditions === 'object') {
            tfAdditions = migrateTFAdditionsToArray(tfAdditions);
            char.data.extensions[CHAR_CONFIG_EXT_KEY].tracked_field_additions = tfAdditions;
        }

        return {
            mode: (stored.mode === 'scenario') ? 'scenario' : 'characters',
            names: Array.isArray(stored.names) && stored.names.length > 0 ? [...stored.names] : [''],
            prompt_settings_override: stored.prompt_settings_override || stored.prompt_settings || {},
            tracked_field_additions: Array.isArray(tfAdditions)
                ? [...tfAdditions.map(e => JSON.parse(JSON.stringify(e)))]
                : [],
        };
    }

    return { ...DEFAULT_CHAR_CONFIG, names: [''], prompt_settings_override: {}, tracked_field_additions: [] };
}

/**
 * Write the character config to the active character's card data
 * and persist to the character file.
 */
function writeCharConfig(config) {
    const charId = panelCharId ?? state.context.characterId;
    const char = charId != null ? state.context.characters?.[charId] : null;

    if (!char) {
        console.warn(`[${EXTENSION_NAME}] No active character (panelCharId=${panelCharId}, contextCharId=${state.context.characterId}) — cannot save`);
        return;
    }

    const configData = {
        mode: config.mode || 'characters',
        names: config.names || [''],
        prompt_settings_override: config.prompt_settings_override || {},
        tracked_field_additions: Array.isArray(config.tracked_field_additions)
            ? config.tracked_field_additions
            : [],
    };

    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions[CHAR_CONFIG_EXT_KEY] = configData;

    if (typeof state.context.writeExtensionField === 'function') {
        try {
            state.context.writeExtensionField(charId, CHAR_CONFIG_EXT_KEY, configData);
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] writeExtensionField error:`, e);
        }
    }

    const avatar = char.avatar;
    if (!avatar) return;

    const headers = state.context.getRequestHeaders ? state.context.getRequestHeaders() : {};

    fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            avatar,
            data: { extensions: { [CHAR_CONFIG_EXT_KEY]: configData } },
        }),
    })
    .then(resp => {
        if (resp.ok) {
            console.log(`[${EXTENSION_NAME}] writeCharConfig: persisted to file`);
        } else {
            console.warn(`[${EXTENSION_NAME}] merge-attributes returned ${resp.status}`);
        }
    })
    .catch(err => {
        console.warn(`[${EXTENSION_NAME}] merge-attributes failed:`, err);
    });
}

// #############################################
// # Public API — for pipeline.js / session.js
// #############################################

/**
 * Derive the init type for the Agent based on stored config.
 */
export function getCharInitType() {
    const config = readCharConfig();
    if (config.mode === 'scenario') return 'scenario';
    if (config.names.length >= 2) return 'multi-character';
    return 'character';
}

/**
 * Get the list of character names the user defined.
 */
export function getCharInitNames() {
    const config = readCharConfig();
    if (config.mode === 'scenario') return [];
    return config.names.map(n => (n || '').trim()).filter(Boolean);
}

/**
 * Get the per-character prompt settings overrides.
 * Returns null if no overrides exist.
 */
export function getCharPromptOverrides() {
    const config = readCharConfig();
    const overrides = config.prompt_settings_override;
    if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return null;
    return overrides;
}

/**
 * Get prompt config overrides for a specific character object.
 */
export function getPromptOverridesForChar(charObj) {
    if (!charObj?.data?.extensions) return null;
    const extData = charObj.data.extensions[CHAR_CONFIG_EXT_KEY];
    const overrides = extData?.prompt_settings_override || extData?.prompt_settings;
    if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return null;
    return JSON.parse(JSON.stringify(overrides));
}

/**
 * Get the per-character tracked field additions.
 * Converts array storage to object format for the payload.
 * Returns null if no additions exist.
 */
export function getCharTrackedFieldAdditions() {
    const config = readCharConfig();
    return tfAdditionsArrayToObject(config.tracked_field_additions);
}

/**
 * Get tracked field additions for a specific character object.
 * Works in group mode where getActiveCharData() returns null.
 * Converts array storage to object format for the payload.
 */
export function getTrackedFieldAdditionsForChar(charObj) {
    if (!charObj?.data?.extensions) return null;
    const extData = charObj.data.extensions[CHAR_CONFIG_EXT_KEY];
    if (!extData?.tracked_field_additions) return null;

    let additions = extData.tracked_field_additions;
    if (!Array.isArray(additions) && typeof additions === 'object') {
        additions = migrateTFAdditionsToArray(additions);
    }
    return tfAdditionsArrayToObject(additions);
}

// #############################################
// # CSS Injection
// #############################################

function injectBrainCSS() {
    if ($('#ass-brain-css').length) return;

    const css = `
    <style id="ass-brain-css">
        /* Brain button */
        #ass-brain-btn {
            cursor: pointer;
            padding: 0 8px;
            color: var(--fg_dim);
            transition: color 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #ass-brain-btn:hover {
            color: #9b59b6;
        }

        /* Overlay backdrop */
        .ass-brain-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: ass-brain-fade-in 0.15s ease-out;
        }
        @keyframes ass-brain-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        /* Panel */
        .ass-brain-panel {
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
        @keyframes ass-brain-slide-in {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        /* Header */
        .ass-brain-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 18px;
        }
        .ass-brain-header h3 {
            margin: 0;
            color: var(--fg);
            font-size: 15px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ass-brain-header h3 i {
            color: #9b59b6;
        }
        .ass-brain-close {
            background: none;
            border: none;
            color: var(--fg_dim);
            font-size: 22px;
            cursor: pointer;
            padding: 0 4px;
            line-height: 1;
            transition: color 0.2s;
        }
        .ass-brain-close:hover {
            color: var(--fg);
        }

        /* Section */
        .ass-brain-section {
            margin-bottom: 16px;
        }
        .ass-brain-section:last-child {
            margin-bottom: 0;
        }
        .ass-brain-section-title {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            font-weight: 600;
            color: var(--fg_dim);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
            padding-bottom: 4px;
            border-bottom: 1px solid rgba(128, 128, 128, 0.2);
        }
        .ass-brain-section-title i {
            font-size: 11px;
            opacity: 0.7;
        }

        .ass-brain-section details summary {
            cursor: pointer;
            padding: 4px 0;
            user-select: none;
        }
        .ass-brain-section details summary:hover {
            color: var(--fg);
        }

        /* Field groups */
        .ass-brain-field {
            margin-bottom: 10px;
        }
        .ass-brain-label {
            display: block;
            font-size: 12px;
            font-weight: 600;
            color: var(--fg_dim);
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        /* Name rows */
        .ass-brain-name-row {
            display: flex;
            gap: 6px;
            align-items: center;
            margin-bottom: 6px;
        }
        .ass-brain-name-row .text_pole {
            flex: 1;
        }
        .ass-brain-remove-name {
            flex-shrink: 0;
            padding: 4px 8px;
            background: rgba(217, 83, 79, 0.1);
            border: 1px solid rgba(217, 83, 79, 0.3);
            border-radius: 4px;
            color: #d9534f;
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s;
            font-size: 12px;
        }
        .ass-brain-remove-name:hover {
            background: rgba(217, 83, 79, 0.25);
            border-color: rgba(217, 83, 79, 0.5);
        }

        #ass-brain-add-name {
            margin-top: 4px;
            font-size: 12px;
        }

        /* Tracked field additions */
        .ass-btf-field {
            background: rgba(128, 128, 128, 0.06);
            border: 1px solid rgba(128, 128, 128, 0.15);
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 6px;
        }
        .ass-btf-field.ass-btf-group {
            background: rgba(92, 184, 92, 0.04);
            border-color: rgba(92, 184, 92, 0.18);
        }
        .ass-btf-field.ass-btf-nested {
            background: rgba(128, 128, 128, 0.04);
            border-color: rgba(128, 128, 128, 0.12);
        }
        .ass-btf-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 4px;
        }
        .ass-btf-row:last-child { margin-bottom: 0; }
        .ass-btf-subfields {
            margin: 6px 0 4px 16px;
            padding-left: 10px;
            border-left: 2px solid rgba(128, 128, 128, 0.2);
        }
        /* Icon toggle buttons */
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

        .ass-brain-info {
            font-size: 11px;
            color: var(--fg_dim);
            margin-top: 8px;
            line-height: 1.5;
        }
    </style>`;

    $('head').append(css);
}

// #############################################
// # Brain Button Injection
// #############################################

function injectBrainButton() {
    if ($('#ass-brain-btn').length) return;

    const $btn = $('<div id="ass-brain-btn" title="Agent Character Config"><i class="fa-solid fa-brain"></i></div>');
    $btn.on('click', toggleCharConfigPanel);

    const $bar = $('#avatar_controls .buttons_block');
    if ($bar.length) {
        $bar.append($btn);
        console.log(`[${EXTENSION_NAME}] Brain button injected (in #avatar_controls .buttons_block)`);
        return;
    }

    const targets = [
        '#entity_del',
        '#delete_character_button',
        '.character_menu_button[title*="Delete"]',
        '#entity_export',
        '#entity_lock',
        '#fav_button',
    ];

    for (const selector of targets) {
        const $target = $(selector);
        if ($target.length) {
            $target.after($btn);
            console.log(`[${EXTENSION_NAME}] Brain button injected (after ${selector})`);
            return;
        }
    }

    setTimeout(injectBrainButton, 1000);
}

// #############################################
// # Panel Toggle
// #############################################

function toggleCharConfigPanel() {
    if ($('#ass-brain-overlay').length) {
        closeCharConfigPanel();
    } else {
        openCharConfigPanel();
    }
}

function openCharConfigPanel() {
    if ($('#ass-brain-overlay').length) return;

    panelCharId = findCharIdByAvatar() || state.context.characterId || null;

    const config = readCharConfig();

    const html = `
    <div id="ass-brain-overlay" class="ass-brain-overlay">
        <div class="ass-brain-panel" id="ass-brain-panel">

            <div class="ass-brain-header">
                <h3><i class="fa-solid fa-brain"></i> Agent Character Config</h3>
                <button id="ass-brain-close" class="ass-brain-close" type="button">&times;</button>
            </div>

            <!-- Section 1: Parse Type -->
            <div class="ass-brain-section">
                <div class="ass-brain-section-title">
                    <i class="fa-solid fa-mask"></i> Card Parse Type
                </div>

                <div class="ass-brain-field">
                    <select id="ass-brain-mode" class="text_pole wide">
                        <option value="characters" ${config.mode === 'characters' ? 'selected' : ''}>Character(s)</option>
                        <option value="scenario" ${config.mode === 'scenario' ? 'selected' : ''}>Scenario</option>
                    </select>
                </div>

                <div id="ass-brain-names-section" style="${config.mode === 'scenario' ? 'display:none;' : ''}">
                    <label class="ass-brain-label">Defined Characters</label>
                    <div id="ass-brain-names-list"></div>
                    <button id="ass-brain-add-name" class="menu_button" type="button">
                        <i class="fa-solid fa-plus"></i> Add Character
                    </button>
                </div>

                <div class="ass-brain-info">
                    Tell the Agent how to interpret this character card.<br>
                    <b>Character(s)</b> — the card defines one or more characters. Add a name for each.<br>
                    <b>Scenario</b> — the card defines a scenario or setting rather than a character.
                </div>
            </div>

            <!-- Section 2: Prompt Configs Override -->
            <div class="ass-brain-section">
                <details>
                    <summary class="ass-brain-section-title">
                        <i class="fa-solid fa-sliders"></i> Prompt Configs Override
                    </summary>
                    <div id="ass-brain-prompt-overrides">
                        ${renderCharPromptOverrides(config.prompt_settings_override)}
                    </div>
                    <div class="ass-brain-info">
                        Override global prompt settings for this character only.<br>
                        Select <b>Global Default</b> to use the value from the main settings.
                    </div>
                </details>
            </div>

            <!-- Section 3: Database Tracked Fields Additions -->
            <div class="ass-brain-section">
                <details>
                    <summary class="ass-brain-section-title">
                        <i class="fa-solid fa-database"></i> Database Tracked Fields Additions
                    </summary>
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
                        Add character-specific fields to track in the state database.<br>
                        These are merged with the global tracked fields when sending to the Agent.<br>
                        <i class="fa-solid fa-eye-slash" style="color:#9b59b6;"></i> <b>Secret</b> — only sent to the character it belongs to.
                        &nbsp;&nbsp;
                        <i class="fa-solid fa-asterisk" style="color:#e67e22;"></i> <b>Required</b> — this field must be filled in.
                        &nbsp;&nbsp;
                        <i class="fa-solid fa-lock" style="color:#e74c3c;"></i> <b>Immutable</b> — cannot be changed once set.
                        &nbsp;&nbsp;
                        <i class="fa-solid fa-code-merge" style="color:#3498db;"></i> <b>Extend</b> — only adds to this field, never overwrites.
                        &nbsp;&nbsp;
                        <i class="fa-solid fa-diagram-project" style="color:#2ecc71;"></i> <b>Dynamic</b> — creates per-character entries (e.g. relationships).
                    </div>
                </details>
            </div>

        </div>
    </div>`;

    $('body').append(html);

    renderNameInputs(config.names);

    // --- Bind events ---
    $('#ass-brain-close').on('click', closeCharConfigPanel);
    $('#ass-brain-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-brain-overlay')) closeCharConfigPanel();
    });
    $(document).on('keydown.brain-panel', function (e) {
        if (e.key === 'Escape') closeCharConfigPanel();
    });

    $('#ass-brain-mode').on('change', function () {
        const mode = $(this).val();
        $('#ass-brain-names-section').toggle(mode === 'characters');
    });

    $('#ass-brain-add-name').on('click', function () {
        const config = readCurrentConfig();
        config.names.push('');
        renderNameInputs(config.names);
        const $inputs = $('#ass-brain-names-list .ass-brain-name-input');
        $inputs.last().focus();
    });

    bindCharPromptOverrideEvents();
    bindTFAdditionEvents('#ass-brain-panel');
}

function closeCharConfigPanel() {
    const config = readCurrentConfig();
    writeCharConfig(config);

    panelCharId = null;

    $('#ass-brain-overlay').remove();
    $(document).off('keydown.brain-panel');
    $(document).off('change.ass-ps-override');
}

// #############################################
// # Name Input Rendering
// #############################################

function readCurrentConfig() {
    const mode = ($('#ass-brain-mode').val() === 'scenario') ? 'scenario' : 'characters';
    const names = [];
    $('#ass-brain-names-list .ass-brain-name-input').each(function () {
        names.push($(this).val() || '');
    });
    if (mode === 'characters' && names.length === 0) {
        names.push('');
    }
    return {
        mode,
        names,
        prompt_settings_override: readCharPromptOverridesFromUI(),
        tracked_field_additions: readTFAdditionsFromUI('#ass-brain-panel'),
    };
}

function renderNameInputs(names) {
    const $list = $('#ass-brain-names-list');
    if (!$list.length) return;
    $list.empty();

    names.forEach((name, index) => {
        const isRemovable = names.length > 1;
        const safeValue = name.replace(/"/g, '&quot;').replace(/</g, '&lt;');

        const $row = $(`
            <div class="ass-brain-name-row">
                <input type="text"
                       class="text_pole wide ass-brain-name-input"
                       placeholder="Character name..."
                       value="${safeValue}">
                ${isRemovable ? `
                    <button class="ass-brain-remove-name" type="button" title="Remove this character">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                ` : ''}
            </div>
        `);

        $list.append($row);

        $row.find('.ass-brain-remove-name').on('click', function () {
            const config = readCurrentConfig();
            config.names.splice(index, 1);
            renderNameInputs(config.names);
        });
    });
}

// #############################################
// # Initialization
// #############################################

export function initCharConfig() {
    injectBrainCSS();
    injectBrainButton();
    console.log(`[${EXTENSION_NAME}] Character config module loaded.`);
}