// tf-data.js — Agent-StateSync Tracked Fields: Shared State & Data Layer
//
// Contains: Module-level state (currentFields, openCategories, saveTimeout,
//   defaultFieldsCache), settings keys, default fields loading from JSON,
//   data load/save, normalizeIsDynamic, and getTrackedFieldsForPayload.
//
// Other sub-modules import state and helpers from this file.

import state from './state.js';

// Settings keys
export const TRACKED_FIELDS_KEY = 'agent_statesync_tracked_fields';
export const SAVED_DEFAULTS_KEY = 'agent_statesync_saved_defaults';

// Module-level: current fields (defaults merged with user edits)
let currentFields = null;
let saveTimeout = null;

// Cached default fields loaded from JSON files
let defaultFieldsCache = null;

// Which categories are currently expanded (persists across re-renders)
let openCategories = { character: false, scenario: false, shared: false };

// #############################################
// # Current Fields Accessor
// #############################################

/**
 * Get the current fields object (mutable reference).
 * Other sub-modules need read/write access to this shared state.
 */
export function getCurrentFields() {
    return currentFields;
}

/**
 * Set the current fields object.
 */
export function setCurrentFields(fields) {
    currentFields = fields;
}

// #############################################
// # Open Categories Accessor
// #############################################

/**
 * Get the openCategories object (mutable reference).
 * Shared between render and modal sub-modules.
 */
export function getOpenCategories() {
    return openCategories;
}

/**
 * Set the entire openCategories object.
 */
export function setOpenCategories(cats) {
    openCategories = cats;
}

// #############################################
// # Default Fields Loading
// #############################################

/**
 * Resolve the extension's base URL (where config.json and default JSON files live).
 * Uses import.meta.url (standard ES module API) which is always correct
 * regardless of how SillyTavern loads extensions.
 */
export function getExtensionBaseUrl() {
    try {
        const moduleUrl = new URL(import.meta.url);
        const path = moduleUrl.pathname;
        const dir = path.substring(0, path.lastIndexOf('/') + 1);
        return dir;
    } catch (e) {
        console.warn('[Agent-StateSync] import.meta.url failed, falling back to script scan:', e.message);
    }

    const scripts = document.querySelectorAll('script[src]');
    for (const s of scripts) {
        const src = s.getAttribute('src') || '';
        const match = src.match(/^(.*\/Agent-StateSync\/)/i);
        if (match) return match[1];
    }
    return '/scripts/extensions/third-party/Agent-StateSync/';
}

/**
 * Load default tracked fields from the external JSON files.
 * Returns a promise that resolves to the defaults object.
 * Caches after first successful load.
 * If the cache contains only empty categories (fetch failures),
 * it is invalidated so the next call will retry.
 */
export async function loadDefaultFields() {
    if (defaultFieldsCache) {
        const hasContent = ['character', 'scenario', 'shared'].some(
            cat => defaultFieldsCache[cat] && Object.keys(defaultFieldsCache[cat]).length > 0
        );
        if (hasContent) return defaultFieldsCache;
        console.log('[Agent-StateSync] Default fields cache was empty, retrying fetch...');
        defaultFieldsCache = null;
    }

    const base = getExtensionBaseUrl();
    console.log(`[Agent-StateSync] Loading default fields from: ${base}`);

    const files = {
        character: 'default-tracked-character.json',
        scenario: 'default-tracked-scenario.json',
        shared: 'default-tracked-shared.json',
    };

    const result = { character: {}, scenario: {}, shared: {} };

    const promises = Object.entries(files).map(async ([key, filename]) => {
        try {
            const url = `${base}${filename}`;
            console.log(`[Agent-StateSync] Fetching: ${url}`);
            const resp = await fetch(url);
            if (resp.ok) {
                result[key] = await resp.json();
                const count = Object.keys(result[key]).length;
                console.log(`[Agent-StateSync] Loaded ${filename}: ${count} fields`);
            } else {
                console.warn(`[Agent-StateSync] Failed to load ${filename}: HTTP ${resp.status} from ${url}`);
            }
        } catch (e) {
            console.warn(`[Agent-StateSync] Failed to fetch ${filename}:`, e.message);
        }
    });

    await Promise.all(promises);

    defaultFieldsCache = result;
    return result;
}

/**
 * Load defaults for a specific category from the JSON files.
 * Returns a deep-cloned copy.
 */
export async function loadDefaultCategory(category) {
    const defaults = await loadDefaultFields();
    return JSON.parse(JSON.stringify(defaults[category] || {}));
}

// #############################################
// # Data Load / Save
// #############################################

/**
 * Load tracked fields: user customizations from ST settings,
 * falling back to defaults from external JSON files.
 * If saved data exists but all categories are empty, loads defaults instead.
 */
export async function loadTrackedFields() {
    const saved = state.context.extensionSettings?.[TRACKED_FIELDS_KEY];
    if (saved && typeof saved === 'object') {
        const categories = ['character', 'scenario', 'shared'];
        const hasContent = categories.some(cat => {
            const catData = saved[cat];
            return catData && typeof catData === 'object' && Object.keys(catData).length > 0;
        });
        if (hasContent) return saved;
    }
    return await loadDefaultFields();
}

/**
 * Persist current fields to ST's extensionSettings.
 */
export function saveTrackedFields() {
    state.context.extensionSettings[TRACKED_FIELDS_KEY] = currentFields;
    state.context.saveSettingsDebounced();
}

/**
 * Debounced save — avoids hammering ST's save on every keystroke.
 */
export function scheduleSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveTrackedFields, 500);
}

/**
 * Recursively normalize is_dynamic values in a tracked fields payload dict.
 * Converts: false/undefined → "False", true → "True", strings kept as-is.
 * Ensures is_dynamic is always a string in the payload output.
 */
export function normalizeIsDynamic(fields) {
    if (!fields || typeof fields !== 'object') return fields;
    const result = {};
    for (const [key, val] of Object.entries(fields)) {
        if (!val || typeof val !== 'object') { result[key] = val; continue; }

        const entry = { ...val };
        if (entry.fields !== undefined) {
            // Group field — include is_dynamic only when non-default (not false/undefined/"False")
            const dynNorm = !entry.is_dynamic || entry.is_dynamic === false || entry.is_dynamic === 'False'
                ? 'False'
                : entry.is_dynamic === true
                    ? 'True'
                    : String(entry.is_dynamic);
            if (dynNorm !== 'False') {
                entry.is_dynamic = dynNorm;
            } else {
                delete entry.is_dynamic;
            }
            entry.fields = normalizeIsDynamic(entry.fields);
        } else {
            // Simple field — include is_dynamic as string only when non-default
            if (entry.is_dynamic !== undefined && entry.is_dynamic !== false) {
                entry.is_dynamic = entry.is_dynamic === true ? 'True' : String(entry.is_dynamic);
            } else {
                delete entry.is_dynamic;
            }
        }
        result[key] = entry;
    }
    return result;
}

/**
 * Get the current tracked fields for the init payload.
 * Called by session.js when building the POST body.
 * is_dynamic values are normalized to strings.
 */
export function getTrackedFieldsForPayload() {
    if (!currentFields) return null;
    const result = {};
    for (const cat of ['character', 'scenario', 'shared']) {
        if (!currentFields[cat] || Object.keys(currentFields[cat]).length === 0) continue;
        result[cat] = normalizeIsDynamic(currentFields[cat]);
    }
    return Object.keys(result).length > 0 ? result : null;
}
