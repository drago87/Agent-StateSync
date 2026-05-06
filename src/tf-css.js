// tf-css.js — Agent-StateSync Tracked Fields: CSS Injection
// File Version: 1.0.0
//
// Contains the injectCSS function that injects the full tracked fields
// editor stylesheet into the document head. Separated from logic for
// clarity and to keep the CSS blob out of the main code files.

export function injectCSS() {
    if ($('#ass-tf-css').length) return;

    const css = `<style id="ass-tf-css">
    /* Settings button */
    #ass-tf-open-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: 1px solid rgba(128, 128, 128, 0.25);
        border-radius: 4px;
        background: rgba(128, 128, 128, 0.1);
        color: var(--fg);
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s, border-color 0.2s;
        white-space: nowrap;
    }
    #ass-tf-open-btn:hover {
        background: rgba(128, 128, 128, 0.2);
        border-color: rgba(128, 128, 128, 0.4);
    }
    #ass-tf-open-btn i {
        color: #9b59b6;
    }

    /* Overlay backdrop */
    .ass-tf-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: ass-tf-fade-in 0.15s ease-out;
    }
    @keyframes ass-tf-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }

    /* Modal panel — wide for horizontal field rows */
    .ass-tf-modal {
        background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.97));
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 10px;
        min-width: 1000px !important;
        width: 1000px !important;
        max-width: 95vw;
        max-height: 85vh;
        overflow-y: auto;
        padding: 20px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        animation: ass-tf-slide-in 0.2s ease-out;
    }
    @keyframes ass-tf-slide-in {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
    }

    /* Modal header */
    .ass-tf-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
    }
    .ass-tf-modal-header h3 {
        margin: 0;
        color: var(--fg);
        font-size: 15px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .ass-tf-modal-header h3 i {
        color: #9b59b6;
    }
    .ass-tf-modal-close {
        background: none;
        border: none;
        color: var(--fg_dim);
        font-size: 22px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
        transition: color 0.2s;
    }
    .ass-tf-modal-close:hover {
        color: var(--fg);
    }

    /* Modal body */
    .ass-tf-modal-info {
        font-size: 11px;
        color: var(--fg_dim);
        margin-top: 12px;
        line-height: 1.6;
        padding-top: 10px;
        border-top: 1px solid rgba(128, 128, 128, 0.2);
    }

    /* Category details/summary */
    .ass-tf-category {
        margin-bottom: 6px;
    }
    .ass-tf-category-summary {
        cursor: pointer;
        padding: 6px 0;
        font-size: 13px;
        user-select: none;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .ass-tf-category-summary:hover {
        color: var(--fg);
    }
    .ass-tf-category[open] > .ass-tf-category-summary {
        margin-bottom: 6px;
        border-bottom: 1px solid rgba(128, 128, 128, 0.15);
    }
    .ass-tf-count {
        font-size: 11px;
        background: rgba(155, 89, 182, 0.2);
        color: #9b59b6;
        border-radius: 8px;
        padding: 1px 6px;
        font-weight: 600;
    }
    .ass-tf-category-actions {
        margin: 8px 0 4px 0;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }

    /* Tracked field containers */
    .ass-tf-field {
        background: rgba(128, 128, 128, 0.06);
        border: 1px solid rgba(128, 128, 128, 0.15);
        border-radius: 4px;
        padding: 6px 8px;
        margin-bottom: 6px;
    }
    .ass-tf-group {
        background: rgba(92, 184, 92, 0.04);
        border-color: rgba(92, 184, 92, 0.18);
    }
    .ass-tf-nested {
        background: rgba(128, 128, 128, 0.04);
        border-color: rgba(128, 128, 128, 0.12);
    }

    /* Flex row for inputs */
    .ass-tf-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
    }
    .ass-tf-row:last-child { margin-bottom: 0; }
    .ass-tf-row .ass-tf-name { flex: 1; min-width: 120px; }
    .ass-tf-row .ass-tf-hint { flex: 3; min-width: 150px; }
    .ass-tf-row .ass-tf-desc { flex: 3; min-width: 150px; }
    .ass-tf-row .ass-tf-type { flex: 0 0 130px; }

    /* Sub-fields container */
    .ass-tf-subfields {
        margin: 6px 0 4px 16px;
        padding-left: 10px;
        border-left: 2px solid rgba(128, 128, 128, 0.2);
    }

    /* Group action buttons */
    .ass-tf-group-actions {
        margin: 4px 0 4px 20px;
        display: flex;
        gap: 6px;
    }

    /* Icon toggle buttons */
    .ass-tf-icon-group {
        display: flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
    }
    .ass-tf-icon-btn {
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
    .ass-tf-icon-btn:hover {
        opacity: 0.7;
    }
    .ass-tf-icon-btn.active {
        opacity: 1;
    }
    .ass-tf-icon-secret { color: #9b59b6; }
    .ass-tf-icon-secret.active { background: rgba(155, 89, 182, 0.15); border-color: rgba(155, 89, 182, 0.3); }
    .ass-tf-icon-required { color: #e67e22; }
    .ass-tf-icon-required.active { background: rgba(230, 126, 34, 0.15); border-color: rgba(230, 126, 34, 0.3); }
    .ass-tf-icon-immutable { color: #e74c3c; }
    .ass-tf-icon-immutable.active { background: rgba(231, 76, 60, 0.15); border-color: rgba(231, 76, 60, 0.3); }
    .ass-tf-icon-extend { color: #3498db; }
    .ass-tf-icon-extend.active { background: rgba(52, 152, 219, 0.15); border-color: rgba(52, 152, 219, 0.3); }
    .ass-tf-icon-dynamic { color: #27ae60; }
    .ass-tf-icon-dynamic.active { background: rgba(39, 174, 96, 0.15); border-color: rgba(39, 174, 96, 0.3); }

    /* Dynamic popup */
    .ass-tf-dyn-popup {
        background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.98));
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        padding: 4px 0;
        min-width: 150px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }
    .ass-tf-dyn-option {
        padding: 6px 12px;
        font-size: 12px;
        cursor: pointer;
        color: var(--fg_dim);
        transition: background 0.1s, color 0.1s;
    }
    .ass-tf-dyn-option:hover {
        background: rgba(128, 128, 128, 0.15);
        color: var(--fg);
    }
    .ass-tf-dyn-active {
        color: #27ae60;
        font-weight: 600;
    }
    .ass-tf-dyn-active::before {
        content: '\\2713 ';
    }

    /* Save / Load defaults buttons */
    .ass-tf-save-defaults,
    .ass-tf-load-defaults {
        opacity: 0.7;
    }
    .ass-tf-save-defaults:hover,
    .ass-tf-load-defaults:hover {
        opacity: 1;
    }
    </style>`;

    $('head').append(css);
}
