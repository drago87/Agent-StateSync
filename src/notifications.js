// notifications.js — Agent-StateSync Notification Polling
// File Version: 1.0.1
//
// Polls the Agent's POST /api/ping endpoint for push notifications.
// Notifications include events like session_deleted that keep the
// extension in sync with the Agent's state.
//
// Flow:
//   POST /api/ping  →  { status, notifications: [...] }
//   POST /api/notifications/ack  →  acknowledges each processed notification
//

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_INITIALIZED, META_KEY_COUNTER,
    getSettings, isBypassMode, updateStatus,
} from './settings.js';
import { getAgentOrigin } from './agent-url.js';

// #############################################
// # Polling State
// #############################################

let pollTimerId = null;
const POLL_INTERVAL_MS = 15000; // 15 seconds

// #############################################
// # Polling Control
// #############################################

/**
 * Start polling the Agent for notifications.
 * Safe to call multiple times — won't create duplicate timers.
 * Only polls when a session exists and extension is enabled.
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
    pollTimerId = setTimeout(() => {
        pollOnce().finally(() => {
            // Schedule next poll (unless stopped)
            if (pollTimerId !== null) {
                scheduleNextPoll();
            }
        });
    }, POLL_INTERVAL_MS);
}

// #############################################
// # Ping / Ack
// #############################################

/**
 * Single poll cycle: call POST /api/ping and process notifications.
 */
async function pollOnce() {
    const settings = getSettings();
    if (!settings.enabled || isBypassMode()) return;

    const origin = getAgentOrigin();
    if (!origin) return;

    // Don't poll if we have no session — nothing to be notified about
    const currentSessionId = state.context.chatMetadata?.[META_KEY_SESSION];
    if (!currentSessionId) return;

    try {
        const resp = await fetch(`${origin}/api/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: currentSessionId }),
            signal: AbortSignal.timeout(5000),
        });

        if (!resp.ok) {
            console.warn(`[${EXTENSION_NAME}] Ping returned ${resp.status}`);
            return;
        }

        const data = await resp.json();

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
// # Notification Handlers
// #############################################

/**
 * Route a notification to the appropriate handler.
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
            await handleSessionDeleted(data);
            break;
        // Future: case 'session_updated': ...
        // Future: case 'config_reload_requested': ...
        default:
            console.log(`[${EXTENSION_NAME}] Unhandled notification type: ${event}`);
    }
}

/**
 * Handle a session_deleted notification from the Agent.
 * Clears session metadata, shows Init button, updates status, stops polling.
 */
async function handleSessionDeleted(data) {
    if (!state.context.chatMetadata) return;

    // Verify this is our current session (ignore stale notifications)
    const currentSessionId = state.context.chatMetadata[META_KEY_SESSION];
    if (currentSessionId && data.session_id && data.session_id !== currentSessionId) {
        console.log(`[${EXTENSION_NAME}] session_deleted for different session (${data.session_id} vs ours ${currentSessionId}), ignoring`);
        return;
    }

    // Stop polling — no session to poll for
    stopNotificationPolling();

    // Clear session metadata
    delete state.context.chatMetadata[META_KEY_SESSION];
    delete state.context.chatMetadata[META_KEY_INITIALIZED];
    state.context.chatMetadata[META_KEY_COUNTER] = 0;
    await state.context.saveMetadata();

    // Update runtime state
    state.sessionInitialized = false;
    state.configSynced = false;

    // Update UI
    updateStatus('Session deleted', '#f0ad4e');

    // Notify UI to show Init button (avoids circular dep with ui.js)
    window.dispatchEvent(new CustomEvent('ass-session-deleted'));

    console.log(`[${EXTENSION_NAME}] Session ${data.session_id} deleted by Agent — Init button now visible`);

    if (typeof toastr !== 'undefined') {
        toastr.info(
            `Session deleted by Agent${data.character_name ? ' (' + data.character_name + ')' : ''}`,
            'Agent-StateSync'
        );
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