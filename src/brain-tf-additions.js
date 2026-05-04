// brain-tf-additions.js — Agent-StateSync Tracked Field Additions Editor
//
// Shared component used by both char-config.js and persona-config.js.
// Renders the "Database Tracked Fields Additions" panel inside
// the brain/persona popout panels.
//
// Uses ARRAY storage format (v2):
//   [{ name: "FieldName", type, hint, extends_only, secret }, ...]
//   Arrays replace entirely on merge — no ghost fields after F5.
//
// Supports:
//   - Arbitrary nested sub-fields (sub-fields can contain sub-groups)
//   - Icon-only toggle buttons: Secret, Required, Immutable, Extend, Dynamic
//   - Sub-groups (add nested group within a group)
//   - Group→Simple back-conversion (when last sub-field removed)
//
// Event binding uses delegated handlers on the panel element.
// The .ass-btf-container element stays stable across re-renders
// (only innerHTML changes), so delegated events survive.
//
// File Version: 2.2.0

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
 * Render the full TF additions container.
 * Returns HTML including the .ass-btf-container wrapper.
 * @param {Array} additions - Array of field entries
 * @param {object} opts - { allowSecret: boolean }
 */
export function renderTFAdditions(additions, opts = {}) {
    const allowSecret = opts.allowSecret !== false; // default true
    const fieldsHtml = renderFieldsInner(additions, opts);

    return `
    <div class="ass-btf-container" data-allow-secret="${allowSecret}">
        ${fieldsHtml}
    </div>`;
}

/**
 * Render just the field HTML (no container wrapper).
 * Used internally for re-renders that keep the container stable.
 */
function renderFieldsInner(additions, opts = {}) {
    const allowSecret = opts.allowSecret !== false;

    if (!Array.isArray(additions) || additions.length === 0) {
        return '<small style="color:var(--fg_dim);">No additions defined.</small>';
    }

    let html = '';
    additions.forEach((entry, index) => {
        html += renderAdditionField(entry, index, 0, allowSecret);
    });
    return html;
}

/**
 * Render a single addition field (simple or group).
 * Supports arbitrary nesting via recursion.
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

    const depthClass = isNested ? 'ass-btf-nested' : '';
    const togglesHtml = buildBtfIconToggles({ secret, extendsOnly, isDynamic, required, immutable, allowSecret });

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
            ${togglesHtml}
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

    const togglesHtml = buildBtfIconToggles({ secret, extendsOnly, isDynamic, required, immutable, allowSecret });

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
            ${togglesHtml}
            <button class="menu_button ass-btf-remove-field" title="Remove group">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        <div class="ass-btf-subfields">
            ${subfieldsHtml}
        </div>
        <div style="margin:4px 0 4px 20px; display:flex; gap:6px;">
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

/**
 * Build icon-only toggle buttons for an additions field row.
 * Five toggles: Secret, Required, Immutable, Extend, Dynamic.
 * All are available on both simple and group fields at any depth.
 * Secret is only shown when allowSecret is true.
 */
function buildBtfIconToggles({ secret, extendsOnly, isDynamic, required, immutable, allowSecret }) {
    let html = '';

    // Secret — hidden from other characters in group chat
    if (allowSecret) {
        html += `<button class="ass-btf-icon-toggle ass-btf-secret-toggle ${secret ? 'active' : ''}" 
                title="Secret — only sent to the character it belongs to" type="button">
            <i class="fa-solid fa-eye-slash"></i>
        </button>`;
    }

    // Required — field must be filled in
    html += `<button class="ass-btf-icon-toggle ass-btf-required-toggle ${required ? 'active' : ''}" 
            title="Required — this field must be filled in" type="button">
        <i class="fa-solid fa-asterisk"></i>
    </button>`;

    // Immutable — field cannot be changed once set
    html += `<button class="ass-btf-icon-toggle ass-btf-immutable-toggle ${immutable ? 'active' : ''}" 
            title="Immutable — this field cannot be changed once set" type="button">
        <i class="fa-solid fa-lock"></i>
    </button>`;

    // Extend — only adds to this field, never overwrites
    html += `<button class="ass-btf-icon-toggle ass-btf-extend-toggle ${extendsOnly ? 'active' : ''}" 
            title="Extend — only adds to this field, never overwrites" type="button">
        <i class="fa-solid fa-code-merge"></i>
    </button>`;

    // Dynamic — creates per-character entries (e.g. relationships)
    html += `<button class="ass-btf-icon-toggle ass-btf-dynamic-toggle ${isDynamic ? 'active' : ''}" 
            title="Dynamic — creates per-character entries (e.g. relationships)" type="button">
        <i class="fa-solid fa-diagram-project"></i>
    </button>`;

    return html;
}

// #############################################
// # Read UI → Data
// #############################################

/**
 * Read all tracked field additions from the DOM.
 * Returns an array in v2 format.
 * @param {string} panelSelector - CSS selector to scope the search (e.g. '#ass-brain-panel')
 */
export function readTFAdditionsFromUI(panelSelector = '') {
    const prefix = panelSelector ? `${panelSelector} ` : '';
    const $container = $(`${prefix}.ass-btf-container`).first();
    if (!$container.length) return [];

    const result = [];
    $container.children('.ass-btf-field').each(function () {
        result.push(readAdditionFieldFromDOM($(this)));
    });
    return result;
}

/**
 * Read a single addition field from its DOM element.
 * Recursively reads nested sub-fields.
 */
function readAdditionFieldFromDOM($el) {
    const $row = $el.find('> .ass-btf-row');

    // Read icon toggle states
    const secret = $row.find('> .ass-btf-secret-toggle').hasClass('active');
    const required = $row.find('> .ass-btf-required-toggle').hasClass('active');
    const immutable = $row.find('> .ass-btf-immutable-toggle').hasClass('active');
    const extendsOnly = $row.find('> .ass-btf-extend-toggle').hasClass('active');
    const isDynamic = $row.find('> .ass-btf-dynamic-toggle').hasClass('active');

    if ($el.hasClass('ass-btf-group')) {
        const result = {
            name: ($row.find('> .ass-btf-name').val() || '').trim(),
            description: ($row.find('> .ass-btf-desc').val() || '').trim(),
            fields: [],
        };
        if (isDynamic) result.is_dynamic = true;
        if (extendsOnly) result.extends_only = true;
        if (secret) result.secret = true;
        if (required) result.required = true;
        if (immutable) result.immutable = true;

        // Read direct child fields
        $el.children('.ass-btf-subfields').children('.ass-btf-field').each(function () {
            result.fields.push(readAdditionFieldFromDOM($(this)));
        });

        return result;
    } else {
        const result = {
            name: ($row.find('> .ass-btf-name').val() || '').trim(),
            type: $row.find('> .ass-btf-type').val() || 'string',
            hint: ($row.find('> .ass-btf-hint').val() || '').trim(),
        };
        if (extendsOnly) result.extends_only = true;
        if (isDynamic) result.is_dynamic = true;
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
    $container.html(renderFieldsInner(additions, { allowSecret }));
}

// #############################################
// # Path Helpers
// #############################################

/**
 * Build an index path from the DOM, walking up from a field element
 * to the container root.
 * E.g. for a sub-field at additions[1].fields[2]:
 *   path = [1, 2]
 */
function buildFieldPath($field) {
    const path = [];
    let $current = $field;

    while ($current.length && $current.hasClass('ass-btf-field')) {
        const index = parseInt($current.attr('data-index') || '0', 10);
        path.unshift(index);
        $current = $current.parent().closest('.ass-btf-field');
    }

    return path;
}

/**
 * Navigate the additions array using an index path.
 * Returns the entry at the given path, or null if not found.
 */
function findEntryByPath(additions, path) {
    if (path.length === 0) return null;

    let current = additions;
    for (let i = 0; i < path.length; i++) {
        const idx = path[i];
        if (i === 0) {
            if (!Array.isArray(current) || idx >= current.length) return null;
            current = current[idx];
        } else {
            if (!current || !Array.isArray(current.fields) || idx >= current.fields.length) return null;
            current = current.fields[idx];
        }
    }
    return current;
}

/**
 * Remove an entry from the additions array at the given path.
 * After removal, if a group is left with no fields and is not
 * dynamic, it is converted back to a simple field.
 *
 * Recursive: navigates into nested .fields arrays.
 */
function removeFromAdditions(additions, path) {
    if (path.length === 0) return;

    if (path.length === 1) {
        // Top-level entry
        additions.splice(path[0], 1);
        return;
    }

    // Navigate one level: the entry at path[0] contains the rest
    const head = path[0];
    const entry = additions[head];
    if (!entry || !Array.isArray(entry.fields)) return;

    // Recurse into the entry's fields
    removeFromAdditions(entry.fields, path.slice(1));

    // Group → Simple back-conversion
    // If the group now has zero fields and isn't dynamic, convert it back.
    if (entry.fields.length === 0 && !entry.is_dynamic) {
        const simpleField = {
            name: entry.name,
            type: 'string',
            hint: entry.description || '',
        };
        if (entry.extends_only) simpleField.extends_only = true;
        if (entry.secret) simpleField.secret = entry.secret;
        additions[head] = simpleField;
    }
}

// #############################################
// # Event Binding
// #############################################

/**
 * Bind events for the TF additions editor.
 * Delegated on the panel element — survives innerHTML re-renders
 * because the panel and .ass-btf-container stay in the DOM.
 * Must be called after the panel HTML is injected into the DOM.
 *
 * @param {string} panelSelector - CSS selector for the panel (e.g. '#ass-brain-panel')
 */
export function bindTFAdditionEvents(panelSelector = '') {
    const panelId = panelSelector || '#ass-brain-panel';
    const $panel = $(panelId);
    if (!$panel.length) return;

    // Prevent double-binding
    $panel.off('.ass-btf');

    // --- Icon toggle clicks ---
    $panel.on('click.ass-btf', '.ass-btf-icon-toggle', function (e) {
        e.preventDefault();
        e.stopPropagation();
        $(this).toggleClass('active');
    });

    // --- Add field (top-level) ---
    $panel.on('click.ass-btf', '#ass-brain-add-tf', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        additions.push({ name: '', type: 'string', hint: '', extends_only: false });
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

    // --- Add top-level group field ---
    $panel.on('click.ass-btf', '#ass-brain-add-tf-group', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        additions.push({
            name: '',
            description: '',
            is_dynamic: false,
            fields: [],
        });
        renderTFContainer(additions, panelSelector);
    });

    // --- Add sub-field inside a group ---
    $panel.on('click.ass-btf', '.ass-btf-add-subfield', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        const $group = $(this).closest('.ass-btf-field');
        const path = buildFieldPath($group);
        const entry = findEntryByPath(additions, path);
        if (!entry || !isGroupEntry(entry)) return;

        entry.fields.push({ name: '', type: 'string', hint: '' });
        renderTFContainer(additions, panelSelector);
    });

    // --- Add sub-group inside a group ---
    $panel.on('click.ass-btf', '.ass-btf-add-subgroup', function () {
        const additions = readTFAdditionsFromUI(panelSelector);
        const $group = $(this).closest('.ass-btf-field');
        const path = buildFieldPath($group);
        const entry = findEntryByPath(additions, path);
        if (!entry) return;

        // If not already a group, convert simple → group with empty fields
        if (!isGroupEntry(entry)) {
            entry.fields = [];
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
        });
        renderTFContainer(additions, panelSelector);
    });
}
