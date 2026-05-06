// btf-import.js — Agent-StateSync Tracked Field Additions: Import from Database Tracked Fields
// File Version: 1.0.0
//
// Contains the import modal UI and logic for pulling fields from the
// Database Tracked Fields configuration into additions.
//
// Imports:  getTrackedFieldsForPayload from ./tracked-fields.js
//           readTFAdditionsFromUI     from ./btf-dom.js
//           renderTFContainer,        from ./btf-render.js
//           CATEGORIES, escapeAttr    from ./btf-render.js
// Exports:  openImportModal

import { getTrackedFieldsForPayload } from './tracked-fields.js';
import { readTFAdditionsFromUI } from './btf-dom.js';
import { renderTFContainer, CATEGORIES, escapeAttr } from './btf-render.js';

// #############################################
// # Import from Database Tracked Fields
// #############################################

/**
 * Open the import modal showing available fields from the Database Tracked Fields.
 */
export function openImportModal(panelSelector) {
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
        <div class="ass-tf-modal" style="width:1000px; max-width:95vw;">
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
        const entry = {
            name: key,
            description: field.description || '',
            fields: subEntries,
        };
        if (field.is_dynamic) entry.is_dynamic = field.is_dynamic;
        if (field.secret) entry.secret = true;
        if (field.required) entry.required = true;
        if (field.immutable) entry.immutable = true;
        return entry;
    }

    const entry = {
        name: key,
        type: field.type || 'string',
        hint: field.hint || '',
    };
    if (field.extends_only) entry.extends_only = true;
    if (field.is_dynamic) entry.is_dynamic = field.is_dynamic;
    if (field.secret) entry.secret = true;
    if (field.required) entry.required = true;
    if (field.immutable) entry.immutable = true;
    return entry;
}
