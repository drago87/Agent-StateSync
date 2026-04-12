// src/index.js — Agent-StateSync SillyTavern Extension
// Intercepts chat completion requests, manages world-state sessions,
// trims history, and communicates with the FastAPI + LangGraph Agent.

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

const defaultSettings = {
    enabled: false,
    // agentUrl removed — ST's Custom Endpoint (Base URL) is now pointed
    // at the Agent directly. The extension auto-detects the Agent URL from
    // intercepted requests.
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

// Auto-detected Agent base URL (extracted from first intercepted request).
// Format: "192.168.0.1:8001" (no protocol, no path).
let _cachedAgentUrl = null;

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

/** Extract the base host:port from a full URL string. */
function extractBaseUrl(urlString) {
    try {
        const urlObj = new URL(urlString);
        const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
        return `${urlObj.hostname}:${port}`;
    } catch (e) {
        return null;
    }
}

/** Get the Agent base URL. Uses cached value from intercepted requests. */
function getAgentUrl() {
    return _cachedAgentUrl;
}

/**
 * Push LLM addresses + template config to the Agent so it knows
 * where to route requests without receiving them on every call.
 */
async function syncConfigToAgent(settings) {
    if (!settings.enabled) return;

    const backendUrl = getAgentUrl();
    if (!backendUrl) {
        console.warn(`[${EXTENSION_NAME}] Cannot sync config — Agent URL not detected yet. Will sync on first request.`);
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
// # 4. UI Rendering
// #############################################

function buildOptions(items, selectedValue) {
    return items.map(opt =>
        `<option value="${opt.value}" ${String(opt.value) === String(selectedValue) ? 'selected' : ''}>${opt.label}</option>`
    ).join('');
}

function renderSettingsUI() {
    const settingsHtml = `
    <div class="agent-statesync-extension">
        <hr class="sysHR">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Agent-StateSync</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- Enable Toggle + Connection Indicator -->
                <div class="flex-container alignitemscenter justifySpaceBetween margin-bot-10">
                    <label class="checkbox_label margin-0" for="ass-toggle">
                        <input type="checkbox" id="ass-toggle">
                        <span>Enable State Sync</span>
                    </label>
                    <div class="flex-container alignitemscenter" style="gap:10px;">
                        <span id="ass-agent-dot" class="fa-solid fa-circle" style="font-size:8px;color:var(--fg_dim);opacity:0.4;" title="Agent not connected"></span>
                        <button id="ass-test-connect" class="menu_button" style="padding:2px 10px;font-size:11px;" title="Test connection to Agent">
                            Test Connect
                        </button>
                    </div>
                </div>

                <small style="color:var(--fg_dim);margin-bottom:8px;display:block;">
                    Agent URL: <code id="ass-agent-url-display" style="font-size:11px;">auto-detecting...</code>
                    <br>Point SillyTavern's Custom Endpoint (Base URL) to the Agent.
                </small>

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

                <!-- Status -->
                <div class="margin-bot-10">
                    <small id="ass-status" style="color: var(--fg_dim);">
                        Status: Idle
                    </small>
                </div>

                <!-- Debug Exploration Panel -->
                <hr class="sysHR">
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <small><b>Debug: Context Explorer</b></small>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <p style="font-size:11px;color:var(--fg_dim);margin:0 0 8px;">
                            Buttons to explore SillyTavern's context object. Useful for understanding what data is available for group chats.
                        </p>
                        <div style="display:flex;flex-wrap:wrap;gap:6px;">
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-chatid">chatId</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-charid">characterId</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-names">name1/name2</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-groups">groups</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-groupid">groupId</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-chars">characters</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-chatmeta">chatMetadata</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-mainapi">mainApi</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-ccsettings">chatCompletion</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;" id="ass-dbg-events">eventTypes</button>
                            <button class="menu_button" style="padding:4px 10px;font-size:11px;background:rgba(248,81,73,0.15);color:#f85149;" id="ass-dbg-full">Full Context Dump</button>
                        </div>
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

    // --- Bind change handlers ---
    function onSettingChange() {
        const updated = getSettings();
        syncConfigToAgent(updated);
    }

    $('#ass-toggle').on('change', function () {
        const settings = getSettings();
        settings.enabled = $(this).prop('checked');
        saveSettings(settings);
        if (settings.enabled) onSettingChange();
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

    // --- Test Connect button ---
    $('#ass-test-connect').on('click', async function () {
        const btn = $(this);
        const originalText = btn.text();
        btn.text('Testing...').prop('disabled', true);

        const ok = await pingAgent();

        if (ok) {
            btn.text('Connected ✓').css('color', 'var(--success-color, #5cb85c)');
            updateStatus('Agent connected', '#5cb85c');
        } else {
            btn.text('Failed ✕').css('color', '#d9534f');
            updateStatus('Agent unreachable — ensure ST Custom Endpoint points to Agent', '#d9534f');
        }

        setTimeout(() => {
            btn.text(originalText).css('color', '').prop('disabled', false);
        }, 3000);
    });

    // --- Debug Explorer Buttons ---
    bindDebugButtons();
}

// #############################################
// # 4b. Debug Context Explorer
// #############################################

/**
 * Show a modal dialog with JSON-formatted data for debugging.
 */
function showDebugDialog(title, data) {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--bg1,#1a1a2e);border:1px solid var(--borderColor,#444);border-radius:12px;padding:20px;width:600px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;color:var(--fg,#ccc);';
    dialog.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h3 style="margin:0;font-size:14px;">${esc(title)}</h3>
            <button style="background:none;border:none;color:var(--fg,#ccc);cursor:pointer;font-size:16px;padding:4px 8px;" title="Close">✕</button>
        </div>
        <pre style="margin:0;padding:12px;background:rgba(0,0,0,0.3);border-radius:8px;overflow:auto;flex:1;font-size:12px;line-height:1.5;max-height:60vh;white-space:pre-wrap;word-break:break-all;">${esc(jsonStr)}</pre>
        <div style="margin-top:12px;text-align:right;">
            <button style="padding:6px 16px;background:rgba(255,255,255,0.1);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;cursor:pointer;font-size:12px;">Close</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    dialog.querySelector('button[title="Close"]').addEventListener('click', close);
    dialog.querySelector('div > button:last-child').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

/** Safe property reader — returns value or error string. */
function safeGet(fn) {
    try { return fn(); } catch (e) { return `<error: ${e.message}>`; }
}

/** Bind all debug explorer buttons. */
function bindDebugButtons() {
    // chatId
    $('#ass-dbg-chatid').on('click', () => {
        const data = {
            context_chatId: safeGet(() => context.chatId),
            getCurrentChatId: safeGet(() => typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : 'not a function'),
            type_chatId: safeGet(() => typeof context.chatId),
        };
        showDebugDialog('chatId', data);
    });

    // characterId
    $('#ass-dbg-charid').on('click', () => {
        const data = {
            characterId: safeGet(() => context.characterId),
            type: safeGet(() => typeof context.characterId),
            name1_persona: safeGet(() => context.name1),
            name2_character: safeGet(() => context.name2),
        };
        showDebugDialog('characterId / name1 / name2', data);
    });

    // groups
    $('#ass-dbg-groups').on('click', () => {
        const groups = safeGet(() => context.groups);
        if (Array.isArray(groups)) {
            // Summarize each group
            const summary = groups.map((g, i) => {
                const members = g.members || g.character_ids || [];
                return {
                    index: i,
                    id: g.id,
                    name: g.name || g.chat_id || '(unnamed)',
                    chat_id: g.chat_id || '(none)',
                    member_count: members.length,
                    members: members.slice(0, 10),
                };
            });
            showDebugDialog(`groups (${groups.length})`, summary);
        } else {
            showDebugDialog('groups', { value: groups, type: typeof groups });
        }
    });

    // groupId
    $('#ass-dbg-groupid').on('click', () => {
        const data = {
            groupId: safeGet(() => context.groupId),
            type: safeGet(() => typeof context.groupId),
            isGroup: safeGet(() => !!context.groupId && context.groupId !== false),
        };
        showDebugDialog('groupId', data);
    });

    // characters array
    $('#ass-dbg-chars').on('click', () => {
        const chars = safeGet(() => context.characters);
        if (Array.isArray(chars)) {
            const summary = chars.map((c, i) => ({
                index: i,
                name: c.name || '(unnamed)',
                avatar: c.avatar || '(none)',
                chat: c.chat || '(none)',
                is_group: !!c.is_group,
                is_user: !!c.is_user,
            }));
            showDebugDialog(`characters (${chars.length})`, summary);
        } else {
            showDebugDialog('characters', { value: chars, type: typeof chars });
        }
    });

    // chatMetadata
    $('#ass-dbg-chatmeta').on('click', () => {
        showDebugDialog('chatMetadata', safeGet(() => context.chatMetadata));
    });

    // mainApi
    $('#ass-dbg-mainapi').on('click', () => {
        const data = {
            mainApi: safeGet(() => context.mainApi),
            onlineStatus: safeGet(() => context.onlineStatus),
        };
        showDebugDialog('mainApi / onlineStatus', data);
    });

    // chatCompletionSettings
    $('#ass-dbg-ccsettings').on('click', () => {
        const oai = safeGet(() => context.chatCompletionSettings);
        if (oai && typeof oai === 'object') {
            // Only show the API URL and model, not the full object
            const summary = {
                custom_url: oai.custom_url || oai.chat_completion_source || '(not set)',
                model: oai.model || oai.openai_model || '(not set)',
                api_type: typeof oai.chat_completion_source !== 'undefined' ? oai.chat_completion_source : '(unknown)',
                all_keys: Object.keys(oai),
            };
            showDebugDialog('chatCompletionSettings (summary)', summary);
        } else {
            showDebugDialog('chatCompletionSettings', { value: oai, type: typeof oai });
        }
    });

    // eventTypes
    $('#ass-dbg-events').on('click', () => {
        const types = safeGet(() => context.eventTypes);
        showDebugDialog('eventTypes', types);
    });

    // Full Context Dump
    $('#ass-dbg-full').on('click', () => {
        const allKeys = Object.keys(context).sort();
        const dump = {};
        for (const key of allKeys) {
            const val = context[key];
            if (typeof val === 'function') {
                dump[key] = '[function]';
            } else if (Array.isArray(val)) {
                dump[key] = `[Array(${val.length})]`;
            } else if (val && typeof val === 'object') {
                dump[key] = `[Object: ${Object.keys(val).join(', ')}]`;
            } else {
                dump[key] = val;
            }
        }
        showDebugDialog(`Full Context (${allKeys.length} keys)`, dump);
    });
}

// #############################################
// # 5. Utility Functions
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
 * HTML-escape a string for safe injection into innerHTML.
 */
function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

/**
 * Update the "Agent URL" display in settings.
 */
function updateAgentUrlDisplay() {
    const el = document.getElementById('ass-agent-url-display');
    if (el) {
        el.textContent = _cachedAgentUrl || 'auto-detecting...';
    }
}

// #############################################
// # 5b. Agent Connectivity
// #############################################

/** Ping the Agent's /health endpoint and update the connection indicator dot.
 *  Also POSTs to /api/ping so the dashboard ST Extension light stays green. */
async function pingAgent() {
    const dot = document.getElementById('ass-agent-dot');
    const url = getAgentUrl();

    if (!url) {
        if (dot) {
            dot.style.color = 'var(--fg_dim)';
            dot.style.opacity = '0.4';
            dot.title = 'Agent URL not detected yet — send a message first';
        }
        return false;
    }

    try {
        const resp = await fetch(`http://${url}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
        });

        if (resp.ok) {
            if (dot) {
                dot.style.color = 'var(--success-color, #5cb85c)';
                dot.style.opacity = '1';
                dot.title = `Agent connected — v${(await resp.json()).version || '?'}`;
            }

            // Fire-and-forget heartbeat to light up dashboard ST Extension indicator
            fetch(`http://${url}/api/ping`, {
                method: 'POST',
                signal: AbortSignal.timeout(3000),
            }).catch(() => {});

            return true;
        } else {
            if (dot) {
                dot.style.color = '#f0ad4e';
                dot.style.opacity = '1';
                dot.title = `Agent responded with ${resp.status}`;
            }
            return false;
        }
    } catch (err) {
        if (dot) {
            dot.style.color = '#d9534f';
            dot.style.opacity = '1';
            dot.title = `Agent unreachable: ${err.message}`;
        }
        return false;
    }
}

/** Start the periodic 5-minute ping to keep the connection indicator fresh. */
function startAgentPingLoop() {
    // Initial ping after 5 seconds
    setTimeout(() => pingAgent(), 5000);

    // Then every 5 minutes
    setInterval(() => pingAgent(), 5 * 60 * 1000);
}

// #############################################
// # 6. Session Management
// #############################################

/**
 * Get the ST chat_id for the current chat.
 * Tries context.chatId first, then getCurrentChatId().
 */
function getStChatId() {
    try {
        if (context.chatId) return context.chatId;
    } catch (e) {}
    try {
        if (typeof context.getCurrentChatId === 'function') return context.getCurrentChatId();
    } catch (e) {}
    return null;
}

/**
 * Determine the Agent's IP:Port for the current request.
 * Since ST is pointed at the Agent, we extract from the request URL.
 */
function resolveBackendUrl(requestUrl, settings) {
    const url = extractBaseUrl(requestUrl);
    if (url) {
        // Cache for future use (ping, proactive checks)
        if (!_cachedAgentUrl) {
            _cachedAgentUrl = url;
            console.log(`[${EXTENSION_NAME}] Auto-detected Agent URL: ${url}`);
            updateAgentUrlDisplay();
        }
    }
    return url;
}

/**
 * Ensure a session_id exists for the current chat.
 * Creates one via POST /api/sessions if missing.
 * Also initializes the session with character data on first run.
 */
async function ensureSession(backendUrl) {
    // --- Check if session already exists ---
    if (context.chatMetadata && context.chatMetadata[META_KEY_SESSION]) {
        if (!context.chatMetadata[META_KEY_INITIALIZED]) {
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
 * Includes the ST chat_id so the Agent can map it to this session.
 */
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

        const charConfig = getCharConfig();
        const isMultiChar = (charDescription + charScenario).toLowerCase().includes('{{char}}') ||
                            (charDescription + charScenario).includes('character:');

        let trackedList = charConfig.tracked_characters
            ? charConfig.tracked_characters.split(',').map(s => s.trim()).filter(Boolean)
            : [];

        const stChatId = getStChatId();

        const initPayload = {
            character_name: charName,
            character_description: charDescription,
            character_personality: charPersonality,
            character_scenario: charScenario,
            character_first_mes: charFirstMes,
            character_mes_example: charMesExample,
            persona_name: personaName,
            persona_description: personaDescription,
            mode: charConfig.mode,
            multi_character: isMultiChar || trackedList.length > 0,
            tracked_characters: trackedList.length > 0 ? trackedList : '',
            st_chat_id: stChatId || '',
        };

        const resp = await fetch(`http://${backendUrl}/api/sessions/${sessionId}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initPayload),
        });

        if (resp.ok) {
            console.log(`[${EXTENSION_NAME}] Session ${sessionId} initialized. st_chat_id=${stChatId}`);
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
// # 6b. Proactive Chat-Changed Hook
// #############################################

/**
 * When the user switches chats or characters, proactively check
 * if the Agent already has a session for this chat. If not, prompt
 * the user to confirm sending character data.
 */
async function onChatChanged() {
    console.log(`[${EXTENSION_NAME}] Chat changed — checking Agent...`);

    const agentUrl = getAgentUrl();
    if (!agentUrl) {
        console.log(`[${EXTENSION_NAME}] No Agent URL cached yet — skipping proactive check.`);
        return;
    }

    // Reset message detection state
    lastUserMsgHash = null;
    lastAssistantMsgHash = null;
    lastConversationCount = 0;
    currentSwipeIndex = 0;
    configSynced = false;

    // Get the ST chat_id
    const stChatId = getStChatId();
    if (!stChatId) {
        console.log(`[${EXTENSION_NAME}] No ST chat_id available — skipping proactive check.`);
        return;
    }

    // Check if the Agent has a session for this chat
    try {
        const resp = await fetch(
            `http://${agentUrl}/api/sessions/by-chat?st_chat_id=${encodeURIComponent(stChatId)}`,
            { signal: AbortSignal.timeout(5000) }
        );

        if (!resp.ok) {
            console.warn(`[${EXTENSION_NAME}] /api/sessions/by-chat returned ${resp.status}`);
            return;
        }

        const data = await resp.json();

        if (data.found) {
            // Session exists — restore session_id in chatMetadata
            console.log(`[${EXTENSION_NAME}] Found existing session ${data.session_id} for chat ${stChatId}`);
            context.chatMetadata = context.chatMetadata || {};
            context.chatMetadata[META_KEY_SESSION] = data.session_id;

            // If the session was initialized, mark it
            if (data.initialized) {
                context.chatMetadata[META_KEY_INITIALIZED] = true;
            } else {
                context.chatMetadata[META_KEY_INITIALIZED] = false;
                // Try to initialize (Agent was down when first created)
                await initSession(agentUrl, data.session_id);
            }

            await context.saveMetadata();
            updateStatus(`Resumed session (${data.character_name || 'unknown'})`, '#5cb85c');
        } else {
            // No session — clear any stale session_id and prompt user
            console.log(`[${EXTENSION_NAME}] No session for chat ${stChatId}`);

            if (context.chatMetadata) {
                delete context.chatMetadata[META_KEY_SESSION];
                delete context.chatMetadata[META_KEY_INITIALIZED];
                delete context.chatMetadata[META_KEY_COUNTER];
                await context.saveMetadata();
            }

            // Ask user if they want to send character data to Agent
            await promptNewSession(agentUrl, stChatId);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Proactive session check failed:`, err.message);
    }
}

/**
 * Show a confirmation dialog asking the user if they want to
 * create a new Agent session for this chat.
 */
async function promptNewSession(agentUrl, stChatId) {
    const charName = context.name2 || context.character_name || 'Unknown';
    const settings = getSettings();

    if (!settings.enabled) return; // Don't prompt if extension is disabled

    // Use SillyTavern's callGenericPopup if available
    if (context.callGenericPopup) {
        const POPUP_TYPE = context.POPUP_TYPE?.CONFIRM;
        const POPUP_RESULT = context.POPUP_RESULT;

        try {
            const result = await context.callGenericPopup(
                `Send character data for <b>${esc(charName)}</b> to Agent-StateSync?`,
                POPUP_TYPE?.CONFIRM || 'confirm'
            );

            // ST returns POPUP_RESULT.ACCEPTED or POPUP_RESULT.CANCELLED (or true/false)
            if (result === (POPUP_RESULT?.ACCEPTED) || result === true || result === 1) {
                updateStatus('Creating session...', '#f0ad4e');
                await ensureSession(agentUrl);
            } else {
                updateStatus('Skipped session creation', '#f0ad4e');
            }
            return;
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] callGenericPopup failed, falling back to custom dialog:`, e.message);
        }
    }

    // Fallback: custom dialog if callGenericPopup is not available
    showNewSessionDialog(agentUrl, stChatId, charName);
}

/**
 * Custom dialog fallback for session creation prompt.
 */
function showNewSessionDialog(agentUrl, stChatId, charName) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--SmartThemeBlurTintColor, var(--bg1, #1a1a2e));' +
        'border:1px solid var(--borderColor, #444);border-radius:12px;padding:24px;width:400px;' +
        'color:var(--fg, #ccc);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);';

    dialog.innerHTML = `
        <h3 style="margin:0 0 14px 0;color:var(--fg, #fff);font-size:16px;">
            <i class="fa-solid fa-brain" style="color:var(--accent-color, #58a6ff);"></i>
            Agent-StateSync — New Chat Detected
        </h3>
        <p style="margin:0 0 20px 0;font-size:13px;line-height:1.5;color:var(--fg,#ccc);">
            No Agent session found for <b>${esc(charName)}</b>.<br>
            Send character data to the Agent for state tracking?
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="ass-new-sess-cancel" style="padding:8px 18px;background:rgba(255,255,255,0.06);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;cursor:pointer;font-size:13px;">Skip</button>
            <button id="ass-new-sess-ok" style="padding:8px 22px;background:var(--accent-color,#58a6ff);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">Send to Agent</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    dialog.querySelector('#ass-new-sess-cancel').addEventListener('click', () => {
        close();
        updateStatus('Skipped session creation', '#f0ad4e');
    });

    dialog.querySelector('#ass-new-sess-ok').addEventListener('click', async () => {
        close();
        updateStatus('Creating session...', '#f0ad4e');
        try {
            await ensureSession(agentUrl);
        } catch (e) {
            console.error(`[${EXTENSION_NAME}] Session creation failed:`, e);
            updateStatus('Session creation failed — check console', '#d9534f');
        }
    });
}

// #############################################
// # 7. Message Type Detection
// #############################################

/**
 * Detect the type of turn the user is performing by comparing
 * the current request's messages against the previous request.
 *
 * Returns one of: 'new', 'continue', 'swipe', 'redo'
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
    else if (convCount === lastConversationCount && currentUserHash === lastUserMsgHash && currentAssistantHash === lastAssistantMsgHash) {
        type = 'continue';
    }
    else if (currentUserHash === lastUserMsgHash && currentAssistantHash !== lastAssistantMsgHash) {
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
// # 8. History Trimming
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
// # 9. [SYSTEM_META] Construction
// #############################################

function buildMetaTag(sessionId, messageId, type, swipeIndex) {
    return `[SYSTEM_META] session_id=${sessionId} message_id=${messageId} type=${type} swipe_index=${swipeIndex}`;
}

// #############################################
// # 10. Fetch Interception (Core Pipeline)
// #############################################

function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (url, options) {
        const settings = getSettings();

        // Pass through if extension is disabled
        if (!settings.enabled) {
            return originalFetch.call(window, url, options);
        }

        // Cache the Agent URL from ANY request going to the Agent
        // (not just chat completions — ST also sends /v1/models, etc.)
        try {
            const urlString = (url instanceof Request) ? url.url : String(url);
            const base = extractBaseUrl(urlString);
            if (base && !_cachedAgentUrl) {
                _cachedAgentUrl = base;
                console.log(`[${EXTENSION_NAME}] Auto-detected Agent URL from non-chat request: ${base}`);
                updateAgentUrlDisplay();
                // Start ping loop now that we have the URL
                startAgentPingLoop();
            }
        } catch (e) {}

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
                throw new Error('Could not determine Agent URL. Ensure SillyTavern is pointed at the Agent.');
            }

            // Ensure session exists
            const sessionId = await ensureSession(backendUrl);
            if (!sessionId) {
                throw new Error('Failed to acquire session ID.');
            }

            // Sync config on first request
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

            // Build and inject [SYSTEM_META] tag
            const metaTag = buildMetaTag(sessionId, messageId, messageType, currentSwipeIndex);
            bodyObject.messages.unshift({
                role: 'system',
                content: metaTag,
            });

            // Build fetch options — send to the ORIGINAL URL
            // (which is already the Agent since ST is configured to point at it)
            const newOptions = { ...options, body: JSON.stringify(bodyObject) };

            console.log(`[${EXTENSION_NAME}] Injected [SYSTEM_META] → ${metaTag}`);
            console.log(`[${EXTENSION_NAME}] Messages trimmed to ${bodyObject.messages.length} (${settings.historyCount} conversation limit)`);
            console.log(`[${EXTENSION_NAME}] Forwarding to: ${urlString}`);

            updateStatus(`Active (${messageType})`, '#5cb85c');

            // Send to original URL (already the Agent)
            return originalFetch.call(window, url, newOptions);

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
// # 11. Chat Event Hooks
// #############################################

let _pingLoopStarted = false;

function hookChatEvents() {
    const eventBus = context.eventBus;
    if (eventBus) {
        eventBus.on('chat-changed', () => {
            console.log(`[${EXTENSION_NAME}] Chat changed — resetting detection state.`);
            onChatChanged();
        });
    }
}

// #############################################
// # 12. Character Management Panel Integration
// #############################################

const CHAR_META_MODE = 'ass_char_mode';
const CHAR_META_TRACKED = 'ass_char_tracked';

function getCharConfig() {
    const meta = context.chatMetadata || {};
    return {
        mode: meta[CHAR_META_MODE] || 'character',
        tracked_characters: meta[CHAR_META_TRACKED] || '',
    };
}

async function saveCharConfig(config) {
    context.chatMetadata = context.chatMetadata || {};
    context.chatMetadata[CHAR_META_MODE] = config.mode;
    context.chatMetadata[CHAR_META_TRACKED] = config.tracked_characters;
    await context.saveMetadata();
}

function setupCharMgmtButton() {
    const observer = new MutationObserver(() => {
        injectCharMgmtButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    injectCharMgmtButton();
}

function injectCharMgmtButton() {
    if (document.getElementById('ass-char-mgmt-btn')) return;

    const charPanel = document.getElementById('rm_ch_create_block');
    if (!charPanel) return;

    const buttonBar = charPanel.querySelector('.form_create_bottom_buttons_block');
    if (!buttonBar) return;

    const btn = document.createElement('div');
    btn.id = 'ass-char-mgmt-btn';
    btn.className = 'menu_button fa-solid fa-brain';
    btn.title = 'Agent-StateSync — Character Config';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCharMgmtDialog();
    });

    const deleteBtn = buttonBar.querySelector('#delete_character_button')
        || buttonBar.querySelector('[id*="delete"]')
        || buttonBar.querySelector('[title*="Delete" i], [title*="delete" i]');

    if (deleteBtn) {
        deleteBtn.parentElement.insertBefore(btn, deleteBtn);
        console.log(`[${EXTENSION_NAME}] Injected Character Management button (before Delete).`);
    } else {
        buttonBar.appendChild(btn);
        console.log(`[${EXTENSION_NAME}] Injected Character Management button (end of bar — Delete button not found).`);
    }
}

function openCharMgmtDialog() {
    const config = getCharConfig();
    const charName = context.name2 || context.character_name || 'Unknown';
    const charDesc = context.description || '';
    const charScenario = context.scenario || '';
    const isMultiChar = (charDesc + charScenario).toLowerCase().includes('{{char}}') ||
                        (charDesc + charScenario).includes('character:');
    const settings = getSettings();
    const sessionId = context.chatMetadata?.[META_KEY_SESSION];

    const overlay = document.createElement('div');
    overlay.id = 'ass-char-mgmt-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--SmartThemeBlurTintColor, var(--bg1, #1a1a2e));' +
        'border:1px solid var(--borderColor, #444);border-radius:12px;padding:24px;width:440px;' +
        'max-height:80vh;overflow-y:auto;color:var(--fg, #ccc);' +
        'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);';

    dialog.innerHTML = `
        <h3 style="margin:0 0 18px 0;color:var(--fg, #fff);font-size:17px;display:flex;align-items:center;gap:10px;">
            <i class="fa-solid fa-brain" style="color:var(--accent-color, #58a6ff);"></i>
            Agent-StateSync — Character Config
        </h3>

        <div style="margin-bottom:16px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid var(--borderColor, #444);">
            <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${esc(charName)}</div>
            ${isMultiChar ? '<span style="font-size:11px;color:var(--fgdim, #888);background:rgba(88,166,255,0.15);padding:2px 6px;border-radius:4px;">Multi-character card detected</span>' : '<span style="font-size:11px;color:var(--fgdim, #888);">Single character card</span>'}
            ${!settings.enabled ? '<div style="margin-top:6px;font-size:12px;color:#f0ad4e;">⚠ Agent-StateSync is currently disabled.</div>' : ''}
        </div>

        <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;">Extraction Mode</label>
            <select id="ass-mode-select" style="width:100%;padding:8px 10px;background:rgba(255,255,255,0.06);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;font-size:13px;">
                <option value="character" ${config.mode === 'character' ? 'selected' : ''}>Character — track character state</option>
                <option value="scenario" ${config.mode === 'scenario' ? 'selected' : ''}>Scenario — track world / scenario state</option>
            </select>
            <small style="color:var(--fgdim,#888);display:block;margin-top:4px;font-size:11px;">
                Character mode tracks health, appearance, location, relationships, etc.<br>
                Scenario mode tracks factions, plot, world details, events, discoveries.
            </small>
        </div>

        <div style="margin-bottom:16px;" id="ass-tracked-section">
            <label style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-weight:600;font-size:13px;">
                Tracked Characters
                <span style="font-weight:400;font-size:11px;color:var(--fgdim,#888);">Main char (${esc(charName)}) tracked automatically</span>
            </label>
            <div id="ass-tracked-list"></div>
            <button id="ass-add-char" type="button" style="margin-top:8px;padding:6px 14px;background:rgba(88,166,255,0.1);color:var(--accent-color,#58a6ff);border:1px dashed rgba(88,166,255,0.3);border-radius:6px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-plus" style="font-size:10px;"></i> Add Character
            </button>
            <small style="color:var(--fgdim,#888);display:block;margin-top:6px;font-size:11px;">
                Add additional characters to track. Each will get their own state entry.
            </small>
        </div>

        ${sessionId ? `
        <div style="margin-bottom:16px;padding:8px 10px;background:rgba(88,255,136,0.06);border:1px solid rgba(88,255,136,0.15);border-radius:6px;font-size:12px;color:var(--fgdim,#888);">
            <i class="fa-solid fa-link" style="color:#3fb950;"></i>
            Session: <code style="font-size:11px;">${sessionId.slice(0, 12)}...</code> —
            ${settings.enabled ? 'changes will sync to Agent immediately' : 'enable Agent-StateSync to sync'}
        </div>
        ` : `
        <div style="margin-bottom:16px;padding:8px 10px;background:rgba(248,81,73,0.06);border:1px solid rgba(248,81,73,0.15);border-radius:6px;font-size:12px;color:var(--fgdim,#888);">
            <i class="fa-solid fa-circle-exclamation" style="color:#f85149;"></i>
            No active session. Settings will be applied when you start chatting.
        </div>
        `}

        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
            <button id="ass-char-mgmt-cancel" style="padding:8px 18px;background:rgba(255,255,255,0.06);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>
            <button id="ass-char-mgmt-save" style="padding:8px 22px;background:var(--accent-color,#58a6ff);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">Save</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Dynamic tracked characters list
    const trackedListEl = document.getElementById('ass-tracked-list');
    const inputStyle = 'flex:1;padding:7px 10px;background:rgba(255,255,255,0.06);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;font-size:13px;box-sizing:border-box;outline:none;';
    const rmBtnStyle = 'width:30px;height:30px;flex-shrink:0;padding:0;background:rgba(248,81,73,0.1);color:#f85149;border:1px solid rgba(248,81,73,0.2);border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;transition:background 0.15s;';

    const existingChars = config.tracked_characters
        ? config.tracked_characters.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    function createTrackedRow(value = '') {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Character name';
        input.value = value;
        input.className = 'ass-tracked-input';
        input.style.cssText = inputStyle;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        removeBtn.title = 'Remove';
        removeBtn.style.cssText = rmBtnStyle;
        removeBtn.addEventListener('mouseenter', () => removeBtn.style.background = 'rgba(248,81,73,0.25)');
        removeBtn.addEventListener('mouseleave', () => removeBtn.style.background = 'rgba(248,81,73,0.1)');
        removeBtn.addEventListener('click', () => {
            row.remove();
            updateRemoveButtons();
        });

        row.appendChild(input);
        row.appendChild(removeBtn);
        return row;
    }

    function updateRemoveButtons() {
        const count = trackedListEl.querySelectorAll('.ass-tracked-input').length;
        trackedListEl.querySelectorAll('button[title="Remove"]').forEach(btn => {
            btn.style.opacity = count <= 1 ? '0.3' : '1';
            btn.style.pointerEvents = count <= 1 ? 'none' : 'auto';
        });
    }

    if (existingChars.length > 0) {
        existingChars.forEach(name => trackedListEl.appendChild(createTrackedRow(name)));
    } else {
        trackedListEl.appendChild(createTrackedRow());
    }
    updateRemoveButtons();

    document.getElementById('ass-add-char').addEventListener('click', () => {
        const row = createTrackedRow();
        trackedListEl.appendChild(row);
        updateRemoveButtons();
        row.querySelector('input').focus();
    });

    const modeSelect = document.getElementById('ass-mode-select');
    const trackedSection = document.getElementById('ass-tracked-section');
    function updateTrackedVisibility() {
        trackedSection.style.display = modeSelect.value === 'character' ? 'block' : 'none';
    }
    modeSelect.addEventListener('change', updateTrackedVisibility);
    updateTrackedVisibility();

    document.getElementById('ass-char-mgmt-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const escHandler = (e) => {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    document.getElementById('ass-char-mgmt-save').addEventListener('click', async () => {
        const newMode = document.getElementById('ass-mode-select').value;
        const trackedInputs = trackedListEl.querySelectorAll('.ass-tracked-input');
        const trackedNames = [];
        trackedInputs.forEach(input => {
            const name = input.value.trim();
            if (name) trackedNames.push(name);
        });
        const newTracked = trackedNames.join(', ');

        await saveCharConfig({ mode: newMode, tracked_characters: newTracked });
        console.log(`[${EXTENSION_NAME}] Character config saved: mode=${newMode}, tracked=[${trackedNames.length ? trackedNames.join(', ') : '(none)'}]`);

        const agentUrl = getAgentUrl();
        if (settings.enabled && sessionId && agentUrl) {
            try {
                const resp = await fetch(`http://${agentUrl}/api/sessions/${sessionId}/config`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: newMode, tracked_characters: newTracked }),
                });
                if (resp.ok) {
                    console.log(`[${EXTENSION_NAME}] Session config synced to Agent.`);
                }
            } catch (err) {
                console.warn(`[${EXTENSION_NAME}] Failed to sync config to Agent:`, err.message);
            }
        }

        if (typeof toastr !== 'undefined') {
            toastr.success('Character config saved.', 'Agent-StateSync');
        }

        overlay.remove();
    });
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

    // Initialize defaults if first run
    if (!context.extensionSettings[SETTINGS_KEY]) {
        context.extensionSettings[SETTINGS_KEY] = { ...defaultSettings };
        context.saveSettingsDebounced();
    }

    // Render UI, hook events, install interceptor
    renderSettingsUI();
    hookChatEvents();
    interceptFetch();
    setupCharMgmtButton();

    // Don't start ping loop here — it will start once we detect the Agent URL
    // from the first intercepted request (in interceptFetch).

    console.log(`[${EXTENSION_NAME}] Extension loaded. Version 2.2`);
    console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
    console.log(`[${EXTENSION_NAME}] Agent URL: auto-detect from ST Custom Endpoint`);
})();