// btf-dom.js — Agent-StateSync Tracked Field Additions: DOM→Data Reading & Path Helpers
// File Version: 1.0.0
//
// Contains functions that read current UI state from the DOM back into data
// (for saving / re-rendering), plus path helpers that navigate and mutate
// the additions data structure by index path.
//
// Imports:  dynamicValueToStored from ./btf-render.js
// Exports:  readTFAdditionsFromUI, readIconActive, readDynamicValue,
//           readAdditionFieldFromDOM, buildFieldPath, findEntryByPath,
//           removeFromAdditions

import { dynamicValueToStored } from './btf-render.js';

// #############################################
// # Read UI → Data
// #############################################

/**
 * Read icon toggle active state from a row's icon group.
 */
export function readIconActive($row, selector) {
    const $btn = $row.find('> .ass-btf-icon-group > ' + selector);
    if (!$btn.length) return false;
    return $btn.attr('data-active') === 'true';
}

/**
 * Read Dynamic icon value from a row's icon group.
 */
export function readDynamicValue($row) {
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
export function readAdditionFieldFromDOM($el) {
    const $row = $el.find('> .ass-btf-row');

    if ($el.hasClass('ass-btf-group')) {
        const result = {
            name: ($row.find('> .ass-btf-name').val() || '').trim(),
            description: ($row.find('> .ass-btf-desc').val() || '').trim(),
            fields: [],
        };

        const isDynamic = readDynamicValue($row);
        const extendsOnly = readIconActive($row, '.ass-btf-icon-extend');
        const secret = readIconActive($row, '.ass-btf-icon-secret');
        const required = readIconActive($row, '.ass-btf-icon-required');
        const immutable = readIconActive($row, '.ass-btf-icon-immutable');
        if (isDynamic) result.is_dynamic = isDynamic;
        if (extendsOnly) result.extends_only = true;
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
        };

        const extendsOnly = readIconActive($row, '.ass-btf-icon-extend');
        const isDynamic = readDynamicValue($row);
        const secret = readIconActive($row, '.ass-btf-icon-secret');
        const required = readIconActive($row, '.ass-btf-icon-required');
        const immutable = readIconActive($row, '.ass-btf-icon-immutable');
        if (extendsOnly) result.extends_only = true;
        if (isDynamic) result.is_dynamic = isDynamic;
        if (secret) result.secret = true;
        if (required) result.required = true;
        if (immutable) result.immutable = true;

        return result;
    }
}

// #############################################
// # Path Helpers
// #############################################

/**
 * Build an index path from the DOM, walking up from a field element
 * to the category root.
 */
export function buildFieldPath($field) {
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
export function findEntryByPath(additions, path) {
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
export function removeFromAdditions(additions, path) {
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
                };
                if (current.secret) simpleField.secret = true;
                if (current.required) simpleField.required = true;
                if (current.immutable) simpleField.immutable = true;
                parentArray[parentIndex] = simpleField;
            }
        }
    }
}
