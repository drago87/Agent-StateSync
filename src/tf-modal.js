// tf-modal.js — Agent-StateSync Tracked Fields: Modal Panel & Edit Handlers
//
// Contains: Modal panel (openTFModal, renderModalCategories, closeTFModal,
//   updateTFButton), edit handlers (addField, addGroupField, saveAsDefault,
//   loadDefaults, removeField, addSubFieldToGroup, addSubGroup, removeSubField,
//   findField), modal event binding (bindModalEvents), and the main entry
//   point initTrackedFieldsUI.
//
// Imports from tf-data.js and tf-render.js.

import state from './state.js';
import {
    getCurrentFields,
    setCurrentFields,
    getOpenCategories,
    setOpenCategories,
    loadTrackedFields,
    saveTrackedFields,
    scheduleSave,
    loadDefaultCategory,
    getExtensionBaseUrl,
    SAVED_DEFAULTS_KEY,
} from './tf-data.js';
import {
    renderCategory,
    renderAllCategories,
    snapshotOpenCategories,
    syncFieldsFromDOM,
    isGroup,
    showDynamicPopup,
} from './tf-render.js';
import { injectCSS } from './tf-css.js';

// #############################################
// # Edit Handlers
// #############################################

function addField(category) {
    syncFieldsFromDOM();

    const currentFields = getCurrentFields();
    const name = 'new_field_' + Date.now();
    currentFields[category] = currentFields[category] || {};
    currentFields[category][name] = {
        type: 'string',
        hint: '',
    };
    const openCategories = getOpenCategories();
    openCategories[category] = true;
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

function addGroupField(category) {
    syncFieldsFromDOM();

    const currentFields = getCurrentFields();
    const name = 'new_group_' + Date.now();
    currentFields[category] = currentFields[category] || {};
    currentFields[category][name] = {
        description: '',
        fields: {},
    };
    const openCategories = getOpenCategories();
    openCategories[category] = true;
    snapshotOpenCategories();
    renderAllCategories();
    scheduleSave();
}

async function saveAsDefault(category) {
    syncFieldsFromDOM();

    const currentFields = getCurrentFields();
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

        const currentFields = getCurrentFields();
        const openCategories = getOpenCategories();

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
    const currentFields = getCurrentFields();
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
    const currentFields = getCurrentFields();
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
    const currentFields = getCurrentFields();
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
    const currentFields = getCurrentFields();
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
export function openTFModal() {
    if ($('#ass-tf-overlay').length) return;

    // Reset open state — categories start collapsed
    const openCategories = getOpenCategories();
    for (const cat of ['character', 'scenario', 'shared']) {
        openCategories[cat] = false;
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
    const openCategories = getOpenCategories();
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

    const currentFields = getCurrentFields();
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
    const openCategories = getOpenCategories();

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
    // Name changes also update data-key attributes so action buttons stay in sync
    $modal.on('input.ass-tf', '.ass-tf-name', function () {
        const newName = ($(this).val() || '').trim();
        const $field = $(this).closest('.ass-tf-field');
        $field.attr('data-key', newName);
        // Update action buttons inside this field that reference data-key
        $field.find('> .ass-tf-group-actions .ass-tf-add-subfield, > .ass-tf-group-actions .ass-tf-add-subgroup').attr('data-key', newName);
        syncFieldsFromDOM();
        scheduleSave();
    });
    $modal.on('input.ass-tf', '.ass-tf-hint, .ass-tf-desc, .ass-tf-type', function () {
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
    setCurrentFields(await loadTrackedFields());

    // Bind the "open modal" button
    $('#ass-tf-open-btn').on('click', openTFModal);

    // Update button badge
    updateTFButton();
}
