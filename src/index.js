// src/index.js — Agent-StateSync SillyTavern Extension
// Intercepts chat completion requests, manages world-state sessions,
// trims history, and communicates with the FastAPI + LangGraph Agent.
//
// v2.4 — Group chat deep exploration: ST server API (/api/groups), character scanning,
//          page URL/DOM analysis, safe value summarization, async debug tests.

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
// # 3. Agent URL Resolution (Auto-Detect)
// #############################################

/**
 * Resolve the Agent URL from SillyTavern's Custom Endpoint setting.
 * Falls back to parsing the request URL at interception time.
 * No manual override — the user configures the URL in ST's API connection panel.
 */
function getAgentOrigin() {
    // 1. Read from ST's Custom Endpoint URL
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

    // Fallback: extract from the request URL
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
        const resp = await fetch(`${origin}/api/config`, {
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
            setConnectionStatus(true, `Connected — ${sessionCount} session(s)`);

            // Also ping the dashboard so the ST Extension light stays green
            pingAgent(url);

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
 * POST /api/ping — lights the "ST Extension" indicator on the dashboard.
 */
async function pingAgent(healthUrl) {
    const origin = getAgentOrigin();
    if (!origin) return;
    try {
        await fetch(`${origin}/api/ping`, { method: 'POST' });
    } catch (e) {
        // Silent — best-effort
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
            setConnectionStatus(false, 'No Agent URL — set Custom Endpoint in ST');
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
// # 6. Debug Panel — Context API Exploration
// #############################################

/**
 * Build the debug panel HTML with exploration buttons.
 */
function buildDebugPanelHTML() {
    return `
    <div class="ass-debug-panel" style="border:1px solid rgba(255,255,0,0.3); border-radius:6px; padding:8px; margin-top:8px; background:rgba(0,0,0,0.15);">
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
            <i class="fa-solid fa-bug" style="color:#f0ad4e;"></i>
            <small><b>Debug Panel — Context API Explorer</b></small>
        </div>
        <!-- Row 1: Basics -->
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
            <button class="ass-dbg-btn menu_button" data-test="chatId">Chat ID</button>
            <button class="ass-dbg-btn menu_button" data-test="names">name1/name2</button>
            <button class="ass-dbg-btn menu_button" data-test="chatMetadata">Chat Metadata</button>
            <button class="ass-dbg-btn menu_button" data-test="mainApi">mainApi</button>
            <button class="ass-dbg-btn menu_button" data-test="chatCompletion">chatCompletion</button>
        </div>
        <!-- Row 2: Group Chat (the important row) -->
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
            <button class="ass-dbg-btn menu_button" data-test="stApiGroups" style="border-color:rgba(255,165,0,0.5);" title="Fetch groups from ST's server API">ST API: /api/groups</button>
            <button class="ass-dbg-btn menu_button" data-test="scanCharsForGroups" title="Search all 64 chars for is_group=true">Scan Chars for Groups</button>
            <button class="ass-dbg-btn menu_button" data-test="pageUrlInfo">Page URL</button>
            <button class="ass-dbg-btn menu_button" data-test="groupScan">Group Scan (old)</button>
            <button class="ass-dbg-btn menu_button" data-test="groupFunctions">Group Functions</button>
        </div>
        <!-- Row 3: Advanced -->
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
            <button class="ass-dbg-btn menu_button" data-test="contextChat">context.chat (msgs)</button>
            <button class="ass-dbg-btn menu_button" data-test="characters">Characters (64)</button>
            <button class="ass-dbg-btn menu_button" data-test="eventTypes">Event Types</button>
            <button class="ass-dbg-btn menu_button" data-test="fullDump" style="border-color:rgba(217,83,79,0.5);">Full Dump (F12)</button>
        </div>
        <div id="ass-dbg-output" style="margin-top:6px; display:none;">
            <pre id="ass-dbg-output-text" style="
                background: rgba(0,0,0,0.4);
                border: 1px solid rgba(128,128,128,0.3);
                border-radius: 4px;
                padding: 6px 8px;
                font-size: 11px;
                color: #5cb85c;
                white-space: pre-wrap;
                word-break: break-all;
                max-height: 300px;
                overflow-y: auto;
                margin: 0;
            "></pre>
        </div>
    </div>`;
}

/**
 * Safely summarize a value for debug display.
 * Prevents crashes on circular refs or huge objects.
 */
function safeSummarize(val, depth) {
    depth = depth || 0;
    if (depth > 2) return '(nested)';
    if (val === null) return 'null';
    if (val === undefined) return 'undefined';
    const type = typeof val;
    if (type === 'function') return 'function';
    if (type === 'string' || type === 'number' || type === 'boolean') return JSON.stringify(val);
    if (Array.isArray(val)) {
        if (val.length === 0) return 'array[0] (empty)';
        const items = val.slice(0, 5).map(v => safeSummarize(v, depth + 1));
        const suffix = val.length > 5 ? ` ... (+${val.length - 5} more)` : '';
        return `array[${val.length}]: [${items.join(', ')}${suffix}]`;
    }
    if (type === 'object') {
        const keys = Object.keys(val);
        if (keys.length === 0) return 'object{} (empty)';
        const entries = keys.slice(0, 8).map(k => `${k}: ${safeSummarize(val[k], depth + 1)}`);
        const suffix = keys.length > 8 ? ` ... (+${keys.length - 8} more)` : '';
        return `object{${keys.length}}: {${entries.join(', ')}${suffix}}`;
    }
    return String(val);
}

/**
 * Run a debug test and show the result.
 */
async function runDebugTest(testName) {
    const outputDiv = $('#ass-dbg-output');
    const outputText = $('#ass-dbg-output-text');
    outputDiv.show();
    outputText.text('Loading...');

    let result = '';
    let label = testName;

    try {
        switch (testName) {
            // ---- Row 1: Basics ----
            case 'chatId': {
                const chatId = typeof context.getCurrentChatId === 'function'
                    ? context.getCurrentChatId()
                    : 'getCurrentChatId not available';
                result = `Chat ID: ${JSON.stringify(chatId)} (type: ${typeof chatId})`;
                break;
            }
            case 'names': {
                result = `name1 (User): ${JSON.stringify(context.name1)}\nname2 (Char/Group): ${JSON.stringify(context.name2)}`;
                break;
            }
            case 'chatMetadata': {
                result = `chatMetadata: ${JSON.stringify(context.chatMetadata, null, 2)}`;
                break;
            }
            case 'mainApi': {
                result = `mainApi: ${JSON.stringify(context.mainApi)}\nonlineStatus: ${JSON.stringify(context.onlineStatus)}`;
                break;
            }
            case 'chatCompletion': {
                const cc = context.chatCompletionSettings || {};
                result = `chatCompletionSettings:\n  custom_url: ${JSON.stringify(cc.custom_url)}\n  model: ${JSON.stringify(cc.model)}\n  (full object logged to F12)`;
                console.log(`[${EXTENSION_NAME}] chatCompletionSettings:`, cc);
                break;
            }

            // ---- Row 2: Group Chat ----
            case 'stApiGroups': {
                // Fetch groups directly from ST's server API
                result = `Fetching /api/groups from ST server...`;
                outputText.text(result);
                try {
                    const resp = await fetch('/api/groups');
                    if (resp.ok) {
                        const data = await resp.json();
                        // data might be an array or object with a groups property
                        let groups = Array.isArray(data) ? data : (data.groups || data);
                        const count = Array.isArray(groups) ? groups.length : 'N/A';
                        result = `=== ST /api/groups ===\n`;
                        result += `Total groups: ${count}\n\n`;

                        if (Array.isArray(groups) && groups.length > 0) {
                            // Show each group's name, id, members
                            for (let i = 0; i < Math.min(groups.length, 10); i++) {
                                const g = groups[i];
                                const gName = g.name || g.chat_name || '(unnamed)';
                                const gId = g.id || g.chat_id || g.group_id || '(no id)';
                                const members = g.members || g.group_members || [];
                                const memberCount = Array.isArray(members) ? members.length : (typeof members === 'object' ? Object.keys(members).length : '?');
                                const isGroup = g.is_group || g.isGroup || false;
                                result += `--- Group ${i + 1}: "${gName}" ---\n`;
                                result += `  id: ${JSON.stringify(gId)}\n`;
                                result += `  is_group: ${isGroup}\n`;
                                result += `  members: ${memberCount}\n`;
                                if (Array.isArray(members) && members.length > 0) {
                                    result += `  member names: ${JSON.stringify(members.slice(0, 8).map(m => m.name || m.avatar || m))}\n`;
                                }
                                // Show all keys for first group
                                if (i === 0) {
                                    result += `  all keys: [${Object.keys(g).join(', ')}]\n`;
                                }
                                result += `\n`;
                            }
                        }

                        console.log(`[${EXTENSION_NAME}] /api/groups response:`, groups);
                    } else {
                        result = `ERROR: /api/groups returned ${resp.status} ${resp.statusText}`;
                    }
                } catch (err) {
                    result = `ERROR fetching /api/groups: ${err.message}`;
                }
                break;
            }
            case 'scanCharsForGroups': {
                // Search context.characters for entries that look like groups
                const chars = context.characters;
                if (!Array.isArray(chars)) {
                    result = `context.characters is not an array: ${typeof chars}`;
                    break;
                }
                const groupChars = [];
                const可疑 = []; // potential groups by name patterns

                for (let i = 0; i < chars.length; i++) {
                    const c = chars[i];
                    const isGroup = c.is_group || c.isGroup || false;
                    const hasMembers = Array.isArray(c.members) || Array.isArray(c.group_members);
                    const memberCount = hasMembers
                        ? (Array.isArray(c.members) ? c.members.length : c.group_members.length)
                        : 0;

                    if (isGroup || hasMembers) {
                        groupChars.push({
                            index: i,
                            name: c.name || c.avatar || '(unnamed)',
                            id: c.id || c.chat_id || c.group_id,
                            is_group: isGroup,
                            memberCount: memberCount,
                            allKeys: Object.keys(c),
                        });
                    }

                    // Also flag chars with 'group' in name
                    const name = (c.name || '').toLowerCase();
                    if (name.includes('group') || name.includes('party') || name.includes('team')) {
                        可疑.push({ index: i, name: c.name, allKeys: Object.keys(c) });
                    }
                }

                result = `=== Scanning ${chars.length} characters for groups ===\n\n`;
                result += `Found ${groupChars.length} with is_group=true or members:\n`;

                if (groupChars.length > 0) {
                    for (const g of groupChars) {
                        result += `\n--- "${g.name}" (index ${g.index}) ---\n`;
                        result += `  is_group: ${g.is_group}\n`;
                        result += `  memberCount: ${g.memberCount}\n`;
                        result += `  id: ${JSON.stringify(g.id)}\n`;
                        result += `  all keys: [${g.allKeys.join(', ')}]\n`;
                    }
                } else {
                    result += `  (none found)\n`;
                }

                if (可疑.length > 0) {
                    result += `\n\nPossible groups by name:\n`;
                    for (const s of 可疑) {
                        result += `  "${s.name}" (index ${s.index}) keys: [${s.allKeys.join(', ')}]\n`;
                    }
                }

                // Also show structure of first character so we know what fields exist
                if (chars.length > 0) {
                    result += `\n\nSample character[0] keys: [${Object.keys(chars[0]).join(', ')}]`;
                    const c0 = chars[0];
                    // Check if characters have chat/visible_chats properties
                    result += `\ncharacter[0].chat type: ${typeof c0.chat} ${Array.isArray(c0.chat) ? '(array[' + c0.chat.length + '])' : ''}`;
                    result += `\ncharacter[0].data keys: ${c0.data ? Object.keys(c0.data).join(', ') : '(no data)'}`;
                }

                console.log(`[${EXTENSION_NAME}] Group chars found:`, groupChars);
                console.log(`[${EXTENSION_NAME}] All chars sample:`, chars[0]);
                break;
            }
            case 'pageUrlInfo': {
                const url = window.location.href;
                const origin = window.location.origin;
                const path = window.location.pathname;
                const hash = window.location.hash;
                result = `=== Page URL ===\n`;
                result += `Full URL: ${url}\n`;
                result += `Origin: ${origin}\n`;
                result += `Path: ${path}\n`;
                result += `Hash: ${hash}\n\n`;
                // Check for group/chat params in URL
                const urlObj = new URL(url);
                const params = Object.fromEntries(urlObj.searchParams);
                result += `Query params: ${JSON.stringify(params)}\n\n`;
                // Also check DOM for hidden group state
                const $charName = $('#character_name_pole');
                const $groupName = $('#group_name_pole');
                const $rmInfo = $('#right-nav-panel');
                result += `DOM checks:\n`;
                result += `  #character_name_pole: ${$charName.length ? $charName.text().trim() : '(not found)'}\n`;
                result += `  #group_name_pole: ${$groupName.length ? $groupName.text().trim() : '(not found)'}\n`;
                result += `  body classes: ${document.body.className}\n`;
                // Check for data attributes on body or chat container
                const $body = $('body');
                result += `  body data-attr keys: [${Array.from($body[0]?.dataset || {}).join(', ')}]\n`;
                break;
            }
            case 'groupScan': {
                // Legacy scan — kept for reference
                const paths = [
                    'groupId', 'isGroup', 'groups', 'group', 'activeGroup',
                    'chat?.group_id', 'chat?.is_group',
                    'character?.is_group', 'character?.members',
                    'chatMetadata?.group_id', 'chatMetadata?.members',
                ];
                const lines = [];
                for (const p of paths) {
                    try {
                        const val = p.split('?.').reduce((obj, key) => {
                            if (obj === null || obj === undefined) return undefined;
                            return obj[key];
                        }, context);
                        lines.push(`context.${p} = ${safeSummarize(val)}`);
                    } catch (e) {
                        lines.push(`context.${p} = ERROR`);
                    }
                }
                result = `=== Context Group Paths ===\n${lines.join('\n')}`;
                break;
            }
            case 'groupFunctions': {
                const allKeys = Object.keys(context);
                const groupFns = allKeys.filter(k => {
                    const lk = k.toLowerCase();
                    return lk.includes('group') || lk.includes('member');
                });
                const fnList = [];
                const varList = [];
                for (const k of groupFns) {
                    const val = context[k];
                    const type = typeof val;
                    if (type === 'function') {
                        fnList.push(k);
                    } else {
                        varList.push(`${k}: ${safeSummarize(val, 1)}`);
                    }
                }
                result = `=== Group/Member on context (${groupFns.length} matches) ===\n`;
                result += `\nFunctions:\n${fnList.map(f => `  ${f}()`).join('\n') || '  (none)'}`;
                result += `\n\nVariables:\n${varList.map(v => `  ${v}`).join('\n') || '  (none)'}`;
                break;
            }

            // ---- Row 3: Advanced ----
            case 'contextChat': {
                const chat = context.chat;
                if (Array.isArray(chat)) {
                    result = `context.chat is array[${chat.length}] (chat messages)\n\n`;
                    // Show first 2 messages summary
                    for (let i = 0; i < Math.min(chat.length, 3); i++) {
                        const m = chat[i];
                        const keys = m ? Object.keys(m) : [];
                        const role = m?.role || m?.is_user !== undefined ? (m.is_user ? 'user' : 'assistant') : '?';
                        const content = m?.mes || m?.content || '';
                        const preview = String(content).substring(0, 80);
                        result += `msg[${i}]: role=${role} keys=[${keys.join(',')}] "${preview}..."\n`;
                    }
                    console.log(`[${EXTENSION_NAME}] context.chat (messages):`, chat);
                } else if (chat && typeof chat === 'object') {
                    result = `context.chat keys (${Object.keys(chat).length}):\n${JSON.stringify(chat, null, 2).substring(0, 1500)}`;
                } else {
                    result = `context.chat: ${safeSummarize(chat)}`;
                }
                break;
            }
            case 'characters': {
                const chars = context.characters;
                const count = Array.isArray(chars) ? chars.length : 'N/A';
                result = `characters: ${count}\n\n`;
                if (Array.isArray(chars) && chars.length > 0) {
                    result += `First 5 names:\n`;
                    for (let i = 0; i < Math.min(5, chars.length); i++) {
                        result += `  [${i}] ${chars[i].name || chars[i].avatar || '(unnamed)'}\n`;
                    }
                    result += `\ncharacter[0] keys: [${Object.keys(chars[0]).join(', ')}]`;
                }
                break;
            }
            case 'eventTypes': {
                const ev = context.eventTypes || context.event_types;
                if (ev) {
                    const keys = Object.keys(ev);
                    const isArr = Array.isArray(ev);
                    if (isArr) {
                        result = `eventTypes (array[${ev.length}]):\n${ev.join(', ')}`;
                    } else {
                        result = `eventTypes (object{${keys.length}}):\n${keys.join('\n')}`;
                    }
                    // Filter for group-related events
                    const groupEvents = keys.filter(k => {
                        const lk = k.toLowerCase();
                        return lk.includes('group') || lk.includes('member') || lk.includes('chat');
                    });
                    if (groupEvents.length > 0) {
                        result += `\n\nGroup/Chat events (${groupEvents.length}):\n${groupEvents.join('\n')}`;
                    }
                    console.log(`[${EXTENSION_NAME}] eventTypes raw:`, ev);
                } else {
                    result = 'eventTypes not found.';
                }
                break;
            }
            case 'fullDump': {
                console.log(`[${EXTENSION_NAME}] ========== FULL CONTEXT DUMP ==========`);
                const summary = {};
                for (const key of Object.keys(context)) {
                    const val = context[key];
                    const type = typeof val;
                    if (type === 'function') {
                        summary[key] = 'function';
                    } else if (Array.isArray(val)) {
                        summary[key] = `array[${val.length}]`;
                    } else if (type === 'object' && val !== null) {
                        summary[key] = `object{${Object.keys(val).length}}`;
                    } else {
                        summary[key] = `${type}: ${JSON.stringify(val)}`;
                    }
                }
                console.log(`[${EXTENSION_NAME}] Context summary:`, summary);
                console.log(`[${EXTENSION_NAME}] Full context object:`, context);
                result = `Full dump logged to F12 console.\n\nKeys (${Object.keys(context).length} total):\n${JSON.stringify(summary, null, 2)}`;
                break;
            }
            default:
                result = `Unknown test: ${testName}`;
        }
    } catch (err) {
        result = `ERROR: ${err.message}\n${err.stack}`;
    }

    outputText.text(result);
    console.log(`[${EXTENSION_NAME}] [Debug] ${label}:\n${result}`);
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
        // ST not ready yet — retry
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
                rp_llm_url: settings.rpLlmUrl,
                instruct_llm_url: settings.instructLlmUrl,
                rp_template: settings.rpTemplate,
                instruct_template: settings.instructTemplate,
                thinking_steps: settings.thinkingSteps,
                refinement_steps: settings.refinementSteps,
            };

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

        /* Debug buttons */
        .ass-dbg-btn.menu_button {
            font-size: 11px !important;
            padding: 3px 8px !important;
            flex-shrink: 0;
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

                <!-- Debug Panel -->
                ${buildDebugPanelHTML()}

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

    // --- Debug buttons ---
    $(document).on('click', '.ass-dbg-btn', function () {
        const testName = $(this).data('test');
        if (testName) runDebugTest(testName);
    });

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
        $text.text('Not detected — set Custom Endpoint in ST');
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
// # 10. Session Management
// #############################################

/**
 * Ensure a session_id exists for the current chat.
 * Creates one via POST /api/sessions if missing.
 */
async function ensureSession(backendOrigin) {
    // --- Check if session already exists ---
    if (context.chatMetadata && context.chatMetadata[META_KEY_SESSION]) {
        if (!context.chatMetadata[META_KEY_INITIALIZED]) {
            await initSession(backendOrigin, context.chatMetadata[META_KEY_SESSION]);
        }
        return context.chatMetadata[META_KEY_SESSION];
    }

    // --- Create new session ---
    console.log(`[${EXTENSION_NAME}] No session ID. Creating session via ${backendOrigin}...`);
    try {
        const resp = await fetch(`${backendOrigin}/api/sessions`, {
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

        await initSession(backendOrigin, sessionId);

        return sessionId;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Session creation failed:`, err);
        throw err;
    }
}

/**
 * Send character card + persona data to the Agent for initial world-state parsing.
 */
async function initSession(backendOrigin, sessionId) {
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
// # 11. Message Type Detection
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
// # 12. History Trimming
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
// # 13. [SYSTEM_META] Construction
// #############################################

/**
 * Build the [SYSTEM_META] tag with all per-request data.
 */
function buildMetaTag(sessionId, messageId, type, swipeIndex) {
    return `[SYSTEM_META] session_id=${sessionId} message_id=${messageId} type=${type} swipe_index=${swipeIndex}`;
}

// #############################################
// # 14. Fetch Interception (Core Pipeline)
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

            // --- Ensure session exists ---
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

            // --- Forward to Agent (or let it go to the original URL if already pointing there) ---
            let targetUrl = url;
            const stOrigin = getAgentOrigin();
            if (stOrigin) {
                // Ensure we're sending to the Agent
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

            updateStatus('Error — check console', '#d9534f');

            return originalFetch.call(window, url, options);
        }
    };
}

// #############################################
// # 15. Chat Event Hooks
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

            // Refresh the Agent URL display (may change per-chat in some configs)
            refreshAgentUrlDisplay();

            const settings = getSettings();
            if (settings.enabled) {
                startHealthChecks();
            }
        });
    }
}

// #############################################
// # 16. Initialization
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

    console.log(`[${EXTENSION_NAME}] Extension loaded. Version 2.4`);
    console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
    console.log(`[${EXTENSION_NAME}] Agent URL (auto-detected):`, getAgentOrigin());
})();