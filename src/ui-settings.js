// ui-settings.js — Agent-StateSync Settings Panel Rendering
//
// Settings panel HTML/CSS, event bindings, Instruct LLM backends
// dynamic list, and all change handlers.
//
// Extracted from ui.js to keep the settings UI separate from
// the initialization orchestrator and button injection logic.
// File Version: 1.0.0

import state from './state.js';
import {
    EXTENSION_NAME,
    TEMPLATE_OPTIONS, THINKING_OPTIONS, REFINEMENT_OPTIONS, HISTORY_OPTIONS,
    DEBUG_COMMANDS,
    getSettings, saveSettings, isBypassMode, syncConfigToAgent, updateStatus, setDebugOutput,
} from './settings.js';
import {
    getAgentOrigin, refreshAgentUrlDisplay, handleReconnect,
    startHealthChecks, stopHealthChecks, setConnectionStatus,
} from './agent-url.js';
import { executeDebugCommand } from './debug.js';
import { initTrackedFieldsUI } from './tracked-fields.js';
import { initPromptSettingsUI } from './prompt-settings.js';

// #############################################
// # Utility
// #############################################

export function buildOptions(items, selectedValue) {
    return items.map(opt =>
        `<option value="${opt.value}" ${String(opt.value) === String(selectedValue) ? 'selected' : ''}>${opt.label}</option>`
    ).join('');
}

// #############################################
// # CSS Injection
// #############################################

export function injectCustomCSS() {
    if ($('#ass-custom-css').length) return;

    const css = `
    <style id="ass-custom-css">
        /* Connection status dot */
        .ass-dot {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 6px;
            vertical-align: middle;
            flex-shrink: 0;
        }
        .ass-dot-green {
            background-color: #5cb85c;
            box-shadow: 0 0 6px 2px rgba(92, 184, 92, 0.5);
            animation: ass-pulse-green 2s ease-in-out infinite;
        }
        .ass-dot-red {
            background-color: #d9534f;
            box-shadow: 0 0 6px 2px rgba(217, 83, 79, 0.4);
        }
        @keyframes ass-pulse-green {
            0%, 100% { box-shadow: 0 0 6px 2px rgba(92, 184, 92, 0.5); }
            50% { box-shadow: 0 0 10px 4px rgba(92, 184, 92, 0.7); }
        }

        /* Enable row */
        .ass-enable-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        .ass-enable-row .checkbox_label {
            margin: 0;
            flex-shrink: 0;
        }
        .ass-enable-right {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        /* Reconnect button */
        .ass-reconnect-btn {
            flex-shrink: 0;
            padding: 3px 10px;
            border: 1px solid rgba(128, 128, 128, 0.3);
            border-radius: 4px;
            background: rgba(128, 128, 128, 0.15);
            color: var(--fg);
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s, border-color 0.2s;
        }
        .ass-reconnect-btn:hover {
            background: rgba(128, 128, 128, 0.3);
            border-color: rgba(128, 128, 128, 0.5);
        }
        .ass-reconnect-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* Read-only Agent URL display */
        .ass-url-display {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 10px;
            background: rgba(128, 128, 128, 0.1);
            border: 1px solid rgba(128, 128, 128, 0.25);
            border-radius: 4px;
            font-size: 12px;
            color: var(--fg_dim);
            min-height: 30px;
        }
        .ass-url-display .ass-url-value {
            flex: 1;
            font-family: monospace;
            color: var(--fg);
            word-break: break-all;
        }
        .ass-url-display .ass-url-status {
            font-size: 11px;
            white-space: nowrap;
        }

        /* Small LLM status dot next to input fields */
        .ass-llm-row {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .ass-llm-row .text_pole {
            flex: 1;
        }
        .ass-llm-dot {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            flex-shrink: 0;
            transition: background-color 0.3s, box-shadow 0.3s;
        }
        .ass-llm-dot-green {
            background-color: #5cb85c;
            box-shadow: 0 0 4px 1px rgba(92, 184, 92, 0.5);
        }
        .ass-llm-dot-red {
            background-color: #d9534f;
            box-shadow: 0 0 4px 1px rgba(217, 83, 79, 0.4);
        }
        .ass-llm-dot-off {
            background-color: #555;
            box-shadow: none;
        }

                /* Init Session button (rocket icon in chat controls) */
                #ass-init-session-btn {
                        cursor: pointer;
                }
    </style>`;

    $('head').append(css);
}

// #############################################
// # Setting Change Handler
// #############################################

/**
 * Called when any setting changes — re-syncs config to Agent.
 * Defined at module level so renderInstructBackends() and other
 * standalone functions can call it.
 */
function onSettingChange() {
    const updated = getSettings();
    syncConfigToAgent(updated, getAgentOrigin());
}

// #############################################
// # Settings Panel Rendering
// #############################################

export function renderSettingsUI() {
    injectCustomCSS();

    const debugVisible = state.debug ? '' : 'display:none;';

    const settingsHtml = `
    <div class="agent-statesync-extension">
        <hr class="sysHR">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Agent-StateSync</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- Enable Toggle + Status + Reconnect (all in one row) -->
                <div class="ass-enable-row">
                    <label class="checkbox_label" for="ass-toggle">
                        <input type="checkbox" id="ass-toggle">
                        <span>Enable State Sync</span>
                    </label>
                    <div class="ass-enable-right">
                        <span id="ass-connection-dot" class="ass-dot ass-dot-red" title="Disconnected"></span>
                        <button id="ass-reconnect-btn" class="ass-reconnect-btn" type="button" title="Reconnect to Agent">
                            <i class="fa-solid fa-rotate-right"></i>
                        </button>
                    </div>
                </div>

                <!-- Agent URL (read-only, auto-detected) -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>Agent URL</b> <i>(auto-detected from ST Custom Endpoint)</i></small>
                    </label>
                    <div class="ass-url-display" id="ass-agent-url-display">
                        <i class="fa-solid fa-link" style="opacity:0.5;"></i>
                        <span class="ass-url-value" id="ass-url-text">Detecting...</span>
                    </div>
                    <small>Configure the URL in SillyTavern's API Connection &rarr; Custom Endpoint.</small>
                </div>

                <hr class="sysHR">

                <!-- RP LLM -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>RP LLM IP:Port</b> (Creative Writer)</small>
                    </label>
                    <div class="ass-llm-row">
                        <input type="text" id="ass-rp-url" class="text_pole wide" placeholder="localhost:5001">
                        <span id="ass-rp-dot" class="ass-llm-dot ass-llm-dot-off" title="RP LLM: not checked"></span>
                    </div>
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoint. Runs the creative model for narrative generation.</small>
                </div>

                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>RP LLM Template</small>
                    </label>
                    <select id="ass-rp-template" class="text_pole wide">
                        ${buildOptions(TEMPLATE_OPTIONS, getSettings().rpTemplate)}
                    </select>
                    <small>Message format template. Set to Raw if your endpoint handles its own formatting (e.g., Koboldcpp native mode).</small>
                </div>

                <!-- Instruct LLM -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>Instruct LLM Backends</b> (Data Logger)</small>
                    </label>
                    <div id="ass-instruct-backends-container"></div>
                    <div style="margin-top:6px;">
                        <button id="ass-add-instruct-backend" class="menu_button" type="button" style="font-size:12px;">
                            <i class="fa-solid fa-plus"></i> Add Backend
                        </button>
                    </div>
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoints. The Agent will load-balance across available backends.</small>
                </div>

                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>Instruct LLM Template</small>
                    </label>
                    <select id="ass-instruct-template" class="text_pole wide">
                        ${buildOptions(TEMPLATE_OPTIONS, getSettings().instructTemplate)}
                    </select>
                    <small>Message format template. Set to Raw if your endpoint handles its own formatting (e.g., Ollama native mode).</small>
                </div>

                <hr class="sysHR">

                <!-- Thinking & Refinement -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>Thinking Steps (RP LLM internal planning)</small>
                    </label>
                    <select id="ass-thinking" class="text_pole wide">
                        ${buildOptions(THINKING_OPTIONS, getSettings().thinkingSteps)}
                    </select>
                    <small>Higher = better coherence, much slower. Each step is a full LLM call.</small>
                </div>

                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>Refinement Steps (post-generation review)</small>
                    </label>
                    <select id="ass-refinement" class="text_pole wide">
                        ${buildOptions(REFINEMENT_OPTIONS, getSettings().refinementSteps)}
                    </select>
                    <small>Replaces the user-visible response with an improved version after generation.</small>
                </div>

                <hr class="sysHR">

                <!-- History -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>History Messages Sent to RP LLM</small>
                    </label>
                    <select id="ass-history" class="text_pole wide">
                        ${buildOptions(HISTORY_OPTIONS, getSettings().historyCount)}
                    </select>
                    <small>System messages (character card, lorebook) are always sent. This controls user/assistant pairs only.</small>
                </div>

                <hr class="sysHR">

                <!-- Pipeline Status -->
                <div class="margin-bot-10">
                    <small id="ass-status" style="color: var(--fg_dim);">
                        Status: Idle
                    </small>
                </div>

                <hr class="sysHR">

                <!-- Tracked Fields Editor -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>Database Tracked Fields</b></small>
                    </label>
                    <div id="ass-tracked-fields-container"></div>
                </div>

                <hr class="sysHR">

                <!-- Prompt Configs -->
                <div id="ass-prompt-settings-container" class="margin-bot-10"></div>

                <hr class="sysHR">

                <!-- Debug-only section: Bypass Mode + Debug Panel -->
                <div id="ass-debug-section" style="${debugVisible}">
                    <!-- Bypass Mode -->
                    <div class="ass-enable-row margin-bot-10">
                        <label class="checkbox_label" for="ass-bypass-toggle">
                            <input type="checkbox" id="ass-bypass-toggle">
                            <span>Bypass Mode (no Agent)</span>
                        </label>
                    </div>
                    <small style="color: var(--fg_dim); margin-bottom: 10px; display: block;">
                        When enabled, the extension intercepts requests but returns dummy responses instead of connecting to the Agent. All data that would have been sent is logged to the browser console (F12). Use this for debugging group matching and metadata issues.
                    </small>

                    <hr class="sysHR">

                    <!-- Debug Panel -->
                    <div class="margin-bot-10">
                        <label class="title_restorable">
                            <small><b>Debug Tools</b></small>
                        </label>
                        <div style="display:flex; gap:6px; align-items:center; margin-bottom:6px;">
                            <select id="ass-debug-cmd" class="text_pole" style="flex:1;">
                                ${DEBUG_COMMANDS.map(c => `<option value="${c.value}">${c.label}</option>`).join('')}
                            </select>
                            <button id="ass-debug-run" class="menu_button" type="button" style="white-space:nowrap;">
                                <i class="fa-solid fa-play"></i> Run
                            </button>
                        </div>
                        <textarea id="ass-debug-output" class="text_pole" style="width:100%; height:220px; font-family:monospace; font-size:11px; resize:vertical; overflow:auto; white-space:pre;" readonly placeholder="Debug output will appear here...\n\nTip: Run &quot;Chat ID &amp; Group ID&quot; first, then &quot;Load &amp; Dump Groups&quot;, then &quot;Find Active Group&quot; to diagnose group matching."></textarea>
                    </div>
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(settingsHtml);

    // --- Bind current values ---
    const s = getSettings();
    $('#ass-toggle').prop('checked', s.enabled);
    $('#ass-rp-url').val(s.rpLlmUrl);

    $('#ass-rp-template').val(s.rpTemplate);
    $('#ass-instruct-template').val(s.instructTemplate);
    $('#ass-thinking').val(s.thinkingSteps);
    $('#ass-refinement').val(s.refinementSteps);
    $('#ass-history').val(s.historyCount);

    // --- Update Agent URL display ---
    refreshAgentUrlDisplay();

    // --- Bind change handlers ---

    $('#ass-toggle').on('change', function () {
        const settings = getSettings();
        settings.enabled = $(this).prop('checked');
        saveSettings(settings);
        if (settings.enabled) {
            onSettingChange();
            startHealthChecks();
        } else {
            stopHealthChecks();
            setConnectionStatus(false, 'Extension disabled');
        }
    });

    $('#ass-rp-url').on('change', function () {
        const settings = getSettings();
        settings.rpLlmUrl = $(this).val().trim();
        saveSettings(settings);
        onSettingChange();
    });

    $('#ass-rp-template').on('change', function () {
        const settings = getSettings();
        settings.rpTemplate = $(this).val();
        saveSettings(settings);
        onSettingChange();
    });

    $('#ass-instruct-template').on('change', function () {
        const settings = getSettings();
        settings.instructTemplate = $(this).val();
        saveSettings(settings);
        onSettingChange();
    });

    $('#ass-thinking').on('change', function () {
        const settings = getSettings();
        settings.thinkingSteps = parseInt($(this).val(), 10);
        saveSettings(settings);
        onSettingChange();
    });

    $('#ass-refinement').on('change', function () {
        const settings = getSettings();
        settings.refinementSteps = parseInt($(this).val(), 10);
        saveSettings(settings);
        onSettingChange();
    });

    $('#ass-history').on('change', function () {
        const settings = getSettings();
        settings.historyCount = parseInt($(this).val(), 10);
        saveSettings(settings);
    });

    // --- Reconnect button ---
    $('#ass-reconnect-btn').on('click', handleReconnect);

    // --- Bypass mode toggle (only bound if debug section exists) ---
    const $bypassToggle = $('#ass-bypass-toggle');
    if ($bypassToggle.length) {
        $bypassToggle.prop('checked', s.bypassMode);
        $bypassToggle.on('change', function () {
            const settings = getSettings();
            settings.bypassMode = $(this).prop('checked');
            saveSettings(settings);
            console.log(`[${EXTENSION_NAME}] Bypass mode: ${settings.bypassMode ? 'ON' : 'OFF'}`);
            if (settings.bypassMode) {
                setConnectionStatus(true, 'Bypass mode (no Agent)');
                updateStatus('Bypass mode', '#5bc0de');
                stopHealthChecks();
            } else {
                setConnectionStatus(false, 'Agent not reachable');
                updateStatus('Idle', 'var(--fg_dim)');
                if (settings.enabled) {
                    startHealthChecks();
                }
            }
        });
    }

    // --- Debug panel (only bound if debug section exists) ---
    const $debugRun = $('#ass-debug-run');
    if ($debugRun.length) {
        $debugRun.on('click', async function () {
            const cmd = $('#ass-debug-cmd').val();
            if (!cmd) {
                setDebugOutput('Select a debug command from the dropdown first.');
                return;
            }
            const $btn = $(this);
            $btn.prop('disabled', true);
            setDebugOutput('Running...');
            try {
                const output = await executeDebugCommand(cmd);
                setDebugOutput(output);
            } catch (err) {
                setDebugOutput(`Error: ${err.message}\n${err.stack || ''}`);
            } finally {
                $btn.prop('disabled', false);
            }
        });
    }

    // --- Render Instruct LLM backends list ---
    renderInstructBackends();
    $('#ass-add-instruct-backend').on('click', addInstructBackend);

    // --- Initialize tracked fields UI ---
    initTrackedFieldsUI();

    // --- Initialize prompt settings UI ---
    initPromptSettingsUI();

    // --- Start health checks if extension is already enabled ---
    if (s.enabled) {
        startHealthChecks();
    }
}

// #############################################
// # Instruct LLM Backends Dynamic List
// #############################################

/**
 * Render the dynamic list of Instruct LLM backend entries.
 */
function renderInstructBackends() {
    const settings = getSettings();
    const backends = settings.instructLlmBackends || [];
    const $container = $('#ass-instruct-backends-container');

    // Remove existing rows (but not the container itself)
    $container.empty();

    backends.forEach((backend, index) => {
        const $row = $(`
            <div class="ass-instruct-backend-row" style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                <input type="text" class="text_pole ass-instruct-url-input" style="flex:2;"
                       placeholder="http://localhost:5002" value="${backend.url || ''}">
                <input type="text" class="text_pole ass-instruct-key-input" style="flex:1;"
                       placeholder="API Key" value="${backend.api_key || 'none'}">
                <span class="ass-llm-dot ass-llm-dot-off ass-instruct-dot" data-index="${index}" title="Not checked"></span>
                <button class="ass-remove-instruct-backend" data-index="${index}" type="button"
                        title="Remove this backend"
                        style="padding:3px 8px; border:1px solid rgba(128,128,128,0.3); border-radius:4px;
                               background:rgba(128,128,128,0.1); color:var(--fg); cursor:pointer; font-size:11px;">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `);
        $container.append($row);
    });

    // Bind change handlers
    $container.find('.ass-instruct-url-input').on('change', function () {
        const idx = $(this).closest('.ass-instruct-backend-row').index();
        const settings = getSettings();
        if (!settings.instructLlmBackends[idx]) return;
        settings.instructLlmBackends[idx].url = $(this).val().trim();
        saveSettings(settings);
        onSettingChange();
    });

    $container.find('.ass-instruct-key-input').on('change', function () {
        const idx = $(this).closest('.ass-instruct-backend-row').index();
        const settings = getSettings();
        if (!settings.instructLlmBackends[idx]) return;
        settings.instructLlmBackends[idx].api_key = $(this).val().trim();
        saveSettings(settings);
        onSettingChange();
    });

    $container.find('.ass-remove-instruct-backend').on('click', function () {
        const idx = $(this).data('index');
        const settings = getSettings();
        settings.instructLlmBackends.splice(idx, 1);
        saveSettings(settings);
        renderInstructBackends();
        onSettingChange();
    });
}

/**
 * Add a new empty backend entry to the list.
 */
function addInstructBackend() {
    const settings = getSettings();
    if (!Array.isArray(settings.instructLlmBackends)) {
        settings.instructLlmBackends = [];
    }
    settings.instructLlmBackends.push({ url: '', api_key: 'none' });
    saveSettings(settings);
    renderInstructBackends();
}