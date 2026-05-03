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
//
// The editor opens in a wide overlay modal (not inline in the settings
// panel) so that the field rows have enough horizontal space for
// all the inputs, checkboxes, and buttons.
//
// File Version: 3.0.0

import state from './state.js';

// Settings key for user customizations
const TRACKED_FIELDS_KEY = 'agent_statesync_tracked_fields';

// Module-level: current fields (defaults merged with user edits)
let currentFields = null;
let saveTimeout = null;

// Cached default fields loaded from JSON files
let defaultFieldsCache = null;

// Which categories are currently expanded (persists across re-renders)
let openCategories = { character: false, scenario: false, shared: false };

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
 * If saved data exists but all categories are empty, loads defaults instead.
 */
async function loadTrackedFields() {
    const saved = state.context.extensionSettings?.[TRACKED_FIELDS_KEY];
    if (saved && typeof saved === 'object') {
        // Check if saved data has any actual field definitions.
        // If all categories are empty objects, fall through to defaults.
        const categories = ['character', 'scenario', 'shared'];
        const hasContent = categories.some(cat => {
            const catData = saved[cat];
            return catData && typeof catData === 'object' && Object.keys(catData).length > 0;
        });
        if (hasContent) return saved;
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
    const fieldCount = entries.length;

    let fieldsHtml = '';
    for (const [fieldKey, fieldValue] of entries) {
        fieldsHtml += renderField(key, fieldKey, fieldValue, 0, allowSecret);
    }

    const countBadge = fieldCount > 0
        ? `<span class="ass-tf-count">${fieldCount}</span>`
        : '';

    return `
    <details ${open ? 'open' : ''} class="ass-tf-category" data-category="${key}">
        <summary class="ass-tf-category-summary">
            <b>${label}</b> ${countBadge}
        </summary>
        <div class="ass-tf-fields">${fieldsHtml}</div>
        <div class="ass-tf-category-actions">
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

    const secretHtml = allowSecret
        ? `<label class="ass-tf-secret-label" title="Mark as secret — hidden from other characters">
               <input type="checkbox" class="ass-tf-secret" ${secret ? 'checked' : ''}>
               <i class="fa-solid fa-eye-slash"></i>
           </label>`
        : '';

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
                   placeholder="Field name">
            <input class="text_pole ass-tf-hint" value="${escapeAttr(hint)}"
                   placeholder="Description / Hint">
            <select class="text_pole ass-tf-type">
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

    const secretHtml = allowSecret
        ? `<label class="ass-tf-secret-label" title="Mark as secret — hidden from other characters">
               <input type="checkbox" class="ass-tf-secret" ${secret ? 'checked' : ''}>
               <i class="fa-solid fa-eye-slash"></i>
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
                   placeholder="Group name">
            <input class="text_pole ass-tf-desc" value="${escapeAttr(description)}"
                   placeholder="Description">
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
        <div class="ass-tf-group-actions">
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
 * Only called for live input/checkbox changes, NOT during re-renders.
 */
function syncFieldsFromDOM() {
    const categories = ['character', 'scenario', 'shared'];
    const $container = $('#ass-tf-modal-fields');

    if (!$container.length) return;

    for (const cat of categories) {
        const $topFields = $container.find(`.ass-tf-field[data-category="${cat}"][data-depth="0"]`);
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

        const $secret = $el.find('> .ass-tf-row > .ass-tf-secret-label > .ass-tf-secret');
        if ($secret.length) {
            result.secret = $secret.is(':checked');
        }

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

        const $secret = $el.find('> .ass-tf-row > .ass-tf-secret-label > .ass-tf-secret');
        if ($secret.length) {
            result.secret = $secret.is(':checked');
        }

        return result;
    }
}

// #############################################
// # Render All Categories
// #############################################

function renderAllCategories() {
    const $container = $('#ass-tf-modal-fields');
    if (!$container.length) return;

    const categories = [
        { key: 'character', label: 'Character', open: openCategories['character'], allowSecret: true },
        { key: 'scenario',  label: 'Scenario',  open: openCategories['scenario'],  allowSecret: false },
        { key: 'shared',    label: 'Shared',    open: openCategories['shared'],    allowSecret: false },
    ];

    $container.empty();
    for (const cat of categories) {
        $container.append(renderCategory(cat));
    }
}

/**
 * Snapshot which categories are open before a re-render.
 */
function snapshotOpenCategories() {
    const $container = $('#ass-tf-modal-fields');
    if (!$container.length) return;

    $container.find('.ass-tf-category').each(function () {
        const key = $(this).attr('data-category');
        if (key) openCategories[key] = this.open;
    });
}

// #############################################
// # Edit Handlers
// #############################################

function addField(category) {
    // Sync DOM → currentFields first to preserve any unsaved edits
    syncFieldsFromDOM();

    const name = 'new_field_' + Date.now();
    currentFields[category] = currentFields[category] || {};
    currentFields[category][name] = {
        type: 'string',
        hint: '',
        extends_only: false,
    };
    openCategories[category] = true;
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

async function loadDefaults(category) {
    // Sync DOM → currentFields first to preserve any unsaved edits in OTHER categories
    syncFieldsFromDOM();

    // Load and replace this category entirely
    const defaults = await loadDefaultCategory(category);
    currentFields[category] = defaults;
    openCategories[category] = true;
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
    console.log(`[Agent-StateSync] Loaded default tracked fields for "${category}"`);
}

function removeField(category, key) {
    syncFieldsFromDOM();
    delete currentFields[category]?.[key];
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

/**
 * Add a simple sub-field to a group.
 * If the parent is a simple field, convert it to a group first.
 */
function addSubFieldToGroup(category, key) {
    syncFieldsFromDOM();
    const field = findField(currentFields[category], key);
    if (!field) return;

    if (!isGroup(field)) {
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

    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

/**
 * Add a sub-group (nested group) to an existing group.
 */
function addSubGroup(category, key) {
    syncFieldsFromDOM();
    const field = findField(currentFields[category], key);
    if (!field) return;

    if (!isGroup(field)) {
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

    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

function removeSubField(category, parentKey, subKey) {
    syncFieldsFromDOM();
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

    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

function findField(parentObj, key) {
    return parentObj?.[key];
}

// #############################################
// # Modal Panel
// #############################################

/**
 * Open the tracked fields editor modal.
 */
function openTFModal() {
    if ($('#ass-tf-overlay').length) return;

    // Reset open state — categories with fields start open
    for (const cat of ['character', 'scenario', 'shared']) {
        const data = currentFields[cat];
        openCategories[cat] = data && typeof data === 'object' && Object.keys(data).length > 0;
    }

    const categoriesHtml = renderModalCategories();

    const html = `
    <div id="ass-tf-overlay" class="ass-tf-overlay">
        <div class="ass-tf-modal" id="ass-tf-modal">
            <div class="ass-tf-modal-header">
                <h3><i class="fa-solid fa-database"></i> Database Tracked Fields</h3>
                <button id="ass-tf-modal-close" class="ass-tf-modal-close" type="button">&times;</button>
            </div>
            <div class="ass-tf-modal-body">
                <div id="ass-tf-modal-fields">
                    ${categoriesHtml}
                </div>
                <div class="ass-tf-modal-info">
                    Define the tracked field schema for the Agent's state database.
                    These are the global fields — per-character and per-persona additions
                    are configured in their respective brain panels.
                    <br><br>
                    <i class="fa-solid fa-eye-slash" style="color:#9b59b6;"></i> = Secret — hidden from other characters in group chat (Character category only).
                    <br>
                    <i class="fa-solid fa-sitemap" style="opacity:0.7;"></i> = Convert to group with sub-fields.
                </div>
            </div>
        </div>
    </div>`;

    $('body').append(html);
    bindModalEvents();
}

function renderModalCategories() {
    const categories = [
        { key: 'character', label: 'Character', open: openCategories['character'], allowSecret: true },
        { key: 'scenario',  label: 'Scenario',  open: openCategories['scenario'],  allowSecret: false },
        { key: 'shared',    label: 'Shared',    open: openCategories['shared'],    allowSecret: false },
    ];

    let html = '';
    for (const cat of categories) {
        html += renderCategory(cat);
    }
    return html;
}

/**
 * Close the modal — no save needed here because all edits
 * are saved live via scheduleSave().
 */
function closeTFModal() {
    // Final sync in case there are unsaved input changes
    syncFieldsFromDOM();
    saveTrackedFields();

    $('#ass-tf-overlay').remove();
    $(document).off('keydown.ass-tf-modal');

    // Update the field count badge on the settings button
    updateTFButton();
}

/**
 * Update the button text/badge in the settings panel to show
 * how many fields are defined.
 */
function updateTFButton() {
    const $btn = $('#ass-tf-open-btn');
    if (!$btn.length) return;

    let total = 0;
    for (const cat of ['character', 'scenario', 'shared']) {
        const data = currentFields[cat];
        if (data && typeof data === 'object') {
            total += Object.keys(data).length;
        }
    }

    const badge = total > 0 ? ` (${total})` : '';
    $btn.html(`<i class="fa-solid fa-database"></i> Database Tracked Fields${badge}`);
}

// #############################################
// # Modal Event Binding
// #############################################

function bindModalEvents() {
    const $modal = $('#ass-tf-modal');

    // Close button
    $('#ass-tf-modal-close').on('click', closeTFModal);

    // Click backdrop to close
    $('#ass-tf-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-tf-overlay')) closeTFModal();
    });

    // Escape to close
    $(document).on('keydown.ass-tf-modal', function (e) {
        if (e.key === 'Escape') closeTFModal();
    });

    // Prevent button clicks inside <details> from toggling the details closed
    $modal.on('click.ass-tf', '.ass-tf-category button', function (e) {
        e.preventDefault();
    });

    // Track category open/close state
    $modal.on('toggle.ass-tf', '.ass-tf-category', function () {
        const key = $(this).attr('data-category');
        if (key) openCategories[key] = this.open;
    });

    // Input changes — live sync + save
    $modal.on('input.ass-tf', '.ass-tf-name, .ass-tf-hint, .ass-tf-desc, .ass-tf-type', function () {
        syncFieldsFromDOM();
        scheduleSave();
    });

    // Checkbox changes — live sync + save
    $modal.on('change.ass-tf', '.ass-tf-extends, .ass-tf-dynamic, .ass-tf-secret', function () {
        syncFieldsFromDOM();
        scheduleSave();
    });

    // Add field
    $modal.on('click.ass-tf', '.ass-tf-add-field', function () {
        addField($(this).attr('data-category'));
    });

    // Load defaults
    $modal.on('click.ass-tf', '.ass-tf-load-defaults', async function () {
        const category = $(this).attr('data-category');
        await loadDefaults(category);
    });

    // Remove field
    $modal.on('click.ass-tf', '.ass-tf-remove-field', function () {
        const $field = $(this).closest('.ass-tf-field');
        const category = $field.attr('data-category');
        const depth = parseInt($field.attr('data-depth') || '0', 10);

        if (depth === 0) {
            removeField(category, $field.attr('data-key'));
        } else {
            const $parent = $field.parent().closest('.ass-tf-field');
            const parentKey = $parent.attr('data-key');
            removeSubField(category, parentKey, $field.attr('data-key'));
        }
    });

    // Add sub-field to group
    $modal.on('click.ass-tf', '.ass-tf-add-subfield', function () {
        addSubFieldToGroup($(this).attr('data-category'), $(this).attr('data-key'));
    });

    // Add sub-field via sitemap button (converts to group)
    $modal.on('click.ass-tf', '.ass-tf-add-sub-to-field', function () {
        const $field = $(this).closest('.ass-tf-field');
        addSubFieldToGroup($field.attr('data-category'), $field.attr('data-key'));
    });

    // Add sub-group
    $modal.on('click.ass-tf', '.ass-tf-add-subgroup', function () {
        addSubGroup($(this).attr('data-category'), $(this).attr('data-key'));
    });
}

// #############################################
// # CSS
// #############################################

function injectCSS() {
    if ($('#ass-tf-css').length) return;

    const css = `<style id="ass-tf-css">
    /* Settings button */
    #ass-tf-open-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: 1px solid rgba(128, 128, 128, 0.25);
        border-radius: 4px;
        background: rgba(128, 128, 128, 0.1);
        color: var(--fg);
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s;
        white-space: nowrap;
    }
    #ass-tf-open-btn:hover {
        background: rgba(128, 128, 128, 0.2);
        border-color: rgba(128, 128, 128, 0.4);
    }
    #ass-tf-open-btn i {
        color: #9b59b6;
    }

    /* Overlay backdrop */
    .ass-tf-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: ass-tf-fade-in 0.15s ease-out;
    }
    @keyframes ass-tf-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }

    /* Modal panel — wide for horizontal field rows */
    .ass-tf-modal {
        background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.97));
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 10px;
        width: 820px;
        max-width: 95vw;
        max-height: 85vh;
        overflow-y: auto;
        padding: 20px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        animation: ass-tf-slide-in 0.2s ease-out;
    }
    @keyframes ass-tf-slide-in {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }

    /* Modal header */
    .ass-tf-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
    }
    .ass-tf-modal-header h3 {
        margin: 0;
        color: var(--fg);
        font-size: 15px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .ass-tf-modal-header h3 i {
        color: #9b59b6;
    }
    .ass-tf-modal-close {
        background: none;
        border: none;
        color: var(--fg_dim);
        font-size: 22px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.2s;
    }
    .ass-tf-modal-close:hover {
        color: var(--fg);
    }

    /* Modal body */
    .ass-tf-modal-body {
        /* just a wrapper */
    }
    .ass-tf-modal-info {
        font-size: 11px;
        color: var(--fg_dim);
        margin-top: 12px;
        line-height: 1.6;
        padding-top: 10px;
        border-top: 1px solid rgba(128, 128, 128, 0.2);
    }

    /* Category details/summary */
    .ass-tf-category {
        margin-bottom: 6px;
    }
    .ass-tf-category-summary {
        cursor: pointer;
        padding: 6px 0;
        font-size: 13px;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .ass-tf-category-summary:hover {
        color: var(--fg);
    }
    .ass-tf-category[open] > .ass-tf-category-summary {
        margin-bottom: 6px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.15);
    }
    .ass-tf-count {
        font-size: 11px;
        background: rgba(155, 89, 182, 0.2);
        color: #9b59b6;
        border-radius: 8px;
        padding: 1px 6px;
        font-weight: 600;
    }
    .ass-tf-category-actions {
        margin: 8px 0 4px 0;
        display: flex;
        gap: 6px;
    }

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
    .ass-tf-row .ass-tf-name { flex: 1; min-width: 120px; }
    .ass-tf-row .ass-tf-hint { flex: 3; min-width: 150px; }
    .ass-tf-row .ass-tf-desc { flex: 3; min-width: 150px; }
    .ass-tf-row .ass-tf-type { flex: 0 0 130px; }

    /* Sub-fields container */
    .ass-tf-subfields {
        margin: 6px 0 4px 16px;
        padding-left: 10px;
        border-left: 2px solid rgba(128, 128, 128, 0.2);
    }

    /* Group action buttons */
    .ass-tf-group-actions {
        margin: 4px 0 4px 20px;
        display: flex;
        gap: 6px;
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
 * Called from ui-settings.js during extension init.
 * Injects CSS and binds the "open modal" button.
 * Data is loaded lazily when the modal opens.
 */
export async function initTrackedFieldsUI() {
    injectCSS();

    // Load data at init time so it's ready for the payload
    currentFields = await loadTrackedFields();

    // Bind the "open modal" button
    $('#ass-tf-open-btn').on('click', openTFModal);

    // Update button badge
    updateTFButton();
}
