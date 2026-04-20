// tracked-fields.js — Agent-StateSync Tracked Fields Editor
//
// Manages the tracked field definitions for the Agent's state database.
// Three categories: character, scenario, shared.
// Each field can be simple (name + type + hint) or a group with sub-fields.
// Defaults come from default-config.json; user edits saved to ST extensionSettings.
// The merged data is included in the session init payload.
// File Version: 1.0.3

import state from './state.js';
import defaultConfig from './default-config.js';

// Settings key for user customizations
const TRACKED_FIELDS_KEY = 'agent_statesync_tracked_fields';

// Module-level: current fields (defaults merged with user edits)
let currentFields = null;
let saveTimeout = null;

// #############################################
// # Data Load / Save
// #############################################

/**
 * Load tracked fields: user customizations from ST settings,
 * falling back to defaults from default-config.json.
 */
function loadTrackedFields() {
    const saved = state.context.extensionSettings?.[TRACKED_FIELDS_KEY];
    if (saved && typeof saved === 'object') {
        return saved;
    }
    // Deep clone defaults so we don't mutate the imported object
    return JSON.parse(JSON.stringify(defaultConfig.tracked_fields));
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
    return currentFields || loadTrackedFields();
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

function renderCategory({ key, label, open }) {
    const fields = currentFields[key] || {};
    const entries = Object.entries(fields);

    let fieldsHtml = '';
    for (const [fieldKey, fieldValue] of entries) {
        fieldsHtml += isGroup(fieldValue)
            ? renderGroupField(key, fieldKey, fieldValue)
            : renderSimpleField(key, fieldKey, fieldValue);
    }

    return `
    <details ${open ? 'open' : ''} class="ass-tf-category">
        <summary><b>${label}</b></summary>
        <div class="ass-tf-fields">${fieldsHtml}</div>
        <div style="margin-top:6px;">
            <button class="menu_button ass-tf-add-field" data-category="${key}">
                <i class="fa-solid fa-plus"></i> Add field
            </button>
        </div>
    </details>`;
}

function renderSimpleField(category, key, field) {
    const type = field.type || 'string';
    const hint = field.hint || '';
    const extendsOnly = field.extends_only || false;

    return `
    <div class="ass-tf-field" data-category="${category}" data-key="${escapeAttr(key)}">
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
            <button class="menu_button ass-tf-add-sub-to-field"
                    title="Add sub-field (converts to group)">
                <i class="fa-solid fa-sitemap"></i>
            </button>
            <button class="menu_button ass-tf-remove-field" title="Remove field">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>`;
}

function renderGroupField(category, key, field) {
    const description = field.description || '';
    const isDynamic = field.is_dynamic || false;
    const fields = field.fields || {};

    let subfieldsHtml = '';
    for (const [subKey, subField] of Object.entries(fields)) {
        subfieldsHtml += renderSubFieldRow(subKey, subField);
    }

    return `
    <div class="ass-tf-field ass-tf-group" data-category="${category}" data-key="${escapeAttr(key)}">
        <div class="ass-tf-row">
            <input class="text_pole ass-tf-name" value="${escapeAttr(key)}"
                   placeholder="Group name" style="flex:1; min-width:0;">
            <input class="text_pole ass-tf-desc" value="${escapeAttr(description)}"
                   placeholder="Description" style="flex:3; min-width:0;">
            <label class="ass-tf-dyn-label" title="Dynamic — entries keyed by name">
                <input type="checkbox" class="ass-tf-dynamic" ${isDynamic ? 'checked' : ''}>
                <small>Dyn</small>
            </label>
            <button class="menu_button ass-tf-remove-field" title="Remove group">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        <div class="ass-tf-subfields">
            ${subfieldsHtml}
        </div>
        <div style="margin:4px 0 4px 20px;">
            <button class="menu_button ass-tf-add-subfield"
                    data-category="${category}" data-key="${escapeAttr(key)}">
                <i class="fa-solid fa-plus"></i> Add sub-field
            </button>
        </div>
    </div>`;
}

function renderSubFieldRow(key, field) {
    const type = field.type || 'string';
    const hint = field.hint || '';
    const extendsOnly = field.extends_only || false;

    return `
    <div class="ass-tf-row ass-tf-subfield-row" data-subkey="${escapeAttr(key)}">
        <input class="text_pole ass-tf-sub-name" value="${escapeAttr(key)}"
               placeholder="Sub-field name" style="flex:1; min-width:0;">
        <select class="text_pole ass-tf-sub-type" style="flex:0 0 130px;">
            ${buildTypeOptions(type)}
        </select>
        <input class="text_pole ass-tf-sub-hint" value="${escapeAttr(hint)}"
               placeholder="Hint" style="flex:2; min-width:0;">
        <label class="ass-tf-extends-label" title="Only extends this and will not overwrite">
            <input type="checkbox" class="ass-tf-extends" ${extendsOnly ? 'checked' : ''}>
        </label>
        <button class="menu_button ass-tf-remove-subfield" title="Remove sub-field">
            <i class="fa-solid fa-xmark"></i>
        </button>
    </div>`;
}

function isGroup(field) {
    return field && field.fields !== undefined;
}

/**
 * Read all current DOM values and sync them into currentFields.
 * Ensures data model is perfectly in sync before any re-render.
 */
function syncFieldsFromDOM() {
    $('#ass-tracked-fields-container .ass-tf-field').each(function () {
        const $field = $(this);
        const category = $field.attr('data-category');
        const oldKey = String($field.attr('data-key'));
        const field = currentFields[category]?.[oldKey];
        if (!field) return;

        // Sync parent field name
        const newName = $field.find('> .ass-tf-row > .ass-tf-name').val().trim();
        if (newName && newName !== oldKey) {
            delete currentFields[category][oldKey];
            currentFields[category][newName] = field;
        }

        if (isGroup(field)) {
            field.description = $field.find('.ass-tf-desc').val().trim();
            field.is_dynamic = $field.find('.ass-tf-dynamic').is(':checked');

            // Sync all sub-fields
            $field.find('.ass-tf-subfield-row').each(function () {
                const $subrow = $(this);
                const subOldKey = String($subrow.attr('data-subkey'));
                const subField = field.fields[subOldKey];
                if (!subField) return;

                const subNewName = $subrow.find('.ass-tf-sub-name').val().trim();
                if (subNewName && subNewName !== subOldKey) {
                    delete field.fields[subOldKey];
                    field.fields[subNewName] = subField;
                }

                subField.type = $subrow.find('.ass-tf-sub-type').val();
                subField.hint = $subrow.find('.ass-tf-sub-hint').val().trim();
                subField.extends_only = $subrow.find('.ass-tf-extends').is(':checked');
            });
        } else {
            field.type = $field.find('.ass-tf-type').val();
            field.hint = $field.find('.ass-tf-hint').val().trim();
            field.extends_only = $field.find('.ass-tf-extends').is(':checked');
        }
    });
}

// #############################################
// # Render All
// #############################################

function renderAllCategories($container) {
    // Flush all pending DOM edits into currentFields before re-rendering.
    // This prevents stale data when adding/removing fields.
    syncFieldsFromDOM();

    const categories = [
        { key: 'character', label: 'Character', open: true },
        { key: 'scenario',  label: 'Scenario',  open: false },
        { key: 'shared',    label: 'Shared',    open: false },
    ];

    $container.empty();
    for (const cat of categories) {
        $container.append(renderCategory(cat));
    }
}

// #############################################
// # Edit Handlers
// #############################################

/**
 * Read DOM state back into currentFields for a given input.
 * Handles both simple fields and group fields, including sub-field edits.
 */
function handleFieldEdit($input) {
    const $field = $input.closest('.ass-tf-field');
    if (!$field.length) return;

    const category = $field.attr('data-category');
    const oldKey = String($field.attr('data-key'));
    const field = currentFields[category]?.[oldKey];
    if (!field) return;

    const newName = $field.find('> .ass-tf-row > .ass-tf-name').val().trim();

    // Rename key if the name changed
    if (newName && newName !== oldKey) {
        delete currentFields[category][oldKey];
        currentFields[category][newName] = field;
        $field.attr('data-key', newName);
    }

    if (isGroup(field)) {
        field.description = $field.find('.ass-tf-desc').val().trim();
        field.is_dynamic = $field.find('.ass-tf-dynamic').is(':checked');
    } else {
        field.type = $field.find('.ass-tf-type').val();
        field.hint = $field.find('.ass-tf-hint').val().trim();
        field.extends_only = $field.find('.ass-tf-extends').is(':checked');
    }

    // Sub-field edits
    if ($input.hasClass('ass-tf-sub-name') || $input.hasClass('ass-tf-sub-type') || $input.hasClass('ass-tf-sub-hint')) {
        if (!field.fields) return;
        const $subrow = $input.closest('.ass-tf-subfield-row');
        const subOldKey = String($subrow.attr('data-subkey'));
        const subField = field.fields[subOldKey];
        if (!subField) return;

        const subNewName = $subrow.find('.ass-tf-sub-name').val().trim();
        if (subNewName && subNewName !== subOldKey) {
            delete field.fields[subOldKey];
            field.fields[subNewName] = subField;
            $subrow.attr('data-subkey', subNewName);
        }
        subField.type = $subrow.find('.ass-tf-sub-type').val();
        subField.hint = $subrow.find('.ass-tf-sub-hint').val().trim();
        subField.extends_only = $subrow.find('.ass-tf-extends').is(':checked');
    }
}

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

function removeField(category, key) {
    delete currentFields[category]?.[key];
    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

function addSubFieldToGroup(category, key) {
    const field = currentFields[category]?.[key];
    if (!field) return;

    if (!isGroup(field)) {
        // Convert simple field to group — move type/hint into first sub-field
        const subName = 'sub_1';
        field.fields = {};
        field.fields[subName] = {
            type: field.type || 'string',
            hint: field.hint || '',
            extends_only: false,
        };
        field.description = field.hint || '';
        delete field.type;
        delete field.hint;
    } else {
        const subName = 'new_sub_' + Date.now();
        field.fields[subName] = { type: 'string', hint: '', extends_only: false };
    }

    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

function removeSubField(category, key, subKey) {
    const field = currentFields[category]?.[key];
    if (!field?.fields) return;

    delete field.fields[subKey];

    // If no sub-fields left, convert back to simple field
    if (Object.keys(field.fields).length === 0) {
        field.type = 'string';
        field.hint = field.description || '';
        delete field.fields;
        delete field.description;
        if (field.is_dynamic !== undefined) delete field.is_dynamic;
    }

    renderAllCategories($('#ass-tracked-fields-container'));
    scheduleSave();
}

// #############################################
// # Event Binding
// #############################################

function bindEvents($container) {
    // Input changes — update data model, debounced save
    $container.on('input', '.ass-tf-name, .ass-tf-hint, .ass-tf-desc, .ass-tf-type, ' +
        '.ass-tf-sub-name, .ass-tf-sub-type, .ass-tf-sub-hint', function () {
        handleFieldEdit($(this));
        scheduleSave();
    });

    // Checkbox changes
    $container.on('change', '.ass-tf-extends, .ass-tf-dynamic', function () {
        handleFieldEdit($(this));
        scheduleSave();
    });

    // Add field to category
    $container.on('click', '.ass-tf-add-field', function () {
        addField($(this).attr('data-category'));
    });

    // Remove field (simple or group)
    $container.on('click', '.ass-tf-remove-field', function () {
        const $field = $(this).closest('.ass-tf-field');
        removeField($field.attr('data-category'), $field.attr('data-key'));
    });

    // Add sub-field to existing group
    $container.on('click', '.ass-tf-add-subfield', function () {
        addSubFieldToGroup($(this).attr('data-category'), $(this).attr('data-key'));
    });

    // Convert simple field to group (via sitemap icon)
    $container.on('click', '.ass-tf-add-sub-to-field', function () {
        const $field = $(this).closest('.ass-tf-field');
        addSubFieldToGroup($field.attr('data-category'), $field.attr('data-key'));
    });

    // Remove sub-field
    $container.on('click', '.ass-tf-remove-subfield', function () {
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
    .ass-tf-subfield-row { margin-bottom: 4px; }
    .ass-tf-subfield-row:last-child { margin-bottom: 0; }

    /* Checkbox labels */
    .ass-tf-extends-label,
    .ass-tf-dyn-label {
        display: flex;
        align-items: center;
        gap: 3px;
        cursor: pointer;
        flex-shrink: 0;
        font-size: 12px;
        white-space: nowrap;
        color: var(--fg_dim);
    }
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
export function initTrackedFieldsUI() {
    injectCSS();

    currentFields = loadTrackedFields();

    const $container = $('#ass-tracked-fields-container');
    if (!$container.length) return;

    renderAllCategories($container);
    bindEvents($container);
}