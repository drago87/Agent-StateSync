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
//   - Database Tracked Fields Additions (per-character extra fields)
// File Version: 1.1.3

import state from './state.js';
import { EXTENSION_NAME, CHAR_CONFIG_EXT_KEY } from './settings.js';
import {
    renderCharPromptOverrides, readCharPromptOverridesFromUI,
    bindCharPromptOverrideEvents,
} from './prompt-settings.js';

// #############################################
// # Default Config
// #############################################

const DEFAULT_CHAR_CONFIG = {
    mode: 'characters',   // 'characters' | 'scenario'
    names: [''],          // array of character name strings
    prompt_settings: {},  // per-character prompt overrides
    tracked_field_additions: {},  // extra tracked fields for this character
};

// #############################################
// # Character Data Access
// #############################################

/**
 * Get the character data object for the currently active character.
 */
function getActiveCharData() {
    if (state.context.characterId == null || !state.context.characters) return null;
    return state.context.characters[state.context.characterId] || null;
}

/**
 * Read the stored character config from the active character's card data.
 * Returns a validated copy of the stored config, or the defaults.
 */
function readCharConfig() {
    const char = getActiveCharData();
    if (!char?.data?.extensions) return { ...DEFAULT_CHAR_CONFIG, names: [''] };
    const stored = char.data.extensions[CHAR_CONFIG_EXT_KEY];
    if (!stored) return { ...DEFAULT_CHAR_CONFIG, names: [''] };
    return {
        mode: (stored.mode === 'scenario') ? 'scenario' : 'characters',
        names: Array.isArray(stored.names) && stored.names.length > 0
            ? [...stored.names]
            : [''],
        prompt_settings: stored.prompt_settings || {},
        tracked_field_additions: stored.tracked_field_additions || {},
    };
}

/**
 * Write the character config to the active character's card data
 * and trigger a debounced save.
 */
function writeCharConfig(config) {
    const char = getActiveCharData();
    if (!char) {
        console.warn(`[${EXTENSION_NAME}] No active character — cannot save char config`);
        return;
    }
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions[CHAR_CONFIG_EXT_KEY] = {
        mode: config.mode || 'characters',
        names: config.names || [''],
        prompt_settings: config.prompt_settings || {},
        tracked_field_additions: config.tracked_field_additions || {},
    };

    try {
        if (typeof state.context.saveCharacterDebounced === 'function') {
            state.context.saveCharacterDebounced();
        } else if (typeof state.context.saveChat === 'function') {
            state.context.saveChat();
        }
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Character save failed:`, e.message);
    }
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
    const char = getActiveCharData();
    if (!char?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]) return null;
    const overrides = char.data.extensions[CHAR_CONFIG_EXT_KEY].prompt_settings;
    if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return null;
    return overrides;
}

/**
 * Get the per-character tracked field additions.
 * Returns null if no additions exist.
 */
export function getCharTrackedFieldAdditions() {
    const char = getActiveCharData();
    if (!char?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]) return null;
    const additions = char.data.extensions[CHAR_CONFIG_EXT_KEY].tracked_field_additions;
    if (!additions || typeof additions !== 'object' || Object.keys(additions).length === 0) return null;
    return additions;
}

// #############################################
// # CSS Injection
// #############################################

function injectBrainCSS() {
    if ($('#ass-brain-css').length) return;

    const css = `
    <style id="ass-brain-css">
        /* Brain button — matches ST's .character_menu_button style */
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

        /* Section divider */
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

        /* Add button */
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
        .ass-btf-subfield-row { margin-bottom: 4px; }
        .ass-btf-subfield-row:last-child { margin-bottom: 0; }
        .ass-btf-extends-label,
        .ass-btf-dyn-label {
            display: flex;
            align-items: center;
            gap: 3px;
            cursor: pointer;
            flex-shrink: 0;
            font-size: 12px;
            white-space: nowrap;
            color: var(--fg_dim);
        }
        .ass-btf-extends-label input,
        .ass-btf-dyn-label input {
            margin: 0;
            width: 14px;
            height: 14px;
        }

        /* Info text */
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

    // Primary target: avatar controls button bar
    const $bar = $('#avatar_controls .buttons_block');
    if ($bar.length) {
        $bar.append($btn);
        console.log(`[${EXTENSION_NAME}] Brain button injected (in #avatar_controls .buttons_block)`);
        return;
    }

    // Fallback targets
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

    // ST not ready yet — retry
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
    console.log('[ASS DEBUG] OPEN - characterId:', state.context.characterId,
                'char exists:', !!state.context.characters?.[state.context.characterId]);

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
                        ${renderCharPromptOverrides(config.prompt_settings)}
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
                    <div id="ass-brain-tf-additions">
                        ${renderTFAdditions(config.tracked_field_additions)}
                    </div>
                    <div style="margin-top:6px;">
                        <button id="ass-brain-add-tf" class="menu_button" type="button">
                            <i class="fa-solid fa-plus"></i> Add Field
                        </button>
                    </div>
                    <div class="ass-brain-info">
                        Add character-specific fields to track in the state database.<br>
                        These are merged with the global tracked fields when sending to the Agent.
                    </div>
                </details>
            </div>

        </div>
    </div>`;

    $('body').append(html);

    // Render initial name inputs
    renderNameInputs(config.names);

    // --- Bind events ---

    // Close button
    $('#ass-brain-close').on('click', closeCharConfigPanel);

    // Click outside panel to close
    $('#ass-brain-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-brain-overlay')) {
            closeCharConfigPanel();
        }
    });

    // Escape key to close
    $(document).on('keydown.brain-panel', function (e) {
        if (e.key === 'Escape') closeCharConfigPanel();
    });

    // Mode dropdown change
    $('#ass-brain-mode').on('change', function () {
        const mode = $(this).val();
        $('#ass-brain-names-section').toggle(mode === 'characters');
        triggerAutoSave();
    });

    // Add character button
    $('#ass-brain-add-name').on('click', function () {
        const config = readCurrentConfig();
        config.names.push('');
        renderNameInputs(config.names);
        const $inputs = $('#ass-brain-names-list .ass-brain-name-input');
        $inputs.last().focus();
        triggerAutoSave();
    });

    // Bind prompt override events
    bindCharPromptOverrideEvents();

    // Auto-save when prompt overrides change
    $('#ass-brain-prompt-overrides').on('change', '.ass-ps-char-override, .ass-ps-char-override-type', triggerAutoSave);
    $('#ass-brain-prompt-overrides').on('input', '.ass-ps-char-override-text', triggerAutoSave);

    // Bind tracked field addition events
    bindTFAdditionEvents();
}

function closeCharConfigPanel() {
    console.log('[ASS DEBUG] CLOSE - characterId:', state.context.characterId,
                'char exists:', !!state.context.characters?.[state.context.characterId]);
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
    const config = readCurrentConfig();
    writeCharConfig(config);

    // DEBUG: verify what we just wrote
    const verify = readCharConfig();
    console.log('[ASS DEBUG] Saved prompt_settings:', verify.prompt_settings);
    console.log('[ASS DEBUG] Saved tf_additions:', verify.tracked_field_additions);
    console.log('[ASS DEBUG] Save fn exists:', typeof state.context.saveCharacterDebounced);

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
        prompt_settings: readCharPromptOverridesFromUI(),
        tracked_field_additions: readTFAdditionsFromUI(),
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

        $row.find('.ass-brain-name-input').on('input', triggerAutoSave);
        $row.find('.ass-brain-remove-name').on('click', function () {
            const config = readCurrentConfig();
            config.names.splice(index, 1);
            renderNameInputs(config.names);
            triggerAutoSave();
        });
    });
}

// #############################################
// # Tracked Fields Additions (brain panel)
// #############################################

function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTypeOptions(selected) {
    const types = ['string', 'list', 'string_or_list', 'dict'];
    return types.map(t =>
        `<option value="${t}" ${t === selected ? 'selected' : ''}>${t}</option>`
    ).join('');
}

function isTFGroup(field) {
    return field && field.fields !== undefined;
}

function renderTFAdditions(additions) {
    if (!additions || typeof additions !== 'object') return '';

    const entries = Object.entries(additions);
    if (entries.length === 0) return '<small style="color:var(--fg_dim);">No additions defined.</small>';

    let html = '';
    for (const [key, field] of entries) {
        html += isTFGroup(field)
            ? renderTFAdditionGroup(key, field)
            : renderTFAdditionSimple(key, field);
    }
    return html;
}

function renderTFAdditionSimple(key, field) {
    const type = field.type || 'string';
    const hint = field.hint || '';
    const extendsOnly = field.extends_only || false;

    return `
    <div class="ass-btf-field" data-tf-key="${escapeAttr(key)}">
        <div class="ass-btf-row">
            <input class="text_pole ass-btf-name" value="${escapeAttr(key)}"
                   placeholder="Field name" style="flex:1; min-width:0;">
            <input class="text_pole ass-btf-hint" value="${escapeAttr(hint)}"
                   placeholder="Description / Hint" style="flex:3; min-width:0;">
            <select class="text_pole ass-btf-type" style="flex:0 0 130px;">
                ${buildTypeOptions(type)}
            </select>
            <label class="ass-btf-extends-label" title="Only extends this and will not overwrite">
                <input type="checkbox" class="ass-btf-extends" ${extendsOnly ? 'checked' : ''}>
            </label>
            <button class="menu_button ass-btf-add-sub-to-field"
                    title="Add sub-field (converts to group)">
                <i class="fa-solid fa-sitemap"></i>
            </button>
            <button class="menu_button ass-btf-remove-field" title="Remove field">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>`;
}

function renderTFAdditionGroup(key, field) {
    const description = field.description || '';
    const isDynamic = field.is_dynamic || false;
    const fields = field.fields || {};

    let subfieldsHtml = '';
    for (const [subKey, subField] of Object.entries(fields)) {
        const type = subField.type || 'string';
        const hint = subField.hint || '';
        const extendsOnly = subField.extends_only || false;

        subfieldsHtml += `
        <div class="ass-btf-row ass-btf-subfield-row" data-tf-subkey="${escapeAttr(subKey)}">
            <input class="text_pole ass-btf-sub-name" value="${escapeAttr(subKey)}"
                   placeholder="Sub-field name" style="flex:1; min-width:0;">
            <select class="text_pole ass-btf-sub-type" style="flex:0 0 130px;">
                ${buildTypeOptions(type)}
            </select>
            <input class="text_pole ass-btf-sub-hint" value="${escapeAttr(hint)}"
                   placeholder="Hint" style="flex:2; min-width:0;">
            <label class="ass-btf-extends-label" title="Only extends this and will not overwrite">
                <input type="checkbox" class="ass-btf-extends" ${extendsOnly ? 'checked' : ''}>
            </label>
            <button class="menu_button ass-btf-remove-subfield" title="Remove sub-field">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`;
    }

    return `
    <div class="ass-btf-field ass-btf-group" data-tf-key="${escapeAttr(key)}">
        <div class="ass-btf-row">
            <input class="text_pole ass-btf-name" value="${escapeAttr(key)}"
                   placeholder="Group name" style="flex:1; min-width:0;">
            <input class="text_pole ass-btf-desc" value="${escapeAttr(description)}"
                   placeholder="Description" style="flex:3; min-width:0;">
            <label class="ass-btf-dyn-label" title="Dynamic — entries keyed by name">
                <input type="checkbox" class="ass-btf-dynamic" ${isDynamic ? 'checked' : ''}>
                <small>Dyn</small>
            </label>
            <button class="menu_button ass-btf-remove-field" title="Remove group">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        <div class="ass-btf-subfields">
            ${subfieldsHtml}
        </div>
        <div style="margin:4px 0 4px 20px;">
            <button class="menu_button ass-btf-add-subfield" data-tf-key="${escapeAttr(key)}">
                <i class="fa-solid fa-plus"></i> Add sub-field
            </button>
        </div>
    </div>`;
}

function readTFAdditionsFromUI() {
    const additions = {};
    $('#ass-brain-tf-additions .ass-btf-field').each(function () {
        const $field = $(this);
        const oldKey = String($field.data('tf-key'));
        const name = $field.find('> .ass-btf-row > .ass-btf-name').val().trim();
        if (!name) return;

        if ($field.hasClass('ass-btf-group')) {
            const group = {
                description: $field.find('.ass-btf-desc').val().trim(),
                is_dynamic: $field.find('.ass-btf-dynamic').is(':checked'),
                fields: {},
            };
            $field.find('.ass-btf-subfield-row').each(function () {
                const subOldKey = String($(this).data('tf-subkey'));
                const subName = $(this).find('.ass-btf-sub-name').val().trim();
                if (!subName) return;
                group.fields[subName] = {
                    type: $(this).find('.ass-btf-sub-type').val(),
                    hint: $(this).find('.ass-btf-sub-hint').val().trim(),
                    extends_only: $(this).find('.ass-btf-extends').is(':checked'),
                };
            });
            additions[name] = group;
        } else {
            additions[name] = {
                type: $field.find('.ass-btf-type').val(),
                hint: $field.find('.ass-btf-hint').val().trim(),
                extends_only: $field.find('.ass-btf-extends').is(':checked'),
            };
        }
    });
    return additions;
}

function bindTFAdditionEvents() {
    const $container = $('#ass-brain-tf-additions');

    // Input changes
    $container.on('input', '.ass-btf-name, .ass-btf-hint, .ass-btf-desc, .ass-btf-type, ' +
        '.ass-btf-sub-name, .ass-btf-sub-type, .ass-btf-sub-hint', function () {
        triggerAutoSave();
    });
    $container.on('change', '.ass-btf-extends, .ass-btf-dynamic', function () {
        triggerAutoSave();
    });

    // Add field
    $('#ass-brain-add-tf').on('click', function () {
        const config = readCurrentConfig();
        const name = 'new_field_' + Date.now();
        config.tracked_field_additions[name] = {
            type: 'string',
            hint: '',
            extends_only: false,
        };
        $('#ass-brain-tf-additions').html(renderTFAdditions(config.tracked_field_additions));
        bindTFAdditionEvents();
        triggerAutoSave();
    });

    // Remove field
    $container.on('click', '.ass-btf-remove-field', function () {
        const config = readCurrentConfig();
        const oldKey = String($(this).closest('.ass-btf-field').data('tf-key'));
        delete config.tracked_field_additions[oldKey];
        $('#ass-brain-tf-additions').html(renderTFAdditions(config.tracked_field_additions));
        bindTFAdditionEvents();
        triggerAutoSave();
    });

    // Convert simple to group
    $container.on('click', '.ass-btf-add-sub-to-field', function () {
        const config = readCurrentConfig();
        const oldKey = String($(this).closest('.ass-btf-field').data('tf-key'));
        const field = config.tracked_field_additions[oldKey];
        if (!field || isTFGroup(field)) return;

        const subName = 'sub_1';
        config.tracked_field_additions[oldKey] = {
            description: field.hint || '',
            is_dynamic: false,
            fields: {
                [subName]: {
                    type: field.type || 'string',
                    hint: '',
                    extends_only: false,
                },
            },
        };
        $('#ass-brain-tf-additions').html(renderTFAdditions(config.tracked_field_additions));
        bindTFAdditionEvents();
        triggerAutoSave();
    });

    // Add sub-field to group
    $container.on('click', '.ass-btf-add-subfield', function () {
        const config = readCurrentConfig();
        const groupKey = String($(this).closest('.ass-btf-field').data('tf-key'));
        const group = config.tracked_field_additions[groupKey];
        if (!group) return;

        if (!group.fields) group.fields = {};
        const subName = 'new_sub_' + Date.now();
        group.fields[subName] = { type: 'string', hint: '', extends_only: false };

        $('#ass-brain-tf-additions').html(renderTFAdditions(config.tracked_field_additions));
        bindTFAdditionEvents();
        triggerAutoSave();
    });

    // Remove sub-field
    $container.on('click', '.ass-btf-remove-subfield', function () {
        const config = readCurrentConfig();
        const $group = $(this).closest('.ass-btf-field');
        const groupKey = String($group.data('tf-key'));
        const subKey = String($(this).closest('.ass-btf-subfield-row').data('tf-subkey'));
        const group = config.tracked_field_additions[groupKey];
        if (!group?.fields) return;

        delete group.fields[subKey];

        // If no sub-fields left, convert back to simple
        if (Object.keys(group.fields).length === 0) {
            config.tracked_field_additions[groupKey] = {
                type: 'string',
                hint: group.description || '',
                extends_only: false,
            };
        }

        $('#ass-brain-tf-additions').html(renderTFAdditions(config.tracked_field_additions));
        bindTFAdditionEvents();
        triggerAutoSave();
    });
}

// #############################################
// # Auto-Save (debounced)
// #############################################

let autoSaveTimer = null;

function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
        const config = readCurrentConfig();
        writeCharConfig(config);
    }, 500);
}

// #############################################
// # Initialization
// #############################################

export function initCharConfig() {
    injectBrainCSS();
    injectBrainButton();
    console.log(`[${EXTENSION_NAME}] Character config module loaded.`);
}