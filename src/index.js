// src/index.js — Agent-StateSync SillyTavern Extension
// Intercepts chat completion requests, manages world-state sessions,
// trims history, and communicates with the FastAPI + LangGraph Agent.
//
// v2.1 — Added: connection status indicator (green/red dot),
//          reconnect button, periodic health checking.

// #############################################
// # 1. Constants & Default Settings
// #############################################

const EXTENSION_NAME = 'Agent-StateSync';
const SETTINGS_KEY = 'agent_statesync_settings';
const META_KEY_SESSION = 'world_session_id';
const META_KEY_COUNTER = 'ass_msg_counter';
const META_KEY_INITIALIZED = 'ass_session_initialized';

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

const HEALTH_CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
const HEALTH_CHECK_TIMEOUT_MS = 5000;   // 5 second timeout per check

const defaultSettings = {
    enabled: false,
    agentUrl: '',                // Blank = use SillyTavern's LLM API URL
    rpLlmUrl: '192.168.0.1:5001',
    instructLlmUrl: '192.168.0.1:11434',
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
let configSynced = false;          // Has the Agent received our config?
let lastUserMsgHash = null;        // For message-type detection
let lastAssistantMsgHash = null;
let lastConversationCount = 0;     // Number of non-system messages last request
let currentSwipeIndex = 0;

// Connection status tracking
let agentConnected = false;        // Current connection state
let healthCheckTimer = null;       // Interval timer for health checks
let isReconnecting = false;        // Prevents spam-clicking reconnect

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

    const configPayload = {
        rp_llm_url: settings.rpLlmUrl,
        instruct_llm_url: settings.instructLlmUrl,
        rp_template: settings.rpTemplate,
        instruct_template: settings.instructTemplate,
        thinking_steps: settings.thinkingSteps,
        refinement_steps: settings.refinementSteps,
    };

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

/**
 * Resolve the Agent URL for health checks.
 * Uses the manual override if set, otherwise returns null (can't auto-detect without a request).
 */
function getHealthCheckUrl() {
    const settings = getSettings();
    if (!settings.enabled) return null;
    if (!settings.agentUrl) return null;
    return `http://${settings.agentUrl}/health`;
}

/**
 * Ping the Agent's /health endpoint.
 * Returns true if the Agent responded, false otherwise.
 */
async function checkAgentHealth() {
    const url = getHealthCheckUrl();
    if (!url) {
        // No URL or extension disabled — stay red
        return false;
    }

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

/**
 * Start the periodic health check loop.
 */
function startHealthChecks() {
    stopHealthChecks();
    // Check immediately, then on interval
    checkAgentHealth();
    healthCheckTimer = setInterval(() => {
        checkAgentHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic health check loop.
 */
function stopHealthChecks() {
    if (healthCheckTimer !== null) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }
}

/**
 * Update the connection status indicator in the UI.
 * @param {boolean} connected — true = green, false = red
 * @param {string} text — tooltip text shown on hover
 */
function setConnectionStatus(connected, text) {
    agentConnected = connected;

    // Update the status dot (inline next to the enable checkbox)
    const dot = $('#ass-connection-dot');
    if (dot.length) {
        dot.removeClass('ass-dot-green ass-dot-red')
           .addClass(connected ? 'ass-dot-green' : 'ass-dot-red');
        dot.attr('title', text || (connected ? 'Connected' : 'Disconnected'));
    }
}

/**
 * Handle the Reconnect button click.
 * Forces a health check + config re-sync immediately.
 * Only works when the extension is enabled.
 */
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

        // Try health check
        const healthy = await checkAgentHealth();

        if (healthy) {
            // Re-sync config
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
// # 5. UI Rendering
// #############################################

function buildOptions(items, selectedValue) {
    return items.map(opt =>
        `<option value="${opt.value}" ${String(opt.value) === String(selectedValue) ? 'selected' : ''}>${opt.label}</option>`
    ).join('');
}

function injectCustomCSS() {
    // Only inject once
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

        /* Enable row — houses toggle + dot + reconnect all in one line */
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

                <!-- Agent URL -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>Agent IP:Port</small>
                    </label>
                    <input type="text" id="ass-agent-url" class="text_pole wide" placeholder="192.168.0.1:8001">
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
                    <input type="text" id="ass-rp-url" class="text_pole wide" placeholder="192.168.0.1:5001">
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
                    <input type="text" id="ass-instruct-url" class="text_pole wide" placeholder="192.168.0.1:11434">
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
        configSynced = false; // Force re-sync with new URL
        onSettingChange();
        // Restart health checks with new URL
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

    // --- Reconnect button (only functional when extension is enabled) ---
    $('#ass-reconnect-btn').on('click', handleReconnect);

    // --- Start health checks if extension is already enabled ---
    if (s.enabled) {
        startHealthChecks();
    }
}

// #############################################
// # 6. Utility Functions
// #############################################

/**
 * Simple string hash for comparing message content across requests.
 * Not cryptographic — just needs to be consistent within a session.
 */
function hashStr(str) {
    let hash = 0;
    const s = str || '';
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit int
    }
    return hash.toString(36);
}

/**
 * Update the small status text in the settings panel.
 */
function updateStatus(text, color) {
    const el = $('#ass-status');
    if (el.length) {
        el.text('Status: ' + text).css('color', color || 'var(--fg_dim)');
    }
}

// #############################################
// # 7. Session Management
// #############################################

/**
 * Determine the Agent's IP:Port for the current request.
 * Uses the manual override if set, otherwise extracts from the request URL.
 */
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

/**
 * Ensure a session_id exists for the current chat.
 * Creates one via POST /api/sessions if missing.
 * Also initializes the session with character data on first run.
 */
async function ensureSession(backendUrl) {
    // --- Check if session already exists ---
    if (context.chatMetadata && context.chatMetadata[META_KEY_SESSION]) {
        // Session exists. Check if it was initialized.
        if (!context.chatMetadata[META_KEY_INITIALIZED]) {
            // Session created but init hasn't run yet (e.g., Agent was down)
            await initSession(backendUrl, context.chatMetadata[META_KEY_SESSION]);
        }
        return context.chatMetadata[META_KEY_SESSION];
    }

    // --- Create new session ---
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

        // Initialize session with character data
        await initSession(backendUrl, sessionId);

        return sessionId;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Session creation failed:`, err);
        throw err;
    }
}

/**
 * Send character card + persona data to the Agent for initial world-state parsing.
 * Uses the Instruct LLM on the Agent side to extract structured state from
 * the character description and first message.
 * Called exactly once per session (tracked via chatMetadata flag).
 */
async function initSession(backendUrl, sessionId) {
    console.log(`[${EXTENSION_NAME}] Initializing session ${sessionId} with character data...`);
    updateStatus('Initializing session...', '#f0ad4e');

    try {
        // --- Extract character data from SillyTavern context ---
        const charName = context.name2 || '';
        const charDescription = context.description || '';
        const charPersonality = context.personality || '';
        const charScenario = context.scenario || '';
        const charFirstMes = context.first_mes || '';
        const charMesExample = context.mes_example || '';
        const personaName = context.name1 || '';
        const personaDescription = context.personaDescription || '';

        const initPayload = {
            character_name: charName,
            character_description: charDescription,
            character_personality: charPersonality,
            character_scenario: charScenario,
            character_first_mes: charFirstMes,
            character_mes_example: charMesExample,
            persona_name: personaName,
            persona_description: personaDescription,
        };

        const resp = await fetch(`http://${backendUrl}/api/sessions/${sessionId}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initPayload),
        });

        if (resp.ok) {
            console.log(`[${EXTENSION_NAME}] Session ${sessionId} initialized with character data.`);
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
// # 8. Message Type Detection
// #############################################

/**
 * Detect the type of turn the user is performing by comparing
 * the current request's messages against the previous request.
 *
 * Returns one of: 'new', 'continue', 'swipe', 'redo'
 */
function detectMessageType(messages) {
    // Separate system messages from conversation messages
    const convMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const convCount = convMsgs.length;

    // Hash the last user and assistant messages
    const userMsgs = convMsgs.filter(m => m.role === 'user');
    const assistantMsgs = convMsgs.filter(m => m.role === 'assistant');
    const currentUserHash = hashStr(userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : '');
    const currentAssistantHash = hashStr(assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : '');

    let type = 'new';

    // No previous request to compare against — must be first request
    if (lastUserMsgHash === null) {
        type = 'new';
    }
    // Same conversation length, same content as last request → Continue
    else if (convCount === lastConversationCount && currentUserHash === lastUserMsgHash && currentAssistantHash === lastAssistantHash) {
        type = 'continue';
    }
    // Same user message, different/missing assistant → Swipe
    else if (currentUserHash === lastUserMsgHash && currentAssistantHash !== lastAssistantHash) {
        type = 'swipe';
        currentSwipeIndex++;
    }
    // Conversation got shorter + user message changed → Redo (user edited a previous message)
    else if (convCount < lastConversationCount && currentUserHash !== lastUserMsgHash) {
        type = 'redo';
        currentSwipeIndex = 0;
    }
    // New user message → New turn
    else if (currentUserHash !== lastUserMsgHash) {
        type = 'new';
        currentSwipeIndex = 0;
    }

    // --- Update tracking state ---
    lastUserMsgHash = currentUserHash;
    lastAssistantMsgHash = currentAssistantHash;
    lastConversationCount = convCount;

    return type;
}

/**
 * Get or increment the message counter for the current chat.
 * Used as message_id in [SYSTEM_META].
 */
function getMessageId() {
    const counter = (context.chatMetadata?.[META_KEY_COUNTER] || 0);
    return counter;
}

async function incrementMessageId() {
    context.chatMetadata = context.chatMetadata || {};
    context.chatMetadata[META_KEY_COUNTER] = (context.chatMetadata[META_KEY_COUNTER] || 0) + 1;
    await context.saveMetadata();
    return context.chatMetadata[META_KEY_COUNTER];
}

// #############################################
// # 9. History Trimming
// #############################################

/**
 * Trim the messages array to the last N user/assistant messages.
 * System messages (character card, lorebook, prompts) are always preserved.
 */
function trimHistory(messages, maxConversationMessages) {
    if (maxConversationMessages === 0) return messages; // 0 = no trimming

    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');

    // Keep last N non-system messages
    const trimmed = convMsgs.slice(-maxConversationMessages);

    // Safety: always include the very last message (the current user input)
    if (convMsgs.length > 0 && trimmed.length > 0 && trimmed[trimmed.length - 1] !== convMsgs[convMsgs.length - 1]) {
        trimmed.push(convMsgs[convMsgs.length - 1]);
    }

    return [...systemMsgs, ...trimmed];
}

// #############################################
// # 10. [SYSTEM_META] Construction
// #############################################

/**
 * Build the [SYSTEM_META] tag with all per-request data.
 *
 * Format:
 * [SYSTEM_META] session_id=abc-123 message_id=5 type=new swipe_index=0
 */
function buildMetaTag(sessionId, messageId, type, swipeIndex) {
    return `[SYSTEM_META] session_id=${sessionId} message_id=${messageId} type=${type} swipe_index=${swipeIndex}`;
}

// #############################################
// # 11. Fetch Interception (Core Pipeline)
// #############################################

function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (url, options) {
        const settings = getSettings();

        // --- Pass through if extension is disabled ---
        if (!settings.enabled) {
            return originalFetch.call(window, url, options);
        }

        // --- Check if this is a chat completion request ---
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

        // --- This is a chat completion request. Begin processing. ---
        updateStatus('Processing request...', '#5bc0de');

        try {
            const urlString = (url instanceof Request) ? url.url : String(url);
            const backendUrl = resolveBackendUrl(urlString, settings);

            if (!backendUrl) {
                throw new Error('Could not determine Agent URL. Set Agent IP:Port in settings.');
            }

            // --- Ensure session exists ---
            const sessionId = await ensureSession(backendUrl);
            if (!sessionId) {
                throw new Error('Failed to acquire session ID.');
            }

            // --- Sync config to Agent on first request (if not already synced) ---
            if (!configSynced) {
                await syncConfigToAgent(settings);
            }

            // --- Detect message type ---
            const messageType = detectMessageType(bodyObject.messages);
            console.log(`[${EXTENSION_NAME}] Message type: ${messageType}, swipe_index: ${currentSwipeIndex}`);

            // --- Update message counter ---
            let messageId = getMessageId();
            if (messageType === 'new') {
                messageId = await incrementMessageId();
            }

            // --- Trim history ---
            bodyObject.messages = trimHistory(bodyObject.messages, settings.historyCount);

            // --- Build and inject [SYSTEM_META] tag ---
            const metaTag = buildMetaTag(sessionId, messageId, messageType, currentSwipeIndex);
            bodyObject.messages.unshift({
                role: 'system',
                content: metaTag,
            });

            // --- Build fetch options ---
            const newOptions = { ...options, body: JSON.stringify(bodyObject) };

            // --- Determine target URL ---
            // If agentUrl is set, redirect to Agent. Otherwise, send to original URL
            // (which should already be the Agent if ST is configured correctly).
            let targetUrl = url;
            if (settings.agentUrl && settings.agentUrl.length > 0) {
                // Reconstruct URL with Agent address, preserving path and query
                try {
                    const urlObj = new URL(urlString);
                    targetUrl = `http://${settings.agentUrl}${urlObj.pathname}${urlObj.search}`;
                } catch (e) {
                    targetUrl = `http://${settings.agentUrl}/v1/chat/completions`;
                }
            }

            console.log(`[${EXTENSION_NAME}] Injected [SYSTEM_META] → ${metaTag}`);
            console.log(`[${EXTENSION_NAME}] Messages trimmed to ${bodyObject.messages.length} (${settings.historyCount} conversation limit)`);
            console.log(`[${EXTENSION_NAME}] Forwarding to: ${targetUrl}`);

            updateStatus(`Active (${messageType})`, '#5cb85c');

            return originalFetch.call(window, targetUrl, newOptions);

        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Interception error:`, err);

            if (typeof toastr !== 'undefined') {
                toastr.error(
                    err.message || 'Check console (F12) for details.',
                    'Agent-StateSync Error'
                );
            }

            updateStatus('Error — check console', '#d9534f');

            // Pass through unmodified on failure
            return originalFetch.call(window, url, options);
        }
    };
}

// #############################################
// # 12. Chat Event Hooks
// #############################################

/**
 * Reset per-chat state when the user switches characters or opens a different chat.
 * SillyTavern fires various events; we hook into the chat-changed signal.
 */
function hookChatEvents() {
    // Reset detection state when a new chat is loaded
    const eventBus = context.eventBus;
    if (eventBus) {
        eventBus.on('chat-changed', () => {
            console.log(`[${EXTENSION_NAME}] Chat changed — resetting detection state.`);
            lastUserMsgHash = null;
            lastAssistantMsgHash = null;
            lastConversationCount = 0;
            currentSwipeIndex = 0;
            configSynced = false; // Re-sync config for new chat context
            // Trigger a fresh health check on chat change
            const settings = getSettings();
            if (settings.enabled) {
                startHealthChecks();
            }
        });
    }

    // Also reset when generating to catch edge cases
    const originalGenerate = context.generate;
    // (We don't override generate — the fetch interceptor handles everything.)
}

// #############################################
// # 13. Initialization
// #############################################

(async function init() {
    // Wait for SillyTavern to be ready
    while (!window.SillyTavern || !window.SillyTavern.getContext) {
        await new Promise(r => setTimeout(r, 100));
    }

    context = window.SillyTavern.getContext();

    // Migrate old settings format if needed
    if (context.extensionSettings[SETTINGS_KEY]) {
        const stored = context.extensionSettings[SETTINGS_KEY];
        // Rename manualOverride → agentUrl (backward compat)
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

    // Render UI, hook events, install interceptor
    renderSettingsUI();
    hookChatEvents();
    interceptFetch();

    console.log(`[${EXTENSION_NAME}] Extension loaded. Version 2.1`);
    console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
})();