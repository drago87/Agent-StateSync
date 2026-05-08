// session.js — Agent-StateSync Session Lifecycle Management
// File Version: 2.0.0
//
// Handles proactive chat-changed hook and initialization with
// character or group data via POST /api/init.
//
// The payload builder logic lives in init-payload.js.
//
// v2.0 — Simplified session model:
//   - No more session creation/lookup endpoints
//   - Init button sends POST /api/init with full payload
//   - Agent processes init asynchronously, reports status via ping
//   - current_chat_id (from _chat_info) serves as the session identifier
//
// Init flow:
//   1. User presses Init button → manualInitSession()
//   2. STe sends POST /api/init with character/group data
//   3. state.initializing = true, pings include "initializing": true
//   4. Agent processes the init payload (may take time)
//   5. Agent responds to ping with current_chat_id_status.initialized:
//      - "false" → still processing (keep pinging)
//      - "true"  → init complete (toast success, session ready)
//      - "failed" → init failed (toast error with failed_message)
//   6. After "true" or "failed", pings return to normal format
//
// Health guards (manual init):
//   - RP LLM status is ignored for init (only matters for message generation)
//   - At least one Instruct backend must be "Healthy" for init to proceed
//   - If some Instruct backends are unhealthy but at least one is Healthy,
//     init proceeds with a warning (may go slower)
//   - If NO Instruct backends are Healthy, init is blocked with an error

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_INITIALIZED, META_KEY_COUNTER,
    getSettings, isBypassMode, syncConfigToAgent, storeLlmConfig,
    updateStatus,
} from './settings.js';
import { getAgentOrigin, fetchLlmConfig } from './agent-url.js';
import { loadGroupData, getFreshContext } from './groups.js';
import { buildInitPayload, getCurrentChatId } from './init-payload.js';
import { startNotificationPolling } from './notifications.js';

// #############################################
// # Proactive Chat-Changed Hook
// #############################################

/**
 * Called when SillyTavern fires the 'chat-changed' event.
 * Does NOT auto-create or auto-initialize sessions.
 *
 * Flow:
 * 1. Load group data for the new chat
 * 2. Check if Agent is reachable
 * 3. If Agent is reachable, the next ping will report the session status
 *    for the current_chat_id (initiated/deleted/missing/error)
 * 4. If no session exists, show a reminder to press the Init button
 */
export async function proactiveChatChanged() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const origin = getAgentOrigin();
    if (!origin) {
        console.log(`[${EXTENSION_NAME}] Chat changed but no Agent URL — will check on first request`);
        return;
    }

    if (state.proactiveInProgress) {
        console.log(`[${EXTENSION_NAME}] Proactive chat-changed already in progress, skipping`);
        return;
    }
    state.proactiveInProgress = true;

    try {
        // Load group data for the new chat
        try {
            await loadGroupData();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Group data load failed (single-char fallback):`, e.message);
        }

        // --- BYPASS MODE: skip all Agent communication ---
        if (isBypassMode()) {
            const currentChatId = getCurrentChatId();
            console.log(`[${EXTENSION_NAME}] [BYPASS] Proactive check skipped for chat ${currentChatId}`);
            console.log(`[${EXTENSION_NAME}] [BYPASS] Group detection: isGroupChat=${state.isGroupChat}, activeGroup=${state.activeGroup ? state.activeGroup.name : '(none)'}`);
            updateStatus('Bypass mode', '#5bc0de');
            return;
        }

        // Check if Agent is reachable
        try {
            const healthResp = await fetch(`${origin}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            });
            if (!healthResp.ok) throw new Error(`Agent returned ${healthResp.status}`);
        } catch (e) {
            console.log(`[${EXTENSION_NAME}] Agent not reachable, will check again later`);
            state.sessionInitialized = false;
            updateStatus('Waiting for Agent...', '#f0ad4e');
            return;
        }

        // Agent is reachable — the ping cycle (started by health checks) will
        // report the session status for current_chat_id. We just need to
        // show the "press Init" popup if there's no initialized session.
        const freshCtx = getFreshContext();
        const isAlreadyInitialized = freshCtx.chatMetadata?.[META_KEY_INITIALIZED]
            || state.context.chatMetadata?.[META_KEY_INITIALIZED];

        if (isAlreadyInitialized && state.sessionInitialized) {
            // Already initialized from a previous session — no action needed
            console.log(`[${EXTENSION_NAME}] Chat already initialized, resuming`);
            updateStatus('Session active', '#5cb85c');
        } else {
            // Not initialized — remind the user to press Init
            state.sessionInitialized = false;
            await showNewChatConfirm();
        }

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Proactive chat-changed error:`, err);
        state.sessionInitialized = false;
        updateStatus('Chat setup failed', '#d9534f');
    } finally {
        state.proactiveInProgress = false;
    }
}

/**
 * Show an informational popup when a new chat is detected.
 * Reminds the user to press the Init button manually.
 */
async function showNewChatConfirm() {
    const chatLabel = state.isGroupChat && state.activeGroup
        ? `Group "${state.activeGroup.name}" (${state.activeGroupCharacters.length} members)`
        : `Character "${getFreshContext().name2 || 'Unknown'}"`;

    // Check Instruct backend health for warnings
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

    const popupFn = window.callPopup || state.context.callPopup;
    if (typeof popupFn === 'function') {
        try {
            await popupFn(popupHtml, 'text');
            updateStatus('Not initialized (press Rocket)', '#f0ad4e');
            return;
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] callPopup failed:`, e.message);
        }
    }

    console.log(`[${EXTENSION_NAME}] New chat detected (no popup): ${chatLabel}`);
    updateStatus('Not initialized (press Rocket)', '#f0ad4e');
}

// #############################################
// # Manual Init (Init button / Rocket)
// #############################################

/**
 * Manual init — called when user clicks the Init button (rocket).
 * Sends the full init payload to POST /api/init.
 *
 * The Agent processes the init asynchronously. STe sets state.initializing = true
 * and pings include "initializing": true. The Agent reports completion via
 * current_chat_id_status.initialized in the ping response:
 *   - "false"  → still processing
 *   - "true"   → init complete
 *   - "failed" → init failed (with failed_message)
 *
 * ALWAYS reloads group data before building the payload to ensure
 * the correct character/group is used.
 *
 * Health guards:
 *   - RP LLM status is ignored (only relevant for message generation, not init).
 *   - If at least one Instruct backend is healthy, init proceeds.
 *   - If NO Instruct backends are healthy, init is blocked with an error.
 *
 * @returns {boolean} true if the init request was sent successfully
 */
export async function manualInitSession() {
    const origin = getAgentOrigin();
    if (!origin) {
        toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
        return false;
    }

    // Prevent double-init
    if (state.initializing) {
        toastr.info('Initialization already in progress. Waiting for Agent to complete...', 'Agent-StateSync');
        return false;
    }

    // Always reload group data to ensure correct character/group
    try {
        await loadGroupData();
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Group data reload failed (single-char fallback):`, e.message);
    }

    // Check Instruct backend health (required for init)
    const instructBackends = state.agentLlmConfig.instruct_backends;
    const healthyCount = instructBackends.filter(b => b.health === 'Healthy').length;
    const totalCount = instructBackends.length;

    if (healthyCount === 0) {
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
        const unhealthyNames = instructBackends
            .filter(b => b.health !== 'Healthy')
            .map(b => `${b.alias || 'unknown'} (${b.health})`)
            .join(', ');
        toastr.warning(
            `${totalCount - healthyCount} Instruct LLM(s) not healthy: ${unhealthyNames}. Init will proceed but may be slower.`,
            'Agent-StateSync'
        );
    }

    try {
        // Build the init payload
        updateStatus('Building init payload...', '#5bc0de');
        const initPayload = await buildInitPayload();

        // --- BYPASS MODE: log what we would have sent ---
        if (isBypassMode()) {
            console.log(`[${EXTENSION_NAME}] [BYPASS] Init SKIPPED. Would have POSTed:`);
            console.log(`[${EXTENSION_NAME}] [BYPASS] URL: ${origin}/api/init`);
            console.log(`[${EXTENSION_NAME}] [BYPASS] Payload:`, JSON.stringify(initPayload, null, 2));
            state.initializing = false;
            state.sessionInitialized = true;  // Pretend it worked in bypass mode
            updateStatus('Bypass init (simulated)', '#5bc0de');
            return true;
        }

        // Send POST /api/init
        updateStatus('Sending init to Agent...', '#f0ad4e');
        console.log(`[${EXTENSION_NAME}] Sending POST /api/init with payload for chat ${getCurrentChatId()}`);

        const resp = await fetch(`${origin}/api/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initPayload),
        });

        if (!resp.ok) {
            const errorText = await resp.text().catch(() => '');
            throw new Error(`Init returned ${resp.status}${errorText ? ': ' + errorText : ''}`);
        }

        // Parse response — may include LLM config
        const data = await resp.json().catch(() => ({}));
        if (data && (data.rp_llm || data.instruct_backends)) {
            storeLlmConfig(data);
        }

        // Mark as initializing — the Agent will report completion via ping
        state.initializing = true;
        state.sessionInitialized = false;

        // Mark metadata as initialized (optimistic — ping will confirm)
        const freshCtx = getFreshContext();
        const meta = freshCtx.chatMetadata || state.context.chatMetadata || {};
        meta[META_KEY_INITIALIZED] = false;  // Not yet confirmed
        meta[META_KEY_COUNTER] = 0;
        state.context.chatMetadata = meta;
        try { await (freshCtx.saveMetadata || state.context.saveMetadata)(); } catch (e) { /* ignore */ }

        // Sync config
        state.configSynced = false;
        await syncConfigToAgent(getSettings(), origin);

        // Fetch the Agent's LLM config
        await fetchLlmConfig();

        // Start notification polling (pings will include "initializing": true)
        startNotificationPolling();

        toastr.info('Init sent to Agent. Waiting for processing to complete...', 'Agent-StateSync');
        updateStatus('Initializing (waiting for Agent)...', '#f0ad4e');
        return true;

    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Manual init failed:`, err);
        toastr.error(`Init failed: ${err.message}`, 'Agent-StateSync');
        state.initializing = false;
        state.sessionInitialized = false;
        updateStatus('Init failed', '#d9534f');
        return false;
    }
}
