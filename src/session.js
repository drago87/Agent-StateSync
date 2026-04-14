// session.js — Agent-StateSync Session Management
//
// Handles proactive chat-changed hook, session creation/attachment,
// and initialization with character or group data.

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
    getSettings, isBypassMode, syncConfigToAgent, updateStatus,
} from './settings.js';
import { getAgentOrigin } from './agent-url.js';
import { loadGroupData } from './groups.js';

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

/**
 * Send character card + persona data to the Agent for initial world-state parsing.
 * In group mode, sends all group members instead of a single character.
 */
export async function initSession(backendOrigin, sessionId) {
    console.log(`[${EXTENSION_NAME}] Initializing session ${sessionId} with character data...`);
    updateStatus('Initializing session...', '#f0ad4e');

    // Build the payload (needed for both bypass and real mode)
    let initPayload;

    if (state.isGroupChat && state.activeGroupCharacters.length > 0) {
        // Group mode: send all member character cards
        const members = state.activeGroupCharacters
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
            group_name: state.activeGroup.name,
            group_members: members,
            persona_name: state.context.name1 || '',
            persona_description: state.context.personaDescription || '',
            is_group: true,
        };

        console.log(`[${EXTENSION_NAME}] Group init: "${state.activeGroup.name}" with ${members.length} members`);
    } else {
        // Single character mode
        initPayload = {
            character_name: state.context.name2 || '',
            character_description: state.context.description || '',
            character_personality: state.context.personality || '',
            character_scenario: state.context.scenario || '',
            character_first_mes: state.context.first_mes || '',
            character_mes_example: state.context.mes_example || '',
            persona_name: state.context.name1 || '',
            persona_description: state.context.personaDescription || '',
            is_group: false,
        };
    }

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
