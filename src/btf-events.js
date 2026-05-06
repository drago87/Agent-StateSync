// btf-events.js — Agent-StateSync Tracked Field Additions: Event Binding
// File Version: 1.0.0
//
// Contains the single bindTFAdditionEvents function that delegates all
// user interactions on the TF additions panel.  Uses delegated handlers
// on the panel element so they survive innerHTML re-renders.
//
// Imports:  readTFAdditionsFromUI from ./btf-dom.js
//           buildFieldPath, findEntryByPath, removeFromAdditions from ./btf-dom.js
//           renderTFContainer, openCategories, isGroupEntry, showDynamicPopup from ./btf-render.js
//           openImportModal from ./btf-import.js
// Exports:  bindTFAdditionEvents

import { readTFAdditionsFromUI, buildFieldPath, findEntryByPath, removeFromAdditions } from './btf-dom.js';
import { renderTFContainer, openCategories, isGroupEntry, showDynamicPopup } from './btf-render.js';
import { openImportModal } from './btf-import.js';

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
        additions[category].push({ name: '', type: 'string', hint: '' });
        openCategories[category] = true;
        renderTFContainer(additions, panelSelector);
    });

    // --- Add group-field (per-category) ---
    $panel.on('click.ass-btf', '.ass-btf-add-group-field', function () {
        const category = $(this).attr('data-category');
        const additions = readTFAdditionsFromUI(panelSelector);
        if (!additions[category]) additions[category] = [];
        additions[category].push({ name: '', description: '', fields: [] });
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
            entry.fields.push({ name: '', type: 'string', hint: '' });
        } else {
            const subField = {
                name: 'sub_1',
                type: entry.type || 'string',
                hint: '',
            };
            if (entry.extends_only) subField.extends_only = true;
            entry.fields = [subField];
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

        if (!isGroupEntry(entry)) {
            const subField = {
                name: 'sub_1',
                type: entry.type || 'string',
                hint: '',
            };
            if (entry.extends_only) subField.extends_only = true;
            entry.fields = [subField];
            entry.description = entry.hint || '';
            delete entry.type;
            delete entry.hint;
            delete entry.extends_only;
        }

        entry.fields.push({
            name: '',
            description: '',
            fields: [],
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
