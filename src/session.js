// session.js — Agent-StateSync Session Management
//
// Handles proactive chat-changed hook, session creation/attachment,
// and initialization with character or group data.
//
// v3.0 — New init payload format:
//   - Card types: plain character, scenario, multi-character
//   - first_mes from chat messages (not card field)
//   - Group chat: members ordered by first message in chat
//   - group_scenario logic: include at top or per-member
//   - Empty fields excluded from payload
// File Version: 1.0.2

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
    CHAR_CONFIG_EXT_KEY,
    getSettings, isBypassMode, syncConfigToAgent, updateStatus, buildPromptSettingsPayload,
} from './settings.js';
import { getAgentOrigin } from './agent-url.js';
import { loadGroupData } from './groups.js';
import defaultConfig from './default-config.js';
import { getCharInitType, getCharInitNames } from './char-config.js';
import { startNotificationPolling, stopNotificationPolling } from './notifications.js';

// #############################################
// # 14. Proactive Chat-Changed Hook
// #############################################

/**
 * Called when SillyTavern fires the 'chat-changed' event.
 * Proactively looks up or creates an Agent session for the new chat.
 *
 * Flow:
 * 1. Get chat ID first (with retries if needed)
 * 2. Defer to proactiveChatChangedWithId() which loads group data
 *    AFTER chatId is available (critical for correct group matching)
 */
export async function proactiveChatChanged() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const origin = getAgentOrigin();
    if (!origin) {
        console.log(`[${EXTENSION_NAME}] Chat changed but no Agent URL - will set up on first request`);
        return;
    }

    if (state.proactiveInProgress) {
        console.log(`[${EXTENSION_NAME}] Proactive chat-changed already in progress, skipping`);
        return;
    }
    state.proactiveInProgress = true;

    try {
        // Step 1: Get the chat ID first (with retries if needed).
        // We MUST have a valid chatId before loading group data,
        // because findActiveGroup() uses getCurrentChatId() to match
        // the correct group.  On F5 refresh, the chat ID isn't available
        // immediately — if we load groups too early, the fallback
        // heuristic grabs the wrong group.
        updateStatus('Loading chat data...', '#5bc0de');

        const chatId = typeof state.context.getCurrentChatId === 'function'
            ? state.context.getCurrentChatId()
            : null;

        if (!chatId) {
            console.log(`[${EXTENSION_NAME}] No chat ID yet, retrying...`);
            for (let attempt = 1; attempt <= 3; attempt++) {
                await new Promise(r => setTimeout(r, 1000));
                const retryId = typeof state.context.getCurrentChatId === 'function'
                    ? state.context.getCurrentChatId()
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
        state.proactiveInProgress = false;
    }
}

/**
 * Continue proactive session setup now that we have a valid chatId.
 */
async function proactiveChatChangedWithId(origin, chatId) {
    try {
        // --- Load group data NOW that we have a valid chatId ---
        // This must happen before any Agent communication so that
        // findActiveGroup() can use getCurrentChatId() correctly.
        try {
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Group data load failed (single-char fallback):`, e.message);
        }

        // --- BYPASS MODE: skip all Agent communication ---
        if (isBypassMode()) {
            console.log(`[${EXTENSION_NAME}] [BYPASS] Proactive setup skipped for chat ${chatId}`);
            console.log(`[${EXTENSION_NAME}] [BYPASS] Would have: health check, session lookup, init`);
            console.log(`[${EXTENSION_NAME}] [BYPASS] Group detection result: isGroupChat=${state.isGroupChat}, activeGroup=${state.activeGroup ? state.activeGroup.name : '(none)'}`);
            updateStatus('Bypass mode', '#5bc0de');
            return;
        }

        // Pre-flight: check if Agent is reachable before doing anything.
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
        const existingSessionId = state.context.chatMetadata?.[META_KEY_SESSION];

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
        state.proactiveInProgress = false;
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
        state.context.chatMetadata = state.context.chatMetadata || {};
        state.context.chatMetadata[META_KEY_SESSION] = sessionId;
        state.context.chatMetadata[META_KEY_INITIALIZED] = false;
        await state.context.saveMetadata();

        // Re-initialize with current character/group data
        await initSession(origin, sessionId);

        // Sync config
        state.configSynced = false;
        await syncConfigToAgent(getSettings(), origin);

        const shortId = sessionId.substring(0, 8);
        const chatLabel = state.isGroupChat && state.activeGroup
            ? `Group "${state.activeGroup.name}"`
            : `"${state.context.name2 || 'Unknown'}"`;
        toastr.success(`Resumed session (${shortId}...) for ${chatLabel}`, 'Agent-StateSync');
        updateStatus(`Session ${shortId}...`, '#5cb85c');
		startNotificationPolling();
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
    const chatLabel = state.isGroupChat && state.activeGroup
        ? `Group "${state.activeGroup.name}" (${state.activeGroupCharacters.length} members)`
        : `Character "${state.context.name2 || 'Unknown'}"`;

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
    const popupFn = window.callPopup || state.context.callPopup;
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
        state.context.chatMetadata = state.context.chatMetadata || {};
        state.context.chatMetadata[META_KEY_SESSION] = sessionId;
        state.context.chatMetadata[META_KEY_COUNTER] = 0;
        await state.context.saveMetadata();

        // Initialize with character/group data
        await initSession(origin, sessionId);

        // Sync config
        state.configSynced = false;
        await syncConfigToAgent(getSettings(), origin);

        const shortId = sessionId.substring(0, 8);
        toastr.success(`Session created: ${shortId}...`, 'Agent-StateSync');
        updateStatus(`Session ${shortId}...`, '#5cb85c');
		startNotificationPolling();
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive session creation failed:`, err);
        toastr.error(`Session creation failed: ${err.message}`, 'Agent-StateSync');
        updateStatus('Session creation failed', '#d9534f');
    }
}

// #############################################
// # 15. Session Management
// #############################################

/**
 * Ensure a session_id exists for the current chat.
 * Used as fallback by the fetch interceptor if proactive setup didn't run.
 * Creates one via POST /api/sessions if missing.
 */
export async function ensureSession(backendOrigin) {
    // --- BYPASS MODE: return a fake session ID, don't talk to Agent ---
    if (isBypassMode()) {
        const fakeId = 'bypass-fake-session-id';
        console.log(`[${EXTENSION_NAME}] [BYPASS] ensureSession: returning fake session ${fakeId}`);
        return fakeId;
    }

    // --- Ensure group data is loaded before doing anything ---
    if (!state.cachedGroups && !state.isGroupChat) {
        try {
            console.log(`[${EXTENSION_NAME}] ensureSession: loading group data (proactive may have missed it)`);
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] ensureSession: group data load failed, single-char fallback`, e.message);
        }
    }

    // --- Check if session already exists in metadata ---
    if (state.context.chatMetadata && state.context.chatMetadata[META_KEY_SESSION]) {
        if (!state.context.chatMetadata[META_KEY_INITIALIZED]) {
            await initSession(backendOrigin, state.context.chatMetadata[META_KEY_SESSION]);
        }
        return state.context.chatMetadata[META_KEY_SESSION];
    }

    // --- Create new session (fallback - proactive should handle this) ---
    console.log(`[${EXTENSION_NAME}] No session ID (proactive missed). Creating session...`);
    try {
        const chatId = typeof state.context.getCurrentChatId === 'function'
            ? state.context.getCurrentChatId()
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

        state.context.chatMetadata = state.context.chatMetadata || {};
        state.context.chatMetadata[META_KEY_SESSION] = sessionId;
        state.context.chatMetadata[META_KEY_COUNTER] = 0;
        await state.context.saveMetadata();

        await initSession(backendOrigin, sessionId);

        return sessionId;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Fallback session creation failed:`, err);
        throw err;
    }
}

// #############################################
// # 15b. Init Payload Builder (v3.0)
// #############################################

/**
 * Build the character/scenario data object from a character's card fields.
 * Uses the first message from the chat (not the card's first_mes field).
 * Excludes empty fields.
 *
 * @param {object} charData - Character object (from context.characters[] or context itself)
 * @param {string|null} firstMesOverride - Override first_mes (from chat messages)
 * @returns {object} Clean data object with only non-empty fields
 */
function buildCardData(charData, firstMesOverride) {
    const data = {};

    const desc = charData.description || '';
    if (desc) data.description = desc;

    const personality = charData.personality || '';
    if (personality) data.personality = personality;

    const scenario = charData.scenario || '';
    if (scenario) data.scenario = scenario;

    const firstMes = firstMesOverride || '';
    if (firstMes) data.first_mes = firstMes;

    const mesExample = charData.mes_example || '';
    if (mesExample) data.mes_example = mesExample;

    return data;
}

/**
 * Build the persona object. Excludes empty fields.
 */
function buildPersona() {
    const persona = {};

    const name = state.context.name1 || '';
    if (name) persona.name = name;

    const desc = state.context.powerUserSettings?.persona_description || '';
    if (desc) persona.description = desc;

    return Object.keys(persona).length > 0 ? persona : undefined;
}

/**
 * Get the first message for a character from the chat history.
 * In group chats, we look for the first message where the character's name
 * appears as the sender (is_user=false, name matches).
 * In single-char chats, we just grab the first non-system message.
 *
 * @param {string|null} charName - Character name to look for (group mode)
 * @returns {string|null} The message text, or null if no message found
 */
function getFirstMesFromChat(charName) {
    const chat = state.context.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    if (charName) {
        // Group mode: find the first message from this character
        for (const msg of chat) {
            if (!msg.is_user && msg.name === charName && msg.mes) {
                return msg.mes;
            }
        }
        // Also try matching with the ForceAvatar-based name
        // (ST may store character names differently in chat messages)
        return null;
    }

    // Single-char mode: first non-user message
    for (const msg of chat) {
        if (!msg.is_user && msg.mes) {
            return msg.mes;
        }
    }

    return null;
}

/**
 * Read the char config (type + names) stored in a character card's extensions.
 * Used for group members where each card can be independently classified.
 *
 * @param {object} charObj - Character object from context.characters[]
 * @returns {{ type: string, names: string[] }}
 */
function readMemberCharConfig(charObj) {
    if (!charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]) {
        return { type: 'character', names: [] };
    }

    const stored = charObj.data.extensions[CHAR_CONFIG_EXT_KEY];
    if (stored.mode === 'scenario') {
        return { type: 'scenario', names: [] };
    }

    // Multi-character if 2+ names defined
    const names = Array.isArray(stored.names)
        ? stored.names.map(n => (n || '').trim()).filter(Boolean)
        : [];
    if (names.length >= 2) {
        return { type: 'multi-character', names };
    }

    return { type: 'character', names: [] };
}

/**
 * Build a single group member entry for the init payload.
 * Each member respects its own card type classification.
 *
 * @param {object} charObj - Resolved character object
 * @param {string|null} firstMes - First message from chat for this member (or null)
 * @returns {object} Member payload object
 */
function buildGroupMemberPayload(charObj, firstMes) {
    const config = readMemberCharConfig(charObj);
    const cardName = charObj.name || 'Unknown';
    const cardData = buildCardData(charObj, firstMes);

    const member = {
        is_multi_character: config.type === 'multi-character',
        is_scenario: config.type === 'scenario',
        card_name: cardName,
    };

    if (config.type === 'multi-character' && config.names.length > 0) {
        member.character_names = config.names.join(', ');
        member.character = cardData;
    } else if (config.type === 'scenario') {
        // Scenario: card data goes under "scenario" key instead of "character"
        member.scenario = cardData;
    } else {
        // Plain character
        member.character = cardData;
    }

    // --- Per-character tracked_field_additions and prompt_settings_override ---
    const extData = charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY];
    if (extData) {
        if (Array.isArray(extData.tracked_field_additions) && extData.tracked_field_additions.length > 0) {
            member.tracked_field_additions = extData.tracked_field_additions;
        }
        if (extData.prompt_settings_override && typeof extData.prompt_settings_override === 'object') {
            const overrides = { ...extData.prompt_settings_override };
            for (const [key, val] of Object.entries(overrides)) {
                if (val === undefined || val === null || val === '' || val === 'global_default') {
                    delete overrides[key];
                }
            }
            if (Object.keys(overrides).length > 0) {
                member.prompt_settings_override = overrides;
            }
        }
    }

    return member;
}

/**
 * Build the full init payload for POST /api/sessions/{id}/init
 * according to the v3.0 spec.
 *
 * Handles all cases:
 * - Single character (plain / multi-character / scenario)
 * - Group chat with mixed card types
 * - group_scenario logic
 * - Empty field exclusion
 * - first_mes from chat messages
 *
 * @returns {object} The complete init payload
 */
export function buildInitPayload() {
    if (state.isGroupChat && state.activeGroupCharacters.length > 0) {
        return buildGroupInitPayload();
    }
    return buildSingleCharInitPayload();
}

/**
 * Build init payload for a single character (non-group) chat.
 */
function buildSingleCharInitPayload() {
    const cardType = getCharInitType();      // 'character' | 'multi-character' | 'scenario'
    const cardNames = getCharInitNames();   // [] for character/scenario, ['Alice','Bob'] for multi
    const cardName = state.context.name2 || '';
    const firstMes = getFirstMesFromChat(null);
    const cardData = buildCardData(state.context, firstMes);
    const persona = buildPersona();

    const payload = {
        is_group: false,
        is_multi_character: cardType === 'multi-character',
        is_scenario: cardType === 'scenario',
        card_name: cardName,
    };

    // For multi-character, include character_names
    if (cardType === 'multi-character' && cardNames.length > 0) {
        payload.character_names = cardNames.join(', ');
    }

    // Card data goes under "character" or "scenario" key depending on type
    if (cardType === 'scenario') {
        payload.scenario = cardData;
    } else {
        payload.character = cardData;
    }

    // Persona
    if (persona) {
        payload.persona = persona;
    }

    // Global tracked_fields definition
    if (defaultConfig?.tracked_fields) {
        payload.tracked_fields = JSON.parse(JSON.stringify(defaultConfig.tracked_fields));
    }

    // Global prompt_settings (merged with per-character overrides)
    const charConfig = state.context.characters?.[state.context.characterFilter]
        ?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]
        || state.context.chatMetadata?.[CHAR_CONFIG_EXT_KEY]
        || null;
    const charOverrides = charConfig?.prompt_settings_override || null;
    payload.prompt_settings = buildPromptSettingsPayload(charOverrides);

    console.log(`[${EXTENSION_NAME}] Single-char init: type=${cardType}, name="${cardName}"`);

    return payload;
}

/**
 * Build init payload for a group chat.
 * Members are ordered by their first message in the chat.
 * Handles group_scenario logic and per-member card type classification.
 */
function buildGroupInitPayload() {
    const members = state.activeGroupCharacters.filter(c => !c._unresolved);

    // --- Determine member ordering by first message in chat ---
    // Build a map of char name -> first message index
    const chat = state.context.chat;
    const nameToFirstIndex = new Map();
    if (Array.isArray(chat) && chat.length > 0) {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg.is_user && msg.name && !nameToFirstIndex.has(msg.name)) {
                nameToFirstIndex.set(msg.name, i);
            }
        }
    }

    // Sort members by their first message index (unseen members keep original order)
    const sortedMembers = [...members];
    sortedMembers.sort((a, b) => {
        const idxA = nameToFirstIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const idxB = nameToFirstIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        // Both unseen: keep original order
        if (idxA === Number.MAX_SAFE_INTEGER && idxB === Number.MAX_SAFE_INTEGER) return 0;
        return idxA - idxB;
    });

    // --- Check if any member is a scenario-type card ---
    const groupScenarioMember = sortedMembers.find(m => {
        const config = readMemberCharConfig(m);
        return config.type === 'scenario';
    });

    // --- Get group_scenario: use the scenario-type member's scenario text ---
    const groupScenario = groupScenarioMember?.scenario || '';

    // --- Build member payloads ---
    const memberPayloads = sortedMembers.map(m => {
        const firstMes = getFirstMesFromChat(m.name);
        const member = buildGroupMemberPayload(m, firstMes);

        // If the group has a group_scenario, strip the scenario key from each member
        if (groupScenario && member.scenario) {
            delete member.scenario;
        }

        return member;
    });

    // --- Build final payload ---
    const payload = {
        is_group: true,
        group_name: state.activeGroup.name,
        group_members: memberPayloads,
    };

    // group_scenario: include only if non-empty
    if (groupScenario) {
        payload.group_scenario = groupScenario;
    }

    // Persona (top-level only for groups)
    const persona = buildPersona();
    if (persona) {
        payload.persona = persona;
    }

    // Global tracked_fields definition
    if (defaultConfig?.tracked_fields) {
        payload.tracked_fields = JSON.parse(JSON.stringify(defaultConfig.tracked_fields));
    }

    // Global prompt_settings
    payload.prompt_settings = buildPromptSettingsPayload(null);

    console.log(`[${EXTENSION_NAME}] Group init: "${state.activeGroup.name}" with ${memberPayloads.length} members`);
    console.log(`[${EXTENSION_NAME}] group_scenario: ${groupScenario ? 'yes' : 'no'}`);

    return payload;
}

/**
 * Send character card + persona data to the Agent for initial world-state parsing.
 * In group mode, sends all group members instead of a single character.
 *
 * Uses the new v3.0 payload format with card type classification,
 * first_mes from chat messages, and empty field exclusion.
 */
export async function initSession(backendOrigin, sessionId) {
    console.log(`[${EXTENSION_NAME}] Initializing session ${sessionId} with character data...`);
    updateStatus('Initializing session...', '#f0ad4e');

    // Build the payload (needed for both bypass and real mode)
    const initPayload = buildInitPayload();

    // --- BYPASS MODE: log what we would have sent, don't actually call Agent ---
    if (isBypassMode()) {
        console.log(`[${EXTENSION_NAME}] [BYPASS] initSession SKIPPED for ${sessionId}. Would have POSTed:`);
        console.log(`[${EXTENSION_NAME}] [BYPASS] URL: ${backendOrigin}/api/sessions/${sessionId}/init`);
        console.log(`[${EXTENSION_NAME}] [BYPASS] Payload:`, JSON.stringify(initPayload, null, 2));
        return;
    }

    try {
        const resp = await fetch(`${backendOrigin}/api/sessions/${sessionId}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initPayload),
        });

        if (resp.ok) {
            console.log(`[${EXTENSION_NAME}] Session ${sessionId} initialized with character data.`);
            state.context.chatMetadata[META_KEY_INITIALIZED] = true;
            await state.context.saveMetadata();
            updateStatus('Session initialized', '#5cb85c');
        } else {
            console.warn(`[${EXTENSION_NAME}] Session init returned ${resp.status}. Will retry on next request.`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Session init failed (Agent may be starting up):`, err.message);
    }
}
