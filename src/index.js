// src/index.js — Agent-StateSync SillyTavern Extension
// Intercepts chat completion requests, manages world-state sessions,
// trims history, and communicates with the FastAPI + LangGraph Agent.
//
// v3.0 — Added: character management (scenario/multi-character cards),
//          character_name + persona_name in [SYSTEM_META],
//          stop generation forwarding, empty default LLM URLs.

// #############################################
// # 1. Constants & Default Settings
// #############################################

const EXTENSION_NAME = 'Agent-StateSync';
const SETTINGS_KEY = 'agent_statesync_settings';
const META_KEY_SESSION = 'world_session_id';
const META_KEY_COUNTER = 'ass_msg_counter';
const META_KEY_INITIALIZED = 'ass_session_initialized';

// Character management keys (stored in chatMetadata — per chat)
const CM_KEY_MODE = 'ass_char_mode';           // 'character' or 'scenario'
const CM_KEY_MULTI = 'ass_multi_character';    // boolean
const CM_KEY_TRACKED = 'ass_tracked_characters'; // string[]

const TEMPLATE_OPTIONS = [
    { value: 'chatml', label: 'ChatML' },
    { value: 'llama3', label: 'Llama 3' },
    { value: 'alpaca', label: 'Alpaca' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'raw', label: 'Raw (None)' },
];

const THINKING_OPTIONS = [
    { value: 0, label: '0 (Disabled)' },
    { value: 1, label: '1 (Fast)' },
    { value: 2, label: '2 (Thorough)' },
];

const REFINEMENT_OPTIONS = [
    { value: 0, label: '0 (Disabled)' },
    { value: 1, label: '1 (Single Pass)' },
];

const HISTORY_OPTIONS = [
    { value: 2, label: '2 messages (minimal context)' },
    { value: 4, label: '4 messages' },
    { value: 6, label: '6 messages' },
    { value: 8, label: '8 messages' },
    { value: 0, label: '0 (send all — no trimming)' },
];

const HEALTH_CHECK_INTERVAL_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

const defaultSettings = {
    enabled: false,
    agentUrl: '',
    rpLlmUrl: '',               // Empty — agent uses config.ini if not set
    instructLlmUrl: '',         // Empty — agent uses config.ini if not set
    rpTemplate: 'chatml',
    instructTemplate: 'llama3',
    thinkingSteps: 0,
    refinementSteps: 0,
    historyCount: 2,
};

// #############################################
// # 2. State Variables (not persisted)
// #############################################

let context = null;
let configSynced = false;
let lastUserMsgHash = null;
let lastAssistantMsgHash = null;
let lastConversationCount = 0;
let currentSwipeIndex = 0;

// Connection status tracking
let agentConnected = false;
let healthCheckTimer = null;
let isReconnecting = false;

// Track whether current request was intercepted (for stop forwarding)
let currentRequestIntercepted = false;
let currentRequestBackendUrl = null;

// #############################################
// # 3. Settings Get/Save/Sync
// #############################################

function getSettings() {
    const stored = context.extensionSettings[SETTINGS_KEY];
    return { ...defaultSettings, ...(stored || {}) };
}

function saveSettings(settings) {
    context.extensionSettings[SETTINGS_KEY] = settings;
    context.saveSettingsDebounced();
}

/**
 * Push LLM addresses + template config to the Agent so it knows
 * where to route requests without receiving them on every call.
 */
async function syncConfigToAgent(settings) {
    if (!settings.enabled) return;

    const backendUrl = settings.agentUrl || null;
    if (!backendUrl) {
        console.warn(`[${EXTENSION_NAME}] Cannot sync config — no Agent URL available yet. Will sync on first request.`);
        return;
    }

    const configPayload = {};
    // Only send non-empty values — let agent use config.ini defaults for empty ones
    if (settings.rpLlmUrl) configPayload.rp_llm_url = settings.rpLlmUrl;
    if (settings.instructLlmUrl) configPayload.instruct_llm_url = settings.instructLlmUrl;
    configPayload.rp_template = settings.rpTemplate;
    configPayload.instruct_template = settings.instructTemplate;
    configPayload.thinking_steps = settings.thinkingSteps;
    configPayload.refinement_steps = settings.refinementSteps;

    try {
        const resp = await fetch(`http://${backendUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configPayload),
        });

        if (resp.ok) {
            configSynced = true;
            console.log(`[${EXTENSION_NAME}] Config synced to Agent.`);
        } else {
            console.warn(`[${EXTENSION_NAME}] Agent config sync returned ${resp.status}. Will retry.`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Agent config sync failed (Agent may not be running yet):`, err.message);
    }
}

// #############################################
// # 4. Connection Health Check
// #############################################

function getHealthCheckUrl() {
    const settings = getSettings();
    if (!settings.enabled) return null;
    if (!settings.agentUrl) return null;
    return `http://${settings.agentUrl}/health`;
}

async function checkAgentHealth() {
    const url = getHealthCheckUrl();
    if (!url) return false;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

        const resp = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const sessionCount = data.sessions || 0;
            setConnectionStatus(true, `Connected — ${sessionCount} session(s)`);
            return true;
        } else {
            setConnectionStatus(false, `Agent returned ${resp.status}`);
            return false;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            setConnectionStatus(false, 'Connection timed out');
        } else {
            setConnectionStatus(false, 'Agent not reachable');
        }
        return false;
    }
}

function startHealthChecks() {
    stopHealthChecks();
    checkAgentHealth();
    healthCheckTimer = setInterval(() => {
        checkAgentHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthChecks() {
    if (healthCheckTimer !== null) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }
}

function setConnectionStatus(connected, text) {
    agentConnected = connected;

    const dot = $('#ass-connection-dot');
    if (dot.length) {
        dot.removeClass('ass-dot-green ass-dot-red')
           .addClass(connected ? 'ass-dot-green' : 'ass-dot-red');
        dot.attr('title', text || (connected ? 'Connected' : 'Disconnected'));
    }
}

async function handleReconnect() {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr.info('Enable State Sync first.', 'Agent-StateSync');
        return;
    }
    if (isReconnecting) return;
    isReconnecting = true;

    const btn = $('#ass-reconnect-btn');
    btn.addClass('fa-spin');
    btn.prop('disabled', true);
    setConnectionStatus(false, 'Reconnecting...');

    try {
        const url = getHealthCheckUrl();

        if (!url) {
            setConnectionStatus(false, 'No Agent URL configured');
            toastr.warning('Set an Agent IP:Port first.', 'Agent-StateSync');
            return;
        }

        const healthy = await checkAgentHealth();

        if (healthy) {
            configSynced = false;
            await syncConfigToAgent(settings);
            toastr.success('Reconnected to Agent!', 'Agent-StateSync');
        } else {
            toastr.error(
                'Could not reach the Agent. Make sure it\'s running and the IP:Port is correct.',
                'Agent-StateSync'
            );
        }
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Reconnect error:`, err);
        setConnectionStatus(false, 'Reconnect failed');
        toastr.error('Reconnect failed. Check console (F12).', 'Agent-StateSync');
    } finally {
        isReconnecting = false;
        btn.removeClass('fa-spin');
        btn.prop('disabled', false);
    }
}

// #############################################
// # 5. Character Management (per-chat)
// #############################################

/**
 * Get character management settings from chatMetadata.
 * These are per-chat: different chats with the same character can have different settings.
 */
function getCharManagement() {
    const meta = context.chatMetadata || {};
    return {
        mode: meta[CM_KEY_MODE] || 'character',        // 'character' or 'scenario'
        multiCharacter: meta[CM_KEY_MULTI] || false,    // boolean
        trackedCharacters: meta[CM_KEY_TRACKED] || [],   // string[]
    };
}

/**
 * Save character management settings to chatMetadata.
 */
async function saveCharManagement(data) {
    context.chatMetadata = context.chatMetadata || {};
    context.chatMetadata[CM_KEY_MODE] = data.mode;
    context.chatMetadata[CM_KEY_MULTI] = data.multiCharacter;
    context.chatMetadata[CM_KEY_TRACKED] = data.trackedCharacters;
    await context.saveMetadata();
}

/**
 * Open the Character Management popup modal.
 * Contains: scenario toggle, multi-character toggle, dynamic name fields.
 */
function openCharManagementPopup() {
    const cm = getCharManagement();
    const charName = context.name2 || '';

    // Build tracked character rows
    let trackedHtml = '';
    if (cm.trackedCharacters.length === 0) {
        // Default: show the main character name
        trackedHtml = buildTrackedCharRow(charName, 0);
    } else {
        cm.trackedCharacters.forEach((name, i) => {
            trackedHtml += buildTrackedCharRow(name, i);
        });
    }

    const popupHtml = `
    <div id="ass-cm-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;">
        <div id="ass-cm-modal" style="background:var(--SmartThemeBlurTintColor,var(--bg-alt-opacity-50));backdrop-filter:blur(var(--SmartThemeBlurStrength,10px));border:1px solid var(--border-color);border-radius:12px;padding:20px;width:500px;max-width:90vw;max-height:80vh;overflow-y:auto;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
                <h3 style="margin:0;color:var(--fg);font-size:16px;">Character Management</h3>
                <button id="ass-cm-close" style="background:none;border:none;color:var(--fg);font-size:20px;cursor:pointer;padding:4px 8px;" title="Close">&times;</button>
            </div>

            <!-- Scenario Card Toggle -->
            <div style="margin-bottom:16px;">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="ass-cm-scenario" ${cm.mode === 'scenario' ? 'checked' : ''}>
                    <span style="color:var(--fg);font-size:14px;">This is a Scenario Card</span>
                </label>
                <small style="color:var(--fg_dim);margin-left:28px;">Track world state, environment, and events instead of character-specific state.</small>
            </div>

            <hr style="border-color:var(--border-color);margin:16px 0;">

            <!-- Multi-Character Toggle -->
            <div style="margin-bottom:16px;">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="ass-cm-multi" ${cm.multiCharacter ? 'checked' : ''}>
                    <span style="color:var(--fg);font-size:14px;">Track Multiple Characters</span>
                </label>
                <small style="color:var(--fg_dim);margin-left:28px;">When ON, the Instruct LLM will track state for each named character below.</small>
            </div>

            <!-- Tracked Characters -->
            <div id="ass-cm-tracked-section" style="margin-bottom:16px;${!cm.multiCharacter && cm.mode !== 'scenario' ? 'display:none;' : ''}">
                <label style="color:var(--fg);font-size:14px;display:block;margin-bottom:8px;">
                    Characters to Track
                </label>
                <small style="color:var(--fg_dim);display:block;margin-bottom:8px;">
                    Add names of characters whose state should be tracked. The Instruct LLM will create a state section for each one.
                </small>
                <div id="ass-cm-tracked-list">
                    ${trackedHtml}
                </div>
                <button id="ass-cm-add-char" style="
                    margin-top:8px;
                    padding:4px 12px;
                    border:1px dashed var(--border-color);
                    border-radius:6px;
                    background:transparent;
                    color:var(--fg_dim);
                    font-size:13px;
                    cursor:pointer;
                    width:100%;
                " title="Add another character">
                    + Add Character
                </button>
            </div>

            <!-- Save Button -->
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;">
                <button id="ass-cm-cancel" style="
                    padding:6px 16px;
                    border:1px solid var(--border-color);
                    border-radius:6px;
                    background:transparent;
                    color:var(--fg);
                    font-size:13px;
                    cursor:pointer;
                ">Cancel</button>
                <button id="ass-cm-save" style="
                    padding:6px 16px;
                    border:1px solid var(--border-color);
                    border-radius:6px;
                    background:var(--SmartThemeBorderColor,rgba(var(--MainAccentColor-rgb),0.3));
                    color:var(--fg);
                    font-size:13px;
                    cursor:pointer;
                ">Save</button>
            </div>
        </div>
    </div>`;

    // Remove existing popup if any
    $('#ass-cm-overlay').remove();

    $('body').append(popupHtml);

    // --- Bind events ---

    // Close button
    $('#ass-cm-close').on('click', () => $('#ass-cm-overlay').remove());
    $('#ass-cm-cancel').on('click', () => $('#ass-cm-overlay').remove());

    // Close on overlay click (not modal)
    $('#ass-cm-overlay').on('click', (e) => {
        if ($(e.target).attr('id') === 'ass-cm-overlay') {
            $('#ass-cm-overlay').remove();
        }
    });

    // Scenario toggle — hides multi-char when scenario is ON
    $('#ass-cm-scenario').on('change', function () {
        const isScenario = $(this).prop('checked');
        if (isScenario) {
            $('#ass-cm-multi').prop('checked', false);
            $('#ass-cm-tracked-section').hide();
        }
    });

    // Multi-character toggle — shows/hides tracked section
    $('#ass-cm-multi').on('change', function () {
        const isMulti = $(this).prop('checked');
        if (isMulti) {
            $('#ass-cm-scenario').prop('checked', false);
            $('#ass-cm-tracked-section').show();
            // Ensure at least one field exists
            if ($('#ass-cm-tracked-list .ass-cm-char-row').length === 0) {
                $('#ass-cm-tracked-list').append(buildTrackedCharRow(charName, 0));
            }
        } else {
            $('#ass-cm-tracked-section').hide();
        }
    });

    // Add character button
    $('#ass-cm-add-char').on('click', () => {
        const count = $('#ass-cm-tracked-list .ass-cm-char-row').length;
        $('#ass-cm-tracked-list').append(buildTrackedCharRow('', count));
        $('#ass-cm-tracked-list .ass-cm-char-row:last input').focus();
    });

    // Delegate: remove character button
    $('#ass-cm-tracked-list').on('click', '.ass-cm-char-remove', function () {
        $(this).closest('.ass-cm-char-row').remove();
        // Ensure at least one field remains
        if ($('#ass-cm-tracked-list .ass-cm-char-row').length === 0) {
            $('#ass-cm-tracked-list').append(buildTrackedCharRow(charName, 0));
        }
    });

    // Delegate: auto-add new empty field when last one gets content
    $('#ass-cm-tracked-list').on('input', '.ass-cm-char-input', function () {
        const $rows = $('#ass-cm-tracked-list .ass-cm-char-row');
        const $lastRow = $rows.last();
        const $lastInput = $lastRow.find('.ass-cm-char-input');

        // If the user typed in the last row and it has content, add a new empty row
        if ($lastInput.val().trim().length > 0) {
            const count = $rows.length;
            $('#ass-cm-tracked-list').append(buildTrackedCharRow('', count));
        }
    });

    // Save button
    $('#ass-cm-save').on('click', () => {
        const mode = $('#ass-cm-scenario').prop('checked') ? 'scenario' : 'character';
        const multiCharacter = $('#ass-cm-multi').prop('checked');

        // Collect tracked character names
        const trackedCharacters = [];
        $('#ass-cm-tracked-list .ass-cm-char-input').each(function () {
            const name = $(this).val().trim();
            if (name) {
                trackedCharacters.push(name);
            }
        });

        // Validation
        if (mode === 'character' && !multiCharacter) {
            // Single character mode — tracked list is just the main character
            trackedCharacters.length = 0;
        }

        saveCharManagement({
            mode: mode,
            multiCharacter: multiCharacter,
            trackedCharacters: trackedCharacters,
        });

        $('#ass-cm-overlay').remove();

        // Update the management button label
        updateCharManagementButton();

        toastr.success(
            mode === 'scenario'
                ? 'Scenario card mode enabled.'
                : multiCharacter
                    ? `Tracking ${trackedCharacters.length} character(s).`
                    : 'Character management saved.',
            'Agent-StateSync'
        );

        console.log(`[${EXTENSION_NAME}] Character management saved:`, { mode, multiCharacter, trackedCharacters });
    });
}

/**
 * Build a single tracked character row HTML.
 */
function buildTrackedCharRow(name, index) {
    return `
    <div class="ass-cm-char-row" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <input type="text" class="ass-cm-char-input text_pole" value="${name}" placeholder="Character name..."
            style="flex:1;padding:4px 8px;font-size:13px;">
        <button class="ass-cm-char-remove" type="button" title="Remove" style="
            background:none;
            border:1px solid rgba(217,83,79,0.3);
            border-radius:4px;
            color:#d9534f;
            font-size:14px;
            cursor:pointer;
            padding:2px 6px;
            line-height:1;
        ">&times;</button>
    </div>`;
}

/**
 * Update the Character Management button label to reflect current state.
 */
function updateCharManagementButton() {
    const cm = getCharManagement();
    const btn = $('#ass-cm-manage-btn');
    if (!btn.length) return;

    if (cm.mode === 'scenario') {
        btn.html('<i class="fa-solid fa-map"></i> Character Management <small style="color:var(--fg_dim);">(Scenario)</small>');
    } else if (cm.multiCharacter) {
        const count = cm.trackedCharacters.length;
        btn.html(`<i class="fa-solid fa-users"></i> Character Management <small style="color:var(--fg_dim);">(${count} tracked)</small>`);
    } else {
        btn.html('<i class="fa-solid fa-user"></i> Character Management');
    }
}

// #############################################
// # 6. UI Rendering
// #############################################

function buildOptions(items, selectedValue) {
    return items.map(opt =>
        `<option value="${opt.value}" ${String(opt.value) === String(selectedValue) ? 'selected' : ''}>${opt.label}</option>`
    ).join('');
}

function injectCustomCSS() {
    if ($('#ass-custom-css').length) return;

    const css = `
    <style id="ass-custom-css">
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
        .ass-cm-btn {
            display: block;
            width: 100%;
            padding: 8px 12px;
            border: 1px solid rgba(128, 128, 128, 0.3);
            border-radius: 6px;
            background: rgba(128, 128, 128, 0.1);
            color: var(--fg);
            font-size: 13px;
            cursor: pointer;
            text-align: left;
            transition: background 0.2s, border-color 0.2s;
        }
        .ass-cm-btn:hover {
            background: rgba(128, 128, 128, 0.25);
            border-color: rgba(128, 128, 128, 0.5);
        }
    </style>`;

    $('head').append(css);
}

function renderSettingsUI() {
    injectCustomCSS();

    const settingsHtml = `
    <div class="agent-statesync-extension">
        <hr class="sysHR">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Agent-StateSync</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- Enable Toggle + Status + Reconnect -->
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

                <!-- Agent URL -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>Agent IP:Port</small>
                    </label>
                    <input type="text" id="ass-agent-url" class="text_pole wide" placeholder="localhost:8001">
                    <small>
                        The FastAPI + LangGraph Agent. Leave blank to auto-detect from SillyTavern's LLM API URL.
                    </small>
                </div>

                <hr class="sysHR">

                <!-- RP LLM -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small><b>RP LLM IP:Port</b> (Creative Writer)</small>
                    </label>
                    <input type="text" id="ass-rp-url" class="text_pole wide" placeholder="localhost:5001">
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoint. Leave blank to use the Agent's config.ini value.</small>
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
                    <input type="text" id="ass-instruct-url" class="text_pole wide" placeholder="localhost:11434">
                    <small>Ollama, Koboldcpp, or any OpenAI-compatible endpoint. Leave blank to use the Agent's config.ini value.</small>
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

                <!-- Character Management Button -->
                <div class="margin-bot-10">
                    <button id="ass-cm-manage-btn" class="ass-cm-btn" type="button">
                        <i class="fa-solid fa-user"></i> Character Management
                    </button>
                    <small style="color:var(--fg_dim);">Configure scenario cards, multi-character tracking, and character tags. Settings are per-chat.</small>
                </div>

                <hr class="sysHR">

                <!-- Pipeline Status -->
                <div class="margin-bot-10">
                    <small id="ass-status" style="color: var(--fg_dim);">
                        Status: Idle
                    </small>
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(settingsHtml);

    // --- Bind current values ---
    const s = getSettings();
    $('#ass-toggle').prop('checked', s.enabled);
    $('#ass-agent-url').val(s.agentUrl);
    $('#ass-rp-url').val(s.rpLlmUrl);
    $('#ass-instruct-url').val(s.instructLlmUrl);
    $('#ass-rp-template').val(s.rpTemplate);
    $('#ass-instruct-template').val(s.instructTemplate);
    $('#ass-thinking').val(s.thinkingSteps);
    $('#ass-refinement').val(s.refinementSteps);
    $('#ass-history').val(s.historyCount);

    // Update Character Management button label
    updateCharManagementButton();

    // --- Bind change handlers ---
    function onSettingChange() {
        const updated = getSettings();
        syncConfigToAgent(updated);
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

    $('#ass-agent-url').on('change', function () {
        const settings = getSettings();
        settings.agentUrl = $(this).val().trim();
        saveSettings(settings);
        configSynced = false;
        onSettingChange();
        if (settings.enabled) {
            startHealthChecks();
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

    // --- Character Management button ---
    $('#ass-cm-manage-btn').on('click', openCharManagementPopup);

    // --- Reconnect button ---
    $('#ass-reconnect-btn').on('click', handleReconnect);

    // --- Start health checks if extension is already enabled ---
    if (s.enabled) {
        startHealthChecks();
    }
}

// #############################################
// # 7. Utility Functions
// #############################################

function hashStr(str) {
    let hash = 0;
    const s = str || '';
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(36);
}

function updateStatus(text, color) {
    const el = $('#ass-status');
    if (el.length) {
        el.text('Status: ' + text).css('color', color || 'var(--fg_dim)');
    }
}

// #############################################
// # 8. Stop Generation Forwarding
// #############################################

/**
 * Forward a stop signal to the Agent's /api/stop endpoint.
 * Called when SillyTavern aborts a fetch that was intercepted by our extension.
 */
function forwardStopToAgent(backendUrl) {
    if (!backendUrl) return;

    const url = `http://${backendUrl}/api/stop`;
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    }).catch((err) => {
        console.warn(`[${EXTENSION_NAME}] Failed to forward stop to Agent:`, err.message);
    });

    console.log(`[${EXTENSION_NAME}] Stop signal forwarded to Agent at ${url}`);
}

// #############################################
// # 9. Session Management
// #############################################

function resolveBackendUrl(requestUrl, settings) {
    if (settings.agentUrl && settings.agentUrl.length > 0) {
        return settings.agentUrl;
    }
    try {
        const urlObj = new URL(requestUrl);
        const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
        return `${urlObj.hostname}:${port}`;
    } catch (e) {
        console.error(`[${EXTENSION_NAME}] Failed to parse URL:`, e);
        return null;
    }
}

async function ensureSession(backendUrl) {
    if (context.chatMetadata && context.chatMetadata[META_KEY_SESSION]) {
        if (!context.chatMetadata[META_KEY_INITIALIZED]) {
            await initSession(backendUrl, context.chatMetadata[META_KEY_SESSION]);
        }
        return context.chatMetadata[META_KEY_SESSION];
    }

    console.log(`[${EXTENSION_NAME}] No session ID. Creating session via ${backendUrl}...`);
    try {
        const resp = await fetch(`http://${backendUrl}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        if (!resp.ok) throw new Error(`Session API returned ${resp.status}`);

        const data = await resp.json();
        if (!data.session_id) throw new Error('Invalid session response');

        const sessionId = data.session_id;
        console.log(`[${EXTENSION_NAME}] Session created: ${sessionId}`);

        context.chatMetadata = context.chatMetadata || {};
        context.chatMetadata[META_KEY_SESSION] = sessionId;
        context.chatMetadata[META_KEY_COUNTER] = 0;
        await context.saveMetadata();

        await initSession(backendUrl, sessionId);

        return sessionId;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Session creation failed:`, err);
        throw err;
    }
}

async function initSession(backendUrl, sessionId) {
    console.log(`[${EXTENSION_NAME}] Initializing session ${sessionId} with character data...`);
    updateStatus('Initializing session...', '#f0ad4e');

    try {
        const charName = context.name2 || '';
        const charDescription = context.description || '';
        const charPersonality = context.personality || '';
        const charScenario = context.scenario || '';
        const charFirstMes = context.first_mes || '';
        const charMesExample = context.mes_example || '';
        const personaName = context.name1 || '';
        const personaDescription = context.personaDescription || '';

        // Get character management settings for this chat
        const cm = getCharManagement();

        const initPayload = {
            character_name: charName,
            character_description: charDescription,
            character_personality: charPersonality,
            character_scenario: charScenario,
            character_first_mes: charFirstMes,
            character_mes_example: charMesExample,
            persona_name: personaName,
            persona_description: personaDescription,
            // Character management
            mode: cm.mode,
            multi_character: cm.multiCharacter,
            tracked_characters: cm.trackedCharacters,
        };

        const resp = await fetch(`http://${backendUrl}/api/sessions/${sessionId}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initPayload),
        });

        if (resp.ok) {
            console.log(`[${EXTENSION_NAME}] Session ${sessionId} initialized.`);
            context.chatMetadata[META_KEY_INITIALIZED] = true;
            await context.saveMetadata();
            updateStatus('Session initialized', '#5cb85c');
        } else {
            console.warn(`[${EXTENSION_NAME}] Session init returned ${resp.status}. Will retry on next request.`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Session init failed (Agent may be starting up):`, err.message);
    }
}

// #############################################
// # 10. Message Type Detection
// #############################################

function detectMessageType(messages) {
    const convMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const convCount = convMsgs.length;

    const userMsgs = convMsgs.filter(m => m.role === 'user');
    const assistantMsgs = convMsgs.filter(m => m.role === 'assistant');
    const currentUserHash = hashStr(userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : '');
    const currentAssistantHash = hashStr(assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : '');

    let type = 'new';

    if (lastUserMsgHash === null) {
        type = 'new';
    } else if (convCount === lastConversationCount && currentUserHash === lastUserMsgHash && currentAssistantHash === lastAssistantHash) {
        type = 'continue';
    } else if (currentUserHash === lastUserMsgHash && currentAssistantHash !== lastAssistantHash) {
        type = 'swipe';
        currentSwipeIndex++;
    } else if (convCount < lastConversationCount && currentUserHash !== lastUserMsgHash) {
        type = 'redo';
        currentSwipeIndex = 0;
    } else if (currentUserHash !== lastUserMsgHash) {
        type = 'new';
        currentSwipeIndex = 0;
    }

    lastUserMsgHash = currentUserHash;
    lastAssistantMsgHash = currentAssistantHash;
    lastConversationCount = convCount;

    return type;
}

function getMessageId() {
    return (context.chatMetadata?.[META_KEY_COUNTER] || 0);
}

async function incrementMessageId() {
    context.chatMetadata = context.chatMetadata || {};
    context.chatMetadata[META_KEY_COUNTER] = (context.chatMetadata[META_KEY_COUNTER] || 0) + 1;
    await context.saveMetadata();
    return context.chatMetadata[META_KEY_COUNTER];
}

// #############################################
// # 11. History Trimming
// #############################################

function trimHistory(messages, maxConversationMessages) {
    if (maxConversationMessages === 0) return messages;

    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');
    const trimmed = convMsgs.slice(-maxConversationMessages);

    if (convMsgs.length > 0 && trimmed.length > 0 && trimmed[trimmed.length - 1] !== convMsgs[convMsgs.length - 1]) {
        trimmed.push(convMsgs[convMsgs.length - 1]);
    }

    return [...systemMsgs, ...trimmed];
}

// #############################################
// # 12. [SYSTEM_META] Construction
// #############################################

/**
 * Build the [SYSTEM_META] tag with all per-request data.
 *
 * Format (multi-line for readability, agent parses flexibly):
 * [SYSTEM_META]
 * session_id=abc-123
 * message_id=5
 * type=new
 * swipe_index=0
 * character_name=Lyra
 * persona_name=Marcus
 * mode=character
 * tracked=Lyra,Kai
 * [/SYSTEM_META]
 */
function buildMetaTag(sessionId, messageId, type, swipeIndex, charName, personaName, mode, tracked) {
    const lines = [
        '[SYSTEM_META]',
        `session_id=${sessionId}`,
        `message_id=${messageId}`,
        `type=${type}`,
        `swipe_index=${swipeIndex}`,
        `character_name=${charName}`,
        `persona_name=${personaName}`,
        `mode=${mode}`,
        `tracked=${tracked}`,
        '[/SYSTEM_META]',
    ];
    return lines.join('\n');
}

// #############################################
// # 13. Fetch Interception (Core Pipeline)
// #############################################

function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (url, options) {
        const settings = getSettings();

        // Pass through if extension is disabled
        if (!settings.enabled) {
            return originalFetch.call(window, url, options);
        }

        // Check if this is a chat completion request
        let isChatRequest = false;
        let bodyObject = null;

        if (options && options.method === 'POST' && options.body) {
            try {
                bodyObject = JSON.parse(options.body);
                if (bodyObject.messages && Array.isArray(bodyObject.messages)) {
                    isChatRequest = true;
                }
            } catch (e) { /* Not JSON, pass through */ }
        }

        if (!isChatRequest) {
            return originalFetch.call(window, url, options);
        }

        // This is a chat completion request. Begin processing.
        updateStatus('Processing request...', '#5bc0de');

        try {
            const urlString = (url instanceof Request) ? url.url : String(url);
            const backendUrl = resolveBackendUrl(urlString, settings);

            if (!backendUrl) {
                throw new Error('Could not determine Agent URL. Set Agent IP:Port in settings.');
            }

            // Ensure session exists
            const sessionId = await ensureSession(backendUrl);
            if (!sessionId) {
                throw new Error('Failed to acquire session ID.');
            }

            // Sync config to Agent on first request (if not already synced)
            if (!configSynced) {
                await syncConfigToAgent(settings);
            }

            // Detect message type
            const messageType = detectMessageType(bodyObject.messages);
            console.log(`[${EXTENSION_NAME}] Message type: ${messageType}, swipe_index: ${currentSwipeIndex}`);

            // Update message counter
            let messageId = getMessageId();
            if (messageType === 'new') {
                messageId = await incrementMessageId();
            }

            // Trim history
            bodyObject.messages = trimHistory(bodyObject.messages, settings.historyCount);

            // --- Get character management data ---
            const cm = getCharManagement();
            const charName = context.name2 || '';
            const personaName = context.name1 || '';
            const mode = cm.mode || 'character';
            const tracked = (cm.multiCharacter && cm.trackedCharacters.length > 0)
                ? cm.trackedCharacters.join(',')
                : charName;  // Single character mode: tracked = character name

            // Build and inject [SYSTEM_META] tag
            const metaTag = buildMetaTag(sessionId, messageId, messageType, currentSwipeIndex, charName, personaName, mode, tracked);
            bodyObject.messages.unshift({
                role: 'system',
                content: metaTag,
            });

            // Build fetch options
            const newOptions = { ...options, body: JSON.stringify(bodyObject) };

            // Determine target URL
            let targetUrl = url;
            if (settings.agentUrl && settings.agentUrl.length > 0) {
                try {
                    const urlObj = new URL(urlString);
                    targetUrl = `http://${settings.agentUrl}${urlObj.pathname}${urlObj.search}`;
                } catch (e) {
                    targetUrl = `http://${settings.agentUrl}/v1/chat/completions`;
                }
            }

            console.log(`[${EXTENSION_NAME}] Injected [SYSTEM_META] → mode=${mode}, tracked=${tracked}`);
            console.log(`[${EXTENSION_NAME}] Messages trimmed to ${bodyObject.messages.length} (${settings.historyCount} conversation limit)`);
            console.log(`[${EXTENSION_NAME}] Forwarding to: ${targetUrl}`);

            updateStatus(`Active (${messageType})`, '#5cb85c');

            // Mark this as an intercepted request for stop forwarding
            currentRequestIntercepted = true;
            currentRequestBackendUrl = settings.agentUrl || backendUrl;

            // Execute the fetch and handle abort for stop forwarding
            const fetchPromise = originalFetch.call(window, targetUrl, newOptions);

            // When ST aborts the request (user presses Stop), forward to Agent
            fetchPromise.catch((err) => {
                if (err.name === 'AbortError' && currentRequestIntercepted) {
                    console.log(`[${EXTENSION_NAME}] Request aborted by SillyTavern — forwarding stop signal to Agent`);
                    forwardStopToAgent(currentRequestBackendUrl);
                }
                currentRequestIntercepted = false;
            });

            return fetchPromise;

        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Interception error:`, err);

            if (typeof toastr !== 'undefined') {
                toastr.error(
                    err.message || 'Check console (F12) for details.',
                    'Agent-StateSync Error'
                );
            }

            updateStatus('Error — check console', '#d9534f');

            return originalFetch.call(window, url, options);
        }
    };
}

// #############################################
// # 14. Chat Event Hooks
// #############################################

function hookChatEvents() {
    const eventBus = context.eventBus;
    if (eventBus) {
        eventBus.on('chat-changed', () => {
            console.log(`[${EXTENSION_NAME}] Chat changed — resetting detection state.`);
            lastUserMsgHash = null;
            lastAssistantMsgHash = null;
            lastConversationCount = 0;
            currentSwipeIndex = 0;
            configSynced = false;
            currentRequestIntercepted = false;
            currentRequestBackendUrl = null;

            // Update Character Management button for new chat context
            updateCharManagementButton();

            const settings = getSettings();
            if (settings.enabled) {
                startHealthChecks();
            }
        });
    }
}

// #############################################
// # 15. Initialization
// #############################################

(async function init() {
    while (!window.SillyTavern || !window.SillyTavern.getContext) {
        await new Promise(r => setTimeout(r, 100));
    }

    context = window.SillyTavern.getContext();

    // Migrate old settings format
    if (context.extensionSettings[SETTINGS_KEY]) {
        const stored = context.extensionSettings[SETTINGS_KEY];
        if (stored.manualOverride !== undefined && !stored.agentUrl) {
            stored.agentUrl = stored.manualOverride;
            delete stored.manualOverride;
        }
    }

    // Initialize defaults if first run
    if (!context.extensionSettings[SETTINGS_KEY]) {
        context.extensionSettings[SETTINGS_KEY] = { ...defaultSettings };
        context.saveSettingsDebounced();
    }

    renderSettingsUI();
    hookChatEvents();
    interceptFetch();

    console.log(`[${EXTENSION_NAME}] Extension loaded. Version 3.0`);
    console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
})();