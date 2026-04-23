// debug.js — Agent-StateSync Debug Command Handlers
//
// Executes diagnostic commands and returns formatted output strings
// for display in the debug panel textbox.
// File Version: 1.0.1

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
} from './settings.js';
import { fetchGroupsFromServer, findActiveGroup, loadGroupData } from './groups.js';
import { buildMetaTag, getMessageId } from './pipeline.js';
import { buildInitPayload } from './session.js';

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

            case 'context_dump': {
                add('=== SillyTavern Context Dump ===');
                add('');
                add(`context.groupId (selected_group): ${state.context.groupId ?? 'null (NOT SET)'}`);
                add(`context.chatId (computed):       ${state.context.chatId ?? 'null (NOT SET)'}`);
                add(`context.characterId (this_chid): ${state.context.characterId ?? 'null'}`);
                add(`context.name1 (persona):         ${state.context.name1 ?? '(empty)'}`);
                add(`context.name2 (character/group):  ${state.context.name2 ?? '(empty)'}`);
                add(`context.onlineStatus:            ${state.context.onlineStatus ?? 'null'}`);
                add(`context.maxContext:               ${state.context.maxContext}`);
                add('');
                add('--- getCurrentChatId() ---');
                const chatId = typeof state.context.getCurrentChatId === 'function'
                    ? state.context.getCurrentChatId() : 'FUNCTION NOT AVAILABLE';
                add(`getCurrentChatId() => ${chatId}`);
                add('');
                add('--- chatMetadata ---');
                add(JSON.stringify(state.context.chatMetadata || {}, null, 2));
                add('');
                add('--- chat array length ---');
                const chatArr = state.context.chat || [];
                add(`context.chat.length = ${Array.isArray(chatArr) ? chatArr.length : '(not array)'}`);
                break;
            }

            case 'chat_ids': {
                add('=== Chat ID & Group ID Analysis ===');
                add('');
                const chatId = typeof state.context.getCurrentChatId === 'function'
                    ? state.context.getCurrentChatId() : null;
                const groupId = state.context.groupId || null;
                const computedChatId = state.context.chatId || null;

                add(`getCurrentChatId():  ${chatId}`);
                add(`context.groupId:    ${groupId}`);
                add(`context.chatId:     ${computedChatId}`);
                add(`context.name2:      "${state.context.name2 || ''}"`);
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
                break;
            }

            case 'find_group': {
                add('=== Finding Active Group ===');
                add('');
                if (!state.cachedGroups) {
                    add('Groups not loaded yet. Run "Load & Dump Groups" first.');
                    break;
                }
                add(`cachedGroups: ${state.cachedGroups.length} groups loaded`);
                const currentChatId = typeof state.context.getCurrentChatId === 'function'
                    ? state.context.getCurrentChatId() : null;
                const currentGroupId = state.context.groupId || null;
                add(`Input: chatId=${currentChatId}, groupId=${currentGroupId}`);
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
                        add('  This can happen if loadGroupData() ran before getCurrentChatId() was ready.');
                        add('  Fix: switch chats or reload the page (the proactive hook will re-run).');
                    }
                } else {
                    add('RESULT: NO MATCH FOUND — single character mode');
                    add('');
                    add('Check the console (F12) for the detailed matching log.');
                    add('The findActiveGroup() function logs every step.');
                }
                break;
            }

            case 'group_members': {
                add('=== Group Members ===');
                add('');
                if (!state.isGroupChat || !state.activeGroup) {
                    add('Not in group mode. No active group.');
                    break;
                }
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

                // 1. Check context.name1
                add(`--- context.name1: "${state.context.name1 || '(empty)'}"`);
                add('');

                // 2. Check powerUserSettings — the correct source
                const pu = state.context.powerUserSettings;
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
