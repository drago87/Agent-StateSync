// ui-settings.js — Agent-StateSync Settings Panel Rendering
//
// Settings panel HTML/CSS, event bindings, and all change handlers.
//
// LLM settings (RP LLM URL, Instruct LLM Backends, Templates) are now
// managed by the Agent. They are displayed as read-only fields (like
// the Agent URL) and updated from state.agentLlmConfig.
//
// Extracted from ui.js to keep the settings UI separate from
// the initialization orchestrator and button injection logic.
// File Version: 2.0.0

import state from './state.js';
import {
    EXTENSION_NAME,
    THINKING_OPTIONS, REFINEMENT_OPTIONS, HISTORY_OPTIONS,
    DEBUG_COMMANDS,
    getSettings, saveSettings, syncConfigToAgent, updateStatus, setDebugOutput,
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

        /* Read-only URL/config display (shared by Agent URL, RP LLM, Instruct backends) */
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

        /* Small LLM status dot next to displays */
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
        .ass-llm-dot-yellow {
            background-color: #f0ad4e;
            box-shadow: 0 0 4px 1px rgba(240, 173, 78, 0.5);
        }
        .ass-llm-dot-red {
            background-color: #d9534f;
            box-shadow: 0 0 4px 1px rgba(217, 83, 79, 0.4);
        }
        .ass-llm-dot-off {
            background-color: #555;
            box-shadow: none;
        }

        /* LLM config label (e.g. template name) */
        .ass-llm-label {
            font-size: 11px;
            padding: 1px 6px;
            border-radius: 3px;
            background: rgba(128, 128, 128, 0.2);
            color: var(--fg_dim);
            white-space: nowrap;
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
 * Defined at module level so other functions can call it.
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

                <!-- RP LLM (read-only, from Agent) -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>RP LLM IP:Port</b> <i>(from Agent)</i></small>
                    </label>
                    <div class="ass-url-display" id="ass-rp-llm-display">
                        <span id="ass-rp-dot" class="ass-llm-dot ass-llm-dot-off" title="RP LLM: not checked"></span>
                        <i class="fa-solid fa-pen-fancy" style="opacity:0.5;"></i>
                        <span class="ass-url-value" id="ass-rp-llm-text">Waiting for Agent...</span>
                        <span class="ass-llm-label" id="ass-rp-llm-template" style="display:none;"></span>
                    </div>
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoint. Configured on the Agent side.</small>
                </div>

                <!-- Instruct LLM Backends (read-only, dynamic from Agent) -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>Instruct LLM Backends</b> <i>(from Agent)</i></small>
                    </label>
                    <div id="ass-instruct-backends-container">
                        <!-- Placeholder row — replaced by updateLlmDisplay() when Agent config arrives -->
                        <div class="ass-url-display ass-instruct-backend-row" style="margin-bottom:4px;">
                            <span class="ass-llm-dot ass-llm-dot-off ass-instruct-dot" data-index="0" title="Not checked"></span>
                            <i class="fa-solid fa-database" style="opacity:0.5;"></i>
                            <span class="ass-url-value" style="color:#d9534f;">Waiting for Agent...</span>
                        </div>
                    </div>
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoints. The Agent will load-balance across available backends.</small>
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

    // --- Initialize tracked fields UI ---
    initTrackedFieldsUI();

    // --- Initialize prompt settings UI ---
    initPromptSettingsUI();

    // --- Start health checks if extension is already enabled ---
    if (s.enabled) {
        startHealthChecks();
    }
}