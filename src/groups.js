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
// If groupId is null/undefined, we are in single-character mode.
// File Version: 1.2.0

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
 * Uses context.groupId (camelCase) as the ONLY reliable signal.
 * - If context.groupId is set → find the matching group by ID
 * - If context.groupId is null/undefined → single-character mode (return null)
 *
 * No chat ID matching or heuristics — those caused false positives
 * where single-character chats were incorrectly detected as groups.
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

    // Quick exit: if groupId is not set, we're definitely NOT in a group chat.
    if (!currentGroupId) {
        console.log(`[${EXTENSION_NAME}] findActiveGroup: groupId is null → single-character mode`);
        return null;
    }

    console.log(`[${EXTENSION_NAME}] findActiveGroup: groupId=${currentGroupId}, name2="${ctx.name2 || ''}"`);

    // Log each group for diagnosis (only first 20 to avoid spam)
    const logGroups = groups.slice(0, 20);
    for (const group of logGroups) {
        const chatsPreview = Array.isArray(group.chats)
            ? `[${group.chats.length} chats, first=${group.chats[0] || 'none'}]`
            : 'no chats array';
        console.log(`[${EXTENSION_NAME}]   Group "${group.name}": id=${group.id}, chat_id=${group.chat_id}, ${chatsPreview}`);
    }

    // --- Match: group.id === context.groupId ---
    for (const group of groups) {
        if (group.id === currentGroupId) {
            console.log(`[${EXTENSION_NAME}]   -> MATCHED by context.groupId === group.id`);
            return group;
        }
    }
    console.warn(`[${EXTENSION_NAME}]   context.groupId=${currentGroupId} did not match any group.id — treating as single-char`);
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
 */
export async function loadGroupData() {
    state.cachedGroups = null;
    state.activeGroup = null;
    state.activeGroupCharacters = [];
    state.isGroupChat = false;

    const groups = await fetchGroupsFromServer();
    state.cachedGroups = groups;

    const ctx = getFreshContext();
    console.log(`[${EXTENSION_NAME}] Loaded ${groups.length} groups from server`);
    console.log(`[${EXTENSION_NAME}] (fresh) context.groupId = ${ctx.groupId ?? 'null (single-char mode)'}`);
    console.log(`[${EXTENSION_NAME}] (stale) state.context.groupId = ${state.context.groupId ?? 'null (may be stale)'}`);

    const found = findActiveGroup(groups);

    if (found) {
        state.activeGroup = found;
        state.isGroupChat = true;
        state.activeGroupCharacters = resolveGroupMemberCharacters(found);

        console.log(`[${EXTENSION_NAME}] Active group: "${found.name}" (id=${found.id}, chat_id=${found.chat_id})`);
        console.log(`[${EXTENSION_NAME}] Members (${state.activeGroupCharacters.length}):`,
            state.activeGroupCharacters.map(c => c.name || c.avatar).join(', ')
        );

        // Try to unshallow group members for full card data
        if (typeof ctx.unshallowGroupMembers === 'function' && found.id) {
            try {
                await ctx.unshallowGroupMembers(found.id);
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
