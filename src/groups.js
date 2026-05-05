// groups.js — Agent-StateSync Group Data Loading
//
// Fetches group data from SillyTavern's server API, finds the active group
// for the current chat, resolves member avatars to full Character objects,
// and caches everything for the interceptor pipeline.
//
// IMPORTANT: ST's getContext() returns a SNAPSHOT object — properties like
// groupId and characterId are captured at call time and become stale.
// Always call getFreshContext() to get current values.
//
// Group detection uses context.groupId (camelCase) as the primary signal.
// If groupId is null/undefined, falls back to chatId matching against
// groups' chat_id and chats[] arrays (ST may not have updated groupId yet).
// File Version: 1.3.0

import state from './state.js';
import { EXTENSION_NAME } from './settings.js';

// #############################################
// # Fresh Context Helper
// #############################################

/**
 * Get a fresh ST context snapshot.
 *
 * ST's getContext() returns a new plain object each time. Properties like
 * groupId and characterId are captured at call time — they don't auto-update.
 * The state.context object we stored at init time becomes stale as soon as
 * the user switches chats.
 *
 * Always use this when reading groupId, characterId, chatId, name2, etc.
 * to ensure you get the CURRENT values, not stale init-time values.
 *
 * @returns {object} Fresh context snapshot
 */
function getFreshContext() {
    if (typeof window.SillyTavern?.getContext === 'function') {
        return window.SillyTavern.getContext();
    }
    // Fallback to the (possibly stale) stored context
    return state.context;
}

// #############################################
// # 6. Group Data Loading
// #############################################

/**
 * Fetch all groups from ST's server API using proper auth headers.
 * ST's getGroups() uses POST /api/groups/all with getRequestHeaders().
 */
export async function fetchGroupsFromServer() {
    const ctx = getFreshContext();
    let headers = {};
    if (typeof ctx.getRequestHeaders === 'function') {
        headers = ctx.getRequestHeaders({ omitContentType: true });
    }

    const resp = await fetch('/api/groups/all', {
        method: 'POST',
        headers: headers,
    });

    if (!resp.ok) {
        throw new Error(`POST /api/groups/all returned ${resp.status}`);
    }

    const data = await resp.json();
    return Array.isArray(data) ? data : [];
}

/**
 * Find the currently active group for the current chat.
 *
 * Two detection strategies (in order of reliability):
 *
 * 1. Primary: context.groupId — ST sets this when a group chat is active.
 *    This is the most reliable signal when available, but ST may not have
 *    updated it yet right after a chat-changed event.
 *
 * 2. Fallback: chatId matching — If groupId is null (ST hasn't updated it yet
 *    after a chat switch), we check if the current chatId appears in any
 *    group's chat_id or chats[] array. This is reliable because a chatId
 *    uniquely identifies a chat, and only one group can own a particular chat.
 *
 * IMPORTANT: Always gets a FRESH context snapshot because the stored
 * state.context becomes stale after chat switches.
 */
export function findActiveGroup(groups) {
    if (!groups || groups.length === 0) {
        console.log(`[${EXTENSION_NAME}] findActiveGroup: no groups loaded`);
        return null;
    }

    // Get FRESH context — state.context.groupId may be stale!
    const ctx = getFreshContext();
    const currentGroupId = ctx.groupId || null;
    const currentChatId = typeof ctx.getCurrentChatId === 'function'
        ? ctx.getCurrentChatId() : null;

    // --- Strategy 1: context.groupId ---
    if (currentGroupId) {
        console.log(`[${EXTENSION_NAME}] findActiveGroup: groupId=${currentGroupId}, name2="${ctx.name2 || ''}"`);

        for (const group of groups) {
            if (group.id === currentGroupId) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED by context.groupId === group.id`);
                return group;
            }
        }
        console.warn(`[${EXTENSION_NAME}]   context.groupId=${currentGroupId} did not match any group.id`);
        // Fall through to chatId matching
    } else {
        console.log(`[${EXTENSION_NAME}] findActiveGroup: groupId is null, trying chatId fallback...`);
    }

    // --- Strategy 2: chatId matching (fallback) ---
    // ST may not have updated context.groupId yet after a chat switch.
    // If we have a chatId, check if any group owns it.
    if (currentChatId) {
        console.log(`[${EXTENSION_NAME}]   Checking chatId="${currentChatId}" against groups...`);
        for (const group of groups) {
            // Match by group.chat_id (current active chat for the group)
            if (group.chat_id === currentChatId) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED group "${group.name}" by chat_id`);
                return group;
            }
            // Match by group.chats[] array (any chat in the group's history)
            if (Array.isArray(group.chats) && group.chats.includes(currentChatId)) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED group "${group.name}" by chats[] array`);
                return group;
            }
        }
        console.log(`[${EXTENSION_NAME}]   chatId did not match any group — single-character mode`);
    } else {
        console.log(`[${EXTENSION_NAME}]   No chatId available for fallback — single-character mode`);
    }

    return null;
}

/**
 * Resolve group member avatar strings to full Character objects.
 * ST stores group members as avatar filenames (e.g. "Belle.png").
 * We match them against context.characters[].avatar.
 */
export function resolveGroupMemberCharacters(group) {
    if (!group || !Array.isArray(group.members)) return [];

    const ctx = getFreshContext();
    const allChars = ctx.characters || [];
    const resolved = [];

    for (const memberAvatar of group.members) {
        const char = allChars.find(c => c.avatar === memberAvatar);
        if (char) {
            resolved.push(char);
        } else {
            // Fallback: try matching by name
            const charByName = allChars.find(c => c.name === memberAvatar);
            if (charByName) {
                resolved.push(charByName);
            } else {
                resolved.push({
                    avatar: memberAvatar,
                    name: memberAvatar.replace(/\.[^.]+$/, ''),
                    _unresolved: true,
                });
            }
        }
    }

    return resolved;
}

/**
 * Main function: Load group data from ST's server, find active group,
 * resolve member characters, and cache everything for the interceptor.
 *
 * Includes a retry mechanism: if findActiveGroup() returns null on the
 * first try (ST may not have updated context.groupId yet), we retry
 * after a short delay. The chatId-based fallback in findActiveGroup()
 * handles most timing issues, but the retry catches edge cases where
 * even getCurrentChatId() hasn't been updated yet.
 */
export async function loadGroupData() {
    state.cachedGroups = null;
    state.activeGroup = null;
    state.activeGroupCharacters = [];
    state.isGroupChat = false;

    const groups = await fetchGroupsFromServer();
    state.cachedGroups = groups;

    const ctx = getFreshContext();
    const currentChatId = typeof ctx.getCurrentChatId === 'function'
        ? ctx.getCurrentChatId() : null;
    console.log(`[${EXTENSION_NAME}] Loaded ${groups.length} groups from server`);
    console.log(`[${EXTENSION_NAME}] (fresh) context.groupId = ${ctx.groupId ?? 'null (single-char mode)'}`);
    console.log(`[${EXTENSION_NAME}] (stale) state.context.groupId = ${state.context.groupId ?? 'null (may be stale)'}`);
    console.log(`[${EXTENSION_NAME}] getCurrentChatId() = ${currentChatId ?? 'null'}`);

    let found = findActiveGroup(groups);

    // Retry: if no group found but we have a chatId, ST may not have
    // updated context yet. Wait and try again.
    if (!found && currentChatId) {
        console.log(`[${EXTENSION_NAME}] No group found on first try — retrying in 500ms...`);
        await new Promise(r => setTimeout(r, 500));
        found = findActiveGroup(groups);
    }

    if (found) {
        state.activeGroup = found;
        state.isGroupChat = true;
        state.activeGroupCharacters = resolveGroupMemberCharacters(found);

        console.log(`[${EXTENSION_NAME}] Active group: "${found.name}" (id=${found.id}, chat_id=${found.chat_id})`);
        console.log(`[${EXTENSION_NAME}] Members (${state.activeGroupCharacters.length}):`,
            state.activeGroupCharacters.map(c => c.name || c.avatar).join(', ')
        );

        // Try to unshallow group members for full card data
        const freshCtx = getFreshContext();
        if (typeof freshCtx.unshallowGroupMembers === 'function' && found.id) {
            try {
                await freshCtx.unshallowGroupMembers(found.id);
                console.log(`[${EXTENSION_NAME}] Called unshallowGroupMembers(${found.id})`);
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] unshallowGroupMembers failed:`, e.message);
            }
        }
    } else {
        console.log(`[${EXTENSION_NAME}] No active group found for current chat. Single-character mode.`);
    }

    return {
        groups: groups,
        activeGroup: state.activeGroup,
        members: state.activeGroupCharacters,
        isGroupChat: state.isGroupChat,
    };
}

/**
 * Export the fresh context getter for use by other modules
 * (debug, init-payload, etc.) that need current context values.
 */
export { getFreshContext };
