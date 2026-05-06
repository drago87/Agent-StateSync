// btf-render.js — Agent-StateSync Tracked Field Additions: Rendering
// File Version: 1.0.0
//
// Contains all HTML generation: helpers, icon toggles, dynamic popup,
// category rendering, field rendering, and container re-render.
// Owns the `openCategories` module-level state and the `CATEGORIES` constant.
//
// Imports:  getTrackedFieldsForPayload from ./tracked-fields.js
// Exports:  renderTFAdditions, normalizeAdditions, renderTFContainer,
//           openCategories, CATEGORIES, isGroupEntry, showDynamicPopup,
//           escapeAttr, dynamicValueToStored

// #############################################
// # Module-level State
// #############################################

// Which categories are currently expanded (persists across re-renders)
export let openCategories = { character: false, scenario: false, shared: false };

// #############################################
// # HTML Helpers
// #############################################

export function escapeAttr(str) {
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
export function dynamicValueToStored(val) {
    if (!val || val === 'false') return false;
    return val;
}

// #############################################
// # Icon Toggle Rendering
// #############################################

/**
 * Render all 5 icon toggle buttons for any addition field type (simple or group).
 * Icons: Secret (purple), Required (orange), Immutable (red), Extend (blue), Dynamic (green)
 */
function renderFieldIcons({ secret, required, immutable, extendsOnly, isDynamic, allowSecret }) {
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
        <button type="button" class="ass-btf-icon-btn ass-btf-icon-extend${extendsOnly ? ' active' : ''}" data-active="${!!extendsOnly}"
                title="Extend — only extends, will not overwrite">
            <i class="fa-solid fa-maximize"></i>
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
export function showDynamicPopup($btn, panelSelector) {
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

export const CATEGORIES = [
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
            const entry = {
                name: name,
                description: field.description || '',
                fields: migrateObjectToArray(field.fields),
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

/**
 * Render all 3 category sections.
 */
export function renderCategoriesInner(additions, opts = {}) {
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
    const isDynamic = entry.is_dynamic || false;
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

    const iconsHtml = renderFieldIcons({
        secret, required, immutable, extendsOnly, isDynamic, allowSecret,
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
    const extendsOnly = entry.extends_only || false;
    const secret = entry.secret || false;
    const required = entry.required || false;
    const immutable = entry.immutable || false;
    const fields = entry.fields || [];

    const iconsHtml = renderFieldIcons({
        secret, required, immutable, extendsOnly, isDynamic, allowSecret,
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

export function isGroupEntry(entry) {
    return entry && entry.fields !== undefined;
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
