// debug.js — Agent-StateSync Debug Command Handlers
//
// Executes diagnostic commands and returns formatted output strings
// for display in the debug panel textbox.
//
// IMPORTANT: Always uses getFreshContext() to get CURRENT values,
// not the stale state.context snapshot from init time.
// File Version: 1.2.0

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
} from './settings.js';
import { fetchGroupsFromServer, findActiveGroup, loadGroupData, getFreshContext } from './groups.js';
import { buildMetaTag, getMessageId } from './pipeline.js';
import { buildInitPayload } from './init-payload.js';

// #############################################
// # 12. Debug Command Handlers
// #############################################

/**
 * Execute a debug command and return its output as a string.
 */
export async function executeDebugCommand(command) {
    if (!command) return '(No command selected)';

    const lines = [];
    const add = (str) => lines.push(str);

    try {
        switch (command) {

            case 'chat_mode': {
                add('=== Chat Mode Detection ===');
                add('');

                // Get FRESH context — state.context may be stale!
                const ctx = getFreshContext();
                const staleGroupId = state.context.groupId ?? null;
                const groupId = ctx.groupId ?? null;
                const characterId = ctx.characterId ?? null;
                const name2 = ctx.name2 || '(empty)';
                const chatId = typeof ctx.getCurrentChatId === 'function'
                    ? ctx.getCurrentChatId() : null;

                add('--- Fresh vs Stale Context ---');
                add(`fresh context.groupId:  ${groupId ?? 'null'}`);
                add(`stale state.context.groupId: ${staleGroupId ?? 'null'}`);
                add(`stale === fresh? ${staleGroupId === groupId ? 'YES (OK)' : 'NO (STALE — this is the bug!)'}`);
                add('');

                add('--- SillyTavern Context Signals (fresh) ---');
                add(`context.groupId:     ${groupId ?? 'null (NOT a group)'}`);
                add(`context.characterId: ${characterId ?? 'null'}`);
                add(`context.name2:       "${name2}"`);
                add(`getCurrentChatId():  ${chatId ?? 'null'}`);
                add('');

                add('--- Extension State ---');
                add(`state.isGroupChat:           ${state.isGroupChat}`);
                add(`state.activeGroup:           ${state.activeGroup ? `"${state.activeGroup.name}" (id=${state.activeGroup.id})` : 'null'}`);
                add(`state.activeGroupCharacters: ${state.activeGroupCharacters.length} member(s)`);
                add(`state.cachedGroups:          ${state.cachedGroups ? `${state.cachedGroups.length} group(s) loaded` : 'null (not loaded)'}`);
                add('');

                add('--- Diagnosis ---');
                if (groupId) {
                    add(`MODE: GROUP CHAT (context.groupId = "${groupId}")`);
                    if (state.cachedGroups) {
                        const g = state.cachedGroups.find(x => x.id === groupId);
                        if (g) {
                            add(`  Matched group: "${g.name}"`);
                            add(`  Members: ${(g.members || []).join(', ')}`);
                        } else {
                            add(`  WARNING: groupId "${groupId}" NOT FOUND in cached groups!`);
                        }
                    } else {
                        add(`  Groups not loaded yet — run "Load & Dump Groups" to verify`);
                    }
                    if (!state.isGroupChat) {
                        add(`  BUG: context.groupId is set but state.isGroupChat is false!`);
                        add(`  loadGroupData() needs to be called to sync.`);
                    }
                } else {
                    add('MODE: SINGLE CHARACTER (context.groupId is null)');
                    if (characterId !== null && characterId !== undefined) {
                        const char = ctx.characters?.[characterId];
                        if (char) {
                            add(`  Character: "${char.name}" (index=${characterId})`);
                            add(`  Avatar: "${char.avatar || ''}"`);
                        } else {
                            add(`  Character index=${characterId} but no character found at that index`);
                        }
                    } else {
                        add(`  No character selected (characterId is null)`);
                    }
                    if (state.isGroupChat) {
                        add(`  BUG: context.groupId is null but state.isGroupChat is true!`);
                        add(`  This is a false group detection bug — stale context was used.`);
                    }
                }
                break;
            }

            case 'context_dump': {
                add('=== SillyTavern Context Dump ===');
                add('');

                // Show both fresh and stale values to highlight staleness bugs
                const ctx = getFreshContext();
                const stale = state.context;

                add('--- Fresh Context (from getContext()) ---');
                add(`context.groupId (selected_group): ${ctx.groupId ?? 'null (NOT SET)'}`);
                add(`context.chatId (computed):       ${ctx.chatId ?? 'null (NOT SET)'}`);
                add(`context.characterId (this_chid): ${ctx.characterId ?? 'null'}`);
                add(`context.name1 (persona):         ${ctx.name1 ?? '(empty)'}`);
                add(`context.name2 (character/group):  "${ctx.name2 ?? '(empty)'}"`);
                add(`context.onlineStatus:            ${ctx.onlineStatus ?? 'null'}`);
                add(`context.maxContext:               ${ctx.maxContext}`);
                add('');
                add('--- Stale Context (from state.context, captured at init) ---');
                add(`stale.groupId:    ${stale.groupId ?? 'null (NOT SET)'}`);
                add(`stale.chatId:     ${stale.chatId ?? 'null (NOT SET)'}`);
                add(`stale.characterId: ${stale.characterId ?? 'null'}`);
                add(`stale.name2:      "${stale.name2 ?? '(empty)'}"`);
                add('');
                add('--- getCurrentChatId() ---');
                const chatId = typeof ctx.getCurrentChatId === 'function'
                    ? ctx.getCurrentChatId() : 'FUNCTION NOT AVAILABLE';
                add(`getCurrentChatId() => ${chatId}`);
                add('');
                add('--- chatMetadata ---');
                add(JSON.stringify(ctx.chatMetadata || {}, null, 2));
                add('');
                add('--- chat array length ---');
                const chatArr = ctx.chat || [];
                add(`context.chat.length = ${Array.isArray(chatArr) ? chatArr.length : '(not array)'}`);
                break;
            }

            case 'chat_ids': {
                add('=== Chat ID & Group ID Analysis ===');
                add('');
                const ctx = getFreshContext();
                const chatId = typeof ctx.getCurrentChatId === 'function'
                    ? ctx.getCurrentChatId() : null;
                const groupId = ctx.groupId || null;
                const computedChatId = ctx.chatId || null;

                add(`getCurrentChatId():  ${chatId}`);
                add(`context.groupId:    ${groupId}`);
                add(`context.chatId:     ${computedChatId}`);
                add(`context.name2:      "${ctx.name2 || ''}"`);
                add(`context.characterId: ${ctx.characterId ?? 'null'}`);
                add('');
                add('--- How ST computes context.chatId (from st-context.js) ---');
                add('For groups:   groups.find(x => x.id == selected_group)?.chat_id');
                add('For single:   characters[this_chid]?.chat');
                add('');
                add('--- Diagnostic ---');
                if (groupId) {
                    add('You ARE in a group (context.groupId is set).');
                    add(`  Expected: group.chat_id should equal getCurrentChatId()`);
                    if (state.cachedGroups) {
                        const g = state.cachedGroups.find(x => x.id === groupId);
                        if (g) {
                            add(`  Found group: "${g.name}" (id=${g.id})`);
                            add(`  group.chat_id = "${g.chat_id}"`);
                            add(`  Match: ${g.chat_id === chatId ? 'YES' : 'NO — THIS IS THE BUG'}`);
                            if (g.chats && g.chats.length) {
                                add(`  group.chats[] = [${g.chats.length} items]`);
                                add(`    Last (current): "${g.chats[g.chats.length - 1]}"`);
                                add(`    chatId in chats[]: ${g.chats.includes(chatId) ? 'YES' : 'NO'}`);
                            }
                        } else {
                            add(`  Group id=${groupId} NOT FOUND in cached groups!`);
                        }
                    } else {
                        add('  Groups not loaded yet. Run "Load & Dump Groups" first.');
                    }
                } else {
                    add('You are NOT in a group (context.groupId is null/undefined).');
                    add('Single character mode.');
                    const charId = ctx.characterId;
                    if (charId !== null && charId !== undefined) {
                        const char = ctx.characters?.[charId];
                        add(`  Character: "${char?.name || 'unknown'}" (index=${charId})`);
                    }
                }
                break;
            }

            case 'load_groups': {
                add('=== Loading Groups from ST Server ===');
                add('(Calling POST /api/groups/all with auth headers)');
                add('');
                const groups = await fetchGroupsFromServer();
                state.cachedGroups = groups;
                add(`Loaded ${groups.length} groups`);
                add('');
                if (groups.length === 0) {
                    add('No groups exist on this ST instance.');
                    add('This is normal if you only use single-character chats.');
                } else {
                    for (let i = 0; i < groups.length; i++) {
                        const g = groups[i];
                        const chatsPreview = Array.isArray(g.chats)
                            ? `[${g.chats.length} chats, last="${g.chats[g.chats.length - 1] || 'none'}"]`
                            : 'no chats array';
                        add(`[${i}] "${g.name}"`);
                        add(`    id=${g.id}  chat_id="${g.chat_id}"`);
                        add(`    members=${JSON.stringify(g.members || [])}`);
                        add(`    disabled_members=${JSON.stringify(g.disabled_members || [])}`);
                        add(`    ${chatsPreview}`);
                    }
                }
                add('');
                const ctx = getFreshContext();
                add(`Current (fresh) context.groupId: ${ctx.groupId ?? 'null (single-char mode)'}`);
                break;
            }

            case 'find_group': {
                add('=== Finding Active Group ===');
                add('');
                const ctx = getFreshContext();
                const currentGroupId = ctx.groupId || null;
                add(`(fresh) context.groupId: ${currentGroupId ?? 'null (single-char mode)'}`);
                add(`(stale) state.context.groupId: ${state.context.groupId ?? 'null'}`);
                add('');

                if (!currentGroupId) {
                    add('RESULT: Single-character mode (context.groupId is null)');
                    add('');
                    const charId = ctx.characterId;
                    if (charId !== null && charId !== undefined) {
                        const char = ctx.characters?.[charId];
                        if (char) {
                            add(`Active character: "${char.name}" (index=${charId})`);
                            add(`Avatar: "${char.avatar || ''}"`);
                        }
                    }
                    add('');
                    add('Extension state:');
                    add(`  isGroupChat: ${state.isGroupChat}`);
                    if (state.isGroupChat) {
                        add('  BUG: isGroupChat is true but context.groupId is null!');
                        add('  This is a false group detection bug. Try reloading group data.');
                    }
                    break;
                }

                if (!state.cachedGroups) {
                    add('Groups not loaded yet. Run "Load & Dump Groups" first.');
                    break;
                }
                add(`cachedGroups: ${state.cachedGroups.length} groups loaded`);
                add('');

                const found = findActiveGroup(state.cachedGroups);
                if (found) {
                    add(`RESULT: Matched group "${found.name}"`);
                    add(`  id=${found.id}`);
                    add(`  chat_id="${found.chat_id}"`);
                    add(`  members=${JSON.stringify(found.members || [])}`);
                    if (found.chats) {
                        add(`  chats[${found.chats.length}]=${JSON.stringify(found.chats)}`);
                    }
                    add('');
                    add(`isGroupChat = ${state.isGroupChat}`);
                    add(`activeGroupCharacters.length = ${state.activeGroupCharacters.length}`);
                    if (state.isGroupChat && state.activeGroup && state.activeGroup.id !== found.id) {
                        add('');
                        add('*** WARNING: Global activeGroup does NOT match findActiveGroup() result! ***');
                        add(`  activeGroup is still set to "${state.activeGroup.name}" (id=${state.activeGroup.id})`);
                        add('  This can happen if loadGroupData() ran before context was ready.');
                        add('  Fix: switch chats or reload the page.');
                    }
                } else {
                    add(`RESULT: groupId="${currentGroupId}" NOT FOUND in cached groups`);
                    add('This is unusual — the group may have been deleted.');
                }
                break;
            }

            case 'group_members': {
                if (state.isGroupChat && state.activeGroup) {
                    add('=== Group Members ===');
                    add('');
                    add(`Active group: "${state.activeGroup.name}" (id=${state.activeGroup.id})`);
                    add(`Resolved members: ${state.activeGroupCharacters.length}`);
                    add('');
                    for (let i = 0; i < state.activeGroupCharacters.length; i++) {
                        const c = state.activeGroupCharacters[i];
                        add(`[${i}] ${c.name || '(unnamed)'}`);
                        add(`    avatar="${c.avatar || ''}"`);
                        if (c._unresolved) {
                            add('    *** UNRESOLVED — could not find full character data ***');
                        } else {
                            add(`    description: ${(c.description || '').substring(0, 100)}${(c.description || '').length > 100 ? '...' : ''}`);
                            add(`    personality: ${(c.personality || '').substring(0, 80)}${(c.personality || '').length > 80 ? '...' : ''}`);
                            add(`    scenario: ${(c.scenario || '').substring(0, 80)}${(c.scenario || '').length > 80 ? '...' : ''}`);
                            add(`    first_mes: ${(c.first_mes || '').substring(0, 80)}${(c.first_mes || '').length > 80 ? '...' : ''}`);

                            // Show char config (brain button) data
                            if (c.data?.extensions?.agent_statesync) {
                                const cc = c.data.extensions.agent_statesync;
                                add(`    [Agent Config] mode=${cc.mode || 'characters'}, names=${JSON.stringify(cc.names || [])}`);
                            } else {
                                add(`    [Agent Config] (default — no brain button config)`);
                            }
                        }
                    }
                    if (state.activeGroup.disabled_members && state.activeGroup.disabled_members.length) {
                        add('');
                        add(`Disabled members: ${JSON.stringify(state.activeGroup.disabled_members)}`);
                    }
                } else {
                    add('=== Single Character Info ===');
                    add('');
                    const ctx = getFreshContext();
                    const charId = ctx.characterId;
                    if (charId !== null && charId !== undefined) {
                        const char = ctx.characters?.[charId];
                        if (char) {
                            add(`Name: "${char.name}"`);
                            add(`Avatar: "${char.avatar || ''}"`);
                            add(`description: ${(char.description || '').substring(0, 150)}${(char.description || '').length > 150 ? '...' : ''}`);
                            add(`personality: ${(char.personality || '').substring(0, 100)}${(char.personality || '').length > 100 ? '...' : ''}`);
                            add(`scenario: ${(char.scenario || '').substring(0, 100)}${(char.scenario || '').length > 100 ? '...' : ''}`);
                            // Show char config (brain button) data
                            if (char.data?.extensions?.agent_statesync) {
                                const cc = char.data.extensions.agent_statesync;
                                add(`[Agent Config] mode=${cc.mode || 'characters'}, names=${JSON.stringify(cc.names || [])}`);
                            } else {
                                add(`[Agent Config] (default — no brain button config)`);
                            }
                        } else {
                            add(`No character found at index ${charId}`);
                        }
                    } else {
                        add('No character selected.');
                    }
                }
                break;
            }

            case 'preview_meta': {
                add('=== SYSTEM_META Preview ===');
                add('');
                const fakeSessionId = state.context.chatMetadata?.[META_KEY_SESSION] || 'bypass-fake-session-id';
                const fakeMessageId = getMessageId();
                const meta = buildMetaTag(fakeSessionId, fakeMessageId, 'new', 0);
                add(meta);
                add('');
                add('(This is what would be injected as the first system message)');
                add('(Uses fake session ID if no real session exists)');
                break;
            }

            case 'init_payload': {
                add('=== Session Init Payload Preview (v3.0) ===');
                add('');
                add(`Mode: ${state.isGroupChat ? 'GROUP' : 'SINGLE CHARACTER'}`);
                if (!state.isGroupChat) {
                    const ctx = getFreshContext();
                    const charId = ctx.characterId;
                    const char = charId !== null && charId !== undefined
                        ? ctx.characters?.[charId] : null;
                    if (char) {
                        add(`Character: "${char.name}"`);
                    }
                } else if (state.activeGroup) {
                    add(`Group: "${state.activeGroup.name}" (${state.activeGroupCharacters.length} members)`);
                }
                add('');

                // Build the actual payload using the same logic as initSession()
                const payload = buildInitPayload();

                // Pretty-print with truncation for display
                const displayPayload = JSON.parse(JSON.stringify(payload, (key, value) => {
                    // Truncate long strings for display
                    if (typeof value === 'string' && value.length > 200) {
                        return value.substring(0, 200) + '... (truncated)';
                    }
                    return value;
                }, 2));

                add(JSON.stringify(displayPayload, null, 2));
                add('');
                add('(Descriptions truncated for display — full data is sent to Agent)');
                add('(Empty fields are excluded from the payload)');
                break;
            }

            case 'session_lookup': {
                add('=== Session Metadata (from ST chatMetadata) ===');
                add('');
                const meta = state.context.chatMetadata || {};
                add(JSON.stringify(meta, null, 2));
                add('');
                add(`world_session_id:      ${meta[META_KEY_SESSION] || '(not set)'}`);
                add(`ass_msg_counter:        ${meta[META_KEY_COUNTER] ?? '(not set)'}`);
                add(`ass_session_initialized: ${meta[META_KEY_INITIALIZED] ?? '(not set)'}`);
                break;
            }

            case 'last_intercept': {
                add('=== Last Intercepted Request ===');
                add('');
                if (!state.lastInterceptLog) {
                    add('No request has been intercepted yet.');
                    add('Send a message in chat while the extension is enabled to see the data here.');
                    break;
                }
                add(`Timestamp:      ${state.lastInterceptLog.timestamp}`);
                add(`Message Type:   ${state.lastInterceptLog.messageType}`);
                add(`Session ID:     ${state.lastInterceptLog.sessionId}`);
                add(`Message ID:     ${state.lastInterceptLog.messageId}`);
                add(`Swipe Index:    ${state.lastInterceptLog.swipeIndex}`);
                add(`Target URL:     ${state.lastInterceptLog.targetUrl}`);
                add(`Group Mode:     ${state.lastInterceptLog.groupMode}`);
                add(`Active Group:   ${state.lastInterceptLog.activeGroup || '(none)'}`);
                add(`Messages Count: ${state.lastInterceptLog.messagesCount}`);
                add('');
                add('--- Message Previews ---');
                if (state.lastInterceptLog.messages) {
                    state.lastInterceptLog.messages.forEach((m, i) => {
                        add(`[${i}] ${m.role}: ${m.contentPreview}`);
                    });
                }
                add('');
                add('--- Full SYSTEM_META tag ---');
                add(state.lastInterceptLog.metaTag);
                break;
            }

            case 'persona': {
                add('=== Persona / User Description Search ===');
                add('');

                const ctx = getFreshContext();

                // 1. Check context.name1
                add(`--- context.name1: "${ctx.name1 || '(empty)'}"`);
                add('');

                // 2. Check powerUserSettings — the correct source
                const pu = ctx.powerUserSettings;
                if (pu) {
                    add(`--- powerUserSettings.persona_description ---`);
                    add(`  "${(pu.persona_description || '(empty)').substring(0, 300)}"`);
                    add('');

                    add(`--- powerUserSettings.persona_descriptions ---`);
                    const descs = pu.persona_descriptions;
                    if (descs && typeof descs === 'object') {
                        const keys = Object.keys(descs);
                        add(`  ${keys.length} persona(s) with descriptions`);
                        keys.forEach(avatar => {
                            const d = descs[avatar];
                            add(`  "${avatar}":`);
                            add(`    name: "${(pu.personas?.[avatar] || '(unknown)').substring(0, 100)}"`);
                            add(`    description: "${(d?.description || '(empty)').substring(0, 200)}"`);
                            add(`    title: "${(d?.title || '(empty)').substring(0, 100)}"`);
                        });
                    } else {
                        add('  (not an object)');
                    }
                    add('');

                    // 3. Check persona name mapping
                    add(`--- powerUserSettings.personas (avatar -> name) ---`);
                    const personas = pu.personas;
                    if (personas) {
                        const personaEntries = Object.entries(personas);
                        add(`  ${personaEntries.length} persona(s) defined`);
                        personaEntries.forEach(([avatar, name]) => {
                            add(`  "${avatar}" -> "${name}"`);
                        });
                    }
                    add('');
                } else {
                    add('--- powerUserSettings: not found ---');
                    add('');
                }

                break;
            }

            default:
                add(`Unknown command: "${command}"`);
        }
    } catch (err) {
        add('');
        add(`ERROR: ${err.message}`);
        add(err.stack || '');
    }

    return lines.join('\n');
}
