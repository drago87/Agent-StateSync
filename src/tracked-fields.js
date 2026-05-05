// tracked-fields.js — Agent-StateSync Tracked Fields Editor
//
// Manages the tracked field definitions for the Agent's state database.
// Three categories: character, scenario, shared.
// Each field can be simple (name + type + hint) or a group with sub-fields.
// Sub-fields can themselves be groups (nested to arbitrary depth).
//
// Icon toggles (instead of checkboxes):
//   Secret    (purple) — hidden from other characters (Character category only)
//   Required  (orange) — must be provided
//   Immutable (red)    — will only be written during initialization
//   Extend    (blue)   — only extends, will not overwrite (simple fields only)
//   Dynamic   (green)  — entries keyed by name (group fields only)
//     Dynamic popup: Off | True | Per-Character | Situation Based
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
// all the inputs, icons, and buttons.
//
// File Version: 4.1.0

import state from './state.js';

// Settings keys
const TRACKED_FIELDS_KEY = 'agent_statesync_tracked_fields';
const SAVED_DEFAULTS_KEY = 'agent_statesync_saved_defaults';

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
 * Uses import.meta.url (standard ES module API) which is always correct
 * regardless of how SillyTavern loads extensions.
 */
function getExtensionBaseUrl() {
    try {
        const moduleUrl = new URL(import.meta.url);
        const path = moduleUrl.pathname;
        const dir = path.substring(0, path.lastIndexOf('/') + 1);
        return dir;
    } catch (e) {
        console.warn('[Agent-StateSync] import.meta.url failed, falling back to script scan:', e.message);
    }

    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
        const src = s.getAttribute('src') || '';
        const match = src.match(/^(.*\/Agent-StateSync\/)/i);
        if (match) return match[1];
    }
    return '/scripts/extensions/third-party/Agent-StateSync/';
}

/**
 * Load default tracked fields from the external JSON files.
 * Returns a promise that resolves to the defaults object.
 * Caches after first successful load.
 * If the cache contains only empty categories (fetch failures),
 * it is invalidated so the next call will retry.
 */
async function loadDefaultFields() {
    if (defaultFieldsCache) {
        const hasContent = ['character', 'scenario', 'shared'].some(
            cat => defaultFieldsCache[cat] && Object.keys(defaultFieldsCache[cat]).length > 0
        );
        if (hasContent) return defaultFieldsCache;
        console.log('[Agent-StateSync] Default fields cache was empty, retrying fetch...');
        defaultFieldsCache = null;
    }

    const base = getExtensionBaseUrl();
    console.log(`[Agent-StateSync] Loading default fields from: ${base}`);

    const files = {
        character: 'default-tracked-character.json',
        scenario: 'default-tracked-scenario.json',
        shared: 'default-tracked-shared.json',
    };

    const result = { character: {}, scenario: {}, shared: {} };

    const promises = Object.entries(files).map(async ([key, filename]) => {
        try {
            const url = `${base}${filename}`;
            console.log(`[Agent-StateSync] Fetching: ${url}`);
            const resp = await fetch(url);
            if (resp.ok) {
                result[key] = await resp.json();
                const count = Object.keys(result[key]).length;
                console.log(`[Agent-StateSync] Loaded ${filename}: ${count} fields`);
            } else {
                console.warn(`[Agent-StateSync] Failed to load ${filename}: HTTP ${resp.status} from ${url}`);
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
        const categories = ['character', 'scenario', 'shared'];
        const hasContent = categories.some(cat => {
            const catData = saved[cat];
            return catData && typeof catData === 'object' && Object.keys(catData).length > 0;
        });
        if (hasContent) return saved;
    }
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
 * Recursively normalize is_dynamic values in a tracked fields payload dict.
 * Converts: false/undefined → "False", true → "True", strings kept as-is.
 * Ensures is_dynamic is always a string in the payload output.
 */
function normalizeIsDynamic(fields) {
    if (!fields || typeof fields !== 'object') return fields;
    const result = {};
    for (const [key, val] of Object.entries(fields)) {
        if (!val || typeof val !== 'object') { result[key] = val; continue; }

        const entry = { ...val };
        if (entry.fields !== undefined) {
            // Group field
            entry.is_dynamic = !entry.is_dynamic || entry.is_dynamic === false
                ? 'False'
                : entry.is_dynamic === true
                    ? 'True'
                    : String(entry.is_dynamic);
            entry.fields = normalizeIsDynamic(entry.fields);
        } else {
            // Simple field — include is_dynamic as string only when non-default
            if (entry.is_dynamic !== undefined && entry.is_dynamic !== false) {
                entry.is_dynamic = entry.is_dynamic === true ? 'True' : String(entry.is_dynamic);
            } else {
                delete entry.is_dynamic;
            }
        }
        result[key] = entry;
    }
    return result;
}

/**
 * Get the current tracked fields for the init payload.
 * Called by session.js when building the POST body.
 * is_dynamic values are normalized to strings.
 */
export function getTrackedFieldsForPayload() {
    if (!currentFields) return null;
    const result = {};
    for (const cat of ['character', 'scenario', 'shared']) {
        if (!currentFields[cat] || Object.keys(currentFields[cat]).length === 0) continue;
        result[cat] = normalizeIsDynamic(currentFields[cat]);
    }
    return Object.keys(result).length > 0 ? result : null;
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
// # Dynamic Value Helpers
// #############################################

/**
 * Normalize is_dynamic to a string value for the data-value attribute.
 * false/undefined → "false"
 * true → "True"
 * string → string (e.g. "Per-Character", "Situation Based")
 */
function normalizeDynamicValue(val) {
    if (!val || val === 'false') return 'false';
    if (val === true) return 'True';
    return String(val);
}

/**
 * Convert a data-value string back to the stored is_dynamic value.
 * "false" → false
 * anything else → the string value
 */
function dynamicValueToStored(val) {
    if (!val || val === 'false') return false;
    return val;
}

// #############################################
// # Icon Toggle Rendering
// #############################################

/**
 * Render all 5 icon toggle buttons for any field type (simple or group).
 * Icons: Secret (purple), Required (orange), Immutable (red), Extend (blue), Dynamic (green)
 */
function renderFieldIcons({ secret, required, immutable, extendsOnly, isDynamic, allowSecret }) {
    const dynValue = normalizeDynamicValue(isDynamic);
    const dynActive = dynValue !== 'false';

    const secretBtn = allowSecret
        ? `<button type="button" class="ass-tf-icon-btn ass-tf-icon-secret${secret ? ' active' : ''}" data-active="${!!secret}"
                title="Secret — hidden from other characters">
            <i class="fa-solid fa-eye-slash"></i>
          </button>`
        : '';

    return `<div class="ass-tf-icon-group">
        ${secretBtn}
        <button type="button" class="ass-tf-icon-btn ass-tf-icon-required${required ? ' active' : ''}" data-active="${!!required}"
                title="Required — must be provided">
            <i class="fa-solid fa-asterisk"></i>
        </button>
        <button type="button" class="ass-tf-icon-btn ass-tf-icon-immutable${immutable ? ' active' : ''}" data-active="${!!immutable}"
                title="Immutable — will only be written during initialization">
            <i class="fa-solid fa-lock"></i>
        </button>
        <button type="button" class="ass-tf-icon-btn ass-tf-icon-extend${extendsOnly ? ' active' : ''}" data-active="${!!extendsOnly}"
                title="Extend — only extends, will not overwrite">
            <i class="fa-solid fa-maximize"></i>
        </button>
        <button type="button" class="ass-tf-icon-btn ass-tf-icon-dynamic${dynActive ? ' active' : ''}" data-value="${dynValue}"
                title="Dynamic — entries keyed by name">
            <i class="fa-solid fa-shuffle"></i>
        </button>
    </div>`;
}

// #############################################
// # Dynamic Popup
// #############################################

/**
 * Show the Dynamic popup for a group field's Dynamic icon.
 * Options: Off, True, Per-Character, Situation Based
 */
function showDynamicPopup($btn) {
    // Remove any existing popup
    $('.ass-tf-dyn-popup').remove();
    $(document).off('mousedown.ass-tf-dyn-popup');

    const currentValue = $btn.attr('data-value') || 'false';

    const options = [
        { value: 'false', label: 'Off' },
        { value: 'True', label: 'True' },
        { value: 'Per-Character', label: 'Per-Character' },
        { value: 'Situation-Based', label: 'Situation-Based' },
    ];

    const optionsHtml = options.map(opt =>
        `<div class="ass-tf-dyn-option${opt.value === currentValue ? ' ass-tf-dyn-active' : ''}"
             data-value="${opt.value}">${opt.label}</div>`
    ).join('');

    const $popup = $(`<div class="ass-tf-dyn-popup">${optionsHtml}</div>`);

    // Position near the button
    const btnRect = $btn[0].getBoundingClientRect();
    $popup.css({
        position: 'fixed',
        top: btnRect.bottom + 4,
        left: Math.max(4, btnRect.left - 60),
        zIndex: 10002,
    });

    $('body').append($popup);

    // Click handler for options
    $popup.on('click', '.ass-tf-dyn-option', function () {
        const newValue = $(this).attr('data-value');
        $btn.attr('data-value', newValue);
        const isActive = newValue !== 'false';
        $btn.toggleClass('active', isActive);
        $popup.remove();
        $(document).off('mousedown.ass-tf-dyn-popup');
        syncFieldsFromDOM();
        scheduleSave();
    });

    // Click outside to close
    setTimeout(() => {
        $(document).on('mousedown.ass-tf-dyn-popup', function (e) {
            if (!$(e.target).closest('.ass-tf-dyn-popup, .ass-tf-icon-dynamic').length) {
                $popup.remove();
                $(document).off('mousedown.ass-tf-dyn-popup');
            }
        });
    }, 10);
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
            <button class="menu_button ass-tf-add-group-field" data-category="${key}">
                <i class="fa-solid fa-folder-plus"></i> Add group-field
            </button>
            <button class="menu_button ass-tf-save-defaults" data-category="${key}" title="Save current fields as default for ${label}">
                <i class="fa-solid fa-floppy-disk"></i> Save as Default
            </button>
            <button class="menu_button ass-tf-load-defaults" data-category="${key}" title="Reset this category to defaults">
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
    const isDynamic = field.is_dynamic || false;
    const secret = field.secret || false;
    const required = field.required || false;
    const immutable = field.immutable || false;
    const isNested = depth > 0;

    const addSubBtn = !isNested
        ? `<button class="menu_button ass-tf-add-sub-to-field"
                  title="Add sub-field (converts to group)">
               <i class="fa-solid fa-sitemap"></i>
           </button>`
        : '';

    const depthClass = isNested ? 'ass-tf-nested' : '';

    const iconsHtml = renderFieldIcons({
        secret, required, immutable, extendsOnly, isDynamic, allowSecret,
    });

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
            ${iconsHtml}
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
    const extendsOnly = field.extends_only || false;
    const secret = field.secret || false;
    const required = field.required || false;
    const immutable = field.immutable || false;
    const fields = field.fields || {};

    let subfieldsHtml = '';
    for (const [subKey, subField] of Object.entries(fields)) {
        subfieldsHtml += renderField(category, subKey, subField, depth + 1, allowSecret);
    }

    const iconsHtml = renderFieldIcons({
        secret, required, immutable, extendsOnly, isDynamic, allowSecret,
    });

    return `
    <div class="ass-tf-field ass-tf-group" data-category="${category}" data-key="${escapeAttr(key)}" data-depth="${depth}">
        <div class="ass-tf-row">
            <input class="text_pole ass-tf-name" value="${escapeAttr(key)}"
                   placeholder="Group name">
            <input class="text_pole ass-tf-desc" value="${escapeAttr(description)}"
                   placeholder="Description">
            ${iconsHtml}
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
 * Read icon toggle active state from a row's icon group.
 */
function readIconActive($row, selector) {
    const $btn = $row.find('> .ass-tf-icon-group > ' + selector);
    if (!$btn.length) return false;
    return $btn.attr('data-active') === 'true';
}

/**
 * Read Dynamic icon value from a row's icon group.
 */
function readDynamicValue($row) {
    const $btn = $row.find('> .ass-tf-icon-group > .ass-tf-icon-dynamic');
    if (!$btn.length) return false;
    return dynamicValueToStored($btn.attr('data-value') || 'false');
}

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
    const $row = $el.find('> .ass-tf-row');

    if ($el.hasClass('ass-tf-group')) {
        const result = {
            description: ($row.find('> .ass-tf-desc').val() || '').trim(),
            fields: {},
        };

        const isDynamic = readDynamicValue($row);
        const extendsOnly = readIconActive($row, '.ass-tf-icon-extend');
        const secret = readIconActive($row, '.ass-tf-icon-secret');
        const required = readIconActive($row, '.ass-tf-icon-required');
        const immutable = readIconActive($row, '.ass-tf-icon-immutable');
        if (isDynamic) result.is_dynamic = isDynamic;
        if (extendsOnly) result.extends_only = true;
        if (secret) result.secret = true;
        if (required) result.required = true;
        if (immutable) result.immutable = true;

        $el.children('.ass-tf-subfields').children('.ass-tf-field').each(function () {
            const subKey = String($(this).attr('data-key'));
            if (subKey) result.fields[subKey] = readFieldFromDOM($(this));
        });

        return result;
    } else {
        const result = {
            type: $row.find('> .ass-tf-type').val() || 'string',
            hint: ($row.find('> .ass-tf-hint').val() || '').trim(),
        };

        const extendsOnly = readIconActive($row, '.ass-tf-icon-extend');
        const isDynamic = readDynamicValue($row);
        const secret = readIconActive($row, '.ass-tf-icon-secret');
        const required = readIconActive($row, '.ass-tf-icon-required');
        const immutable = readIconActive($row, '.ass-tf-icon-immutable');
        if (extendsOnly) result.extends_only = true;
        if (isDynamic) result.is_dynamic = isDynamic;
        if (secret) result.secret = true;
        if (required) result.required = true;
        if (immutable) result.immutable = true;

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
    syncFieldsFromDOM();

    const name = 'new_field_' + Date.now();
    currentFields[category] = currentFields[category] || {};
    currentFields[category][name] = {
        type: 'string',
        hint: '',
    };
    openCategories[category] = true;
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

function addGroupField(category) {
    syncFieldsFromDOM();

    const name = 'new_group_' + Date.now();
    currentFields[category] = currentFields[category] || {};
    currentFields[category][name] = {
        description: '',
        fields: {},
    };
    openCategories[category] = true;
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

async function saveAsDefault(category) {
    syncFieldsFromDOM();

    const savedDefaults = state.context.extensionSettings?.[SAVED_DEFAULTS_KEY] || {};
    savedDefaults[category] = JSON.parse(JSON.stringify(currentFields[category] || {}));
    state.context.extensionSettings[SAVED_DEFAULTS_KEY] = savedDefaults;
    state.context.saveSettingsDebounced();

    toastr.success(`Saved current ${category} fields as default.`, 'Agent-StateSync');
}

async function loadDefaults(category) {
    // Confirmation popup
    const confirmed = await new Promise(resolve => {
        const $confirm = $(`
        <div class="ass-tf-overlay" style="z-index:10001;">
            <div class="ass-tf-modal" style="width:380px;">
                <div class="ass-tf-modal-header">
                    <h3><i class="fa-solid fa-rotate-left"></i> Load Defaults</h3>
                </div>
                <div class="ass-tf-modal-body" style="padding:16px;">
                    <p style="margin:0 0 12px;">This will replace all fields in this category with the saved defaults (or JSON file defaults if none saved). Continue?</p>
                    <div style="display:flex; gap:8px; justify-content:flex-end;">
                        <button class="menu_button ass-tf-confirm-cancel">Cancel</button>
                        <button class="menu_button ass-tf-confirm-ok" style="background:rgba(231,76,60,0.15); border-color:rgba(231,76,60,0.3);">
                            <i class="fa-solid fa-rotate-left"></i> Load Defaults
                        </button>
                    </div>
                </div>
            </div>
        </div>`);
        $('body').append($confirm);
        $confirm.on('click', '.ass-tf-confirm-ok', () => { $confirm.remove(); resolve(true); });
        $confirm.on('click', '.ass-tf-confirm-cancel', () => { $confirm.remove(); resolve(false); });
        $confirm.on('mousedown', function (e) {
            if ($(e.target).is('.ass-tf-overlay')) { $confirm.remove(); resolve(false); }
        });
    });

    if (!confirmed) return;

    try {
        // Sync DOM → currentFields first to preserve any unsaved edits in OTHER categories
        syncFieldsFromDOM();

        // Check for saved defaults first
        const savedDefaults = state.context.extensionSettings?.[SAVED_DEFAULTS_KEY];
        if (savedDefaults?.[category]) {
            currentFields[category] = JSON.parse(JSON.stringify(savedDefaults[category]));
            openCategories[category] = true;
            snapshotOpenCategories();
            renderAllCategories();
            scheduleSave();
            console.log(`[Agent-StateSync] Loaded saved defaults for "${category}"`);
            toastr.success(`Loaded saved defaults for ${category}.`, 'Agent-StateSync');
            return;
        }

        // Fall back to JSON file defaults
        const defaults = await loadDefaultCategory(category);
        const count = Object.keys(defaults).length;
        console.log(`[Agent-StateSync] loadDefaults("${category}"): got ${count} fields from JSON`);

        if (count === 0) {
            console.warn(`[Agent-StateSync] loadDefaults("${category}"): defaults were empty — JSON file may be missing. Base URL: ${getExtensionBaseUrl()}`);
            toastr.warning(`Could not load defaults for ${category} — JSON file not found. Check the browser console (F12) for details.`, 'Agent-StateSync');
            return;
        }

        currentFields[category] = defaults;
        openCategories[category] = true;
        snapshotOpenCategories();
        renderAllCategories();
        scheduleSave();
        console.log(`[Agent-StateSync] Loaded default tracked fields for "${category}"`);
        toastr.success(`Loaded JSON file defaults for ${category}.`, 'Agent-StateSync');
    } catch (err) {
        console.error(`[Agent-StateSync] loadDefaults("${category}") error:`, err);
        toastr.error(`Error loading defaults: ${err.message}`, 'Agent-StateSync');
    }
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
        const subField = {
            type: field.type || 'string',
            hint: field.hint || '',
        };
        if (field.extends_only) subField.extends_only = true;
        field.fields = {};
        field.fields['sub_1'] = subField;
        field.description = field.hint || '';
        // Keep meta properties on the group
        // secret, required, immutable stay on the group
        delete field.type;
        delete field.hint;
        delete field.extends_only;
    } else {
        const subName = 'new_sub_' + Date.now();
        field.fields[subName] = { type: 'string', hint: '' };
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
        const subField = {
            type: field.type || 'string',
            hint: field.hint || '',
        };
        if (field.extends_only) subField.extends_only = true;
        field.fields = {};
        field.fields['sub_1'] = subField;
        field.description = field.hint || '';
        delete field.type;
        delete field.hint;
        delete field.extends_only;
    }

    const subName = 'new_group_' + Date.now();
    field.fields[subName] = {
        description: '',
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
    // Also clean up any stray dynamic popups
    $('.ass-tf-dyn-popup').remove();
    $(document).off('mousedown.ass-tf-dyn-popup');

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

    // --- Icon toggle clicks ---
    $modal.on('click.ass-tf', '.ass-tf-icon-secret, .ass-tf-icon-required, .ass-tf-icon-immutable, .ass-tf-icon-extend', function (e) {
        e.stopPropagation();
        const $btn = $(this);
        const isActive = $btn.attr('data-active') === 'true';
        $btn.attr('data-active', !isActive);
        $btn.toggleClass('active', !isActive);
        syncFieldsFromDOM();
        scheduleSave();
    });

    // --- Dynamic icon click — show popup ---
    $modal.on('click.ass-tf', '.ass-tf-icon-dynamic', function (e) {
        e.stopPropagation();
        showDynamicPopup($(this));
    });

    // Add field
    $modal.on('click.ass-tf', '.ass-tf-add-field', function () {
        addField($(this).attr('data-category'));
    });

    // Add group-field
    $modal.on('click.ass-tf', '.ass-tf-add-group-field', function () {
        addGroupField($(this).attr('data-category'));
    });

    // Save as default
    $modal.on('click.ass-tf', '.ass-tf-save-defaults', async function () {
        await saveAsDefault($(this).attr('data-category'));
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
        width: 1000px;
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
        flex-wrap: wrap;
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

    /* Icon toggle buttons */
    .ass-tf-icon-group {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
    }
    .ass-tf-icon-btn {
        background: none;
        border: 1px solid transparent;
        border-radius: 3px;
        padding: 2px 5px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        transition: all 0.15s;
        opacity: 0.3;
    }
    .ass-tf-icon-btn:hover {
        opacity: 0.7;
    }
    .ass-tf-icon-btn.active {
        opacity: 1;
    }
    .ass-tf-icon-secret { color: #9b59b6; }
    .ass-tf-icon-secret.active { background: rgba(155, 89, 182, 0.15); border-color: rgba(155, 89, 182, 0.3); }
    .ass-tf-icon-required { color: #e67e22; }
    .ass-tf-icon-required.active { background: rgba(230, 126, 34, 0.15); border-color: rgba(230, 126, 34, 0.3); }
    .ass-tf-icon-immutable { color: #e74c3c; }
    .ass-tf-icon-immutable.active { background: rgba(231, 76, 60, 0.15); border-color: rgba(231, 76, 60, 0.3); }
    .ass-tf-icon-extend { color: #3498db; }
    .ass-tf-icon-extend.active { background: rgba(52, 152, 219, 0.15); border-color: rgba(52, 152, 219, 0.3); }
    .ass-tf-icon-dynamic { color: #27ae60; }
    .ass-tf-icon-dynamic.active { background: rgba(39, 174, 96, 0.15); border-color: rgba(39, 174, 96, 0.3); }

    /* Dynamic popup */
    .ass-tf-dyn-popup {
        background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.98));
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        padding: 4px 0;
        min-width: 150px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .ass-tf-dyn-option {
        padding: 6px 12px;
        font-size: 12px;
        cursor: pointer;
        color: var(--fg_dim);
        transition: background 0.1s, color 0.1s;
    }
    .ass-tf-dyn-option:hover {
        background: rgba(128, 128, 128, 0.15);
        color: var(--fg);
    }
    .ass-tf-dyn-active {
        color: #27ae60;
        font-weight: 600;
    }
    .ass-tf-dyn-active::before {
        content: '\\2713 ';
    }

    /* Save / Load defaults buttons */
    .ass-tf-save-defaults,
    .ass-tf-load-defaults {
        opacity: 0.7;
    }
    .ass-tf-save-defaults:hover,
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
