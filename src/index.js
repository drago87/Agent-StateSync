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

    const backendUrl = settings.agentUrl || null; // Will be resolved at request time
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

                <!-- Enable Toggle -->
                <div class="flex-container alignitemscenter margin-bot-10">
                    <label class="checkbox_label margin-0" for="ass-toggle">
                        <input type="checkbox" id="ass-toggle">
                        <span>Enable State Sync</span>
                    </label>
                </div>

                <!-- Agent URL -->
                <div class="margin-bot-10">
                    <label class="title_restorable">
                        <small>Agent IP:Port</small>
                    </label>
                    <input type="text" id="ass-agent-url" class="text_pole wide" placeholder="192.168.0.1:8000">
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

                <!-- Status -->
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
        if (settings.enabled) onSettingChange();
    });

    $('#ass-agent-url').on('change', function () {
        const settings = getSettings();
        settings.agentUrl = $(this).val().trim();
        saveSettings(settings);
        configSynced = false; // Force re-sync with new URL
        onSettingChange();
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

// #############################################
// # 6. Session Management
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

        // --- Read character config (mode, tracked_characters) from chatMetadata ---
        const charConfig = getCharConfig();
        const isMultiChar = (charDescription + charScenario).toLowerCase().includes('{{char}}') ||
                            (charDescription + charScenario).includes('character:');

        // Parse tracked characters from comma-separated string
        let trackedList = charConfig.tracked_characters
            ? charConfig.tracked_characters.split(',').map(s => s.trim()).filter(Boolean)
            : [];

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
// # 7. Message Type Detection
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
    else if (convCount === lastConversationCount && currentUserHash === lastUserMsgHash && currentAssistantHash === lastAssistantMsgHash) {
        type = 'continue';
    }
    // Same user message, different/missing assistant → Swipe
    else if (currentUserHash === lastUserMsgHash && currentAssistantHash !== lastAssistantMsgHash) {
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
// # 8. History Trimming
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
// # 9. [SYSTEM_META] Construction
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
// # 10. Fetch Interception (Core Pipeline)
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
// # 11. Chat Event Hooks
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
        });
    }

    // Also reset when generating to catch edge cases
    const originalGenerate = context.generate;
    // (We don't override generate — the fetch interceptor handles everything.)
}

// #############################################
// # 12. Character Management Panel Integration
// #############################################

/**
 * Storage keys in chatMetadata for per-chat character config.
 * These persist with the chat so each chat can have different tracked characters.
 */
const CHAR_META_MODE = 'ass_char_mode';
const CHAR_META_TRACKED = 'ass_char_tracked';

/**
 * Read character config from current chat metadata.
 */
function getCharConfig() {
    const meta = context.chatMetadata || {};
    return {
        mode: meta[CHAR_META_MODE] || 'character',          // 'character' | 'scenario'
        tracked_characters: meta[CHAR_META_TRACKED] || '',   // comma-separated string
    };
}

/**
 * Save character config to current chat metadata.
 */
async function saveCharConfig(config) {
    context.chatMetadata = context.chatMetadata || {};
    context.chatMetadata[CHAR_META_MODE] = config.mode;
    context.chatMetadata[CHAR_META_TRACKED] = config.tracked_characters;
    await context.saveMetadata();
}

/**
 * Inject an "Agent-StateSync" button into SillyTavern's Character Management
 * action bar (alongside Advanced Definitions, Export and Download, Delete Character).
 *
 * SillyTavern's character edit panel is `#rm_ch_create_block` (right sidebar).
 * The button bar is `.form_create_bottom_buttons_block`, containing divs like
 * `#advanced_div`, `#export_button`, `#delete_button` — all with class `menu_button`.
 *
 * We use a MutationObserver to detect when the panel opens and inject our button.
 */
function setupCharMgmtButton() {
    const observer = new MutationObserver(() => {
        injectCharMgmtButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also try immediately in case panel is already open
    injectCharMgmtButton();
}

function injectCharMgmtButton() {
    // Already injected? Skip.
    if (document.getElementById('ass-char-mgmt-btn')) return;

    // Find SillyTavern's character edit panel (right sidebar)
    const charPanel = document.getElementById('rm_ch_create_block');
    if (!charPanel) return;

    // Find the button bar container
    const buttonBar = charPanel.querySelector('.form_create_bottom_buttons_block');
    if (!buttonBar) return;

    // Find a known button to copy styling from
    const refButton = buttonBar.querySelector('#export_button')
                   || buttonBar.querySelector('#advanced_div')
                   || buttonBar.querySelector('.menu_button');
    if (!refButton) return;

    // Create our button as a <div> with menu_button class (matching ST's convention)
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

    // Insert before the "More..." dropdown (which is a <label> after the button bar)
    // This puts us at the end of the action buttons but before the dropdown
    const moreDropdown = buttonBar.nextElementSibling;
    if (moreDropdown && moreDropdown.querySelector('#char-management-dropdown')) {
        buttonBar.appendChild(btn);
    } else {
        // Fallback: just append to end of button bar
        buttonBar.appendChild(btn);
    }

    console.log(`[${EXTENSION_NAME}] Injected Character Management button.`);
}

/**
 * Open a modal dialog for configuring Agent-StateSync per-character settings.
 *
 * - Extraction Mode: character (track character state) vs scenario (track world state)
 * - Tracked Characters: comma-separated list for multi-character cards
 *
 * Settings are saved to chatMetadata and synced to the agent mid-session.
 */
function openCharMgmtDialog() {
    const config = getCharConfig();
    const charName = context.name2 || context.character_name || 'Unknown';
    const charDesc = context.description || '';
    const charScenario = context.scenario || '';
    const isMultiChar = (charDesc + charScenario).toLowerCase().includes('{{char}}') ||
                        (charDesc + charScenario).includes('character:');
    const settings = getSettings();
    const sessionId = context.chatMetadata?.[META_KEY_SESSION];

    // ── Build overlay + dialog ──
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

        <!-- Current character info -->
        <div style="margin-bottom:16px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid var(--borderColor, #444);">
            <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${esc(charName)}</div>
            ${isMultiChar ? '<span style="font-size:11px;color:var(--fgdim, #888);background:rgba(88,166,255,0.15);padding:2px 6px;border-radius:4px;">Multi-character card detected</span>' : '<span style="font-size:11px;color:var(--fgdim, #888);">Single character card</span>'}
            ${!settings.enabled ? '<div style="margin-top:6px;font-size:12px;color:#f0ad4e;">⚠ Agent-StateSync is currently disabled. Settings will be saved but not used until enabled.</div>' : ''}
        </div>

        <!-- Extraction Mode -->
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

        <!-- Tracked Characters -->
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

        <!-- Session status -->
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

        <!-- Action buttons -->
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
            <button id="ass-char-mgmt-cancel" style="padding:8px 18px;background:rgba(255,255,255,0.06);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>
            <button id="ass-char-mgmt-save" style="padding:8px 22px;background:var(--accent-color,#58a6ff);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px;">Save</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // ── Dynamic tracked characters list ──
    const trackedListEl = document.getElementById('ass-tracked-list');
    const inputStyle = 'flex:1;padding:7px 10px;background:rgba(255,255,255,0.06);color:var(--fg,#ccc);border:1px solid var(--borderColor,#444);border-radius:6px;font-size:13px;box-sizing:border-box;outline:none;';
    const rmBtnStyle = 'width:30px;height:30px;flex-shrink:0;padding:0;background:rgba(248,81,73,0.1);color:#f85149;border:1px solid rgba(248,81,73,0.2);border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;transition:background 0.15s;';

    // Parse existing tracked chars from saved config
    const existingChars = config.tracked_characters
        ? config.tracked_characters.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    /** Create one tracked-char row (input + remove button) */
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

    /** Dim the X button when only 1 row remains so it can't be fully emptied */
    function updateRemoveButtons() {
        const count = trackedListEl.querySelectorAll('.ass-tracked-input').length;
        trackedListEl.querySelectorAll('button[title="Remove"]').forEach(btn => {
            btn.style.opacity = count <= 1 ? '0.3' : '1';
            btn.style.pointerEvents = count <= 1 ? 'none' : 'auto';
        });
    }

    // Populate with existing tracked chars, or one empty row if none
    if (existingChars.length > 0) {
        existingChars.forEach(name => trackedListEl.appendChild(createTrackedRow(name)));
    } else {
        trackedListEl.appendChild(createTrackedRow());
    }
    updateRemoveButtons();

    // Add character button
    document.getElementById('ass-add-char').addEventListener('click', () => {
        const row = createTrackedRow();
        trackedListEl.appendChild(row);
        updateRemoveButtons();
        row.querySelector('input').focus();
    });

    // ── Mode change: show/hide tracked characters section ──
    const modeSelect = document.getElementById('ass-mode-select');
    const trackedSection = document.getElementById('ass-tracked-section');
    function updateTrackedVisibility() {
        trackedSection.style.display = modeSelect.value === 'character' ? 'block' : 'none';
    }
    modeSelect.addEventListener('change', updateTrackedVisibility);
    updateTrackedVisibility();

    // ── Cancel ──
    document.getElementById('ass-char-mgmt-cancel').addEventListener('click', () => overlay.remove());

    // ── Overlay click to close ──
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // ── ESC to close ──
    const escHandler = (e) => {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    // ── Save ──
    document.getElementById('ass-char-mgmt-save').addEventListener('click', async () => {
        const newMode = document.getElementById('ass-mode-select').value;
        // Collect tracked characters from dynamic inputs
        const trackedInputs = trackedListEl.querySelectorAll('.ass-tracked-input');
        const trackedNames = [];
        trackedInputs.forEach(input => {
            const name = input.value.trim();
            if (name) trackedNames.push(name);
        });
        const newTracked = trackedNames.join(', ');

        // Save to chatMetadata
        await saveCharConfig({ mode: newMode, tracked_characters: newTracked });
        console.log(`[${EXTENSION_NAME}] Character config saved: mode=${newMode}, tracked=[${trackedNames.length ? trackedNames.join(', ') : '(none)'}]`);

        // Sync to agent mid-session
        const settings = getSettings();
        if (settings.enabled && sessionId) {
            const backendUrl = settings.agentUrl || null;
            if (backendUrl) {
                try {
                    const resp = await fetch(`http://${backendUrl}/api/sessions/${sessionId}/config`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            mode: newMode,
                            tracked_characters: newTracked,
                        }),
                    });
                    if (resp.ok) {
                        console.log(`[${EXTENSION_NAME}] Session config synced to Agent.`);
                    } else {
                        console.warn(`[${EXTENSION_NAME}] Session config sync returned ${resp.status}.`);
                    }
                } catch (err) {
                    console.warn(`[${EXTENSION_NAME}] Failed to sync config to Agent:`, err.message);
                }
            }
        }

        // User feedback
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
    setupCharMgmtButton();

    console.log(`[${EXTENSION_NAME}] Extension loaded. Version 2.0`);
    console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
})();