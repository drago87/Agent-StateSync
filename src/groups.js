// groups.js — Agent-StateSync Group Data Loading
//
// Fetches group data from SillyTavern's server API, finds the active group
// for the current chat, resolves member avatars to full Character objects,
// and caches everything for the interceptor pipeline.
// File Version: 1.0.0

import state from './state.js';
import { EXTENSION_NAME } from './settings.js';

// #############################################
// # 6. Group Data Loading
// #############################################

/**
 * Fetch all groups from ST's server API using proper auth headers.
 * ST's getGroups() uses POST /api/groups/all with getRequestHeaders().
 */
export async function fetchGroupsFromServer() {
    let headers = {};
    if (typeof state.context.getRequestHeaders === 'function') {
        headers = state.context.getRequestHeaders({ omitContentType: true });
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
 * Find the currently active group by matching chat_id against
 * the current chat ID from ST's context.
 *
 * Match priority:
 *  1. context.group_id  vs  group.id        (most reliable in group mode)
 *  2. getCurrentChatId() vs group.chat_id   (current active chat)
 *  3. getCurrentChatId() vs group.id         (unlikely but possible)
 *  4. getCurrentChatId() in group.chats[]    (historical chats)
 *  5. Fallback: context.name2 === 'SillyTavern System' heuristic
 */
export function findActiveGroup(groups) {
    if (!groups || groups.length === 0) {
        console.log(`[${EXTENSION_NAME}] findActiveGroup: no groups loaded`);
        return null;
    }

    const currentChatId = typeof state.context.getCurrentChatId === 'function'
        ? state.context.getCurrentChatId()
        : null;

    // ST sets context.group_id when viewing a group chat.
    // This is the most reliable signal — use it first.
    const currentGroupId = state.context.group_id || state.context.chat?.group_id || null;

    console.log(`[${EXTENSION_NAME}] findActiveGroup: chatId=${currentChatId}, groupId=${currentGroupId}, name2="${state.context.name2 || ''}"`);

    // Log each group for diagnosis (only first 20 to avoid spam)
    const logGroups = groups.slice(0, 20);
    for (const group of logGroups) {
        const chatsPreview = Array.isArray(group.chats)
            ? `[${group.chats.length} chats, first=${group.chats[0] || 'none'}]`
            : 'no chats array';
        console.log(`[${EXTENSION_NAME}]   Group "${group.name}": id=${group.id}, chat_id=${group.chat_id}, ${chatsPreview}`);
    }

    // --- Match 1: group.id === context.group_id (most reliable) ---
    if (currentGroupId) {
        for (const group of groups) {
            if (group.id === currentGroupId) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED by context.group_id === group.id`);
                return group;
            }
        }
        console.warn(`[${EXTENSION_NAME}]   context.group_id=${currentGroupId} did not match any group.id`);
    }

    // --- Match 2 & 3: group.chat_id or group.id === currentChatId ---
    if (currentChatId) {
        for (const group of groups) {
            if (group.chat_id === currentChatId) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED by group.chat_id`);
                return group;
            }
        }
        for (const group of groups) {
            if (group.id === currentChatId) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED by group.id`);
                return group;
            }
        }

        // --- Match 4: currentChatId in group.chats[] ---
        for (const group of groups) {
            if (Array.isArray(group.chats) && group.chats.includes(currentChatId)) {
                console.log(`[${EXTENSION_NAME}]   -> MATCHED by group.chats[]`);
                return group;
            }
        }
    }

    // --- Fallback: 'SillyTavern System' heuristic ---
    // In ST, context.name2 is set to 'SillyTavern System' when viewing a
    // group chat (it's ST's default group persona).  If we see this but
    // couldn't match by ID, we know we're in a group — try harder.
    if (state.context.name2 === 'SillyTavern System') {
        console.warn(`[${EXTENSION_NAME}]   -> FALLBACK: name2='SillyTavern System' but no ID match found`);

        // If context.group_id exists, we already tried it above and failed.
        // Try matching by looking for the group whose chat_id matches
        // whatever the "current" chat ID is reported as.
        if (currentGroupId && !currentChatId) {
            // We have a group_id but no chat_id — match was already attempted
            console.warn(`[${EXTENSION_NAME}]   -> Have group_id=${currentGroupId} but no chat_id; group ID not found in list`);
        }

        // Last resort: use the first group that has a chat_id set.
        // This is a heuristic — it might be wrong if the user has multiple
        // groups, but it's better than returning null.
        for (const group of groups) {
            if (group.chat_id) {
                console.warn(`[${EXTENSION_NAME}]   -> Using first group with chat_id: "${group.name}" (MAY BE WRONG — check console)`);
                return group;
            }
        }
        // Even more desperate: return the first group
        if (groups.length === 1) {
            console.warn(`[${EXTENSION_NAME}]   -> Only 1 group exists, using it: "${groups[0].name}"`);
            return groups[0];
        }
    }

    console.log(`[${EXTENSION_NAME}]   -> NO MATCH FOUND`);
    return null;
}

/**
 * Resolve group member avatar strings to full Character objects.
 * ST stores group members as avatar filenames (e.g. "Belle.png").
 * We match them against context.characters[].avatar.
 */
export function resolveGroupMemberCharacters(group) {
    if (!group || !Array.isArray(group.members)) return [];

    const allChars = state.context.characters || [];
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

    console.log(`[${EXTENSION_NAME}] Loaded ${groups.length} groups from server`);

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
        if (typeof state.context.unshallowGroupMembers === 'function' && found.id) {
            try {
                await state.context.unshallowGroupMembers(found.id);
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
