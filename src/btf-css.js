// btf-css.js — Agent-StateSync Tracked Field Additions: CSS Injection
//
// Contains the injectBtfCSS function that inserts the full stylesheet
// for the TF additions editor into the document head.  Idempotent —
// will not inject a second <style> if one already exists.
//
// Imports:  (none)
// Exports:  injectBtfCSS

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
