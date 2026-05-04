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
//   - Secret checkbox (marks fields as private for other characters)
//   - Sub-groups (add nested group within a group)
//   - Group→Simple back-conversion (when last sub-field removed)
//
// Event binding uses delegated handlers on the panel element.
// The .ass-btf-container element stays stable across re-renders
// (only innerHTML changes), so delegated events survive.
//
// File Version: 2.1.0

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
    const secret = entry.secret || false;
    const isNested = depth > 0;

    const secretHtml = allowSecret
        ? `<label class="ass-btf-secret-label" title="Mark as secret — hidden from other characters">
               <input type="checkbox" class="ass-btf-secret" ${secret ? 'checked' : ''}>
               <i class="fa-solid fa-eye-slash" style="font-size:11px;"></i>
           </label>`
        : '';

    // No per-field convert button — top-level "Add field" and "Add group field"
    // buttons handle the two creation paths instead.

    const depthClass = isNested ? 'ass-btf-nested' : '';

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
            <label class="ass-btf-extends-label" title="Only extends this and will not overwrite">
                <input type="checkbox" class="ass-btf-extends" ${extendsOnly ? 'checked' : ''}>
            </label>
            ${secretHtml}
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
    const fields = entry.fields || [];

    const secretHtml = allowSecret
        ? `<label class="ass-btf-secret-label" title="Mark as secret — hidden from other characters">
               <input type="checkbox" class="ass-btf-secret" ${secret ? 'checked' : ''}>
               <i class="fa-solid fa-eye-slash" style="font-size:11px;"></i>
           </label>`
        : '';

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
            <label class="ass-btf-dyn-label" title="Dynamic — entries keyed by name">
                <input type="checkbox" class="ass-btf-dynamic" ${isDynamic ? 'checked' : ''}>
                <small>Dyn</small>
            </label>
            ${secretHtml}
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
    if ($el.hasClass('ass-btf-group')) {
        const result = {
            name: ($el.find('> .ass-btf-row > .ass-btf-name').val() || '').trim(),
            description: ($el.find('> .ass-btf-row > .ass-btf-desc').val() || '').trim(),
            is_dynamic: $el.find('> .ass-btf-row > .ass-btf-dynamic').is(':checked'),
            fields: [],
        };

        // Read secret
        const $secret = $el.find('> .ass-btf-row > .ass-btf-secret-label > .ass-btf-secret');
        if ($secret.length) {
            result.secret = $secret.is(':checked');
        }

        // Read direct child fields
        $el.children('.ass-btf-subfields').children('.ass-btf-field').each(function () {
            result.fields.push(readAdditionFieldFromDOM($(this)));
        });

        return result;
    } else {
        const result = {
            name: ($el.find('> .ass-btf-row > .ass-btf-name').val() || '').trim(),
            type: $el.find('> .ass-btf-row > .ass-btf-type').val() || 'string',
            hint: ($el.find('> .ass-btf-row > .ass-btf-hint').val() || '').trim(),
            extends_only: $el.find('> .ass-btf-row > .ass-btf-extends').is(':checked'),
        };

        // Read secret
        const $secret = $el.find('> .ass-btf-row > .ass-btf-secret-label > .ass-btf-secret');
        if ($secret.length) {
            result.secret = $secret.is(':checked');
        }

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
            extends_only: false,
        };
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

        entry.fields.push({ name: '', type: 'string', hint: '', extends_only: false });
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
