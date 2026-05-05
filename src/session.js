// session.js — Agent-StateSync Session Lifecycle Management
//
// Handles proactive chat-changed hook, session creation/attachment,
// and initialization with character or group data.
//
// The payload builder logic lives in init-payload.js.
//
// v3.0 — New init payload format:
//   - Card types: plain character, scenario, multi-character
//   - first_mes from chat messages (not card field)
//   - Group chat: members ordered by first message in chat
//   - group_scenario logic: include at top or per-member
//   - Empty fields excluded from payload
//   - _chat_info with chatName-/groupName-prefixed chat_id
//
// Health guards (manual init):
//   - RP LLM status is ignored for init (only matters for message generation)
//   - At least one Instruct backend must be "Healthy" for init to proceed
//   - If some Instruct backends are unhealthy but at least one is Healthy,
//     init proceeds with a warning (may go slower)
//   - If NO Instruct backends are Healthy, init is blocked with an error
// File Version: 1.9.0

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
    getSettings, isBypassMode, syncConfigToAgent, storeLlmConfig,
    updateStatus,
} from './settings.js';
import { getAgentOrigin, fetchLlmConfig } from './agent-url.js';
import { loadGroupData, getFreshContext } from './groups.js';
import { buildInitPayload, getSessionIdentity } from './init-payload.js';
import { startNotificationPolling } from './notifications.js';

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
        updateStatus('Loading chat data...', '#5bc0de');

        const chatId = typeof getFreshContext().getCurrentChatId === 'function'
            ? getFreshContext().getCurrentChatId()
            : (typeof state.context.getCurrentChatId === 'function'
                ? state.context.getCurrentChatId()
                : null);

        if (!chatId) {
            console.log(`[${EXTENSION_NAME}] No chat ID yet, retrying...`);
            for (let attempt = 1; attempt <= 3; attempt++) {
                await new Promise(r => setTimeout(r, 1000));
                const retryCtx = getFreshContext();
                const retryId = typeof retryCtx.getCurrentChatId === 'function'
                    ? retryCtx.getCurrentChatId()
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
        try {
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Group data load failed (single-char fallback):`, e.message);
        }

        // --- Get session identity using the same logic as buildChatInfo ---
        const identity = getSessionIdentity();
        const stChatId = identity.st_chat_id || chatId;  // fallback to raw chatId
        const chatName = identity.name;

        // --- BYPASS MODE: skip all Agent communication ---
        if (isBypassMode()) {
            console.log(`[${EXTENSION_NAME}] [BYPASS] Proactive setup skipped for chat ${stChatId} (${chatName})`);
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
        // Use getFreshContext() to get the CURRENT chatMetadata — state.context.chatMetadata
        // may point to a previous chat's metadata after a character switch.
        const freshCtx = getFreshContext();
        const existingSessionId = freshCtx.chatMetadata?.[META_KEY_SESSION]
            || state.context.chatMetadata?.[META_KEY_SESSION];

        // Step 3: Ask the Agent if it has a session for this ST chat ID
        let agentSessionId = null;
        try {
            const resp = await fetch(
                `${origin}/api/sessions/by-chat?st_chat_id=${encodeURIComponent(stChatId)}`
            );

            if (resp.ok) {
                const data = await resp.json();
                agentSessionId = data.session_id || null;
                console.log(`[${EXTENSION_NAME}] Agent session lookup for chat "${stChatId}" (${chatName}): ${agentSessionId || 'none'}`);
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
                    body: JSON.stringify({ st_chat_id: stChatId, name: chatName }),
                });
                console.log(`[${EXTENSION_NAME}] Re-linked session ${existingSessionId} to chat ${stChatId} (${chatName})`);
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] Failed to re-link session:`, e.message);
            }
            // Re-init with current character data
            await initSession(origin, existingSessionId);
            updateStatus(`Session ${existingSessionId.substring(0, 8)}...`, '#5cb85c');
        } else {
            // No session anywhere - ask user if they want to create one
            await showNewChatConfirm(origin, stChatId, chatName);
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
        // Use getFreshContext() to get CURRENT chatMetadata — state.context.chatMetadata
        // may be stale after a character switch.
        const attachCtx = getFreshContext();
        const attachMeta = attachCtx.chatMetadata || state.context.chatMetadata || {};
        attachMeta[META_KEY_SESSION] = sessionId;
        attachMeta[META_KEY_INITIALIZED] = false;
        state.context.chatMetadata = attachMeta;  // keep stale ref in sync
        await (attachCtx.saveMetadata || state.context.saveMetadata)();

        // Re-initialize with current character/group data
        await initSession(origin, sessionId);

        // Sync config
        state.configSynced = false;
        await syncConfigToAgent(getSettings(), origin);

        // Fetch the Agent's LLM config (may have changed since last connection)
        await fetchLlmConfig();

        const shortId = sessionId.substring(0, 8);
        const chatLabel = state.isGroupChat && state.activeGroup
            ? `Group "${state.activeGroup.name}"`
            : `"${getFreshContext().name2 || 'Unknown'}"`;
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
 * Show an informational popup when a new chat is detected.
 * No auto-creation — reminds the user to press the Init button manually.
 */
async function showNewChatConfirm(origin, stChatId, chatName) {
    const chatLabel = state.isGroupChat && state.activeGroup
        ? `Group "${state.activeGroup.name}" (${state.activeGroupCharacters.length} members)`
        : `Character "${getFreshContext().name2 || 'Unknown'}"`;

    // Check Instruct backend health for warnings
    // RP LLM status is ignored for init — only Instruct backends matter
    const instructBackends = state.agentLlmConfig.instruct_backends;
    const healthyCount = instructBackends.filter(b => b.health === 'Healthy').length;
    const totalCount = instructBackends.length;

    let warningHtml = '';
    if (healthyCount === 0) {
        if (totalCount === 0) {
            warningHtml += `<p style="margin:0 0 8px 0; color:#d9534f;"><i class="fa-solid fa-circle-xmark"></i> No Instruct LLM backends detected. At least one must be Healthy to initialize.</p>`;
        } else {
            warningHtml += `<p style="margin:0 0 8px 0; color:#d9534f;"><i class="fa-solid fa-circle-xmark"></i> No healthy Instruct LLM backend. At least one must be Healthy to initialize.</p>`;
        }
    } else if (healthyCount < totalCount) {
        const unhealthyNames = instructBackends
            .filter(b => b.health !== 'Healthy')
            .map(b => b.alias || 'unknown')
            .join(', ');
        warningHtml += `<p style="margin:0 0 8px 0; color:#f0ad4e;"><i class="fa-solid fa-triangle-exclamation"></i> ${totalCount - healthyCount} Instruct LLM(s) not healthy: ${unhealthyNames}. Init may be slower.</p>`;
    }

    const popupHtml = `
        <div style="text-align:center; padding:8px 0;">
            <h3 style="margin:0 0 8px 0;">
                <i class="fa-solid fa-plug" style="color:#5bc0de;"></i>
                Agent-StateSync
            </h3>
            <p style="margin:0 0 4px 0;"><b>New chat detected:</b></p>
            <p style="margin:0 0 12px 0; color:var(--fg_dim);">${chatLabel}</p>
            ${warningHtml}
            <p style="margin:0 0 12px 0;">Remember to initialize the chat before starting to chat.</p>
            <p style="margin:0 0 12px 0; font-size:11px; color:var(--fg_dim);">
                Press the Rocket button to initialize the chat with the Agent with this chat's character/group data.
            </p>
        </div>
    `;

    // Use ST's built-in callPopup with a single OK button
    const popupFn = window.callPopup || state.context.callPopup;
    if (typeof popupFn === 'function') {
        try {
            await popupFn(popupHtml, 'text');
            updateStatus('No session (not initialized)', '#f0ad4e');
            return;
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] callPopup failed:`, e.message);
        }
    }

    // Fallback: just log it
    console.log(`[${EXTENSION_NAME}] New chat detected (no popup): ${chatLabel}`);
    updateStatus('No session (not initialized)', '#f0ad4e');
}

/**
 * Create a new Agent session linked to the current ST chat ID,
 * then initialize it with character/group data.
 *
 * The Agent's response may include LLM config (rp_llm and instruct_backends),
 * which STe stores for display purposes.
 */
async function createAndInitSession(origin, stChatId, chatName) {
    try {
        updateStatus('Creating session...', '#f0ad4e');

        const resp = await fetch(`${origin}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ st_chat_id: stChatId, name: chatName }),
        });

        if (!resp.ok) throw new Error(`Session API returned ${resp.status}`);

        const data = await resp.json();
        if (!data.session_id) throw new Error('Invalid session response');

        const sessionId = data.session_id;
        console.log(`[${EXTENSION_NAME}] Created session ${sessionId} for chat ${stChatId} (${chatName})`);

        // Parse LLM config from the Agent's session creation response if included.
        if (data.rp_llm || data.instruct_backends) {
            storeLlmConfig(data);
            console.log(`[${EXTENSION_NAME}] LLM config received from session creation response.`);
        }

        // Save to metadata — use fresh context to get CURRENT chatMetadata
        const createCtx = getFreshContext();
        const createMeta = createCtx.chatMetadata || state.context.chatMetadata || {};
        createMeta[META_KEY_SESSION] = sessionId;
        createMeta[META_KEY_COUNTER] = 0;
        state.context.chatMetadata = createMeta;  // keep stale ref in sync
        await (createCtx.saveMetadata || state.context.saveMetadata)();

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
    // (manualInitSession and pipeline already call loadGroupData(),
    //  so this is just a safety net for edge cases)
    if (!state.cachedGroups && !state.isGroupChat) {
        try {
            console.log(`[${EXTENSION_NAME}] ensureSession: loading group data (proactive may have missed it)`);
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] ensureSession: group data load failed, single-char fallback`, e.message);
        }
    }

    // --- Check if session already exists in metadata ---
    // Use getFreshContext() to get CURRENT chatMetadata — state.context.chatMetadata
    // may be stale after a character switch.
    const freshCtx = getFreshContext();
    const currentMeta = freshCtx.chatMetadata || state.context.chatMetadata;
    if (currentMeta && currentMeta[META_KEY_SESSION]) {
        if (!currentMeta[META_KEY_INITIALIZED]) {
            await initSession(backendOrigin, currentMeta[META_KEY_SESSION]);
        }
        return currentMeta[META_KEY_SESSION];
    }

    // --- Create new session (fallback - proactive should handle this) ---
    console.log(`[${EXTENSION_NAME}] No session ID (proactive missed). Creating session...`);
    try {
        const identity = getSessionIdentity();

        const resp = await fetch(`${backendOrigin}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ st_chat_id: identity.st_chat_id, name: identity.name }),
        });

        if (!resp.ok) throw new Error(`Session API returned ${resp.status}`);

        const data = await resp.json();
        if (!data.session_id) throw new Error('Invalid session response');

        const sessionId = data.session_id;
        console.log(`[${EXTENSION_NAME}] Fallback session created: ${sessionId}`);

        // Parse LLM config from the response
        if (data.rp_llm || data.instruct_backends) {
            storeLlmConfig(data);
        }

        // Save to metadata — use fresh context to get CURRENT chatMetadata
        const fallbackCtx = getFreshContext();
        const fallbackMeta = fallbackCtx.chatMetadata || state.context.chatMetadata || {};
        fallbackMeta[META_KEY_SESSION] = sessionId;
        fallbackMeta[META_KEY_COUNTER] = 0;
        state.context.chatMetadata = fallbackMeta;  // keep stale ref in sync
        await (fallbackCtx.saveMetadata || state.context.saveMetadata)();

        await initSession(backendOrigin, sessionId);

        return sessionId;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Fallback session creation failed:`, err);
        throw err;
    }
}

/**
 * Manual init — called when user clicks the Init button (rocket) or runs /ass-init.
 * Creates a session if needed, initializes it, and starts polling.
 *
 * ALWAYS reloads group data before building the payload to ensure
 * the correct character/group is used, even if the proactive setup
 * was missed or used stale data.
 *
 * Health guards:
 *   - RP LLM status is ignored (only relevant for message generation, not init).
 *   - If at least one Instruct backend is healthy, init proceeds.
 *     If some are unhealthy, a warning is shown (may be slower).
 *   - If NO Instruct backends are healthy, init is blocked with an error.
 *
 * @returns {boolean} true if successful
 */
export async function manualInitSession() {
    const origin = getAgentOrigin();
    if (!origin) {
        toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
        return false;
    }

    // --- Always reload group data to ensure correct character/group ---
    // The proactive setup may have used stale data or been missed entirely.
    // This ensures /ass-init always gets the right chat mode.
    try {
        await loadGroupData();
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Group data reload failed (single-char fallback):`, e.message);
    }

    // --- Check Instruct backend health (required for init) ---
    // Init requires at least one Healthy Instruct LLM to process the payload.
    // - All healthy  → proceed normally
    // - Some healthy → proceed with warning (may be slower)
    // - None healthy → block init with error
    const instructBackends = state.agentLlmConfig.instruct_backends;
    const healthyCount = instructBackends.filter(b => b.health === 'Healthy').length;
    const totalCount = instructBackends.length;

    if (healthyCount === 0) {
        // No healthy Instruct backends — block init
        if (totalCount === 0) {
            toastr.error(
                'No Instruct LLM backends detected. At least one must be Healthy to initialize.',
                'Agent-StateSync'
            );
        } else {
            const statuses = instructBackends.map(b => `${b.alias || 'unknown'}: ${b.health}`).join(', ');
            toastr.error(
                `No healthy Instruct LLM backend (${statuses}). At least one must be Healthy to initialize.`,
                'Agent-StateSync'
            );
        }
        updateStatus('Init blocked — no healthy Instruct LLM', '#d9534f');
        return false;
    } else if (healthyCount < totalCount) {
        // Some but not all healthy — proceed with warning
        const unhealthyNames = instructBackends
            .filter(b => b.health !== 'Healthy')
            .map(b => `${b.alias || 'unknown'} (${b.health})`)
            .join(', ');
        toastr.warning(
            `${totalCount - healthyCount} Instruct LLM(s) not healthy: ${unhealthyNames}. Init will proceed but may be slower.`,
            'Agent-StateSync'
        );
    }
    // If all healthy, no warning needed — proceed silently

    try {
        const sessionId = await ensureSession(origin);

        if (!sessionId) {
            toastr.error('Failed to create session.', 'Agent-StateSync');
            return false;
        }

        // Initialize with current character/group data
        await initSession(origin, sessionId);

        // Sync config
        state.configSynced = false;
        await syncConfigToAgent(getSettings(), origin);

        // Fetch the Agent's LLM config
        await fetchLlmConfig();

        // Start notification polling
        startNotificationPolling();

        state.sessionInitialized = true;

        const shortId = sessionId.substring(0, 8);
        toastr.success(`Session initialized: ${shortId}...`, 'Agent-StateSync');
        updateStatus(`Session ${shortId}...`, '#5cb85c');
        return true;
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Manual init failed:`, err);
        toastr.error(`Init failed: ${err.message}`, 'Agent-StateSync');
        updateStatus('Init failed', '#d9534f');
        return false;
    }
}

// #############################################
// # Session Init (sends payload to Agent)
// #############################################

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
    // buildInitPayload() is async because it may need to unshallow character data
    const initPayload = await buildInitPayload();

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
            // Use fresh context for chatMetadata — state.context.chatMetadata may be stale
            const initCtx = getFreshContext();
            const initMeta = initCtx.chatMetadata || state.context.chatMetadata;
            if (initMeta) initMeta[META_KEY_INITIALIZED] = true;
            await (initCtx.saveMetadata || state.context.saveMetadata)();
            updateStatus('Session initialized', '#5cb85c');
        } else {
            console.warn(`[${EXTENSION_NAME}] Session init returned ${resp.status}. Will retry on next request.`);
        }
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Session init failed (Agent may be starting up):`, err.message);
    }
}