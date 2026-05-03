// tracked-fields.js — Agent-StateSync Tracked Fields Editor
//
// Manages the tracked field definitions for the Agent's state database.
// Three categories: character, scenario, shared.
// Each field can be simple (name + type + hint) or a group with sub-fields.
// Sub-fields can themselves be groups (nested to arbitrary depth).
// Character fields support a "secret" checkbox for privacy marking.
//
// Defaults loaded from external JSON files in the extension root:
//   - default-tracked-character.json
//   - default-tracked-scenario.json
//   - default-tracked-shared.json
//
// User edits are saved to ST extensionSettings.
// The merged data is included in the session init payload.
// File Version: 2.0.0

import state from './state.js';

// Settings key for user customizations
const TRACKED_FIELDS_KEY = 'agent_statesync_tracked_fields';

// Module-level: current fields (defaults merged with user edits)
let currentFields = null;
let saveTimeout = null;

// Cached default fields loaded from JSON files
let defaultFieldsCache = null;

// #############################################
// # Default Fields Loading
// #############################################

/**
 * Resolve the extension's base URL (where config.json and default JSON files live).
 * SillyTavern loads extensions from /scripts/extensions/<folderName>/.
 */
function getExtensionBaseUrl() {
    // Look for any <script> or <link> tag that reveals our extension path
    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
        const src = s.getAttribute('src') || '';
        const match = src.match(/^(.*\/Agent-StateSync\/)/i);
        if (match) return match[1];
    }
    // Fallback: use the known SillyTavern extensions path
    return '/scripts/extensions/Agent-StateSync/';
}

/**
 * Load default tracked fields from the external JSON files.
 * Returns a promise that resolves to the defaults object.
 * Caches after first load.
 */
async function loadDefaultFields() {
    if (defaultFieldsCache) return defaultFieldsCache;

    const base = getExtensionBaseUrl();
    const files = {
        character: 'default-tracked-character.json',
        scenario: 'default-tracked-scenario.json',
        shared: 'default-tracked-shared.json',
    };

    const result = { character: {}, scenario: {}, shared: {} };

    const promises = Object.entries(files).map(async ([key, filename]) => {
        try {
            const resp = await fetch(`${base}${filename}`);
            if (resp.ok) {
                result[key] = await resp.json();
            } else {
                console.warn(`[Agent-StateSync] Failed to load ${filename}: ${resp.status}`);
            }
        } catch (e) {
            console.warn(`[Agent-StateSync] Failed to fetch ${filename}:`, e.message);
        }
    });

    await Promise.all(promises);

    defaultFieldsCache = result;
    return result;
}

/**
 * Load defaults for a specific category from the JSON files.
 * Returns a deep-cloned copy.
 */
async function loadDefaultCategory(category) {
    const defaults = await loadDefaultFields();
    return JSON.parse(JSON.stringify(defaults[category] || {}));
}

// #############################################
// # Data Load / Save
// #############################################

/**
 * Load tracked fields: user customizations from ST settings,
 * falling back to defaults from external JSON files.
 */
async function loadTrackedFields() {
    const saved = state.context.extensionSettings?.[TRACKED_FIELDS_KEY];
    if (saved && typeof saved === 'object') {
        return saved;
    }
    // Load defaults from JSON files
    return await loadDefaultFields();
}

/**
 * Persist current fields to ST's extensionSettings.
 */
function saveTrackedFields() {
    state.context.extensionSettings[TRACKED_FIELDS_KEY] = currentFields;
    state.context.saveSettingsDebounced();
}

/**
 * Debounced save — avoids hammering ST's save on every keystroke.
 */
function scheduleSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveTrackedFields, 500);
}

/**
 * Get the current tracked fields for the init payload.
 * Called by session.js when building the POST body.
 */
export function getTrackedFieldsForPayload() {
    return currentFields;
}

// #############################################
// # HTML Helpers
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

// #############################################
// # Render Functions
// #############################################

/**
 * Render a full category (character, scenario, shared).
 * @param {object} opts - { key, label, open, allowSecret }
 */
function renderCategory({ key, label, open, allowSecret }) {
    const fields = currentFields[key] || {};
    const entries = Object.entries(fields);

    let fieldsHtml = '';
    for (const [fieldKey, fieldValue] of entries) {
        fieldsHtml += renderField(key, fieldKey, fieldValue, 0, allowSecret);
    }

    return `
    <details ${open ? 'open' : ''} class="ass-tf-category">
        <summary><b>${label}</b></summary>
        <div class="ass-tf-fields">${fieldsHtml}</div>
        <div style="margin-top:6px; display:flex; gap:6px;">
            <button class="menu_button ass-tf-add-field" data-category="${key}">
                <i class="fa-solid fa-plus"></i> Add field
            </button>
            <button class="menu_button ass-tf-load-defaults" data-category="${key}" title="Reset this category to defaults from ${label} JSON file">
                <i class="fa-solid fa-rotate-left"></i> Load Defaults
            </button>
        </div>
    </details>`;
}

/**
 * Render a field — either simple or group (with nested sub-fields).
 * Supports arbitrary nesting depth.
 *
 * @param {string} category - "character" | "scenario" | "shared"
 * @param {string} key - Field name
 * @param {object} field - Field definition
 * @param {number} depth - Nesting depth (0 = top-level)
 * @param {boolean} allowSecret - Whether to show secret checkbox
 */
function renderField(category, key, field, depth, allowSecret) {
    if (isGroup(field)) {
        return renderGroupField(category, key, field, depth, allowSecret);
    }
    return renderSimpleField(category, key, field, depth, allowSecret);
}

function renderSimpleField(category, key, field, depth, allowSecret) {
    const type = field.type || 'string';
    const hint = field.hint || '';
    const extendsOnly = field.extends_only || false;
    const secret = field.secret || false;
    const isNested = depth > 0;

    // Build secret checkbox only for character category
    const secretHtml = allowSecret
        ? `<label class="ass-tf-secret-label" title="Mark as secret — hidden from other characters">
               <input type="checkbox" class="ass-tf-secret" ${secret ? 'checked' : ''}>
               <i class="fa-solid fa-eye-slash" style="font-size:11px;"></i>
           </label>`
        : '';

    // At top level, show the "convert to group" button
    const addSubBtn = !isNested
        ? `<button class="menu_button ass-tf-add-sub-to-field"
                  title="Add sub-field (converts to group)">
               <i class="fa-solid fa-sitemap"></i>
           </button>`
        : '';

    const depthClass = isNested ? 'ass-tf-nested' : '';

    return `
    <div class="ass-tf-field ${depthClass}" data-category="${category}" data-key="${escapeAttr(key)}" data-depth="${depth}">
        <div class="ass-tf-row">
            <input class="text_pole ass-tf-name" value="${escapeAttr(key)}"
                   placeholder="Field name" style="flex:1; min-width:0;">
            <input class="text_pole ass-tf-hint" value="${escapeAttr(hint)}"
                   placeholder="Description / Hint" style="flex:3; min-width:0;">
            <select class="text_pole ass-tf-type" style="flex:0 0 130px;">
                ${buildTypeOptions(type)}
            </select>
            <label class="ass-tf-extends-label" title="Only extends this and will not overwrite">
                <input type="checkbox" class="ass-tf-extends" ${extendsOnly ? 'checked' : ''}>
            </label>
            ${secretHtml}
            ${addSubBtn}
            <button class="menu_button ass-tf-remove-field" title="Remove field">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>`;
}

function renderGroupField(category, key, field, depth, allowSecret) {
    const description = field.description || '';
    const isDynamic = field.is_dynamic || false;
    const fields = field.fields || {};
    const secret = field.secret || false;

    // Build secret checkbox only for character category
    const secretHtml = allowSecret
        ? `<label class="ass-tf-secret-label" title="Mark as secret — hidden from other characters">
               <input type="checkbox" class="ass-tf-secret" ${secret ? 'checked' : ''}>
               <i class="fa-solid fa-eye-slash" style="font-size:11px;"></i>
           </label>`
        : '';

    let subfieldsHtml = '';
    for (const [subKey, subField] of Object.entries(fields)) {
        subfieldsHtml += renderField(category, subKey, subField, depth + 1, allowSecret);
    }

    return `
    <div class="ass-tf-field ass-tf-group" data-category="${category}" data-key="${escapeAttr(key)}" data-depth="${depth}">
        <div class="ass-tf-row">
            <input class="text_pole ass-tf-name" value="${escapeAttr(key)}"
                   placeholder="Group name" style="flex:1; min-width:0;">
            <input class="text_pole ass-tf-desc" value="${escapeAttr(description)}"
                   placeholder="Description" style="flex:3; min-width:0;">
            <label class="ass-tf-dyn-label" title="Dynamic — entries keyed by name">
                <input type="checkbox" class="ass-tf-dynamic" ${isDynamic ? 'checked' : ''}>
                <small>Dyn</small>
            </label>
            ${secretHtml}
            <button class="menu_button ass-tf-remove-field" title="Remove group">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        <div class="ass-tf-subfields">
            ${subfieldsHtml}
        </div>
        <div style="margin:4px 0 4px 20px; display:flex; gap:6px;">
            <button class="menu_button ass-tf-add-subfield"
                    data-category="${category}" data-key="${escapeAttr(key)}" data-depth="${depth}">
                <i class="fa-solid fa-plus"></i> Add sub-field
            </button>
            <button class="menu_button ass-tf-add-subgroup"
                    data-category="${category}" data-key="${escapeAttr(key)}" data-depth="${depth}">
                <i class="fa-solid fa-folder-plus"></i> Add sub-group
            </button>
        </div>
    </div>`;
}

function isGroup(field) {
    return field && field.fields !== undefined;
}

// #############################################
// # DOM → Data Sync
// #############################################

/**
 * Read all current DOM values and sync them into currentFields.
 * Handles arbitrary nesting depth by walking the DOM tree.
 */
function syncFieldsFromDOM() {
    const categories = ['character', 'scenario', 'shared'];

    for (const cat of categories) {
        const $topFields = $(`#ass-tracked-fields-container .ass-tf-field[data-category="${cat}"][data-depth="0"]`);
        currentFields[cat] = {};
        $topFields.each(function () {
            const key = String($(this).attr('data-key'));
            const field = readFieldFromDOM($(this));
            if (key) currentFields[cat][key] = field;
        });
    }
}

/**
 * Read a single field (simple or group) from its DOM element.
 * Recursively reads nested sub-fields.
 */
function readFieldFromDOM($el) {
    if ($el.hasClass('ass-tf-group')) {
        const result = {
            description: ($el.find('> .ass-tf-row > .ass-tf-desc').val() || '').trim(),
            is_dynamic: $el.find('> .ass-tf-row > .ass-tf-dynamic').is(':checked'),
            fields: {},
        };

        // Read secret if checkbox exists (character category)
        const $secret = $el.find('> .ass-tf-row > .ass-tf-secret-label > .ass-tf-secret');
        if ($secret.length) {
            result.secret = $secret.is(':checked');
        }

        // Read direct child fields (immediate children, not deeper nested)
        $el.children('.ass-tf-subfields').children('.ass-tf-field').each(function () {
            const subKey = String($(this).attr('data-key'));
            if (subKey) result.fields[subKey] = readFieldFromDOM($(this));
        });

        return result;
    } else {
        const result = {
            type: $el.find('> .ass-tf-row > .ass-tf-type').val() || 'string',
            hint: ($el.find('> .ass-tf-row > .ass-tf-hint').val() || '').trim(),
            extends_only: $el.find('> .ass-tf-row > .ass-tf-extends').is(':checked'),
        };

        // Read secret if checkbox exists (character category)
        const $secret = $el.find('> .ass-tf-row > .ass-tf-secret-label > .ass-tf-secret');
        if ($secret.length) {
            result.secret = $secret.is(':checked');
        }

        return result;
    }
}

// #############################################
// # Render All
// #############################################

function renderAllCategories($container) {
    // Flush all pending DOM edits into currentFields before re-rendering.
    syncFieldsFromDOM();

    const categories = [
        { key: 'character', label: 'Character', open: false, allowSecret: true },
        { key: 'scenario',  label: 'Scenario',  open: false, allowSecret: false },
        { key: 'shared',    label: 'Shared',    open: false, allowSecret: false },
    ];

    $container.empty();
    for (const cat of categories) {
        $container.append(renderCategory(cat));
    }
}

// #############################################
// # Edit Handlers
// #############################################

function addField(category) {
    const name = 'new_field_' + Date.now();
    currentFields[category] = currentFields[category] || {};
    currentFields[category][name] = {
        type: 'string',
        hint: '',
        extends_only: false,
    };
    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

async function loadDefaults(category) {
    const defaults = await loadDefaultCategory(category);
    currentFields[category] = defaults;
    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
    console.log(`[Agent-StateSync] Loaded default tracked fields for "${category}"`);
}

function removeField(category, key) {
    delete currentFields[category]?.[key];
    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

/**
 * Add a simple sub-field to a group.
 * If the parent is a simple field, convert it to a group first.
 */
function addSubFieldToGroup(category, key) {
    const field = findField(currentFields[category], key);
    if (!field) return;

    if (!isGroup(field)) {
        // Convert simple field to group — move type/hint into first sub-field
        field.fields = {};
        field.fields['sub_1'] = {
            type: field.type || 'string',
            hint: field.hint || '',
            extends_only: field.extends_only || false,
        };
        field.description = field.hint || '';
        delete field.type;
        delete field.hint;
        delete field.extends_only;
    } else {
        const subName = 'new_sub_' + Date.now();
        field.fields[subName] = { type: 'string', hint: '', extends_only: false };
    }

    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

/**
 * Add a sub-group (nested group) to an existing group.
 */
function addSubGroup(category, key) {
    const field = findField(currentFields[category], key);
    if (!field) return;

    if (!isGroup(field)) {
        // Convert simple field to group first
        field.fields = {};
        field.fields['sub_1'] = {
            type: field.type || 'string',
            hint: field.hint || '',
            extends_only: field.extends_only || false,
        };
        field.description = field.hint || '';
        delete field.type;
        delete field.hint;
        delete field.extends_only;
    }

    const subName = 'new_group_' + Date.now();
    field.fields[subName] = {
        description: '',
        is_dynamic: false,
        fields: {},
    };

    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

function removeSubField(category, parentKey, subKey) {
    const parent = findField(currentFields[category], parentKey);
    if (!parent?.fields) return;

    delete parent.fields[subKey];

    // If no sub-fields left, convert back to simple field
    if (Object.keys(parent.fields).length === 0 && !parent.is_dynamic) {
        parent.type = 'string';
        parent.hint = parent.description || '';
        delete parent.fields;
        delete parent.description;
        if (parent.is_dynamic !== undefined) delete parent.is_dynamic;
    }

    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

/**
 * Find a field by key path in the nested structure.
 * For top-level: findField(obj, 'physical')
 * For nested: findField(obj, 'physical.fields.health') — not needed,
 *   since we use DOM traversal for context.
 *
 * Actually, for the current flat key approach at each level,
 * this is a simple property lookup.
 */
function findField(parentObj, key) {
    return parentObj?.[key];
}

// #############################################
// # Event Binding
// #############################################

function bindEvents($container) {
    $container.off('.ass-tf');

    // Input changes
    $container.on('input.ass-tf', '.ass-tf-name, .ass-tf-hint, .ass-tf-desc, .ass-tf-type, ' +
        '.ass-tf-sub-name, .ass-tf-sub-type, .ass-tf-sub-hint', function () {
        syncFieldsFromDOM();
        scheduleSave();
    });

    // Checkbox changes
    $container.on('change.ass-tf', '.ass-tf-extends, .ass-tf-dynamic, .ass-tf-secret', function () {
        syncFieldsFromDOM();
        scheduleSave();
    });

    // Add field
    $container.on('click.ass-tf', '.ass-tf-add-field', function () {
        addField($(this).attr('data-category'));
    });

    // Load defaults
    $container.on('click.ass-tf', '.ass-tf-load-defaults', async function () {
        const category = $(this).attr('data-category');
        await loadDefaults(category);
    });

    // Remove field
    $container.on('click.ass-tf', '.ass-tf-remove-field', function () {
        const $field = $(this).closest('.ass-tf-field');
        const category = $field.attr('data-category');
        const depth = parseInt($field.attr('data-depth') || '0', 10);

        if (depth === 0) {
            removeField(category, $field.attr('data-key'));
        } else {
            // Nested field — find parent and remove from parent.fields
            const $parent = $field.parent().closest('.ass-tf-field');
            const parentKey = $parent.attr('data-key');
            removeSubField(category, parentKey, $field.attr('data-key'));
        }
    });

    // Add sub-field to group
    $container.on('click.ass-tf', '.ass-tf-add-subfield', function () {
        addSubFieldToGroup($(this).attr('data-category'), $(this).attr('data-key'));
    });

    // Add sub-field via sitemap button (converts to group)
    $container.on('click.ass-tf', '.ass-tf-add-sub-to-field', function () {
        const $field = $(this).closest('.ass-tf-field');
        addSubFieldToGroup($field.attr('data-category'), $field.attr('data-key'));
    });

    // Add sub-group
    $container.on('click.ass-tf', '.ass-tf-add-subgroup', function () {
        addSubGroup($(this).attr('data-category'), $(this).attr('data-key'));
    });

    // Remove sub-field (X button) — kept for backward compat
    $container.on('click.ass-tf', '.ass-tf-remove-subfield', function () {
        const $subrow = $(this).closest('.ass-tf-subfield-row');
        const $field = $subrow.closest('.ass-tf-field');
        removeSubField($field.attr('data-category'), $field.attr('data-key'), $subrow.attr('data-subkey'));
    });
}

// #############################################
// # CSS
// #############################################

function injectCSS() {
    if ($('#ass-tf-css').length) return;

    const css = `<style id="ass-tf-css">
    /* Tracked field containers */
    .ass-tf-field {
        background: rgba(128, 128, 128, 0.06);
        border: 1px solid rgba(128, 128, 128, 0.15);
        border-radius: 4px;
        padding: 6px 8px;
        margin-bottom: 6px;
    }
    .ass-tf-group {
        background: rgba(92, 184, 92, 0.04);
        border-color: rgba(92, 184, 92, 0.18);
    }
    /* Nested fields get a slightly different tint per depth */
    .ass-tf-nested {
        background: rgba(128, 128, 128, 0.04);
        border-color: rgba(128, 128, 128, 0.12);
    }

    /* Flex row for inputs */
    .ass-tf-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
    }
    .ass-tf-row:last-child { margin-bottom: 0; }

    /* Sub-fields container */
    .ass-tf-subfields {
        margin: 6px 0 4px 16px;
        padding-left: 10px;
        border-left: 2px solid rgba(128, 128, 128, 0.2);
    }

    /* Checkbox labels */
    .ass-tf-extends-label,
    .ass-tf-dyn-label,
    .ass-tf-secret-label {
        display: flex;
        align-items: center;
        gap: 3px;
        cursor: pointer;
        flex-shrink: 0;
        font-size: 12px;
        white-space: nowrap;
        color: var(--fg_dim);
    }
    .ass-tf-secret-label {
        color: #9b59b6;
    }
    .ass-tf-secret-label input,
    .ass-tf-extends-label input,
    .ass-tf-dyn-label input {
        margin: 0;
        width: 14px;
        height: 14px;
    }

    /* Category details/summary */
    .ass-tf-category { margin-bottom: 4px; }
    .ass-tf-category summary {
        cursor: pointer;
        padding: 4px 0;
        font-size: 13px;
        user-select: none;
    }
    .ass-tf-category[open] > summary { margin-bottom: 6px; }

    /* Load defaults button */
    .ass-tf-load-defaults {
        opacity: 0.7;
    }
    .ass-tf-load-defaults:hover {
        opacity: 1;
    }
    </style>`;

    $('head').append(css);
}

// #############################################
// # Public API
// #############################################

/**
 * Initialize the tracked fields UI.
 * Called from ui.js during extension init.
 * Renders the collapsible editor into #ass-tracked-fields-container.
 */
export async function initTrackedFieldsUI() {
    injectCSS();

    currentFields = await loadTrackedFields();

    const $container = $('#ass-tracked-fields-container');
    if (!$container.length) return;

    renderAllCategories($container);
    bindEvents($container);
}