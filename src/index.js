// src/index.js — Agent-StateSync SillyTavern Extension
// Intercepts chat completion requests, manages world-state sessions,
// trims history, and communicates with the FastAPI + LangGraph Agent.
//
// v2.7 — Phase 1: LLM status indicators now ask the Agent instead of
//          probing backends directly from the browser. This fixes "no URL set"
//          when URLs are configured in config.ini rather than the extension.

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
    { value: 0, label: '0 (send all - no trimming)' },
];

const HEALTH_CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
const HEALTH_CHECK_TIMEOUT_MS = 5000;   // 5 second timeout per check

const defaultSettings = {
    enabled: false,
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

// Group data (populated by loadGroupData)
let cachedGroups = null;           // All groups from /api/groups/all
let activeGroup = null;            // The currently active group object (with resolved members)
let activeGroupCharacters = [];    // Full Character objects for active group members
let isGroupChat = false;           // Whether the current chat is a group chat

// Proactive session tracking
let proactiveInProgress = false;   // Prevents overlapping proactive calls

// #############################################
// # 3. Agent URL Resolution (Auto-Detect)
// #############################################

/**
 * Resolve the Agent URL from SillyTavern's Custom Endpoint setting.
 * Falls back to parsing the request URL at interception time.
 * No manual override - the user configures the URL in ST's API connection panel.
 */
function getAgentOrigin() {
    try {
        const customUrl = context.chatCompletionSettings?.custom_url;
        if (customUrl) {
            const urlObj = new URL(customUrl);
            return urlObj.origin; // e.g. "http://localhost:8001"
        }
    } catch (e) {
        // ST setting not a valid URL or not set
    }
    return null;
}

/**
 * Get Agent origin, falling back to parsing a request URL.
 */
function resolveBackendOrigin(requestUrl) {
    const fromST = getAgentOrigin();
    if (fromST) return fromST;

    try {
        const urlObj = new URL(requestUrl);
        return urlObj.origin;
    } catch (e) {
        console.error(`[${EXTENSION_NAME}] Failed to parse URL:`, e);
        return null;
    }
}

/**
 * Resolve just the host:port string for display / health checks.
 */
function getAgentHostPort() {
    const origin = getAgentOrigin();
    if (!origin) return null;
    try {
        const urlObj = new URL(origin);
        const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
        return `${urlObj.hostname}:${port}`;
    } catch (e) {
        return null;
    }
}

// #############################################
// # 4. Settings Get/Save/Sync
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
 * Push LLM addresses + template config to the Agent.
 */
async function syncConfigToAgent(settings) {
    if (!settings.enabled) return;

    const origin = getAgentOrigin();
    if (!origin) {
        console.warn(`[${EXTENSION_NAME}] Cannot sync config - no Agent URL available yet. Will sync on first request.`);
        return;
    }

    const configPayload = {
        rp_template: settings.rpTemplate,
        instruct_template: settings.instructTemplate,
        thinking_steps: settings.thinkingSteps,
        refinement_steps: settings.refinementSteps,
    };

    // Only include URL fields if they have actual values.
    // The Agent uses config.ini fallbacks when URLs are not provided.
    if (settings.rpLlmUrl && settings.rpLlmUrl.trim()) {
        configPayload.rp_llm_url = settings.rpLlmUrl.trim();
    }
    if (settings.instructLlmUrl && settings.instructLlmUrl.trim()) {
        configPayload.instruct_llm_url = settings.instructLlmUrl.trim();
    }

    try {
        const resp = await fetch(`${origin}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configPayload),
        });

        if (resp.ok) {
            configSynced = true;
            console.log(`[${EXTENSION_NAME}] Config synced to Agent.`, Object.keys(configPayload));
        } else {
            console.warn(`[${EXTENSION_NAME}] Agent config sync returned ${resp.status}. Will retry.`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Agent config sync failed (Agent may not be running yet):`, err.message);
    }
}

// #############################################
// # 5. Connection Health Check
// #############################################

/**
 * Get the health check URL. Auto-detected from ST's Custom Endpoint.
 */
function getHealthCheckUrl() {
    const settings = getSettings();
    if (!settings.enabled) return null;

    const origin = getAgentOrigin();
    if (!origin) return null;

    return `${origin}/health`;
}

/**
 * Ping the Agent's /health endpoint.
 */
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
            setConnectionStatus(true, `Connected - ${sessionCount} session(s)`);

            // Also ping the dashboard so the ST Extension light stays green
            pingAgent(url);

            // Check LLM backend status (fire-and-forget, don't block health check)
            checkLlmStatuses();

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
 * Update the LLM status dots in the extension settings panel.
 * Asks the Agent to probe both backends (the Agent runs server-side
 * and has the actual URLs from config.ini — the browser may not be
 * able to reach the backends directly due to CORS or networking).
 */
async function checkLlmStatuses() {
    const origin = getAgentOrigin();
    if (!origin) return;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const resp = await fetch(`${origin}/api/dashboard/status`, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) return;
        const status = await resp.json();

        // RP LLM
        const rpDot = $('#ass-rp-dot');
        if (rpDot.length) {
            rpDot.removeClass('ass-llm-dot-green ass-llm-dot-red ass-llm-dot-off');
            if (status.rp_llm_disabled) {
                rpDot.addClass('ass-llm-dot-off');
                rpDot.attr('title', 'RP LLM: disabled (config.ini)');
            } else if (status.rp_llm_connected) {
                rpDot.addClass('ass-llm-dot-green');
                rpDot.attr('title', 'RP LLM: online (via Agent)');
            } else {
                rpDot.addClass('ass-llm-dot-red');
                rpDot.attr('title', 'RP LLM: offline (via Agent)');
            }
        }

        // Instruct LLM
        const instructDot = $('#ass-instruct-dot');
        if (instructDot.length) {
            instructDot.removeClass('ass-llm-dot-green ass-llm-dot-red ass-llm-dot-off');
            if (status.instruct_llm_disabled) {
                instructDot.addClass('ass-llm-dot-off');
                instructDot.attr('title', 'Instruct LLM: disabled (config.ini)');
            } else if (status.instruct_llm_connected) {
                instructDot.addClass('ass-llm-dot-green');
                instructDot.attr('title', 'Instruct LLM: online (via Agent)');
            } else {
                instructDot.addClass('ass-llm-dot-red');
                instructDot.attr('title', 'Instruct LLM: offline (via Agent)');
            }
        }
    } catch (e) {
        // Silent — will retry on next health check cycle
        console.debug(`[${EXTENSION_NAME}] LLM status check via Agent failed:`, e.message);
    }
}

/**
 * POST /api/ping - lights the "ST Extension" indicator on the dashboard.
 */
async function pingAgent(healthUrl) {
    const origin = getAgentOrigin();
    if (!origin) return;
    try {
        await fetch(`${origin}/api/ping`, { method: 'POST' });
    } catch (e) {
        // Silent - best-effort
    }
}

/**
 * Start the periodic health check loop.
 */
function startHealthChecks() {
    stopHealthChecks();
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
 */
function setConnectionStatus(connected, text) {
    agentConnected = connected;

    const dot = $('#ass-connection-dot');
    if (dot.length) {
        dot.removeClass('ass-dot-green ass-dot-red')
           .addClass(connected ? 'ass-dot-green' : 'ass-dot-red');
        dot.attr('title', text || (connected ? 'Connected' : 'Disconnected'));
    }
}

/**
 * Handle the Reconnect button click.
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
            setConnectionStatus(false, 'No Agent URL - set Custom Endpoint in ST');
            toastr.warning('Set a Custom Endpoint URL in SillyTavern\'s API connection settings.', 'Agent-StateSync');
            return;
        }

        const healthy = await checkAgentHealth();

        if (healthy) {
            configSynced = false;
            await syncConfigToAgent(settings);
            toastr.success('Reconnected to Agent!', 'Agent-StateSync');
        } else {
            toastr.error(
                'Could not reach the Agent. Make sure it\'s running and the Custom Endpoint URL is correct.',
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
// # 6. Group Data Loading
// #############################################

/**
 * Fetch all groups from ST's server API using proper auth headers.
 * ST's getGroups() uses POST /api/groups/all with getRequestHeaders().
 */
async function fetchGroupsFromServer() {
    let headers = {};
    if (typeof context.getRequestHeaders === 'function') {
        headers = context.getRequestHeaders({ omitContentType: true });
    }

    const resp = await fetch('/api/groups/all', {
        method: 'POST',
        headers: headers,
    });

    if (!resp.ok) {
        throw new Error(`POST /api/groups/all returned ${resp.status}`);
    }

    const data = await resp.json();
    return Array.isArray(data) ? data : [];
}

/**
 * Find the currently active group by matching chat_id against
 * the current chat ID from ST's context.
 */
function findActiveGroup(groups) {
    const currentChatId = typeof context.getCurrentChatId === 'function'
        ? context.getCurrentChatId()
        : null;

    if (!currentChatId || !groups) return null;

    // Direct match on chat_id
    for (const group of groups) {
        if (group.chat_id === currentChatId || group.id === currentChatId) {
            return group;
        }
    }

    // Also check if currentChatId is in the group's chats array
    for (const group of groups) {
        if (Array.isArray(group.chats) && group.chats.includes(currentChatId)) {
            return group;
        }
    }

    return null;
}

/**
 * Resolve group member avatar strings to full Character objects.
 * ST stores group members as avatar filenames (e.g. "Belle.png").
 * We match them against context.characters[].avatar.
 */
function resolveGroupMemberCharacters(group) {
    if (!group || !Array.isArray(group.members)) return [];

    const allChars = context.characters || [];
    const resolved = [];

    for (const memberAvatar of group.members) {
        const char = allChars.find(c => c.avatar === memberAvatar);
        if (char) {
            resolved.push(char);
        } else {
            // Fallback: try matching by name
            const charByName = allChars.find(c => c.name === memberAvatar);
            if (charByName) {
                resolved.push(charByName);
            } else {
                resolved.push({
                    avatar: memberAvatar,
                    name: memberAvatar.replace(/\.[^.]+$/, ''),
                    _unresolved: true,
                });
            }
        }
    }

    return resolved;
}

/**
 * Main function: Load group data from ST's server, find active group,
 * resolve member characters, and cache everything for the interceptor.
 */
async function loadGroupData() {
    cachedGroups = null;
    activeGroup = null;
    activeGroupCharacters = [];
    isGroupChat = false;

    const groups = await fetchGroupsFromServer();
    cachedGroups = groups;

    console.log(`[${EXTENSION_NAME}] Loaded ${groups.length} groups from server`);

    const found = findActiveGroup(groups);

    if (found) {
        activeGroup = found;
        isGroupChat = true;
        activeGroupCharacters = resolveGroupMemberCharacters(found);

        console.log(`[${EXTENSION_NAME}] Active group: "${found.name}" (id=${found.id}, chat_id=${found.chat_id})`);
        console.log(`[${EXTENSION_NAME}] Members (${activeGroupCharacters.length}):`,
            activeGroupCharacters.map(c => c.name || c.avatar).join(', ')
        );

        // Try to unshallow group members for full card data
        if (typeof context.unshallowGroupMembers === 'function' && found.id) {
            try {
                await context.unshallowGroupMembers(found.id);
                console.log(`[${EXTENSION_NAME}] Called unshallowGroupMembers(${found.id})`);
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] unshallowGroupMembers failed:`, e.message);
            }
        }
    } else {
        console.log(`[${EXTENSION_NAME}] No active group found for current chat. Single-character mode.`);
    }

    return {
        groups: groups,
        activeGroup: activeGroup,
        members: activeGroupCharacters,
        isGroupChat: isGroupChat,
    };
}

// #############################################
// # 7. Character Config Button (Action Bar)
// #############################################

/**
 * Inject a "Char Config" button into SillyTavern's action button bar,
 * just before the Delete button.
 * Pings Agent config endpoint with current character's data.
 */
function injectCharConfigButton() {
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
                configSynced = true;
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
// # 8. UI Rendering
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

    // --- Start health checks if extension is already enabled ---
    if (s.enabled) {
        startHealthChecks();
    }
}

/**
 * Refresh the read-only Agent URL display.
 */
function refreshAgentUrlDisplay() {
    const $text = $('#ass-url-text');
    if (!$text.length) return;

    const origin = getAgentOrigin();
    if (origin) {
        $text.text(origin);
    } else {
        $text.text('Not detected - set Custom Endpoint in ST');
        $text.css('color', '#d9534f');
    }
}

// #############################################
// # 9. Utility Functions
// #############################################

/**
 * Simple string hash for comparing message content across requests.
 */
function hashStr(str) {
    let hash = 0;
    const s = str || '';
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash = hash & hash;
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
// # 10. Proactive Chat-Changed Hook (Phase 1)
// #############################################

/**
 * Called when SillyTavern fires the 'chat-changed' event.
 * Proactively looks up or creates an Agent session for the new chat.
 *
 * Flow:
 * 1. Reset detection state + group cache
 * 2. Load group data for new chat
 * 3. Look up existing session via GET /api/sessions/by-chat?st_chat_id=<chatId>
 * 4. If session found -> re-initialize with current character/group data
 * 5. If no session -> show confirmation popup -> create new session
 */
async function proactiveChatChanged() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const origin = getAgentOrigin();
    if (!origin) {
        console.log(`[${EXTENSION_NAME}] Chat changed but no Agent URL - will set up on first request`);
        return;
    }

    if (proactiveInProgress) {
        console.log(`[${EXTENSION_NAME}] Proactive chat-changed already in progress, skipping`);
        return;
    }
    proactiveInProgress = true;

    try {
        // Step 1: Load group data for the new chat
        updateStatus('Loading chat data...', '#5bc0de');
        try {
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Group data load failed (single-char fallback):`, e.message);
        }

        const chatId = typeof context.getCurrentChatId === 'function'
            ? context.getCurrentChatId()
            : null;

        if (!chatId) {
            // ST may not have the chat ID ready immediately after a
            // chat-changed event.  Retry a few times with a short delay
            // before giving up.
            console.log(`[${EXTENSION_NAME}] No chat ID yet, retrying...`);
            for (let attempt = 1; attempt <= 3; attempt++) {
                await new Promise(r => setTimeout(r, 1000));
                const retryId = typeof context.getCurrentChatId === 'function'
                    ? context.getCurrentChatId()
                    : null;
                if (retryId) {
                    console.log(`[${EXTENSION_NAME}] Got chat ID on retry ${attempt}: ${retryId}`);
                    return proactiveChatChangedWithId(origin, retryId);
                }
            }
            console.log(`[${EXTENSION_NAME}] No chat ID after retries - skipping proactive setup`);
            updateStatus('No chat ID', '#f0ad4e');
            return;
        }

        return proactiveChatChangedWithId(origin, chatId);

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive chat-changed error:`, err);
        updateStatus('Chat setup failed', '#d9534f');
    } finally {
        proactiveInProgress = false;
    }
}

/**
 * Continue proactive session setup now that we have a valid chatId.
 */
async function proactiveChatChangedWithId(origin, chatId) {
    try {
        // Pre-flight: check if Agent is reachable before doing anything.
        // If the Agent isn't up yet, the lazy fallback (ensureSession in
        // the fetch interceptor) will handle session creation later.
        try {
            const healthResp = await fetch(`${origin}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            });
            if (!healthResp.ok) throw new Error(`Agent returned ${healthResp.status}`);
        } catch (e) {
            console.log(`[${EXTENSION_NAME}] Agent not reachable yet, deferring session setup to first request`);
            updateStatus('Waiting for Agent...', '#f0ad4e');
            return;
        }

        // Step 2: Check if local metadata already has a session for this chat
        const existingSessionId = context.chatMetadata?.[META_KEY_SESSION];

        // Step 3: Ask the Agent if it has a session for this ST chat ID
        let agentSessionId = null;
        try {
            const resp = await fetch(
                `${origin}/api/sessions/by-chat?st_chat_id=${encodeURIComponent(chatId)}`
            );

            if (resp.ok) {
                const data = await resp.json();
                agentSessionId = data.session_id || null;
                console.log(`[${EXTENSION_NAME}] Agent session lookup for chat "${chatId}": ${agentSessionId || 'none'}`);
            } else {
                console.warn(`[${EXTENSION_NAME}] Session lookup returned ${resp.status} (Agent may not support it yet)`);
            }
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Session lookup failed:`, e.message);
        }

        // Step 4: Determine what to do
        if (agentSessionId) {
            // Agent has a session for this chat - switch to it
            await attachToExistingSession(origin, agentSessionId);
        } else if (existingSessionId) {
            // Local metadata has a session but Agent doesn't know about this chat ID
            // This can happen if the Agent DB was reset. Re-link it.
            try {
                await fetch(`${origin}/api/sessions/${existingSessionId}/link-chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ st_chat_id: chatId }),
                });
                console.log(`[${EXTENSION_NAME}] Re-linked session ${existingSessionId} to chat ${chatId}`);
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] Failed to re-link session:`, e.message);
            }
            // Re-init with current character data
            await initSession(origin, existingSessionId);
            updateStatus(`Session ${existingSessionId.substring(0, 8)}...`, '#5cb85c');
        } else {
            // No session anywhere - ask user if they want to create one
            await showNewChatConfirm(origin, chatId);
        }

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive chat-changed error:`, err);
        updateStatus('Chat setup failed', '#d9534f');
    } finally {
        proactiveInProgress = false;
    }
}

/**
 * Attach to an existing Agent session found by ST chat ID.
 * Updates local metadata and re-initializes with character/group data.
 */
async function attachToExistingSession(origin, sessionId) {
    console.log(`[${EXTENSION_NAME}] Attaching to existing session: ${sessionId}`);
    updateStatus('Reconnecting session...', '#f0ad4e');

    try {
        // Update local metadata to point to this session
        context.chatMetadata = context.chatMetadata || {};
        context.chatMetadata[META_KEY_SESSION] = sessionId;
        context.chatMetadata[META_KEY_INITIALIZED] = false;
        await context.saveMetadata();

        // Re-initialize with current character/group data
        await initSession(origin, sessionId);

        // Sync config
        configSynced = false;
        await syncConfigToAgent(getSettings());

        const shortId = sessionId.substring(0, 8);
        const chatLabel = isGroupChat && activeGroup
            ? `Group "${activeGroup.name}"`
            : `"${context.name2 || 'Unknown'}"`;
        toastr.success(`Resumed session (${shortId}...) for ${chatLabel}`, 'Agent-StateSync');
        updateStatus(`Session ${shortId}...`, '#5cb85c');
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Session attach failed:`, err);
        toastr.error(`Session attach failed: ${err.message}`, 'Agent-StateSync');
        updateStatus('Session attach failed', '#d9534f');
    }
}

/**
 * Show a confirmation popup asking the user to create a new Agent session
 * for the current chat.
 */
async function showNewChatConfirm(origin, chatId) {
    const chatLabel = isGroupChat && activeGroup
        ? `Group "${activeGroup.name}" (${activeGroupCharacters.length} members)`
        : `Character "${context.name2 || 'Unknown'}"`;

    const popupHtml = `
        <div style="text-align:center; padding:8px 0;">
            <h3 style="margin:0 0 8px 0;">
                <i class="fa-solid fa-plug" style="color:#5bc0de;"></i>
                Agent-StateSync
            </h3>
            <p style="margin:0 0 4px 0;"><b>New chat detected:</b></p>
            <p style="margin:0 0 12px 0; color:var(--fg_dim);">${chatLabel}</p>
            <p style="margin:0 0 4px 0;">Create a new Agent session for this chat?</p>
            <p style="margin:0 0 12px 0; font-size:11px; color:var(--fg_dim);">
                The Agent will initialize with this chat's character/group data.
            </p>
        </div>
    `;

    // Use ST's built-in callPopup if available
    const popupFn = window.callPopup || context.callPopup;
    if (typeof popupFn === 'function') {
        try {
            const confirmed = await popupFn(popupHtml, 'confirm');
            if (confirmed) {
                await createAndInitSession(origin, chatId);
            } else {
                updateStatus('No session (skipped)', '#f0ad4e');
                console.log(`[${EXTENSION_NAME}] User declined session creation for chat ${chatId}`);
            }
            return;
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] callPopup failed, trying fallback:`, e.message);
        }
    }

    // Fallback: auto-create without confirmation
    console.log(`[${EXTENSION_NAME}] No popup available, auto-creating session`);
    await createAndInitSession(origin, chatId);
}

/**
 * Create a new Agent session linked to the current ST chat ID,
 * then initialize it with character/group data.
 */
async function createAndInitSession(origin, chatId) {
    try {
        updateStatus('Creating session...', '#f0ad4e');

        const resp = await fetch(`${origin}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ st_chat_id: chatId }),
        });

        if (!resp.ok) throw new Error(`Session API returned ${resp.status}`);

        const data = await resp.json();
        if (!data.session_id) throw new Error('Invalid session response');

        const sessionId = data.session_id;
        console.log(`[${EXTENSION_NAME}] Created session ${sessionId} for chat ${chatId}`);

        // Save to metadata
        context.chatMetadata = context.chatMetadata || {};
        context.chatMetadata[META_KEY_SESSION] = sessionId;
        context.chatMetadata[META_KEY_COUNTER] = 0;
        await context.saveMetadata();

        // Initialize with character/group data
        await initSession(origin, sessionId);

        // Sync config
        configSynced = false;
        await syncConfigToAgent(getSettings());

        const shortId = sessionId.substring(0, 8);
        toastr.success(`Session created: ${shortId}...`, 'Agent-StateSync');
        updateStatus(`Session ${shortId}...`, '#5cb85c');
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive session creation failed:`, err);
        toastr.error(`Session creation failed: ${err.message}`, 'Agent-StateSync');
        updateStatus('Session creation failed', '#d9534f');
    }
}

// #############################################
// # 11. Session Management
// #############################################

/**
 * Ensure a session_id exists for the current chat.
 * Used as fallback by the fetch interceptor if proactive setup didn't run.
 * Creates one via POST /api/sessions if missing.
 */
async function ensureSession(backendOrigin) {
    // --- Ensure group data is loaded before doing anything ---
    // If proactive didn't run (or hasn't finished yet), we need group
    // info so initSession() can decide between group vs single-char mode.
    if (!cachedGroups && !isGroupChat) {
        try {
            console.log(`[${EXTENSION_NAME}] ensureSession: loading group data (proactive may have missed it)`);
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] ensureSession: group data load failed, single-char fallback`, e.message);
        }
    }

    // --- Check if session already exists in metadata ---
    if (context.chatMetadata && context.chatMetadata[META_KEY_SESSION]) {
        if (!context.chatMetadata[META_KEY_INITIALIZED]) {
            await initSession(backendOrigin, context.chatMetadata[META_KEY_SESSION]);
        }
        return context.chatMetadata[META_KEY_SESSION];
    }

    // --- Create new session (fallback - proactive should handle this) ---
    console.log(`[${EXTENSION_NAME}] No session ID (proactive missed). Creating session...`);
    try {
        const chatId = typeof context.getCurrentChatId === 'function'
            ? context.getCurrentChatId()
            : null;

        const resp = await fetch(`${backendOrigin}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ st_chat_id: chatId || '' }),
        });

        if (!resp.ok) throw new Error(`Session API returned ${resp.status}`);

        const data = await resp.json();
        if (!data.session_id) throw new Error('Invalid session response');

        const sessionId = data.session_id;
        console.log(`[${EXTENSION_NAME}] Fallback session created: ${sessionId}`);

        context.chatMetadata = context.chatMetadata || {};
        context.chatMetadata[META_KEY_SESSION] = sessionId;
        context.chatMetadata[META_KEY_COUNTER] = 0;
        await context.saveMetadata();

        await initSession(backendOrigin, sessionId);

        return sessionId;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Fallback session creation failed:`, err);
        throw err;
    }
}

/**
 * Send character card + persona data to the Agent for initial world-state parsing.
 * In group mode, sends all group members instead of a single character.
 */
async function initSession(backendOrigin, sessionId) {
    console.log(`[${EXTENSION_NAME}] Initializing session ${sessionId} with character data...`);
    updateStatus('Initializing session...', '#f0ad4e');

    try {
        let initPayload;

        if (isGroupChat && activeGroupCharacters.length > 0) {
            // Group mode: send all member character cards
            const members = activeGroupCharacters
                .filter(c => !c._unresolved)
                .map(c => ({
                    name: c.name,
                    description: c.description || '',
                    personality: c.personality || '',
                    scenario: c.scenario || '',
                    first_mes: c.first_mes || '',
                    mes_example: c.mes_example || '',
                }));

            initPayload = {
                group_name: activeGroup.name,
                group_members: members,
                persona_name: context.name1 || '',
                persona_description: context.personaDescription || '',
                is_group: true,
            };

            console.log(`[${EXTENSION_NAME}] Group init: "${activeGroup.name}" with ${members.length} members`);
        } else {
            // Single character mode
            initPayload = {
                character_name: context.name2 || '',
                character_description: context.description || '',
                character_personality: context.personality || '',
                character_scenario: context.scenario || '',
                character_first_mes: context.first_mes || '',
                character_mes_example: context.mes_example || '',
                persona_name: context.name1 || '',
                persona_description: context.personaDescription || '',
                is_group: false,
            };
        }

        const resp = await fetch(`${backendOrigin}/api/sessions/${sessionId}/init`, {
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
// # 12. Message Type Detection
// #############################################

/**
 * Detect the type of turn: 'new', 'continue', 'swipe', 'redo'
 */
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
    }
    else if (convCount === lastConversationCount && currentUserHash === lastUserMsgHash && currentAssistantHash === lastAssistantHash) {
        type = 'continue';
    }
    else if (currentUserHash === lastUserMsgHash && currentAssistantHash !== lastAssistantHash) {
        type = 'swipe';
        currentSwipeIndex++;
    }
    else if (convCount < lastConversationCount && currentUserHash !== lastUserMsgHash) {
        type = 'redo';
        currentSwipeIndex = 0;
    }
    else if (currentUserHash !== lastUserMsgHash) {
        type = 'new';
        currentSwipeIndex = 0;
    }

    lastUserMsgHash = currentUserHash;
    lastAssistantMsgHash = currentAssistantHash;
    lastConversationCount = convCount;

    return type;
}

/**
 * Get or increment the message counter.
 */
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
// # 13. History Trimming
// #############################################

/**
 * Trim the messages array to the last N user/assistant messages.
 * System messages are always preserved.
 */
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
// # 14. [SYSTEM_META] Construction
// #############################################

/**
 * Build the [SYSTEM_META] tag with all per-request data.
 * In group mode, includes group_id and member names.
 */
function buildMetaTag(sessionId, messageId, type, swipeIndex) {
    let tag = `[SYSTEM_META] session_id=${sessionId} message_id=${messageId} type=${type} swipe_index=${swipeIndex}`;

    if (isGroupChat && activeGroup) {
        tag += ` group_id=${activeGroup.id} group_name=${activeGroup.name}`;

        // Include member names for the Agent to know who is in the scene
        const memberNames = activeGroupCharacters
            .filter(c => !c._unresolved)
            .map(c => c.name)
            .join(',');
        if (memberNames) {
            tag += ` members=${memberNames}`;
        }

        // Include disabled members so Agent knows who is muted
        if (Array.isArray(activeGroup.disabled_members) && activeGroup.disabled_members.length > 0) {
            const disabledNames = activeGroup.disabled_members
                .map(avatar => {
                    const char = activeGroupCharacters.find(c => c.avatar === avatar);
                    return char ? char.name : avatar;
                })
                .filter(n => n)
                .join(',');
            if (disabledNames) {
                tag += ` disabled_members=${disabledNames}`;
            }
        }
    }

    return tag;
}

// #############################################
// # 15. Fetch Interception (Core Pipeline)
// #############################################

function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (url, options) {
        const settings = getSettings();

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

        updateStatus('Processing request...', '#5bc0de');

        try {
            const urlString = (url instanceof Request) ? url.url : String(url);
            const backendOrigin = resolveBackendOrigin(urlString);

            if (!backendOrigin) {
                throw new Error('Could not determine Agent URL. Set Custom Endpoint in ST.');
            }

            // --- Load group data if not cached yet (lazy load on first request) ---
            if (cachedGroups === null) {
                try {
                    await loadGroupData();
                } catch (e) {
                    console.warn(`[${EXTENSION_NAME}] Group data load failed (continuing in single-char mode):`, e.message);
                }
            }

            // --- Ensure session exists (fallback if proactive didn't run) ---
            const sessionId = await ensureSession(backendOrigin);
            if (!sessionId) {
                throw new Error('Failed to acquire session ID.');
            }

            // --- Sync config on first request ---
            if (!configSynced) {
                await syncConfigToAgent(settings);
            }

            // --- Detect message type ---
            const messageType = detectMessageType(bodyObject.messages);
            console.log(`[${EXTENSION_NAME}] Message type: ${messageType}, swipe_index: ${currentSwipeIndex}`);
            console.log(`[${EXTENSION_NAME}] Group mode: ${isGroupChat}${isGroupChat && activeGroup ? ' ("' + activeGroup.name + '")' : ''}`);

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

            // --- Forward to Agent ---
            let targetUrl = url;
            const stOrigin = getAgentOrigin();
            if (stOrigin) {
                try {
                    const urlObj = new URL(urlString);
                    targetUrl = `${stOrigin}${urlObj.pathname}${urlObj.search}`;
                } catch (e) {
                    targetUrl = `${stOrigin}/v1/chat/completions`;
                }
            }

            console.log(`[${EXTENSION_NAME}] Injected [SYSTEM_META] -> ${metaTag}`);
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

            updateStatus('Error - check console', '#d9534f');

            return originalFetch.call(window, url, options);
        }
    };
}

// #############################################
// # 16. Chat Event Hooks
// #############################################

function hookChatEvents() {
    const eventBus = context.eventBus;
    if (eventBus) {
        eventBus.on('chat-changed', () => {
            console.log(`[${EXTENSION_NAME}] Chat changed - proactive session setup`);
            lastUserMsgHash = null;
            lastAssistantMsgHash = null;
            lastConversationCount = 0;
            currentSwipeIndex = 0;
            configSynced = false;

            // Reset group cache so it reloads for the new chat
            cachedGroups = null;
            activeGroup = null;
            activeGroupCharacters = [];
            isGroupChat = false;

            // Refresh the Agent URL display
            refreshAgentUrlDisplay();

            const settings = getSettings();
            if (settings.enabled) {
                startHealthChecks();
                // Proactive session setup for the new chat
                proactiveChatChanged();
            }
        });
    }
}

// #############################################
// # 17. Initialization
// #############################################

(async function init() {
    // Wait for SillyTavern to be ready
    while (!window.SillyTavern || !window.SillyTavern.getContext) {
        await new Promise(r => setTimeout(r, 100));
    }

    context = window.SillyTavern.getContext();

    // Migrate old settings format (remove agentUrl if present)
    if (context.extensionSettings[SETTINGS_KEY]) {
        const stored = context.extensionSettings[SETTINGS_KEY];
        if (stored.agentUrl !== undefined) {
            delete stored.agentUrl;
            console.log(`[${EXTENSION_NAME}] Removed deprecated agentUrl setting (now auto-detected).`);
        }
        if (stored.manualOverride !== undefined) {
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

    // Inject Char Config button into action bar
    injectCharConfigButton();

    console.log(`[${EXTENSION_NAME}] Extension loaded. Version 2.6`);
    console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
    console.log(`[${EXTENSION_NAME}] Agent URL (auto-detected):`, getAgentOrigin());

    // --- Initial proactive session setup (for the chat that's open on page load) ---
    const settings = getSettings();
    if (settings.enabled) {
        // Small delay to let ST finish loading the initial chat
        setTimeout(async () => {
            try {
                await proactiveChatChanged();
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] Initial proactive setup failed:`, e.message);
            }
        }, 2000);
    }
})();