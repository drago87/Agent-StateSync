// brain-tf-additions.js — Agent-StateSync Tracked Field Additions Editor
//
// Shared component used by both char-config.js and persona-config.js.
// Renders the "Database Tracked Fields Additions" panel inside
// the brain/persona popout panels.
//
// Uses CATEGORIZED ARRAY storage format (v3):
//   {
//     character: [{ name, type, hint, extends_only, secret, required, immutable }, ...],
//     scenario:  [...],
//     shared:    [...]
//   }
//   Each category's array replaces entirely on merge — no ghost fields after F5.
//
// Icon toggles (instead of checkboxes):
//   Secret    (purple) — hidden from other characters
//   Required  (orange) — must be provided
//   Immutable (red)    — will only be written during initialization
//   Extend    (blue)   — only extends, will not overwrite (simple fields only)
//   Dynamic   (green)  — entries keyed by name (group fields only)
//     Dynamic popup: Off | True | Per-Character | Situation Based
//
// Supports:
//   - 3 category dropdowns (Characters, Scenario, Shared) — like Database
//     Tracked Fields but WITHOUT Load Defaults / Save as Default buttons
//   - Arbitrary nested sub-fields (sub-fields can contain sub-groups)
//   - Add group-field button (starts as group with empty sub-fields)
//   - Import from Database Tracked Fields
//
// Event binding uses delegated handlers on the panel element.
// The .ass-btf-container element stays stable across re-renders
// (only innerHTML changes), so delegated events survive.
//
// File Version: 4.0.0

import state from './state.js';
import { getTrackedFieldsForPayload } from './tracked-fields.js';

// Which categories are currently expanded (persists across re-renders)
let openCategories = { character: false, scenario: false, shared: false };

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
 */
function normalizeDynamicValue(val) {
    if (!val || val === 'false') return 'false';
    if (val === true) return 'True';
    return String(val);
}

/**
 * Convert a data-value string back to the stored is_dynamic value.
 */
function dynamicValueToStored(val) {
    if (!val || val === 'false') return false;
    return val;
}

// #############################################
// # Icon Toggle Rendering
// #############################################

/**
 * Render icon toggle buttons for a simple addition field.
 * Icons: Secret (purple), Required (orange), Immutable (red), Extend (blue)
 */
function renderSimpleIcons({ secret, required, immutable, extendsOnly, allowSecret }) {
    const secretBtn = allowSecret
        ? `<button type="button" class="ass-btf-icon-btn ass-btf-icon-secret${secret ? ' active' : ''}" data-active="${!!secret}"
                title="Secret — hidden from other characters">
            <i class="fa-solid fa-eye-slash"></i>
          </button>`
        : '';

    return `<div class="ass-btf-icon-group">
        ${secretBtn}
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-required${required ? ' active' : ''}" data-active="${!!required}"
                title="Required — must be provided">
            <i class="fa-solid fa-asterisk"></i>
        </button>
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-immutable${immutable ? ' active' : ''}" data-active="${!!immutable}"
                title="Immutable — will only be written during initialization">
            <i class="fa-solid fa-lock"></i>
        </button>
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-extend${extendsOnly ? ' active' : ''}" data-active="${!!extendsOnly}"
                title="Extend — only extends, will not overwrite">
            <i class="fa-solid fa-maximize"></i>
        </button>
    </div>`;
}

/**
 * Render icon toggle buttons for a group addition field.
 * Icons: Secret (purple), Required (orange), Immutable (red), Dynamic (green)
 */
function renderGroupIcons({ secret, required, immutable, isDynamic, allowSecret }) {
    const dynValue = normalizeDynamicValue(isDynamic);
    const dynActive = dynValue !== 'false';

    const secretBtn = allowSecret
        ? `<button type="button" class="ass-btf-icon-btn ass-btf-icon-secret${secret ? ' active' : ''}" data-active="${!!secret}"
                title="Secret — hidden from other characters">
            <i class="fa-solid fa-eye-slash"></i>
          </button>`
        : '';

    return `<div class="ass-btf-icon-group">
        ${secretBtn}
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-required${required ? ' active' : ''}" data-active="${!!required}"
                title="Required — must be provided">
            <i class="fa-solid fa-asterisk"></i>
        </button>
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-immutable${immutable ? ' active' : ''}" data-active="${!!immutable}"
                title="Immutable — will only be written during initialization">
            <i class="fa-solid fa-lock"></i>
        </button>
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-dynamic${dynActive ? ' active' : ''}" data-value="${dynValue}"
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
 */
function showDynamicPopup($btn, panelSelector) {
    // Remove any existing popup
    $('.ass-btf-dyn-popup').remove();
    $(document).off('mousedown.ass-btf-dyn-popup');

    const currentValue = $btn.attr('data-value') || 'false';

    const options = [
        { value: 'false', label: 'Off' },
        { value: 'True', label: 'True' },
        { value: 'Per-Character', label: 'Per-Character' },
        { value: 'Situation-Based', label: 'Situation-Based' },
    ];

    const optionsHtml = options.map(opt =>
        `<div class="ass-btf-dyn-option${opt.value === currentValue ? ' ass-btf-dyn-active' : ''}"
             data-value="${opt.value}">${opt.label}</div>`
    ).join('');

    const $popup = $(`<div class="ass-btf-dyn-popup">${optionsHtml}</div>`);

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
    $popup.on('click', '.ass-btf-dyn-option', function () {
        const newValue = $(this).attr('data-value');
        $btn.attr('data-value', newValue);
        const isActive = newValue !== 'false';
        $btn.toggleClass('active', isActive);
        $popup.remove();
        $(document).off('mousedown.ass-btf-dyn-popup');
        // No sync needed here — readTFAdditionsFromUI reads data-value at save time
    });

    // Click outside to close
    setTimeout(() => {
        $(document).on('mousedown.ass-btf-dyn-popup', function (e) {
            if (!$(e.target).closest('.ass-btf-dyn-popup, .ass-btf-icon-dynamic').length) {
                $popup.remove();
                $(document).off('mousedown.ass-btf-dyn-popup');
            }
        });
    }, 10);
}

// #############################################
// # Category Rendering
// #############################################

const CATEGORIES = [
    { key: 'character', label: 'Character', allowSecret: true },
    { key: 'scenario',  label: 'Scenario',  allowSecret: false },
    { key: 'shared',    label: 'Shared',    allowSecret: false },
];

/**
 * Render the full TF additions container.
 * Returns HTML including the .ass-btf-container wrapper.
 * @param {object} additions - Categorized additions: { character: [...], scenario: [...], shared: [...] }
 * @param {object} opts - { allowSecret: boolean }
 */
export function renderTFAdditions(additions, opts = {}) {
    const allowSecret = opts.allowSecret !== false;

    // Normalize additions to categorized format
    const normalized = normalizeAdditions(additions);

    // Categories with fields start open
    for (const cat of CATEGORIES) {
        const arr = normalized[cat.key];
        openCategories[cat.key] = Array.isArray(arr) && arr.length > 0;
    }

    const categoriesHtml = renderCategoriesInner(normalized, { allowSecret });

    return `
    <div class="ass-btf-container" data-allow-secret="${allowSecret}">
        ${categoriesHtml}
    </div>`;
}

/**
 * Normalize additions data to the categorized format.
 */
export function normalizeAdditions(additions) {
    const empty = { character: [], scenario: [], shared: [] };

    if (!additions) return empty;

    if (typeof additions === 'object' && !Array.isArray(additions)) {
        if (additions.character !== undefined || additions.scenario !== undefined || additions.shared !== undefined) {
            return {
                character: Array.isArray(additions.character) ? additions.character : [],
                scenario:  Array.isArray(additions.scenario)  ? additions.scenario  : [],
                shared:    Array.isArray(additions.shared)    ? additions.shared    : [],
            };
        }
        const arr = migrateObjectToArray(additions);
        return { ...empty, character: arr };
    }

    if (Array.isArray(additions)) {
        return { ...empty, character: additions };
    }

    return empty;
}

/**
 * Migrate old object-format tracked_field_additions to array format.
 */
function migrateObjectToArray(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
    return Object.entries(obj).map(([name, field]) => {
        if (field && field.fields !== undefined) {
            return {
                name: name,
                description: field.description || '',
                is_dynamic: field.is_dynamic || false,
                secret: field.secret || false,
                required: field.required || false,
                immutable: field.immutable || false,
                fields: migrateObjectToArray(field.fields),
            };
        }
        return {
            name: name,
            type: field.type || 'string',
            hint: field.hint || '',
            extends_only: field.extends_only || false,
            secret: field.secret || false,
            required: field.required || false,
            immutable: field.immutable || false,
        };
    });
}

/**
 * Render all 3 category sections.
 */
function renderCategoriesInner(additions, opts = {}) {
    const allowSecret = opts.allowSecret !== false;
    let html = '';

    for (const cat of CATEGORIES) {
        html += renderCategory(cat, additions[cat.key] || [], allowSecret);
    }

    // Import button
    html += `
    <div class="ass-btf-import-section">
        <button class="menu_button ass-btf-import-btn" title="Import fields from Database Tracked Fields">
            <i class="fa-solid fa-file-import"></i> Import from Database Tracked Fields
        </button>
    </div>`;

    return html;
}

/**
 * Render a single category section (without Load/Save Default).
 */
function renderCategory(catConfig, fields, allowSecret) {
    const { key, label } = catConfig;
    const catAllowSecret = allowSecret && catConfig.allowSecret;
    const fieldCount = Array.isArray(fields) ? fields.length : 0;
    const isOpen = openCategories[key] || fieldCount > 0;

    let fieldsHtml = '';
    if (Array.isArray(fields)) {
        fields.forEach((entry, index) => {
            fieldsHtml += renderAdditionField(entry, index, 0, catAllowSecret);
        });
    }

    if (fieldCount === 0) {
        fieldsHtml = '<small style="color:var(--fg_dim);">No additions in this category.</small>';
    }

    const countBadge = fieldCount > 0
        ? `<span class="ass-btf-count">${fieldCount}</span>`
        : '';

    return `
    <details ${isOpen ? 'open' : ''} class="ass-btf-category" data-category="${key}">
        <summary class="ass-btf-category-summary">
            <b>${label}</b> ${countBadge}
        </summary>
        <div class="ass-btf-fields">${fieldsHtml}</div>
        <div class="ass-btf-category-actions">
            <button class="menu_button ass-btf-add-field" data-category="${key}">
                <i class="fa-solid fa-plus"></i> Add field
            </button>
            <button class="menu_button ass-btf-add-group-field" data-category="${key}">
                <i class="fa-solid fa-folder-plus"></i> Add group-field
            </button>
        </div>
    </details>`;
}

// #############################################
// # Field Rendering
// #############################################

/**
 * Render a single addition field (simple or group).
 */
function renderAdditionField(entry, index, depth, allowSecret) {
    if (isGroupEntry(entry)) {
        return renderAdditionGroup(entry, index, depth, allowSecret);
    }
    return renderAdditionSimple(entry, index, depth, allowSecret);
}

function renderAdditionSimple(entry, index, depth, allowSecret) {
    const name = entry.name || '';
    const type = entry.type || 'string';
    const hint = entry.hint || '';
    const extendsOnly = entry.extends_only || false;
    const secret = entry.secret || false;
    const required = entry.required || false;
    const immutable = entry.immutable || false;
    const isNested = depth > 0;

    const addSubBtn = !isNested
        ? `<button class="menu_button ass-btf-add-sub-to-field" title="Add sub-field (converts to group)">
               <i class="fa-solid fa-sitemap"></i>
           </button>`
        : '';

    const depthClass = isNested ? 'ass-btf-nested' : '';

    const iconsHtml = renderSimpleIcons({
        secret, required, immutable, extendsOnly, allowSecret,
    });

    return `
    <div class="ass-btf-field ${depthClass}" data-index="${index}" data-depth="${depth}">
        <div class="ass-btf-row">
            <input class="text_pole ass-btf-name" value="${escapeAttr(name)}"
                   placeholder="Field name" style="flex:1; min-width:0;">
            <input class="text_pole ass-btf-hint" value="${escapeAttr(hint)}"
                   placeholder="Description / Hint" style="flex:3; min-width:0;">
            <select class="text_pole ass-btf-type" style="flex:0 0 130px;">
                ${buildTypeOptions(type)}
            </select>
            ${iconsHtml}
            ${addSubBtn}
            <button class="menu_button ass-btf-remove-field" title="Remove field">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    </div>`;
}

function renderAdditionGroup(entry, index, depth, allowSecret) {
    const name = entry.name || '';
    const description = entry.description || '';
    const isDynamic = entry.is_dynamic || false;
    const secret = entry.secret || false;
    const required = entry.required || false;
    const immutable = entry.immutable || false;
    const fields = entry.fields || [];

    const iconsHtml = renderGroupIcons({
        secret, required, immutable, isDynamic, allowSecret,
    });

    let subfieldsHtml = '';
    fields.forEach((subEntry, subIndex) => {
        subfieldsHtml += renderAdditionField(subEntry, subIndex, depth + 1, allowSecret);
    });

    return `
    <div class="ass-btf-field ass-btf-group" data-index="${index}" data-depth="${depth}">
        <div class="ass-btf-row">
            <input class="text_pole ass-btf-name" value="${escapeAttr(name)}"
                   placeholder="Group name" style="flex:1; min-width:0;">
            <input class="text_pole ass-btf-desc" value="${escapeAttr(description)}"
                   placeholder="Description" style="flex:3; min-width:0;">
            ${iconsHtml}
            <button class="menu_button ass-btf-remove-field" title="Remove group">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        <div class="ass-btf-subfields">
            ${subfieldsHtml}
        </div>
        <div class="ass-btf-group-actions">
            <button class="menu_button ass-btf-add-subfield">
                <i class="fa-solid fa-plus"></i> Add sub-field
            </button>
            <button class="menu_button ass-btf-add-subgroup">
                <i class="fa-solid fa-folder-plus"></i> Add sub-group
            </button>
        </div>
    </div>`;
}

function isGroupEntry(entry) {
    return entry && entry.fields !== undefined;
}

// #############################################
// # Read UI → Data
// #############################################

/**
 * Read icon toggle active state from a row's icon group.
 */
function readIconActive($row, selector) {
    const $btn = $row.find('> .ass-btf-icon-group > ' + selector);
    if (!$btn.length) return false;
    return $btn.attr('data-active') === 'true';
}

/**
 * Read Dynamic icon value from a row's icon group.
 */
function readDynamicValue($row) {
    const $btn = $row.find('> .ass-btf-icon-group > .ass-btf-icon-dynamic');
    if (!$btn.length) return false;
    return dynamicValueToStored($btn.attr('data-value') || 'false');
}

/**
 * Read all tracked field additions from the DOM.
 * Returns a categorized object: { character: [...], scenario: [...], shared: [...] }
 */
export function readTFAdditionsFromUI(panelSelector = '') {
    const prefix = panelSelector ? `${panelSelector} ` : '';
    const $container = $(`${prefix}.ass-btf-container`).first();
    if (!$container.length) return { character: [], scenario: [], shared: [] };

    const result = { character: [], scenario: [], shared: [] };

    $container.find('.ass-btf-category').each(function () {
        const category = $(this).attr('data-category');
        if (!category || !result.hasOwnProperty(category)) return;

        const fields = [];
        $(this).find('> .ass-btf-fields > .ass-btf-field').each(function () {
            fields.push(readAdditionFieldFromDOM($(this)));
        });
        result[category] = fields;
    });

    return result;
}

/**
 * Read a single addition field from its DOM element.
 * Recursively reads nested sub-fields.
 */
function readAdditionFieldFromDOM($el) {
    const $row = $el.find('> .ass-btf-row');

    if ($el.hasClass('ass-btf-group')) {
        const result = {
            name: ($row.find('> .ass-btf-name').val() || '').trim(),
            description: ($row.find('> .ass-btf-desc').val() || '').trim(),
            is_dynamic: readDynamicValue($row),
            fields: [],
        };

        const secret = readIconActive($row, '.ass-btf-icon-secret');
        const required = readIconActive($row, '.ass-btf-icon-required');
        const immutable = readIconActive($row, '.ass-btf-icon-immutable');
        if (secret) result.secret = true;
        if (required) result.required = true;
        if (immutable) result.immutable = true;

        $el.children('.ass-btf-subfields').children('.ass-btf-field').each(function () {
            result.fields.push(readAdditionFieldFromDOM($(this)));
        });

        return result;
    } else {
        const result = {
            name: ($row.find('> .ass-btf-name').val() || '').trim(),
            type: $row.find('> .ass-btf-type').val() || 'string',
            hint: ($row.find('> .ass-btf-hint').val() || '').trim(),
            extends_only: readIconActive($row, '.ass-btf-icon-extend'),
        };

        const secret = readIconActive($row, '.ass-btf-icon-secret');
        const required = readIconActive($row, '.ass-btf-icon-required');
        const immutable = readIconActive($row, '.ass-btf-icon-immutable');
        if (secret) result.secret = true;
        if (required) result.required = true;
        if (immutable) result.immutable = true;

        return result;
    }
}

// #############################################
// # Container Re-render (stable container)
// #############################################

/**
 * Re-render additions inside the existing .ass-btf-container.
 * Only replaces innerHTML — the container element stays stable
 * so delegated events survive across re-renders.
 */
export function renderTFContainer(additions, panelSelector = '') {
    const prefix = panelSelector ? `${panelSelector} ` : '';
    const $container = $(`${prefix}.ass-btf-container`).first();
    if (!$container.length) return;

    const allowSecret = $container.attr('data-allow-secret') !== 'false';
    const normalized = normalizeAdditions(additions);

    // Snapshot which categories are currently open
    $container.find('.ass-btf-category').each(function () {
        const key = $(this).attr('data-category');
        if (key) openCategories[key] = this.open;
    });

    $container.html(renderCategoriesInner(normalized, { allowSecret }));
}

// #############################################
// # Path Helpers
// #############################################

/**
 * Build an index path from the DOM, walking up from a field element
 * to the category root.
 */
function buildFieldPath($field) {
    const path = [];
    let $current = $field;

    while ($current.length && $current.hasClass('ass-btf-field')) {
        const index = parseInt($current.attr('data-index') || '0', 10);
        path.unshift(index);
        $current = $current.parent().closest('.ass-btf-field');
    }

    const $category = $field.closest('.ass-btf-category');
    if ($category.length) {
        path.unshift($category.attr('data-category'));
    }

    return path;
}

/**
 * Navigate the additions object using a path.
 */
function findEntryByPath(additions, path) {
    if (path.length === 0) return null;

    const category = path[0];
    let current = additions[category];
    if (!Array.isArray(current)) return null;

    for (let i = 1; i < path.length; i++) {
        const idx = path[i];
        if (i === 1) {
            if (idx >= current.length) return null;
            current = current[idx];
        } else {
            if (!current || !Array.isArray(current.fields) || idx >= current.fields.length) return null;
            current = current.fields[idx];
        }
    }
    return current;
}

/**
 * Remove an entry from the additions at the given path.
 */
function removeFromAdditions(additions, path) {
    if (path.length < 2) return;

    const category = path[0];
    if (!additions[category]) return;

    if (path.length === 2) {
        additions[category].splice(path[1], 1);
        return;
    }

    let current = additions[category];
    for (let i = 1; i < path.length - 1; i++) {
        const idx = path[i];
        if (i === 1) {
            current = current[idx];
        } else {
            if (!current || !Array.isArray(current.fields)) return;
            current = current.fields[idx];
        }
    }

    const lastIdx = path[path.length - 1];
    if (Array.isArray(current.fields)) {
        current.fields.splice(lastIdx, 1);

        // Group → Simple back-conversion
        if (current.fields.length === 0 && !current.is_dynamic) {
            const parentArray = path.length === 3
                ? additions[category]
                : null;
            const parentIndex = path.length === 3 ? path[1] : -1;

            if (parentArray && parentIndex >= 0) {
                const simpleField = {
                    name: current.name,
                    type: 'string',
                    hint: current.description || '',
                    extends_only: false,
                    required: false,
                    immutable: false,
                };
                if (current.secret) simpleField.secret = current.secret;
                parentArray[parentIndex] = simpleField;
            }
        }
    }
}

// #############################################
// # Import from Database Tracked Fields
// #############################################

/**
 * Open the import modal showing available fields from the Database Tracked Fields.
 */
function openImportModal(panelSelector) {
    if ($('#ass-btf-import-overlay').length) return;

    const trackedFields = getTrackedFieldsForPayload();
    if (!trackedFields) {
        toastr.info('No Database Tracked Fields defined yet.', 'Agent-StateSync');
        return;
    }

    let fieldsListHtml = '';

    for (const cat of CATEGORIES) {
        const catFields = trackedFields[cat.key];
        if (!catFields || typeof catFields !== 'object' || Object.keys(catFields).length === 0) continue;

        let itemsHtml = '';
        for (const [fieldKey, fieldValue] of Object.entries(catFields)) {
            const isGroup = fieldValue && fieldValue.fields !== undefined;
            const icon = isGroup ? 'fa-folder' : 'fa-file';
            const subCount = isGroup ? ` (${Object.keys(fieldValue.fields || {}).length} fields)` : '';
            const typeLabel = !isGroup ? ` — ${fieldValue.type || 'string'}` : '';

            itemsHtml += `
            <label class="ass-btf-import-item">
                <input type="checkbox" class="ass-btf-import-check" data-category="${cat.key}" data-field-key="${escapeAttr(fieldKey)}">
                <i class="fa-solid ${icon}" style="opacity:0.6; width:14px;"></i>
                <span>${escapeAttr(fieldKey)}${subCount}${typeLabel}</span>
            </label>`;
        }

        fieldsListHtml += `
        <div class="ass-btf-import-category">
            <div class="ass-btf-import-cat-label">${cat.label}</div>
            ${itemsHtml}
        </div>`;
    }

    if (!fieldsListHtml) {
        toastr.info('No Database Tracked Fields to import.', 'Agent-StateSync');
        return;
    }

    const html = `
    <div id="ass-btf-import-overlay" class="ass-tf-overlay">
        <div class="ass-tf-modal" style="width:550px;">
            <div class="ass-tf-modal-header">
                <h3><i class="fa-solid fa-file-import"></i> Import from Database Tracked Fields</h3>
                <button id="ass-btf-import-close" class="ass-tf-modal-close" type="button">&times;</button>
            </div>
            <div class="ass-tf-modal-body">
                <p style="font-size:12px; color:var(--fg_dim); margin-bottom:10px;">
                    Select fields to import into tracked field additions.
                    Imported fields will be added to the same category in additions.
                </p>
                <div id="ass-btf-import-fields">
                    ${fieldsListHtml}
                </div>
                <div style="margin-top:12px; display:flex; gap:8px; justify-content:flex-end;">
                    <button id="ass-btf-import-cancel" class="menu_button" type="button">Cancel</button>
                    <button id="ass-btf-import-do" class="menu_button" type="button" style="background:rgba(92,184,92,0.15); border-color:rgba(92,184,92,0.3);">
                        <i class="fa-solid fa-file-import"></i> Import Selected
                    </button>
                </div>
            </div>
        </div>
    </div>`;

    $('body').append(html);

    // Bind events
    $('#ass-btf-import-close, #ass-btf-import-cancel').on('click', () => {
        $('#ass-btf-import-overlay').remove();
    });
    $('#ass-btf-import-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-btf-import-overlay')) {
            $('#ass-btf-import-overlay').remove();
        }
    });
    $(document).on('keydown.btf-import', function (e) {
        if (e.key === 'Escape') $('#ass-btf-import-overlay').remove();
    });

    $('#ass-btf-import-do').on('click', () => {
        const selected = [];
        $('#ass-btf-import-fields .ass-btf-import-check:checked').each(function () {
            selected.push({
                category: $(this).attr('data-category'),
                fieldKey: $(this).attr('data-field-key'),
            });
        });

        if (selected.length === 0) {
            toastr.info('No fields selected for import.', 'Agent-StateSync');
            return;
        }

        importSelectedFields(selected, panelSelector);

        $('#ass-btf-import-overlay').remove();
        $(document).off('keydown.btf-import');
    });
}

/**
 * Import selected fields from tracked_fields into additions.
 */
function importSelectedFields(selected, panelSelector) {
    const additions = readTFAdditionsFromUI(panelSelector);
    const trackedFields = getTrackedFieldsForPayload();

    let importCount = 0;

    for (const sel of selected) {
        const cat = sel.category;
        const fieldKey = sel.fieldKey;
        const catFields = trackedFields[cat];
        if (!catFields || !catFields[fieldKey]) continue;

        const entry = trackedFieldToEntry(fieldKey, catFields[fieldKey]);
        if (entry) {
            if (!Array.isArray(additions[cat])) additions[cat] = [];
            additions[cat].push(entry);
            importCount++;
        }
    }

    if (importCount > 0) {
        renderTFContainer(additions, panelSelector);
        toastr.success(`Imported ${importCount} field(s) into additions.`, 'Agent-StateSync');
    }
}

/**
 * Convert a single tracked field (dict format) to an array-format entry.
 */
function trackedFieldToEntry(key, field) {
    if (!field || typeof field !== 'object') return null;

    if (field.fields !== undefined) {
        const subEntries = [];
        for (const [subKey, subField] of Object.entries(field.fields || {})) {
            const subEntry = trackedFieldToEntry(subKey, subField);
            if (subEntry) subEntries.push(subEntry);
        }
        return {
            name: key,
            description: field.description || '',
            is_dynamic: field.is_dynamic || false,
            secret: field.secret || false,
            required: field.required || false,
            immutable: field.immutable || false,
            fields: subEntries,
        };
    }

    return {
        name: key,
        type: field.type || 'string',
        hint: field.hint || '',
        extends_only: field.extends_only || false,
        secret: field.secret || false,
        required: field.required || false,
        immutable: field.immutable || false,
    };
}

// #############################################
// # Event Binding
// #############################################

/**
 * Bind events for the TF additions editor.
 * Delegated on the panel element — survives innerHTML re-renders.
 */
export function bindTFAdditionEvents(panelSelector = '') {
    const panelId = panelSelector || '#ass-brain-panel';
    const $panel = $(panelId);
    if (!$panel.length) return;

    // Prevent double-binding
    $panel.off('.ass-btf');

    // --- Add field (per-category) ---
    $panel.on('click.ass-btf', '.ass-btf-add-field', function () {
        const category = $(this).attr('data-category');
        const additions = readTFAdditionsFromUI(panelSelector);
        if (!additions[category]) additions[category] = [];
        additions[category].push({ name: '', type: 'string', hint: '', extends_only: false, required: false, immutable: false });
        openCategories[category] = true;
        renderTFContainer(additions, panelSelector);
    });

    // --- Add group-field (per-category) ---
    $panel.on('click.ass-btf', '.ass-btf-add-group-field', function () {
        const category = $(this).attr('data-category');
        const additions = readTFAdditionsFromUI(panelSelector);
        if (!additions[category]) additions[category] = [];
        additions[category].push({ name: '', description: '', is_dynamic: false, fields: [], required: false, immutable: false });
        openCategories[category] = true;
        renderTFContainer(additions, panelSelector);
    });

    // --- Remove field (simple or group, any depth) ---
    $panel.on('click.ass-btf', '.ass-btf-remove-field', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        const $field = $(this).closest('.ass-btf-field');
        const path = buildFieldPath($field);

        removeFromAdditions(additions, path);
        renderTFContainer(additions, panelSelector);
    });

    // --- Add sub-field via sitemap (converts simple → group) ---
    $panel.on('click.ass-btf', '.ass-btf-add-sub-to-field', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        const $field = $(this).closest('.ass-btf-field');
        const path = buildFieldPath($field);
        const entry = findEntryByPath(additions, path);
        if (!entry) return;

        if (isGroupEntry(entry)) {
            entry.fields.push({ name: '', type: 'string', hint: '', extends_only: false, required: false, immutable: false });
        } else {
            entry.fields = [{
                name: 'sub_1',
                type: entry.type || 'string',
                hint: '',
                extends_only: entry.extends_only || false,
                required: false,
                immutable: false,
            }];
            entry.description = entry.hint || '';
            delete entry.type;
            delete entry.hint;
            delete entry.extends_only;
        }
        renderTFContainer(additions, panelSelector);
    });

    // --- Add sub-field inside a group ---
    $panel.on('click.ass-btf', '.ass-btf-add-subfield', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        const $group = $(this).closest('.ass-btf-field');
        const path = buildFieldPath($group);
        const entry = findEntryByPath(additions, path);
        if (!entry || !isGroupEntry(entry)) return;

        entry.fields.push({ name: '', type: 'string', hint: '', extends_only: false, required: false, immutable: false });
        renderTFContainer(additions, panelSelector);
    });

    // --- Add sub-group inside a group ---
    $panel.on('click.ass-btf', '.ass-btf-add-subgroup', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        const $group = $(this).closest('.ass-btf-field');
        const path = buildFieldPath($group);
        const entry = findEntryByPath(additions, path);
        if (!entry) return;

        if (!isGroupEntry(entry)) {
            entry.fields = [{
                name: 'sub_1',
                type: entry.type || 'string',
                hint: '',
                extends_only: entry.extends_only || false,
                required: false,
                immutable: false,
            }];
            entry.description = entry.hint || '';
            delete entry.type;
            delete entry.hint;
            delete entry.extends_only;
        }

        entry.fields.push({
            name: '',
            description: '',
            is_dynamic: false,
            fields: [],
            required: false,
            immutable: false,
        });
        renderTFContainer(additions, panelSelector);
    });

    // --- Icon toggle clicks (Secret, Required, Immutable, Extend) ---
    $panel.on('click.ass-btf', '.ass-btf-icon-secret, .ass-btf-icon-required, .ass-btf-icon-immutable, .ass-btf-icon-extend', function (e) {
        e.stopPropagation();
        const $btn = $(this);
        const isActive = $btn.attr('data-active') === 'true';
        $btn.attr('data-active', !isActive);
        $btn.toggleClass('active', !isActive);
        // No sync needed — readTFAdditionsFromUI reads data-active at save time
    });

    // --- Dynamic icon click — show popup ---
    $panel.on('click.ass-btf', '.ass-btf-icon-dynamic', function (e) {
        e.stopPropagation();
        showDynamicPopup($(this), panelSelector);
    });

    // --- Track category open/close state ---
    $panel.on('toggle.ass-btf', '.ass-btf-category', function () {
        const key = $(this).attr('data-category');
        if (key) openCategories[key] = this.open;
    });

    // --- Prevent button clicks inside <details> from toggling closed ---
    $panel.on('click.ass-btf', '.ass-btf-category button', function (e) {
        e.preventDefault();
    });

    // --- Import from Database Tracked Fields ---
    $panel.on('click.ass-btf', '.ass-btf-import-btn', function () {
        openImportModal(panelSelector);
    });
}

// #############################################
// # CSS
// #############################################

export function injectBtfCSS() {
    if ($('#ass-btf-css').length) return;

    const css = `<style id="ass-btf-css">
    /* Category details/summary */
    .ass-btf-category {
        margin-bottom: 6px;
    }
    .ass-btf-category-summary {
        cursor: pointer;
        padding: 6px 0;
        font-size: 13px;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .ass-btf-category-summary:hover {
        color: var(--fg);
    }
    .ass-btf-category[open] > .ass-btf-category-summary {
        margin-bottom: 6px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.15);
    }
    .ass-btf-count {
        font-size: 11px;
        background: rgba(155, 89, 182, 0.2);
        color: #9b59b6;
        border-radius: 8px;
        padding: 1px 6px;
        font-weight: 600;
    }
    .ass-btf-category-actions {
        margin: 8px 0 4px 0;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }

    /* Tracked field additions containers */
    .ass-btf-field {
        background: rgba(128, 128, 128, 0.06);
        border: 1px solid rgba(128, 128, 128, 0.15);
        border-radius: 4px;
        padding: 6px 8px;
        margin-bottom: 6px;
    }
    .ass-btf-group {
        background: rgba(92, 184, 92, 0.04);
        border-color: rgba(92, 184, 92, 0.18);
    }
    .ass-btf-nested {
        background: rgba(128, 128, 128, 0.04);
        border-color: rgba(128, 128, 128, 0.12);
    }

    /* Flex row for inputs */
    .ass-btf-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
    }
    .ass-btf-row:last-child { margin-bottom: 0; }

    /* Sub-fields container */
    .ass-btf-subfields {
        margin: 6px 0 4px 16px;
        padding-left: 10px;
        border-left: 2px solid rgba(128, 128, 128, 0.2);
    }

    /* Group action buttons */
    .ass-btf-group-actions {
        margin: 4px 0 4px 20px;
        display: flex;
        gap: 6px;
    }

    /* Icon toggle buttons */
    .ass-btf-icon-group {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
    }
    .ass-btf-icon-btn {
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
    .ass-btf-icon-btn:hover {
        opacity: 0.7;
    }
    .ass-btf-icon-btn.active {
        opacity: 1;
    }
    .ass-btf-icon-secret { color: #9b59b6; }
    .ass-btf-icon-secret.active { background: rgba(155, 89, 182, 0.15); border-color: rgba(155, 89, 182, 0.3); }
    .ass-btf-icon-required { color: #e67e22; }
    .ass-btf-icon-required.active { background: rgba(230, 126, 34, 0.15); border-color: rgba(230, 126, 34, 0.3); }
    .ass-btf-icon-immutable { color: #e74c3c; }
    .ass-btf-icon-immutable.active { background: rgba(231, 76, 60, 0.15); border-color: rgba(231, 76, 60, 0.3); }
    .ass-btf-icon-extend { color: #3498db; }
    .ass-btf-icon-extend.active { background: rgba(52, 152, 219, 0.15); border-color: rgba(52, 152, 219, 0.3); }
    .ass-btf-icon-dynamic { color: #27ae60; }
    .ass-btf-icon-dynamic.active { background: rgba(39, 174, 96, 0.15); border-color: rgba(39, 174, 96, 0.3); }

    /* Dynamic popup */
    .ass-btf-dyn-popup {
        background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.98));
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        padding: 4px 0;
        min-width: 150px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .ass-btf-dyn-option {
        padding: 6px 12px;
        font-size: 12px;
        cursor: pointer;
        color: var(--fg_dim);
        transition: background 0.1s, color 0.1s;
    }
    .ass-btf-dyn-option:hover {
        background: rgba(128, 128, 128, 0.15);
        color: var(--fg);
    }
    .ass-btf-dyn-active {
        color: #27ae60;
        font-weight: 600;
    }
    .ass-btf-dyn-active::before {
        content: '\\2713 ';
    }

    /* Import section */
    .ass-btf-import-section {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid rgba(128, 128, 128, 0.15);
    }
    .ass-btf-import-btn {
        opacity: 0.8;
    }
    .ass-btf-import-btn:hover {
        opacity: 1;
    }

    /* Import modal items */
    .ass-btf-import-category {
        margin-bottom: 10px;
    }
    .ass-btf-import-cat-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--fg_dim);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
    }
    .ass-btf-import-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 13px;
        border-radius: 3px;
        transition: background 0.15s;
    }
    .ass-btf-import-item:hover {
        background: rgba(128, 128, 128, 0.1);
    }
    .ass-btf-import-item input[type="checkbox"] {
        margin: 0;
        width: 14px;
        height: 14px;
    }
    </style>`;

    $('head').append(css);
}
