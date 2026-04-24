// listeners.js — Agent-StateSync Event Listeners
//
// Registers one-time event listeners for SillyTavern events
// (chat rename, etc.) and forwards relevant changes to the Agent backend.
//
// File Version: 1.0.0

import state from './state.js';
import { EXTENSION_NAME, META_KEY_SESSION } from './settings.js';
import { getAgentOrigin } from './agent-url.js';

// #############################################
// # Chat Rename Listener
// #############################################

let _renameListenerRegistered = false;

/**
 * Set up a one-time listener for ST's unified CHAT_RENAMED event.
 * When a chat is renamed, forwards the rename (without .jsonl) to the Agent backend.
 * Only sends if a session is currently active.
 */
export function setupChatRenameListener() {
    if (_renameListenerRegistered) return;
    _renameListenerRegistered = true;

    const eventSource = state.context.eventSource;
    const eventTypes = state.context.eventTypes;
    if (!eventSource || !eventTypes) {
        console.warn(`[${EXTENSION_NAME}] Cannot set up rename listener: eventSource/eventTypes not available`);
        return;
    }

    eventSource.on(eventTypes.CHAT_RENAMED, async (eventData) => {
        // Only forward if we have an active session
        const sessionId = state.context.chatMetadata?.[META_KEY_SESSION];
        if (!sessionId) return;

        const origin = getAgentOrigin();
        if (!origin) return;

        // Strip .jsonl — the event includes it but we don't want it
        const oldFileName = eventData.oldFileName.replace('.jsonl', '');
        const newFileName = eventData.newFileName.replace('.jsonl', '');

        console.log(`[${EXTENSION_NAME}] Chat renamed: "${oldFileName}" → "${newFileName}"`);

        try {
            const resp = await fetch(`${origin}/api/chat/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: sessionId,
                    old_file_name: oldFileName,
                    new_file_name: newFileName,
                }),
            });

            if (!resp.ok) {
                console.warn(`[${EXTENSION_NAME}] Chat rename forward failed: ${resp.status}`);
            } else {
                console.log(`[${EXTENSION_NAME}] Chat rename forwarded to Agent`);
            }
        } catch (err) {
            console.warn(`[${EXTENSION_NAME}] Chat rename forward error:`, err.message);
        }
    });

    console.log(`[${EXTENSION_NAME}] Chat rename listener registered`);
}