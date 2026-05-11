// notifications.js — Agent-StateSync Notification Polling
// File Version: 2.0.0
//
// Polls the Agent's POST /api/ping endpoint for session status and
// push notifications.
//
// Ping request format (during initialization):
//   { last_changed: "...", current_chat_id: "...", initializing: true }
//
// Ping request format (after initialization):
//   { last_changed: "...", current_chat_id: "..." }
//
// Ping response format (during initialization):
//   { config_changed: true|false,
//     current_chat_id_status: { current_chat_id, initialized: "true"|"false"|"failed",
//                               failed_message: "..." (optional) } }
//
// Ping response format (after initialization):
//   { config_changed: true|false,
//     current_chat_id_status: { current_chat_id, status: "initiated"|"deleted"|"missing"|"error" } }
//
// Push notifications:
//   POST /api/notifications/ack  →  acknowledges each processed notification

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_INITIALIZED, META_KEY_COUNTER,
    getSettings, isBypassMode, updateStatus,
} from './settings.js';
import { getAgentOrigin } from './agent-url.js';
import { getCurrentChatId } from './init-payload.js';

// #############################################
// # Polling State
// #############################################

let pollTimerId = null;
const POLL_INTERVAL_MS = 3000; // 3 seconds
const INIT_POLL_INTERVAL_MS = 3000; // 3 seconds while initializing (same — always fast)

// #############################################
// # Polling Control
// #############################################

/**
 * Start polling the Agent for notifications.
 * Safe to call multiple times — won't create duplicate timers.
 */
export function startNotificationPolling() {
    stopNotificationPolling();
    scheduleNextPoll();
}

/**
 * Stop polling. Called when session is deleted or extension disabled.
 */
export function stopNotificationPolling() {
    if (pollTimerId !== null) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
    }
}

function scheduleNextPoll() {
    // Use faster interval while initializing for quicker feedback
    const interval = state.initializing ? INIT_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    pollTimerId = setTimeout(() => {
        pollOnce().finally(() => {
            // Schedule next poll (unless stopped)
            if (pollTimerId !== null) {
                scheduleNextPoll();
            }
        });
    }, interval);
}

// #############################################
// # Ping / Ack
// #############################################

/**
 * Single poll cycle: call POST /api/ping and process chat status + notifications.
 *
 * During initialization:
 *   Request:  { last_changed, current_chat_id, initializing: true }
 *   Response: { config_changed, current_chat_id_status: { current_chat_id, initialized: "true"|"false"|"failed", failed_message? } }
 *
 * After initialization:
 *   Request:  { last_changed, current_chat_id }
 *   Response: { config_changed, current_chat_id_status: { current_chat_id, status: "initiated"|"deleted"|"missing"|"error" } }
 */
async function pollOnce() {
    const settings = getSettings();
    if (!settings.enabled || isBypassMode()) return;

    const origin = getAgentOrigin();
    if (!origin) return;

    try {
        const body = {};

        // Include last_changed timestamp
        if (state.lastChanged !== null) {
            body.last_changed = state.lastChanged;
        }

        // Include current_chat_id using the same format as _chat_info.chat_id
        const currentChatId = getCurrentChatId();
        if (currentChatId) {
            body.current_chat_id = currentChatId;
        }

        // Include initializing flag when init is in progress
        if (state.initializing) {
            body.initializing = true;
        }

        const resp = await fetch(`${origin}/api/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) {
            console.warn(`[${EXTENSION_NAME}] Ping returned ${resp.status}`);
            return;
        }

        const data = await resp.json();

        // Handle current_chat_id_status from the Agent
        if (data.current_chat_id_status) {
            await handleChatIdStatus(data.current_chat_id_status);
        }

        // Handle push notifications (session_deleted, etc.)
        if (data.notifications && Array.isArray(data.notifications) && data.notifications.length > 0) {
            console.log(`[${EXTENSION_NAME}] Received ${data.notifications.length} notification(s)`);
            for (const notif of data.notifications) {
                await handleNotification(notif);
                await ackNotification(origin, notif.id);
            }
        }
    } catch (e) {
        // Timeout or network error — silent, will retry next cycle
        if (e.name !== 'TimeoutError' && e.name !== 'AbortError') {
            console.warn(`[${EXTENSION_NAME}] Ping failed:`, e.message);
        }
    }
}

/**
 * Acknowledge a notification so the Agent stops sending it.
 */
async function ackNotification(origin, notificationId) {
    try {
        await fetch(`${origin}/api/notifications/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: notificationId }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Failed to ack notification ${notificationId}:`, e.message);
    }
}

// #############################################
// # Chat ID Status Handler
// #############################################

/**
 * Handle the current_chat_id_status response from /api/ping.
 *
 * During initialization (initialized field present):
 *   "true"    → Init complete, session is ready
 *   "false"   → Still processing
 *   "failed"  → Init failed (check failed_message)
 *
 * After initialization (status field present):
 *   "initiated" — DB exists and is initialized
 *   "deleted"   — DB was previously known but has been deleted
 *   "missing"   — No DB exists for this chat_id (never created)
 *   "error"     — DB exists but is in an error state
 */
async function handleChatIdStatus(statusData) {
    if (!statusData || !statusData.current_chat_id) return;

    const { current_chat_id } = statusData;
    const ourChatId = getCurrentChatId();

    // Only act if this status is for OUR current chat
    if (current_chat_id !== ourChatId) {
        console.log(`[${EXTENSION_NAME}] Ping status for different chat (${current_chat_id} vs ours ${ourChatId}), ignoring`);
        return;
    }

    // --- During initialization: check "initialized" field ---
    if (statusData.initialized !== undefined) {
        await handleInitStatus(statusData);
        return;
    }

    // --- After initialization: check "status" field ---
    if (statusData.status) {
        await handleSessionStatus(statusData);
    }
}

/**
 * Handle the initialization status response.
 * Called while state.initializing is true.
 *
 * initialized values:
 *   "true"    → Init completed successfully
 *   "false"   → Still processing (keep pinging with initializing: true)
 *   "failed"  → Init failed
 */
async function handleInitStatus(statusData) {
    const { current_chat_id, initialized, failed_message } = statusData;

    console.log(`[${EXTENSION_NAME}] Init status for ${current_chat_id}: initialized=${initialized}`);

    if (initialized === 'true') {
        // Init complete!
        state.initializing = false;
        state.sessionInitialized = true;

        // Update metadata
        const freshCtx = state.context;
        if (freshCtx.chatMetadata) {
            freshCtx.chatMetadata[META_KEY_INITIALIZED] = true;
            try { await freshCtx.saveMetadata(); } catch (e) { /* ignore */ }
        }

        // Notify UI
        window.dispatchEvent(new CustomEvent('ass-session-confirmed'));
        updateStatus('Session initialized', '#5cb85c');

        if (typeof toastr !== 'undefined') {
            toastr.success('Chat initialized successfully!', 'Agent-StateSync');
        }

    } else if (initialized === 'failed') {
        // Init failed
        state.initializing = false;
        state.sessionInitialized = false;

        // Clear metadata
        const freshCtx = state.context;
        if (freshCtx.chatMetadata) {
            delete freshCtx.chatMetadata[META_KEY_INITIALIZED];
            freshCtx.chatMetadata[META_KEY_COUNTER] = 0;
            try { await freshCtx.saveMetadata(); } catch (e) { /* ignore */ }
        }

        const errorMsg = failed_message || 'Unknown error';
        updateStatus('Init failed', '#d9534f');
        window.dispatchEvent(new CustomEvent('ass-session-deleted'));

        if (typeof toastr !== 'undefined') {
            toastr.error(`Init failed: ${errorMsg}`, 'Agent-StateSync');
        }

    } else if (initialized === 'false') {
        // Still processing — keep polling
        console.log(`[${EXTENSION_NAME}] Agent still processing init for ${current_chat_id}...`);
        updateStatus('Initializing (Agent processing)...', '#f0ad4e');
        // state.initializing stays true — next ping will still include "initializing": true
    }
}

/**
 * Handle the session status response (after initialization is complete).
 *
 * Status values:
 *   "initiated" — DB exists and is initialized
 *   "deleted"   — DB was previously known but has been deleted
 *   "missing"   — No DB exists for this chat_id (never created)
 *   "error"     — DB exists but is in an error state
 */
async function handleSessionStatus(statusData) {
    const { current_chat_id, status } = statusData;

    console.log(`[${EXTENSION_NAME}] Session status for ${current_chat_id}: ${status}`);

    switch (status) {
        case 'initiated':
            // Agent confirms this chat has an initialized session
            if (!state.sessionInitialized) {
                console.log(`[${EXTENSION_NAME}] Ping confirms session is initialized for ${current_chat_id}`);
                state.sessionInitialized = true;
                window.dispatchEvent(new CustomEvent('ass-session-confirmed'));
            }
            break;

        case 'deleted':
            // Agent deleted the DB for this chat
            state.initializing = false;
            state.sessionInitialized = false;
            state.configSynced = false;

            // Clear session metadata
            const delCtx = state.context;
            if (delCtx.chatMetadata) {
                delete delCtx.chatMetadata[META_KEY_INITIALIZED];
                delCtx.chatMetadata[META_KEY_COUNTER] = 0;
                try { await delCtx.saveMetadata(); } catch (e) { /* ignore */ }
            }

            updateStatus('Session deleted', '#f0ad4e');
            window.dispatchEvent(new CustomEvent('ass-session-deleted'));

            if (typeof toastr !== 'undefined') {
                toastr.info('Session deleted by Agent.', 'Agent-StateSync');
            }
            break;

        case 'missing':
            // Agent has no DB for this chat
            if (state.sessionInitialized) {
                console.log(`[${EXTENSION_NAME}] Ping reports session missing for ${current_chat_id}`);
                state.sessionInitialized = false;
                state.configSynced = false;

                // Clear stale metadata
                const missCtx = state.context;
                if (missCtx.chatMetadata) {
                    delete missCtx.chatMetadata[META_KEY_INITIALIZED];
                    missCtx.chatMetadata[META_KEY_COUNTER] = 0;
                    try { await missCtx.saveMetadata(); } catch (e) { /* ignore */ }
                }

                updateStatus('No session (press Init)', '#f0ad4e');
                window.dispatchEvent(new CustomEvent('ass-session-deleted'));
            }
            break;

        case 'error':
            // Agent DB is in an error state
            if (state.sessionInitialized) {
                state.sessionInitialized = false;
                state.configSynced = false;
            }
            state.initializing = false;
            updateStatus('Session error', '#d9534f');
            window.dispatchEvent(new CustomEvent('ass-session-deleted'));

            if (typeof toastr !== 'undefined') {
                toastr.error('Session is in an error state. Try re-initializing.', 'Agent-StateSync');
            }
            break;

        default:
            console.log(`[${EXTENSION_NAME}] Unknown session status from ping: ${status}`);
    }
}

// #############################################
// # Push Notification Handlers
// #############################################

/**
 * Route a push notification to the appropriate handler.
 * Extensible — add new cases for future notification types.
 */
async function handleNotification(notification) {
    if (!notification?.event || !notification?.data) {
        console.warn(`[${EXTENSION_NAME}] Malformed notification:`, notification);
        return;
    }

    const { event, data } = notification;
    console.log(`[${EXTENSION_NAME}] Notification: ${event}`, data);

    switch (event) {
        case 'session_deleted':
            // Delegate to the status handler — it already handles "deleted"
            await handleSessionStatus({
                current_chat_id: getCurrentChatId(),
                status: 'deleted',
            });
            break;
        // Future: case 'session_updated': ...
        // Future: case 'config_reload_requested': ...
        default:
            console.log(`[${EXTENSION_NAME}] Unhandled notification type: ${event}`);
    }
}

// #############################################
// # Public API
// #############################################

/**
 * Check if notification polling is currently active.
 */
export function isNotificationPolling() {
    return pollTimerId !== null;
}
