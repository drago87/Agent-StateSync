// prompt-settings.js — Agent-StateSync Prompt Settings Editor
//
// Global prompt settings that control how the Agent generates,
// extracts, and translates content.
// File Version: 1.0.0

import state from './state.js';
import {
    loadPromptSettings, savePromptSettings,
} from './settings.js';

// #############################################
// # Settings Definitions
// #############################################

const PROMPT_SETTINGS_DEFS = [
    {
        key: 'perspective',
        label: 'Perspective',
        hint: 'Controls narrative POV. Per-character override available.',
        type: 'select',
        options: [
            { value: 'first_person', label: 'First Person' },
            { value: 'second_person', label: 'Second Person' },
            { value: 'third_person_limited', label: 'Third Person Limited' },
            { value: 'third_person_omniscient', label: 'Third Person Omniscient' },
        ],
        perCharacter: true,
    },
    {
        key: 'tense',
        label: 'Tense',
        hint: 'Narrative tense. Per-character override available.',
        type: 'select',
        options: [
            { value: 'past', label: 'Past' },
            { value: 'present', label: 'Present' },
        ],
        perCharacter: true,
    },
    {
        key: 'tone',
        label: 'Tone',
        hint: 'Narrative voice style. Per-character override available.',
        type: 'select',
        options: [
            { value: 'casual', label: 'Casual' },
            { value: 'literary', label: 'Literary' },
            { value: 'dramatic', label: 'Dramatic' },
            { value: 'clinical', label: 'Clinical' },
        ],
        perCharacter: true,
    },
    {
        key: 'content_rating',
        label: 'Content Rating',
        hint: 'Controls explicitness of narrative content.',
        type: 'select',
        options: [
            { value: 'sfw', label: 'SFW' },
            { value: 'nsfw', label: 'NSFW' },
            { value: 'unrestricted', label: 'Unrestricted' },
        ],
        perCharacter: true,
    },
    {
        key: 'extraction_strictness',
        label: 'Extraction Strictness',
        hint: 'How aggressively the Agent extracts state from narrative.',
        type: 'select',
        options: [
            { value: 'conservative', label: 'Conservative' },
            { value: 'moderate', label: 'Moderate' },
            { value: 'aggressive', label: 'Aggressive' },
        ],
        perCharacter: true,
    },
    {
        key: 'detail_level',
        label: 'Detail Level',
        hint: 'How much state to extract per turn.',
        type: 'select',
        options: [
            { value: 'minimal', label: 'Minimal' },
            { value: 'standard', label: 'Standard' },
            { value: 'thorough', label: 'Thorough' },
        ],
        perCharacter: true,
    },
    {
        key: 'language',
        label: 'Language',
        hint: 'Language of the RP. Per-character override available.',
        type: 'text',
        perCharacter: true,
    },
    {
        key: 'relationship_depth',
        label: 'Relationship Depth',
        hint: 'How much detail to track for relationships.',
        type: 'select',
        options: [
            { value: 'shallow', label: 'Shallow' },
            { value: 'standard', label: 'Standard' },
            { value: 'deep', label: 'Deep' },
        ],
        perCharacter: true,
    },
    {
        key: 'character_voice_in_state',
        label: 'Character Voice in State',
        hint: 'Translation preserves character speech patterns and quotes.',
        type: 'checkbox',
        perCharacter: false,
    },
    {
        key: 'state_granularity',
        label: 'State Granularity',
        hint: 'Summary: flowing paragraph. Per-field: each field listed separately.',
        type: 'select',
        options: [
            { value: 'summary', label: 'Summary' },
            { value: 'per_field', label: 'Per-field' },
        ],
        perCharacter: false,
    },
    {
        key: 'translation_length',
        label: 'DB Translation Length',
        hint: 'Brief: 1 paragraph. Standard: 2-3. Extended: 3-5.',
        type: 'select',
        options: [
            { value: 'brief', label: 'Brief' },
            { value: 'standard', label: 'Standard' },
            { value: 'extended', label: 'Extended' },
        ],
        perCharacter: false,
    },
];

// #############################################
// # CSS
// #############################################

function injectCSS() {
    if ($('#ass-ps-css').length) return;

    const css = `<style id="ass-ps-css">
    .ass-ps-setting {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }
    .ass-ps-setting label {
        flex: 0 0 180px;
        font-size: 12px;
        font-weight: 600;
        color: var(--fg_dim);
        white-space: nowrap;
    }
    .ass-ps-setting select,
    .ass-ps-setting input[type="text"] {
        flex: 1;
        min-width: 0;
    }
    .ass-ps-setting .ass-ps-per-char {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--fg_dim);
        opacity: 0.7;
        width: 16px;
        text-align: center;
    }
    .ass-ps-setting .ass-ps-per-char[title] {
        cursor: help;
    }
    </style>`;

    $('head').append(css);
}

// #############################################
// # Render
// #############################################

function renderPromptSettings() {
    const settings = loadPromptSettings();

    const rows = PROMPT_SETTINGS_DEFS.map(def => {
        let inputHtml = '';

        if (def.type === 'select') {
            const optionsHtml = def.options.map(opt =>
                `<option value="${opt.value}" ${settings[def.key] === opt.value ? 'selected' : ''}>${opt.label}</option>`
            ).join('');
            inputHtml = `<select class="text_pole ass-ps-input" data-key="${def.key}">${optionsHtml}</select>`;
        } else if (def.type === 'text') {
            inputHtml = `<input type="text" class="text_pole ass-ps-input" data-key="${def.key}" value="${settings[def.key] || ''}">`;
        } else if (def.type === 'checkbox') {
            inputHtml = `<input type="checkbox" class="ass-ps-input" data-key="${def.key}" ${settings[def.key] ? 'checked' : ''}>`;
        }

        const perCharIcon = def.perCharacter
            ? `<span class="ass-ps-per-char" title="Per-character override available"><i class="fa-solid fa-user"></i></span>`
            : '';

        return `
        <div class="ass-ps-setting" title="${def.hint}">
            <label>${def.label}</label>
            ${inputHtml}
            ${perCharIcon}
        </div>`;
    }).join('');

    return rows;
}

// #############################################
// # Event Binding
// #############################################

function bindEvents($container) {
    $container.on('change', '.ass-ps-input', function () {
        saveFromUI();
    });
    $container.on('input', '.ass-ps-input', function () {
        saveFromUI();
    });
}

function saveFromUI() {
    const settings = loadPromptSettings();
    $('#ass-prompt-settings-container .ass-ps-input').each(function () {
        const key = $(this).data('key');
        const def = PROMPT_SETTINGS_DEFS.find(d => d.key === key);
        if (!def) return;

        if (def.type === 'checkbox') {
            settings[key] = $(this).is(':checked');
        } else {
            settings[key] = $(this).val();
        }
    });
    savePromptSettings(settings);
}

// #############################################
// # Public API
// #############################################

export function initPromptSettingsUI() {
    injectCSS();

    const $container = $('#ass-prompt-settings-container');
    if (!$container.length) return;

    const html = `
    <details class="ass-tf-category">
        <summary><b>Prompt Configs</b></summary>
        ${renderPromptSettings()}
    </details>`;

    $container.html(html);
    bindEvents($container);
}