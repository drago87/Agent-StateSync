// listeners.js — Agent-StateSync Event Listeners
// File Version: 1.1.0
//
// Registers one-time event listeners for SillyTavern events
// (chat rename, etc.) and forwards relevant changes to the Agent backend.
//
// Chat rename format:
//   - Group chats:  old_chat_id = groupName + "-" + chatTimestamp
//                   new_chat_id = groupName + "-" + newChatTimestamp
//   - Non-group:    old_chat_id = cardName + "-" + chatTimestamp
//                   new_chat_id = cardName + "-" + newChatTimestamp
//
// Response from Agent: {"rename": "ok"} or {"rename": "failed"}
//

import state from './state.js';
import { EXTENSION_NAME, META_KEY_SESSION } from './settings.js';
import { getAgentOrigin } from './agent-url.js';
import { getFreshContext } from './groups.js';

// #############################################
// # Chat Rename Listener
// #############################################

let _renameListenerRegistered = false;

/**
 * Set up a one-time listener for ST's unified CHAT_RENAMED event.
 * When a chat is renamed, forwards the rename (without .jsonl) to the Agent backend.
 * Only sends if a session is currently active.
 *
 * Chat ID format:
 *   - Groups:    groupName-chatTimestamp  (e.g. "test-2026-04-12@21h22m16s024ms")
 *   - Non-group: cardName-chatTimestamp   (e.g. "Alice-2026-05-04@12h30m45s123ms")
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

        // Build old_chat_id / new_chat_id depending on group vs non-group chat
        let oldChatId, newChatId;

        if (state.isGroupChat && state.activeGroup) {
            // Group chats: groupName-chatTimestamp
            // ST filenames for groups: {groupName}_{chatTimestamp}.jsonl
            const groupChatName = state.activeGroup.name;
            const groupPrefix = groupChatName + '_';
            const oldChatName = oldFileName.startsWith(groupPrefix)
                ? oldFileName.slice(groupPrefix.length)
                : oldFileName;
            const newChatName = newFileName.startsWith(groupPrefix)
                ? newFileName.slice(groupPrefix.length)
                : newFileName;
            oldChatId = groupChatName + '-' + oldChatName;
            newChatId = groupChatName + '-' + newChatName;
        } else {
            // Non-group chats: cardName-chatTimestamp
            // ST filenames for non-groups: {cardName} - {chatTimestamp}.jsonl
            const cardName = getFreshContext().name2 || '';
            const prefix = cardName + ' - ';
            const oldChatName = oldFileName.startsWith(prefix)
                ? oldFileName.slice(prefix.length)
                : oldFileName;
            const newChatName = newFileName.startsWith(prefix)
                ? newFileName.slice(prefix.length)
                : newFileName;
            oldChatId = cardName + '-' + oldChatName;
            newChatId = cardName + '-' + newChatName;
        }

        console.log(`[${EXTENSION_NAME}] Chat renamed: "${oldChatId}" → "${newChatId}"`);

        try {
            const resp = await fetch(`${origin}/api/chat/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_chat_id: oldChatId,
                    new_chat_id: newChatId,
                }),
            });

            const data = await resp.json();
            if (data.rename === 'ok') {
                console.log(`[${EXTENSION_NAME}] Chat rename forwarded to Agent successfully`);
            } else if (data.rename === 'failed') {
                console.warn(`[${EXTENSION_NAME}] Chat rename forward failed: Agent returned failure`);
            }
        } catch (err) {
            console.warn(`[${EXTENSION_NAME}] Chat rename forward error:`, err.message);
        }
    });

    console.log(`[${EXTENSION_NAME}] Chat rename listener registered`);
}
