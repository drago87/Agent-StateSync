// ui.js — Agent-StateSync UI Rendering & Event Hooks
//
// Settings panel HTML/CSS, event bindings, character config button,
// chat-changed event hook, and the main initialization IIFE.
// File Version: 1.0.2

import state from './state.js';
import {
    EXTENSION_NAME, SETTINGS_KEY,
    TEMPLATE_OPTIONS, THINKING_OPTIONS, REFINEMENT_OPTIONS, HISTORY_OPTIONS,
    DEBUG_COMMANDS, defaultSettings,
    getSettings, saveSettings, isBypassMode, syncConfigToAgent, updateStatus, setDebugOutput,
} from './settings.js';
import {
    getAgentOrigin, refreshAgentUrlDisplay, handleReconnect,
    startHealthChecks, stopHealthChecks, setConnectionStatus,
} from './agent-url.js';
import { proactiveChatChanged, manualInitSession } from './session.js';
import { interceptFetch } from './pipeline.js';
import { executeDebugCommand } from './debug.js';
import { initCharConfig } from './char-config.js';
import { initTrackedFieldsUI } from './tracked-fields.js';
import { initPromptSettingsUI } from './prompt-settings.js';

// #############################################
// # 10. UI Rendering
// #############################################

export function buildOptions(items, selectedValue) {
    return items.map(opt =>
        `<option value="${opt.value}" ${String(opt.value) === String(selectedValue) ? 'selected' : ''}>${opt.label}</option>`
    ).join('');
}

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
                        <input type="text" id="ass-rp-url" class="text_pole wide" placeholder="192.168.0.1:5001">
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
                        <small><b>Instruct LLM IP:Port</b> (Data Logger)</small>
                    </label>
                    <div class="ass-llm-row">
                        <input type="text" id="ass-instruct-url" class="text_pole wide" placeholder="192.168.0.1:11434">
                        <span id="ass-instruct-dot" class="ass-llm-dot ass-llm-dot-off" title="Instruct LLM: not checked"></span>
                    </div>
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoint. Runs a smaller model for JSON state extraction.</small>
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
    $('#ass-instruct-url').val(s.instructLlmUrl);
    $('#ass-rp-template').val(s.rpTemplate);
    $('#ass-instruct-template').val(s.instructTemplate);
    $('#ass-thinking').val(s.thinkingSteps);
    $('#ass-refinement').val(s.refinementSteps);
    $('#ass-history').val(s.historyCount);

    // --- Update Agent URL display ---
    refreshAgentUrlDisplay();

    // --- Bind change handlers ---
    function onSettingChange() {
        const updated = getSettings();
        syncConfigToAgent(updated, getAgentOrigin());
    }

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

    $('#ass-instruct-url').on('change', function () {
        const settings = getSettings();
        settings.instructLlmUrl = $(this).val().trim();
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
// # 9. Character Config Button (Action Bar)
// #############################################

/**
 * Inject a "Char Config" button into SillyTavern's action button bar,
 * just before the Delete button.
 * Pings Agent config endpoint with current character's data.
 */
export function injectCharConfigButton() {
    if ($('#ass-char-config-btn').length) return; // Already injected

    const $deleteBtn = $('#delete_character_button');
    if (!$deleteBtn.length) {
        // ST not ready yet - retry
        setTimeout(injectCharConfigButton, 1000);
        return;
    }

    const $btn = $(`
        <div id="ass-char-config-btn" class="ass-char-config-wrap" style="display:inline-flex; margin:0 2px;">
            <button class="menu_button" type="button" title="Send character config to Agent">
                <i class="fa-solid fa-gear"></i>
                Char Config
            </button>
        </div>
    `);

    $deleteBtn.before($btn);

    $btn.on('click', async function () {
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.info('Enable State Sync first.', 'Agent-StateSync');
            return;
        }

        const origin = getAgentOrigin();
        if (!origin) {
            toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
            return;
        }

        toastr.info('Sending character config to Agent...', 'Agent-StateSync');

        try {
            const configPayload = {
                rp_template: settings.rpTemplate,
                instruct_template: settings.instructTemplate,
                thinking_steps: settings.thinkingSteps,
                refinement_steps: settings.refinementSteps,
            };

            // Only include URL fields if they have actual values
            if (settings.rpLlmUrl && settings.rpLlmUrl.trim()) {
                configPayload.rp_llm_url = settings.rpLlmUrl.trim();
            }
            if (settings.instructLlmUrl && settings.instructLlmUrl.trim()) {
                configPayload.instruct_llm_url = settings.instructLlmUrl.trim();
            }

            const resp = await fetch(`${origin}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload),
            });

            if (resp.ok) {
                state.configSynced = true;
                toastr.success('Config synced to Agent!', 'Agent-StateSync');
            } else {
                toastr.error(`Agent returned ${resp.status}`, 'Agent-StateSync');
            }
        } catch (err) {
            toastr.error(`Config sync failed: ${err.message}`, 'Agent-StateSync');
        }
    });
}

// #############################################
// # Init Session Button (Rocket Icon)
// #############################################

/**
 * Inject an "Init Session" button into the GG menu buttons container.
 * Hidden by default; shown when a chat needs initialization.
 * Hidden again after a successful init.
 */
export function injectInitButton() {
    if ($('#ass-init-session-btn').length) return; // Already injected

    const $container = $('#gg-menu-buttons-container');
    if (!$container.length) {
        // GG container not ready yet - retry
        setTimeout(injectInitButton, 1000);
        return;
    }

    const $btn = $(`
        <div id="ass-init-session-btn" class="gg-menu-button fa-solid fa-rocket interactable" style="display:none;" title="Initialize the current chat" tabindex="0"></div>
    `);

    $container.append($btn);

    $btn.on('click', async function () {
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.info('Enable State Sync first.', 'Agent-StateSync');
            return;
        }

        const origin = getAgentOrigin();
        if (!origin) {
            toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
            return;
        }

        $btn.css('opacity', '0.5').css('pointer-events', 'none');
        toastr.info('Initializing Agent session...', 'Agent-StateSync');

        try {
            const success = await manualInitSession();
            if (success) {
                toastr.success('Agent session initialized!', 'Agent-StateSync');
                $btn.hide(); // Hide after successful init
                state.sessionInitialized = true;
            } else {
                toastr.warning('Init failed. Check console for details.', 'Agent-StateSync');
            }
        } catch (err) {
            toastr.error(`Init failed: ${err.message}`, 'Agent-StateSync');
        } finally {
            $btn.css('opacity', '').css('pointer-events', '');
        }
    });
}

/**
 * Show or hide the init button based on whether the current chat
 * already has an initialized session.
 * Call this on chat-changed and after page load.
 */
export function updateInitButtonVisibility() {
    const $btn = $('#ass-init-session-btn');
    if (!$btn.length) return;

    if (state.sessionInitialized) {
        $btn.hide();
    } else {
        $btn.show();
    }
}

// #############################################
// # 20. Chat Event Hooks
// #############################################

export function hookChatEvents() {
    const eventBus = state.context.eventBus;
    if (eventBus) {
        eventBus.on('chat-changed', () => {
            console.log(`[${EXTENSION_NAME}] Chat changed - proactive session setup`);
            state.lastUserMsgHash = null;
            state.lastAssistantMsgHash = null;
            state.lastConversationCount = 0;
            state.currentSwipeIndex = 0;
            state.configSynced = false;

            // Reset group cache so it reloads for the new chat
            state.cachedGroups = null;
            state.activeGroup = null;
            state.activeGroupCharacters = [];
            state.isGroupChat = false;

            // Refresh the Agent URL display
            refreshAgentUrlDisplay();

            const settings = getSettings();
            if (settings.enabled) {
                startHealthChecks();
                // Proactive session setup for the new chat (silent)
                proactiveChatChanged().then(() => {
                    updateInitButtonVisibility();
                });
            }
        });
    }
}

// #############################################
// # 21. Initialization
// #############################################

export function init(debug = false) {
    // Store debug flag in state before anything else
    state.debug = debug;
    console.log(`[${EXTENSION_NAME}] Debug mode: ${state.debug}`);

    // Wait for SillyTavern to be ready
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
        while (!window.SillyTavern || !window.SillyTavern.getContext) {
            await new Promise(r => setTimeout(r, 100));
        }

        state.context = window.SillyTavern.getContext();

        // Migrate old settings format (remove agentUrl if present)
        if (state.context.extensionSettings[SETTINGS_KEY]) {
            const stored = state.context.extensionSettings[SETTINGS_KEY];
            if (stored.agentUrl !== undefined) {
                delete stored.agentUrl;
                console.log(`[${EXTENSION_NAME}] Removed deprecated agentUrl setting (now auto-detected).`);
            }
            if (stored.manualOverride !== undefined) {
                delete stored.manualOverride;
            }
        }

        // Initialize defaults if first run
        if (!state.context.extensionSettings[SETTINGS_KEY]) {
            state.context.extensionSettings[SETTINGS_KEY] = { ...defaultSettings };
            state.context.saveSettingsDebounced();
        }

        // Render UI, hook events, install interceptor
        renderSettingsUI();
        hookChatEvents();
        interceptFetch();

        // Inject Char Config button into action bar
        injectCharConfigButton();

        // Inject Init Session button into chat controls
        injectInitButton();

        // Inject brain button into Character Sheet Bar
        initCharConfig();

        console.log(`[${EXTENSION_NAME}] Extension loaded. Version 3.0`);
        console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
        console.log(`[${EXTENSION_NAME}] Agent URL (auto-detected):`, getAgentOrigin());

        // --- Initial proactive session setup (for the chat that's open on page load) ---
        const settings = getSettings();
        if (settings.enabled) {
            // Small delay to let ST finish loading the initial chat
            setTimeout(async () => {
                try {
                    await proactiveChatChanged();
                    updateInitButtonVisibility();
                } catch (e) {
                    console.warn(`[${EXTENSION_NAME}] Initial proactive setup failed:`, e.message);
                }
            }, 2000);
        }

        resolve();
    });
}