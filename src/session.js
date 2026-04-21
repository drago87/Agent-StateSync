// session.js — Agent-StateSync Session Management
//
// Handles proactive chat-changed hook, session creation/attachment,
// and initialization with character or group data.
// File Version: 1.0.2

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
    CHAR_CONFIG_EXT_KEY,
    getSettings, isBypassMode, syncConfigToAgent, updateStatus,
} from './settings.js';
import { getAgentOrigin } from './agent-url.js';
import { loadGroupData } from './groups.js';
import { getCharInitType, getCharInitNames, getCharPromptOverrides, getCharTrackedFieldAdditions, getTrackedFieldAdditionsForChar, getPromptOverridesForChar } from './char-config.js';
import { buildPromptSettingsPayload } from './settings.js';
import { getTrackedFieldsForPayload } from './tracked-fields.js';

// #############################################
// # 14. Proactive Chat-Changed Hook
// #############################################

/**
 * Called when SillyTavern fires the 'chat-changed' event.
 * Proactively checks if the Agent already has a session for the new chat.
 * If yes: silently link to it and hide the init button.
 * If no:  set flag so the init button becomes visible.
 *
 * NO popups. NO auto-creation. NO auto-init.
 * The user controls session creation via the Init Session button.
 */
export async function proactiveChatChanged() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const origin = getAgentOrigin();
    if (!origin) {
        console.log(`[${EXTENSION_NAME}] Chat changed but no Agent URL - will set up on first request`);
        state.sessionInitialized = false;
        return;
    }

    if (state.proactiveInProgress) {
        console.log(`[${EXTENSION_NAME}] Proactive chat-changed already in progress, skipping`);
        return;
    }
    state.proactiveInProgress = true;

    try {
        updateStatus('Loading chat data...', '#5cb0de');

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
            state.sessionInitialized = false;
            updateStatus('No chat ID', '#f0ad4e');
            return;
        }

        return proactiveChatChangedWithId(origin, chatId);

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive chat-changed error:`, err);
        state.sessionInitialized = false;
        updateStatus('Chat setup failed', '#d9534f');
    } finally {
        state.proactiveInProgress = false;
    }
}

/**
 * Continue proactive session setup now that we have a valid chatId.
 * Silent: no popups, no auto-creation, no auto-init.
 * Just checks Agent DB and sets state flags for the UI.
 */
async function proactiveChatChangedWithId(origin, chatId) {
    try {
        // --- Load group data NOW that we have a valid chatId ---
        try {
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Group data load failed (single-char fallback):`, e.message);
        }

        // --- BYPASS MODE ---
        if (isBypassMode()) {
            console.log(`[${EXTENSION_NAME}] [BYPASS] Proactive setup skipped for chat ${chatId}`);
            state.sessionInitialized = true;
            updateStatus('Bypass mode', '#5bc0de');
            return;
        }

        // Pre-flight: check if Agent is reachable
        try {
            const healthResp = await fetch(`${origin}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            });
            if (!healthResp.ok) throw new Error(`Agent returned ${healthResp.status}`);
        } catch (e) {
            console.log(`[${EXTENSION_NAME}] Agent not reachable yet, deferring session setup to first request`);
            state.sessionInitialized = false;
            updateStatus('Waiting for Agent...', '#f0ad4e');
            return;
        }

        // --- Check local metadata for existing session ---
        const existingSessionId = state.context.chatMetadata?.[META_KEY_SESSION];

        // --- Ask the Agent if it has a session for this ST chat ID ---
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

        // --- Determine what to do (SILENT — no popups) ---
        if (agentSessionId) {
            // Agent already has a session for this chat — silently link to metadata
            state.context.chatMetadata = state.context.chatMetadata || {};
            state.context.chatMetadata[META_KEY_SESSION] = agentSessionId;
            state.context.chatMetadata[META_KEY_INITIALIZED] = true;
            await state.context.saveMetadata();
            state.sessionInitialized = true;

            // Sync config
            state.configSynced = false;
            try { await syncConfigToAgent(getSettings(), origin); } catch (_) {}

            const shortId = agentSessionId.substring(0, 8);
            updateStatus(`Session ${shortId}...`, '#5cb85c');
            console.log(`[${EXTENSION_NAME}] Silently linked to existing session: ${agentSessionId}`);

        } else if (existingSessionId) {
            // Local metadata has a session but Agent doesn't know about this chat ID.
            // Try to re-link, then consider it initialized (init data was sent before).
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
            state.sessionInitialized = true;

            state.configSynced = false;
            try { await syncConfigToAgent(getSettings(), origin); } catch (_) {}

            const shortId = existingSessionId.substring(0, 8);
            updateStatus(`Session ${shortId}...`, '#5cb85c');
            console.log(`[${EXTENSION_NAME}] Existing session re-linked: ${existingSessionId}`);

        } else {
            // No session anywhere — user needs to click Init Session button
            state.sessionInitialized = false;
            console.log(`[${EXTENSION_NAME}] No session for chat ${chatId} — Init button visible`);
            updateStatus('No session', '#f0ad4e');
        }

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive chat-changed error:`, err);
        state.sessionInitialized = false;
        updateStatus('Chat setup failed', '#d9534f');
    } finally {
        state.proactiveInProgress = false;
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

    const desc = state.context.personaDescription || '';
    if (desc) persona.description = desc;

    return Object.keys(persona).length > 0 ? persona : undefined;
}

/**
 * Get the first message for a character from the chat history.
 */
function getFirstMesFromChat(charName) {
    const chat = state.context.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    if (charName) {
        for (const msg of chat) {
            if (!msg.is_user && msg.name === charName && msg.mes) {
                return msg.mes;
            }
        }
        return null;
    }

    for (const msg of chat) {
        if (!msg.is_user && msg.mes) {
            return msg.mes;
        }
    }

    return null;
}

/**
 * Read the char config (type + names) stored in a character card's extensions.
 */
function readMemberCharConfig(charObj) {
    if (!charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]) {
        return { type: 'character', names: [] };
    }

    const stored = charObj.data.extensions[CHAR_CONFIG_EXT_KEY];
    if (stored.mode === 'scenario') {
        return { type: 'scenario', names: [] };
    }

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
        member.scenario = cardData;
    } else {
        member.character = cardData;
    }
	
	// Add per-character tracked field additions (if any)
    const charTFAdditions = getTrackedFieldAdditionsForChar(charObj);
    if (charTFAdditions) {
        member.tracked_fields_additions = charTFAdditions;
    }
	
	// Add per-character prompt overrides (if any)
    const charPromptOverrides = getPromptOverridesForChar(charObj);
    if (charPromptOverrides) {
        member.prompt_overrides = charPromptOverrides;
    }

    return member;
}

/**
 * Build the full init payload for POST /api/sessions/{id}/init
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
    const cardType = getCharInitType();
    const cardNames = getCharInitNames();
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

    if (cardType === 'multi-character' && cardNames.length > 0) {
        payload.character_names = cardNames.join(', ');
    }

    if (cardType === 'scenario') {
        payload.scenario = cardData;
    } else {
        payload.character = cardData;
    }

    if (persona) {
        payload.persona = persona;
    }

    // Tracked fields for the Agent's state database
    const trackedFields = getTrackedFieldsForPayload();

    // Merge per-character tracked field additions
    const charAdditions = getCharTrackedFieldAdditions();
    if (charAdditions) {
        trackedFields.character = { ...trackedFields.character, ...charAdditions };
    }

    if (trackedFields) {
        payload.tracked_fields = trackedFields;
    }

    // Prompt settings (global merged with char overrides)
    const promptSettings = buildPromptSettingsPayload(getCharPromptOverrides());
    if (promptSettings) {
        payload.prompt_settings = promptSettings;
    }

    console.log(`[${EXTENSION_NAME}] Single-char init: type=${cardType}, name="${cardName}"`);

    return payload;
}

/**
 * Build init payload for a group chat.
 */
function buildGroupInitPayload() {
    const members = state.activeGroupCharacters.filter(c => !c._unresolved);

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

    const sortedMembers = [...members];
    sortedMembers.sort((a, b) => {
        const idxA = nameToFirstIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const idxB = nameToFirstIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        if (idxA === Number.MAX_SAFE_INTEGER && idxB === Number.MAX_SAFE_INTEGER) return 0;
        return idxA - idxB;
    });

    const groupScenarioMember = sortedMembers.find(m => {
        const config = readMemberCharConfig(m);
        return config.type === 'scenario';
    });

    const groupScenario = groupScenarioMember?.scenario || '';

    const memberPayloads = sortedMembers.map(m => {
        const firstMes = getFirstMesFromChat(m.name);
        const member = buildGroupMemberPayload(m, firstMes);

        if (groupScenario && member.scenario) {
            delete member.scenario;
        }

        return member;
    });

    const payload = {
        is_group: true,
        group_name: state.activeGroup.name,
        group_members: memberPayloads,
    };

    if (groupScenario) {
        payload.group_scenario = groupScenario;
    }

    const persona = buildPersona();
    if (persona) {
        payload.persona = persona;
    }

    // Tracked fields for the Agent's state database
    const trackedFields = getTrackedFieldsForPayload();

    // Merge per-character tracked field additions (use first active member)
    const charAdditions = getCharTrackedFieldAdditions();
    if (charAdditions) {
        trackedFields.character = { ...trackedFields.character, ...charAdditions };
    }

    if (trackedFields) {
        payload.tracked_fields = trackedFields;
    }

    // Prompt settings (global merged with char overrides)
    const promptSettings = buildPromptSettingsPayload(getCharPromptOverrides());
    if (promptSettings) {
        payload.prompt_settings = promptSettings;
    }

    console.log(`[${EXTENSION_NAME}] Group init: "${state.activeGroup.name}" with ${memberPayloads.length} members`);
    console.log(`[${EXTENSION_NAME}] group_scenario: ${groupScenario ? 'yes' : 'no'}`);

    return payload;
}

/**
 * Send character card + persona data to the Agent for initial world-state parsing.
 */
export async function initSession(backendOrigin, sessionId) {
    console.log(`[${EXTENSION_NAME}] Initializing session ${sessionId} with character data...`);
    updateStatus('Initializing session...', '#f0ad4e');

    const initPayload = buildInitPayload();

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
            return true;
        } else {
            console.warn(`[${EXTENSION_NAME}] Session init returned ${resp.status}.`);
            return false;
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Session init failed (Agent may be starting up):`, err.message);
        return false;
    }
}

/**
 * Manually send the init payload to the Agent.
 * Triggered by the Init Session button in the GG menu.
 * Creates a session if one doesn't exist yet, then sends character/group data.
 *
 * @returns {boolean} true if init succeeded, false otherwise
 */
export async function manualInitSession() {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr.info('Enable State Sync first.', 'Agent-StateSync');
        return false;
    }

    const origin = getAgentOrigin();
    if (!origin) {
        toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
        return false;
    }

    let sessionId = state.context.chatMetadata?.[META_KEY_SESSION];

    // Create session if one doesn't exist yet
    if (!sessionId) {
        const chatId = typeof state.context.getCurrentChatId === 'function'
            ? state.context.getCurrentChatId() : null;

        try {
            updateStatus('Creating session...', '#f0ad4e');

            const resp = await fetch(`${origin}/api/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ st_chat_id: chatId || '' }),
            });

            if (!resp.ok) throw new Error(`Session API returned ${resp.status}`);
            const data = await resp.json();
            if (!data.session_id) throw new Error('Invalid session response');

            sessionId = data.session_id;

            state.context.chatMetadata = state.context.chatMetadata || {};
            state.context.chatMetadata[META_KEY_SESSION] = sessionId;
            state.context.chatMetadata[META_KEY_COUNTER] = 0;
            await state.context.saveMetadata();

            console.log(`[${EXTENSION_NAME}] Manual session created: ${sessionId}`);
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Manual session creation failed:`, err);
            toastr.error(`Session creation failed: ${err.message}`, 'Agent-StateSync');
            updateStatus('Session creation failed', '#d9534f');
            return false;
        }
    }

    // Send init payload
    const success = await initSession(origin, sessionId);

    if (success) {
        state.sessionInitialized = true;
        const shortId = sessionId.substring(0, 8);
        const chatLabel = state.isGroupChat && state.activeGroup
            ? `Group "${state.activeGroup.name}"`
            : `"${state.context.name2 || 'Unknown'}"`;
        toastr.success(`Initialized: ${chatLabel} (${shortId}...)`, 'Agent-StateSync');
    } else {
        toastr.error('Init failed — check console (F12)', 'Agent-StateSync');
    }

    // Sync config after init
    state.configSynced = false;
    await syncConfigToAgent(settings, origin);

    return success;
}