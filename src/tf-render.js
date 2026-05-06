// tf-render.js — Agent-StateSync Tracked Fields: Rendering & DOM Sync
// File Version: 1.1.0
//
// Contains: HTML helpers (escapeAttr, buildTypeOptions), dynamic value helpers
//   (normalizeDynamicValue, dynamicValueToStored), icon toggle rendering
//   (renderFieldIcons), dynamic popup (showDynamicPopup), render functions
//   (renderCategory, renderField, renderSimpleField, renderGroupField, isGroup),
//   DOM→data sync (readIconActive, readDynamicValue, syncFieldsFromDOM,
//   readFieldFromDOM), renderAllCategories, snapshotOpenCategories.
//
// Imports: currentFields and openCategories from tf-data.js, scheduleSave from tf-data.js

import {
    getCurrentFields,
    getOpenCategories,
    scheduleSave,
} from './tf-data.js';

// #############################################
// # HTML Helpers
// #############################################

export function escapeAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildTypeOptions(selected) {
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
export function normalizeDynamicValue(val) {
    if (!val || val === 'false') return 'false';
    if (val === true) return 'True';
    return String(val);
}

/**
 * Convert a data-value string back to the stored is_dynamic value.
 * "false" → false
 * anything else → the string value
 */
export function dynamicValueToStored(val) {
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
export function renderFieldIcons({ secret, required, immutable, extendsOnly, isDynamic, allowSecret }) {
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
export function showDynamicPopup($btn) {
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
export function renderCategory({ key, label, open, allowSecret }) {
    const currentFields = getCurrentFields();
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
export function renderField(category, key, field, depth, allowSecret) {
    if (isGroup(field)) {
        return renderGroupField(category, key, field, depth, allowSecret);
    }
    return renderSimpleField(category, key, field, depth, allowSecret);
}

export function renderSimpleField(category, key, field, depth, allowSecret) {
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

export function renderGroupField(category, key, field, depth, allowSecret) {
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

export function isGroup(field) {
    return field && field.fields !== undefined;
}

// #############################################
// # DOM → Data Sync
// #############################################

/**
 * Read icon toggle active state from a row's icon group.
 */
export function readIconActive($row, selector) {
    const $btn = $row.find('> .ass-tf-icon-group > ' + selector);
    if (!$btn.length) return false;
    return $btn.attr('data-active') === 'true';
}

/**
 * Read Dynamic icon value from a row's icon group.
 */
export function readDynamicValue($row) {
    const $btn = $row.find('> .ass-tf-icon-group > .ass-tf-icon-dynamic');
    if (!$btn.length) return false;
    return dynamicValueToStored($btn.attr('data-value') || 'false');
}

/**
 * Read all current DOM values and sync them into currentFields.
 * Only called for live input/checkbox changes, NOT during re-renders.
 */
export function syncFieldsFromDOM() {
    const currentFields = getCurrentFields();
    const categories = ['character', 'scenario', 'shared'];
    const $container = $('#ass-tf-modal-fields');

    if (!$container.length) return;

    for (const cat of categories) {
        const $topFields = $container.find(`.ass-tf-field[data-category="${cat}"][data-depth="0"]`);
        currentFields[cat] = {};
        $topFields.each(function () {
            // Read the key from the name input (user may have edited it),
            // fall back to data-key attribute for edge cases
            const newName = String($(this).find('> .ass-tf-row > .ass-tf-name').val() || '').trim();
            const key = newName || String($(this).attr('data-key') || '');
            const field = readFieldFromDOM($(this));
            if (key) currentFields[cat][key] = field;
        });
    }
}

/**
 * Read a single field (simple or group) from its DOM element.
 * Recursively reads nested sub-fields.
 */
export function readFieldFromDOM($el) {
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
            // Read the sub-key from the name input (user may have edited it),
            // fall back to data-key attribute for edge cases
            const subName = String($(this).find('> .ass-tf-row > .ass-tf-name').val() || '').trim();
            const subKey = subName || String($(this).attr('data-key') || '');
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

export function renderAllCategories() {
    const $container = $('#ass-tf-modal-fields');
    if (!$container.length) return;

    const openCategories = getOpenCategories();
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
export function snapshotOpenCategories() {
    const openCategories = getOpenCategories();
    const $container = $('#ass-tf-modal-fields');
    if (!$container.length) return;

    $container.find('.ass-tf-category').each(function () {
        const key = $(this).attr('data-category');
        if (key) openCategories[key] = this.open;
    });
}
