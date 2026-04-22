// brain-tf-additions.js — Tracked Fields Additions UI for the Brain Panel
//
// Handles rendering, reading, and event binding for the
// "Database Tracked Fields Additions" section inside the
// Agent Character Config panel.
//
// Storage format: ARRAY of entries (v2)
//   Simple: [{ name: "FieldName", type: "string", hint: "", extends_only: false }, ...]
//   Group:  [{ name: "Group", description: "", is_dynamic: false, fields: [...] }, ...]
//
// Arrays replace entirely on merge — no ghost fields after F5.
//
// File Version: 1.0.0

// #############################################
// # Helpers
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

function isTFGroup(entry) {
    return entry && entry.fields !== undefined;
}

// #############################################
// # Render
// #############################################

export function renderTFAdditions(additions) {
    if (!Array.isArray(additions) || additions.length === 0) {
        return '<small style="color:var(--fg_dim);">No additions defined.</small>';
    }

    let html = '';
    for (let i = 0; i < additions.length; i++) {
        html += isTFGroup(additions[i])
            ? renderTFAdditionGroup(additions[i], i)
            : renderTFAdditionSimple(additions[i], i);
    }
    return html;
}

function renderTFAdditionSimple(field, index) {
    const name = field.name || '';
    const type = field.type || 'string';
    const hint = field.hint || '';
    const extendsOnly = field.extends_only || false;

    return `
    <div class="ass-btf-field" data-tf-index="${index}">
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

function renderTFAdditionGroup(field, index) {
    const name = field.name || '';
    const description = field.description || '';
    const isDynamic = field.is_dynamic || false;
    const fields = Array.isArray(field.fields) ? field.fields : [];

    let subfieldsHtml = '';
    for (let si = 0; si < fields.length; si++) {
        const sub = fields[si];
        const type = sub.type || 'string';
        const hint = sub.hint || '';
        const extendsOnly = sub.extends_only || false;

        subfieldsHtml += `
        <div class="ass-btf-row ass-btf-subfield-row" data-tf-subindex="${si}">
            <input class="text_pole ass-btf-sub-name" value="${escapeAttr(sub.name || '')}"
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
    <div class="ass-btf-field ass-btf-group" data-tf-index="${index}">
        <div class="ass-btf-row">
            <input class="text_pole ass-btf-name" value="${escapeAttr(name)}"
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
            <button class="menu_button ass-btf-add-subfield">
                <i class="fa-solid fa-plus"></i> Add sub-field
            </button>
        </div>
    </div>`;
}

// #############################################
// # Read from DOM
// #############################################

export function readTFAdditionsFromUI() {
    const additions = [];
    $('#ass-brain-tf-additions .ass-btf-field').each(function () {
        const $field = $(this);
        const name = ($field.find('> .ass-btf-row > .ass-btf-name').val() || '').trim();
        if (!name) return;

        if ($field.hasClass('ass-btf-group')) {
            const group = {
                name: name,
                description: ($field.find('.ass-btf-desc').val() || '').trim(),
                is_dynamic: $field.find('.ass-btf-dynamic').is(':checked'),
                fields: [],
            };
            $field.find('.ass-btf-subfield-row').each(function () {
                const subName = ($(this).find('.ass-btf-sub-name').val() || '').trim();
                if (!subName) return;
                group.fields.push({
                    name: subName,
                    type: $(this).find('.ass-btf-sub-type').val() || 'string',
                    hint: ($(this).find('.ass-btf-sub-hint').val() || '').trim(),
                    extends_only: $(this).find('.ass-btf-extends').is(':checked'),
                });
            });
            additions.push(group);
        } else {
            additions.push({
                name: name,
                type: $field.find('.ass-btf-type').val() || 'string',
                hint: ($field.find('.ass-btf-hint').val() || '').trim(),
                extends_only: $field.find('.ass-btf-extends').is(':checked'),
            });
        }
    });
    return additions;
}

// #############################################
// # Render Container
// #############################################

export function renderTFContainer(additions) {
    $('#ass-brain-tf-additions').html(renderTFAdditions(additions));
}

// #############################################
// # Handlers
// #############################################

function handleTFAddField() {
    const additions = readTFAdditionsFromUI();
    additions.push({
        name: 'new_field_' + Date.now(),
        type: 'string',
        hint: '',
        extends_only: false,
    });
    renderTFContainer(additions);
}

function handleTFRemoveField(button) {
    const additions = readTFAdditionsFromUI();
    const index = parseInt($(button).closest('.ass-btf-field').attr('data-tf-index'));
    if (!isNaN(index) && index >= 0 && index < additions.length) {
        additions.splice(index, 1);
    }
    renderTFContainer(additions);
}

function handleTFConvertToGroup(button) {
    const additions = readTFAdditionsFromUI();
    const index = parseInt($(button).closest('.ass-btf-field').attr('data-tf-index'));
    const field = additions[index];
    if (!field || isTFGroup(field)) return;

    additions[index] = {
        name: field.name,
        description: field.hint || '',
        is_dynamic: false,
        fields: [{
            name: 'sub_1',
            type: field.type || 'string',
            hint: '',
            extends_only: false,
        }],
    };
    renderTFContainer(additions);
}

function handleTFAddSubField(button) {
    const additions = readTFAdditionsFromUI();
    const index = parseInt($(button).closest('.ass-btf-field').attr('data-tf-index'));
    const group = additions[index];
    if (!group || !isTFGroup(group)) return;

    if (!group.fields) group.fields = [];
    group.fields.push({
        name: 'new_sub_' + Date.now(),
        type: 'string',
        hint: '',
        extends_only: false,
    });

    renderTFContainer(additions);
}

function handleTFRemoveSubField(button) {
    const additions = readTFAdditionsFromUI();
    const $group = $(button).closest('.ass-btf-field');
    const groupIndex = parseInt($group.attr('data-tf-index'));
    const subIndex = parseInt($(button).closest('.ass-btf-subfield-row').attr('data-tf-subindex'));
    const group = additions[groupIndex];
    if (!group?.fields) return;

    group.fields.splice(subIndex, 1);

    // If no sub-fields left, convert back to simple
    if (group.fields.length === 0) {
        additions[groupIndex] = {
            name: group.name,
            type: 'string',
            hint: group.description || '',
            extends_only: false,
        };
    }

    renderTFContainer(additions);
}

// #############################################
// # Event Binding
// #############################################

/**
 * Bind tracked field addition events ONCE.
 * Delegated events on the container survive re-renders.
 * NEVER call this function again — it would accumulate handlers.
 */
export function bindTFAdditionEvents() {
    const $container = $('#ass-brain-tf-additions');

    // Add field (direct — button is outside the container)
    $('#ass-brain-add-tf').on('click', handleTFAddField);

    // Remove field (delegated)
    $container.on('click', '.ass-btf-remove-field', function () {
        handleTFRemoveField(this);
    });

    // Convert simple to group (delegated)
    $container.on('click', '.ass-btf-add-sub-to-field', function () {
        handleTFConvertToGroup(this);
    });

    // Add sub-field to group (delegated)
    $container.on('click', '.ass-btf-add-subfield', function () {
        handleTFAddSubField(this);
    });

    // Remove sub-field (delegated)
    $container.on('click', '.ass-btf-remove-subfield', function () {
        handleTFRemoveSubField(this);
    });
}