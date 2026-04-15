// char-config.js — Agent-StateSync Character Config Panel
//
// Brain button in the Character Sheet Bar (star/skull row).
// Opens a panel where the user defines how the Agent should parse
// the character card: as a single character, multiple characters,
// or a scenario.  Stored per-character in the card's data.extensions
// so it persists on export/import.

import state from './state.js';
import { EXTENSION_NAME, CHAR_CONFIG_EXT_KEY } from './settings.js';

// #############################################
// # Default Config
// #############################################

const DEFAULT_CHAR_CONFIG = {
    mode: 'characters',   // 'characters' | 'scenario'
    names: [''],          // array of character name strings
};

// #############################################
// # Character Data Access
// #############################################

/**
 * Get the character data object for the currently active character.
 * Works in single-character mode.  Returns null in group mode
 * (or when no character is selected).
 */
function getActiveCharData() {
    if (state.context.characterId == null || !state.context.characters) return null;
    return state.context.characters[state.context.characterId] || null;
}

/**
 * Read the stored character config from the active character's card data.
 * Returns a validated copy of the stored config, or the defaults.
 */
function readCharConfig() {
    const char = getActiveCharData();
    if (!char?.data?.extensions) return { ...DEFAULT_CHAR_CONFIG, names: [''] };
    const stored = char.data.extensions[CHAR_CONFIG_EXT_KEY];
    if (!stored) return { ...DEFAULT_CHAR_CONFIG, names: [''] };
    return {
        mode: (stored.mode === 'scenario') ? 'scenario' : 'characters',
        names: Array.isArray(stored.names) && stored.names.length > 0
            ? [...stored.names]
            : [''],
    };
}

/**
 * Write the character config to the active character's card data
 * and trigger a debounced save.
 */
function writeCharConfig(config) {
    const char = getActiveCharData();
    if (!char) {
        console.warn(`[${EXTENSION_NAME}] No active character — cannot save char config`);
        return;
    }
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions[CHAR_CONFIG_EXT_KEY] = {
        mode: config.mode || 'characters',
        names: config.names || [''],
    };

    // Trigger ST's character save
    try {
        if (typeof state.context.saveCharacterDebounced === 'function') {
            state.context.saveCharacterDebounced();
        } else if (typeof state.context.saveChat === 'function') {
            state.context.saveChat();
        }
        console.log(`[${EXTENSION_NAME}] Character config saved.`);
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Character save failed:`, e.message);
    }
}

// #############################################
// # Public API — for pipeline.js / session.js
// #############################################

/**
 * Derive the init type for the Agent based on stored config.
 * Returns: 'character' | 'multi-character' | 'scenario'
 */
export function getCharInitType() {
    const config = readCharConfig();
    if (config.mode === 'scenario') return 'scenario';
    if (config.names.length >= 2) return 'multi-character';
    return 'character';
}

/**
 * Get the list of character names the user defined.
 * Empty array for 'scenario' mode, filtered for blank strings otherwise.
 */
export function getCharInitNames() {
    const config = readCharConfig();
    if (config.mode === 'scenario') return [];
    return config.names.map(n => (n || '').trim()).filter(Boolean);
}

// #############################################
// # CSS Injection
// #############################################

function injectBrainCSS() {
    if ($('#ass-brain-css').length) return;

    const css = `
    <style id="ass-brain-css">
        /* Brain button — matches ST's .character_menu_button style */
        #ass-brain-btn {
            cursor: pointer;
            padding: 0 8px;
            color: var(--fg_dim);
            transition: color 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #ass-brain-btn:hover {
            color: #9b59b6;
        }

        /* Overlay backdrop */
        .ass-brain-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: ass-brain-fade-in 0.15s ease-out;
        }
        @keyframes ass-brain-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        /* Panel */
        .ass-brain-panel {
            background: var(--SmartThemeBlurTintColor, rgba(25, 25, 35, 0.97));
            border: 1px solid rgba(128, 128, 128, 0.3);
            border-radius: 10px;
            width: 420px;
            max-width: 90vw;
            max-height: 80vh;
            overflow-y: auto;
            padding: 20px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            animation: ass-brain-slide-in 0.2s ease-out;
        }
        @keyframes ass-brain-slide-in {
            from { transform: translateY(20px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        /* Header */
        .ass-brain-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 18px;
        }
        .ass-brain-header h3 {
            margin: 0;
            color: var(--fg);
            font-size: 15px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ass-brain-header h3 i {
            color: #9b59b6;
        }
        .ass-brain-close {
            background: none;
            border: none;
            color: var(--fg_dim);
            font-size: 22px;
            cursor: pointer;
            padding: 0 4px;
            line-height: 1;
            transition: color 0.2s;
        }
        .ass-brain-close:hover {
            color: var(--fg);
        }

        /* Field groups */
        .ass-brain-field {
            margin-bottom: 16px;
        }
        .ass-brain-label {
            display: block;
            font-size: 12px;
            font-weight: 600;
            color: var(--fg_dim);
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        /* Name rows */
        .ass-brain-name-row {
            display: flex;
            gap: 6px;
            align-items: center;
            margin-bottom: 6px;
        }
        .ass-brain-name-row .text_pole {
            flex: 1;
        }
        .ass-brain-remove-name {
            flex-shrink: 0;
            padding: 4px 8px;
            background: rgba(217, 83, 79, 0.1);
            border: 1px solid rgba(217, 83, 79, 0.3);
            border-radius: 4px;
            color: #d9534f;
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s;
            font-size: 12px;
        }
        .ass-brain-remove-name:hover {
            background: rgba(217, 83, 79, 0.25);
            border-color: rgba(217, 83, 79, 0.5);
        }

        /* Add button */
        #ass-brain-add-name {
            margin-top: 4px;
            font-size: 12px;
        }

        /* Info text */
        .ass-brain-info {
            font-size: 11px;
            color: var(--fg_dim);
            margin-top: 12px;
            line-height: 1.5;
        }
    </style>`;

    $('head').append(css);
}

// #############################################
// # Brain Button Injection
// #############################################

function injectBrainButton() {
    if ($('#ass-brain-btn').length) return;

    // Find the Character Sheet Bar by looking for the skull button (rightmost icon).
    // ST typically uses #entity_del for the skull/delete character button.
    const $skull = $('#entity_del');
    if ($skull.length) {
        const $btn = $('<div id="ass-brain-btn" title="Agent Character Config"><i class="fa-solid fa-brain"></i></div>');
        $skull.after($btn);
        $btn.on('click', toggleCharConfigPanel);
        console.log(`[${EXTENSION_NAME}] Brain button injected (after #entity_del)`);
        return;
    }

    // Fallback: try the star button
    const $star = $('#fav_button');
    if ($star.length) {
        const $btn = $('<div id="ass-brain-btn" title="Agent Character Config"><i class="fa-solid fa-brain"></i></div>');
        $star.after($btn);
        $btn.on('click', toggleCharConfigPanel);
        console.log(`[${EXTENSION_NAME}] Brain button injected (after #fav_button)`);
        return;
    }

    // ST not ready yet — retry
    setTimeout(injectBrainButton, 1000);
}

// #############################################
// # Panel Toggle
// #############################################

function toggleCharConfigPanel() {
    if ($('#ass-brain-overlay').length) {
        closeCharConfigPanel();
    } else {
        openCharConfigPanel();
    }
}

function openCharConfigPanel() {
    if ($('#ass-brain-overlay').length) return;

    const config = readCharConfig();

    const html = `
    <div id="ass-brain-overlay" class="ass-brain-overlay">
        <div class="ass-brain-panel">
            <div class="ass-brain-header">
                <h3><i class="fa-solid fa-brain"></i> Agent Character Config</h3>
                <button id="ass-brain-close" class="ass-brain-close" type="button">&times;</button>
            </div>

            <div class="ass-brain-field">
                <label class="ass-brain-label">Parse Type</label>
                <select id="ass-brain-mode" class="text_pole wide">
                    <option value="characters" ${config.mode === 'characters' ? 'selected' : ''}>Character(s)</option>
                    <option value="scenario" ${config.mode === 'scenario' ? 'selected' : ''}>Scenario</option>
                </select>
            </div>

            <div id="ass-brain-names-section" style="${config.mode === 'scenario' ? 'display:none;' : ''}">
                <label class="ass-brain-label">Defined Characters</label>
                <div id="ass-brain-names-list"></div>
                <button id="ass-brain-add-name" class="menu_button" type="button">
                    <i class="fa-solid fa-plus"></i> Add Character
                </button>
            </div>

            <div class="ass-brain-info">
                Tell the Agent how to interpret this character card.<br>
                <b>Character(s)</b> — the card defines one or more characters. Add a name for each.<br>
                <b>Scenario</b> — the card defines a scenario or setting rather than a character.
            </div>
        </div>
    </div>`;

    $('body').append(html);

    // Render initial name inputs
    renderNameInputs(config.names);

    // --- Bind events ---

    // Close button
    $('#ass-brain-close').on('click', closeCharConfigPanel);

    // Click outside panel to close
    $('#ass-brain-overlay').on('mousedown', function (e) {
        if ($(e.target).is('#ass-brain-overlay')) {
            closeCharConfigPanel();
        }
    });

    // Escape key to close
    $(document).on('keydown.brain-panel', function (e) {
        if (e.key === 'Escape') closeCharConfigPanel();
    });

    // Mode dropdown change
    $('#ass-brain-mode').on('change', function () {
        const mode = $(this).val();
        $('#ass-brain-names-section').toggle(mode === 'characters');
        triggerAutoSave();
    });

    // Add character button
    $('#ass-brain-add-name').on('click', function () {
        const config = readCurrentConfig();
        config.names.push('');
        renderNameInputs(config.names);
        // Focus the new input
        const $inputs = $('#ass-brain-names-list .ass-brain-name-input');
        $inputs.last().focus();
        triggerAutoSave();
    });
}

function closeCharConfigPanel() {
    $('#ass-brain-overlay').remove();
    $(document).off('keydown.brain-panel');
}

// #############################################
// # Name Input Rendering
// #############################################

/**
 * Read the current state of the panel inputs.
 */
function readCurrentConfig() {
    const mode = ($('#ass-brain-mode').val() === 'scenario') ? 'scenario' : 'characters';
    const names = [];
    $('#ass-brain-names-list .ass-brain-name-input').each(function () {
        names.push($(this).val() || '');
    });
    // Ensure at least one name entry when in characters mode
    if (mode === 'characters' && names.length === 0) {
        names.push('');
    }
    return { mode, names };
}

/**
 * Render the name input rows inside the panel.
 */
function renderNameInputs(names) {
    const $list = $('#ass-brain-names-list');
    if (!$list.length) return;
    $list.empty();

    names.forEach((name, index) => {
        const isRemovable = names.length > 1;
        const safeValue = name.replace(/"/g, '&quot;').replace(/</g, '&lt;');

        const $row = $(`
            <div class="ass-brain-name-row">
                <input type="text"
                       class="text_pole wide ass-brain-name-input"
                       placeholder="Character name..."
                       value="${safeValue}">
                ${isRemovable ? `
                    <button class="ass-brain-remove-name" type="button" title="Remove this character">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                ` : ''}
            </div>
        `);

        $list.append($row);

        // Auto-save on input
        $row.find('.ass-brain-name-input').on('input', triggerAutoSave);

        // Remove button
        $row.find('.ass-brain-remove-name').on('click', function () {
            const config = readCurrentConfig();
            config.names.splice(index, 1);
            renderNameInputs(config.names);
            triggerAutoSave();
        });
    });
}

// #############################################
// # Auto-Save (debounced)
// #############################################

let autoSaveTimer = null;

function triggerAutoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
        const config = readCurrentConfig();
        writeCharConfig(config);
    }, 500);
}

// #############################################
// # Initialization
// #############################################

/**
 * Called from ui.js init(). Injects the brain button into the
 * Character Sheet Bar.  Retries until ST has rendered the bar.
 */
export function initCharConfig() {
    injectBrainCSS();
    injectBrainButton();
    console.log(`[${EXTENSION_NAME}] Character config module loaded.`);
}
