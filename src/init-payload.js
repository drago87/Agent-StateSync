// init-payload.js — Agent-StateSync Init Payload Builder (v3.1)
//
// Constructs the character/scenario data payloads sent to
// POST /api/sessions/{id}/init.  Handles single-character,
// multi-character, scenario, and group chat formats.
//
// Includes _chat_info with chat_id format:
//   - Single-char: chatName-rawChatId
//   - Group:       groupName-rawChatId
//
// IMPORTANT: SillyTavern's getContext() does NOT include character card
// fields (description, personality, scenario, mes_example) as top-level
// properties.  These must be accessed via ctx.characters[ctx.characterId].
// Always use the resolved character object for buildCardData(), never the
// raw context object.
//
// Extracted from session.js to keep the payload builder
// separate from the session lifecycle management.
// File Version: 1.2.0

import state from './state.js';
import {
    EXTENSION_NAME, CHAR_CONFIG_EXT_KEY,
    buildPromptSettingsPayload,
} from './settings.js';
import { getCharInitType, getCharInitNames, getCharTrackedFieldAdditions, getTrackedFieldAdditionsForChar } from './char-config.js';
import { getPersonaPromptOverrides, getPersonaTrackedFieldAdditions } from './persona-config.js';
import { getTrackedFieldsForPayload } from './tracked-fields.js';
import { getFreshContext } from './groups.js';

// #############################################
// # Payload Helper Functions
// #############################################

/**
 * Build the character/scenario data object from a character's card fields.
 * Uses the first message from the chat (not the card's first_mes field).
 * Excludes empty fields.
 *
 * IMPORTANT: charData MUST be a character object from context.characters[],
 * NOT the raw context object.  SillyTavern's getContext() does not include
 * description, personality, scenario, or mes_example as top-level properties.
 *
 * @param {object} charData - Character object from context.characters[]
 * @param {string|null} firstMesOverride - Override first_mes (from chat messages)
 * @returns {object} Clean data object with only non-empty fields
 */
function buildCardData(charData, firstMesOverride) {
    const data = {};

    if (!charData || typeof charData !== 'object') {
        console.warn(`[${EXTENSION_NAME}] buildCardData: charData is missing or invalid`);
        return data;
    }

    const desc = charData.description || '';
    if (desc) data.description = desc;

    const personality = charData.personality || '';
    if (personality) data.personality = personality;

    const scenario = charData.scenario || '';
    if (scenario) data.scenario = scenario;

    const firstMes = firstMesOverride || '';
    if (firstMes) data.first_mes = firstMes;

    const mesExample = charData.mes_example || '';
    if (mesExample) data.mes_example = mesExample;

    return data;
}

/**
 * Build the persona object. Excludes empty fields.
 */
function buildPersona() {
    const ctx = getFreshContext();
    const persona = {};

    const name = ctx.name1 || '';
    if (name) persona.name = name;

    const desc = ctx.powerUserSettings?.persona_description || '';
    if (desc) persona.description = desc;

    // Per-persona tracked field additions
    const personaTFAdditions = getPersonaTrackedFieldAdditions();
    if (personaTFAdditions) {
        persona.tracked_field_additions = personaTFAdditions;
    }

    // Per-persona prompt settings override
    const personaPSOverride = getPersonaPromptOverrides();
    if (personaPSOverride) {
        persona.prompt_settings_override = personaPSOverride;
    }

    return Object.keys(persona).length > 0 ? persona : undefined;
}

/**
 * Get the first message for a character from the chat history.
 * In group chats, we look for the first message where the character's name
 * appears as the sender (is_user=false, name matches).
 * In single-char chats, we just grab the first non-system message.
 *
 * @param {string|null} charName - Character name to look for (group mode)
 * @returns {string|null} The message text, or null if no message found
 */
function getFirstMesFromChat(charName) {
    const ctx = getFreshContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;

    if (charName) {
        // Group mode: find the first message from this character
        for (const msg of chat) {
            if (!msg.is_user && msg.name === charName && msg.mes) {
                return msg.mes;
            }
        }
        // Also try matching with the ForceAvatar-based name
        // (ST may store character names differently in chat messages)
        return null;
    }

    // Single-char mode: first non-user message
    for (const msg of chat) {
        if (!msg.is_user && msg.mes) {
            return msg.mes;
        }
    }

    return null;
}

/**
 * Read the char config (type + names) stored in a character card's extensions.
 * Used for group members where each card can be independently classified.
 *
 * @param {object} charObj - Character object from context.characters[]
 * @returns {{ type: string, names: string[] }}
 */
function readMemberCharConfig(charObj) {
    if (!charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]) {
        return { type: 'character', names: [] };
    }

    const stored = charObj.data.extensions[CHAR_CONFIG_EXT_KEY];
    if (stored.mode === 'scenario') {
        return { type: 'scenario', names: [] };
    }

    // Multi-character if 2+ names defined
    const names = Array.isArray(stored.names)
        ? stored.names.map(n => (n || '').trim()).filter(Boolean)
        : [];
    if (names.length >= 2) {
        return { type: 'multi-character', names };
    }

    // Single character — still return names so caller can add character_names
    return { type: 'character', names };
}

/**
 * Build a single group member entry for the init payload.
 * Each member respects its own card type classification.
 *
 * @param {object} charObj - Resolved character object
 * @param {string|null} firstMes - First message from chat for this member (or null)
 * @returns {object} Member payload object
 */
function buildGroupMemberPayload(charObj, firstMes) {
    const config = readMemberCharConfig(charObj);
    const cardName = charObj.name || 'Unknown';
    const cardData = buildCardData(charObj, firstMes);

    const member = {
        is_multi_character: config.type === 'multi-character',
        is_scenario: config.type === 'scenario',
        card_name: cardName,
    };

    if (config.type === 'multi-character' && config.names.length > 0) {
        member.character_names = config.names.join(', ');
        member.character = cardData;
    } else if (config.type === 'scenario') {
        // Scenario: card data goes under "scenario" key instead of "character"
        member.scenario = cardData;
    } else if (config.names.length === 1) {
        // Single name override: card name differs from actual character name
        member.character_names = config.names[0];
        member.character = cardData;
    } else {
        // Plain character
        member.character = cardData;
    }

    // --- Per-character tracked_field_additions and prompt_settings_override ---
    const charTFAdditions = getTrackedFieldAdditionsForChar(charObj);
    if (charTFAdditions) {
        member.tracked_field_additions = charTFAdditions;
    }
    const extData = charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY];
    if (extData) {
        if (extData.prompt_settings_override && typeof extData.prompt_settings_override === 'object') {
            const overrides = { ...extData.prompt_settings_override };
            for (const [key, val] of Object.entries(overrides)) {
                if (val === undefined || val === null || val === '' || val === 'global_default') {
                    delete overrides[key];
                }
            }
            if (Object.keys(overrides).length > 0) {
                member.prompt_settings_override = overrides;
            }
        }
    }

    return member;
}

// #############################################
// # Prompt Settings Merge Helper
// #############################################

/**
 * Apply persona prompt overrides on top of merged prompt settings.
 * Shared between single-char and group payload builders.
 *
 * @param {object} promptSettings - Already-merged prompt settings
 * @param {object|null} personaOverrides - From getPersonaPromptOverrides()
 * @returns {object} The same object with persona overrides applied
 */
function applyPersonaOverrides(promptSettings, personaOverrides) {
    if (!personaOverrides) return promptSettings;

    const overridableKeys = [
        'perspective', 'tense', 'tone', 'content_rating',
        'extraction_strictness', 'detail_level', 'language', 'relationship_depth',
    ];
    for (const key of overridableKeys) {
        if (personaOverrides[key] !== undefined && personaOverrides[key] !== null
            && personaOverrides[key] !== '' && personaOverrides[key] !== 'global_default') {
            promptSettings[key] = personaOverrides[key];
        }
    }

    return promptSettings;
}

// #############################################
// # Public: buildInitPayload
// #############################################

/**
 * Get the session identity components derived from the same logic as buildChatInfo().
 * Returns { st_chat_id: rawChatId, name: chatNameOrGroupName }
 * - Single-char: name = ctx.name2 (character name)
 * - Group:       name = state.activeGroup.name (group name)
 * - st_chat_id is always the raw ST chat ID (without prefix)
 */
export function getSessionIdentity() {
    const ctx = getFreshContext();
    const rawChatId = typeof ctx.getCurrentChatId === 'function'
        ? ctx.getCurrentChatId() || ''
        : '';

    let name = '';
    if (state.isGroupChat && state.activeGroup) {
        name = state.activeGroup.name || '';
    } else {
        name = ctx.name2 || '';
    }

    return { st_chat_id: rawChatId, name };
}

/**
 * Build the _chat_info object for the init payload.
 * chat_id format: chatName-rawChatId (single) or groupName-rawChatId (group)
 * Uses the same getSessionIdentity() to ensure consistency.
 */
function buildChatInfo() {
    const { st_chat_id, name } = getSessionIdentity();

    const chatId = name && st_chat_id
        ? `${name}-${st_chat_id}`
        : st_chat_id || name;

    return {
        chat_id: chatId,
        mode: state.isGroupChat ? 'group' : 'single-character',
    };
}

/**
 * Build the full init payload for POST /api/sessions/{id}/init
 * according to the v3.0 spec.
 *
 * Handles all cases:
 * - Single character (plain / multi-character / scenario)
 * - Group chat with mixed card types
 * - group_scenario logic
 * - Empty field exclusion
 * - first_mes from chat messages
 *
 * This function is async because it may need to unshallow character
 * data (load full card from server) when building a single-char payload.
 *
 * @returns {Promise<object>} The complete init payload
 */
export async function buildInitPayload() {
    if (state.isGroupChat && state.activeGroupCharacters.length > 0) {
        return buildGroupInitPayload();
    }
    return buildSingleCharInitPayload();
}

// #############################################
// # Single-Character Payload
// #############################################

/**
 * Resolve the active character object from the fresh context.
 * SillyTavern's getContext() does NOT include card fields (description,
 * personality, scenario, mes_example) as top-level properties — they
 * live inside ctx.characters[ctx.characterId].
 *
 * If the character data appears shallow (missing description AND personality),
 * attempts to unshallow it via ctx.unshallowCharacter().
 *
 * @param {object} ctx - Fresh context from getFreshContext()
 * @returns {object|null} The character object, or null if not found
 */
async function resolveActiveCharacter(ctx) {
    const charId = ctx.characterId;
    if (charId == null) {
        console.warn(`[${EXTENSION_NAME}] resolveActiveCharacter: characterId is null`);
        return null;
    }

    const charObj = ctx.characters?.[charId];
    if (!charObj) {
        console.warn(`[${EXTENSION_NAME}] resolveActiveCharacter: no character at index ${charId}`);
        return null;
    }

    // Check if the character data is shallow (only basic fields loaded).
    // A shallow character won't have description or personality — try to
    // load the full data on demand.
    if (charObj.shallow && typeof ctx.unshallowCharacter === 'function') {
        console.log(`[${EXTENSION_NAME}] resolveActiveCharacter: unshallowing character at index ${charId}`);
        try {
            await ctx.unshallowCharacter(charId);
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] resolveActiveCharacter: unshallowCharacter failed:`, e.message);
        }
    }

    return charObj;
}

/**
 * Build init payload for a single character (non-group) chat.
 *
 * IMPORTANT: Reads character card data from ctx.characters[ctx.characterId]
 * instead of from the context top-level.  SillyTavern's getContext() does
 * NOT include description, personality, scenario, mes_example as top-level
 * properties — those fields live on the character objects in the characters[]
 * array.
 */
async function buildSingleCharInitPayload() {
    const cardType = getCharInitType();      // 'character' | 'multi-character' | 'scenario'
    const cardNames = getCharInitNames();   // [] for character/scenario, ['Alice','Bob'] for multi
    const ctx = getFreshContext();
    const cardName = ctx.name2 || '';
    const firstMes = getFirstMesFromChat(null);

    // --- Resolve the active character object ---
    // Use ctx.characters[ctx.characterId] instead of ctx directly.
    // The context object does NOT have description/personality/scenario/
    // mes_example as top-level properties.
    const charObj = await resolveActiveCharacter(ctx);
    const cardData = buildCardData(charObj || {}, firstMes);
    const persona = buildPersona();

    const payload = {
        is_group: false,
        is_multi_character: cardType === 'multi-character',
        is_scenario: cardType === 'scenario',
        card_name: cardName,
        _chat_info: buildChatInfo(),
    };
        // Chat name (character card name)
        const chatName = ctx.name2 || '';
        if (chatName) payload.chat_name = chatName;

    // For multi-character, include character_names
    if (cardType === 'multi-character' && cardNames.length > 0) {
        payload.character_names = cardNames.join(', ');
    }
    // Single name override: card name differs from actual character name
    else if (cardType === 'character' && cardNames.length === 1) {
        payload.character_names = cardNames[0];
    }

    // Card data goes under "character" or "scenario" key depending on type
    if (cardType === 'scenario') {
        payload.scenario = cardData;
    } else {
        payload.character = cardData;
    }

    // Persona
    if (persona) {
        payload.persona = persona;
    }

    // Global tracked_fields definition (from STe settings)
    const trackedFields = getTrackedFieldsForPayload();
    if (trackedFields && typeof trackedFields === 'object') {
        const hasContent = ['character', 'scenario', 'shared'].some(
            cat => trackedFields[cat] && Object.keys(trackedFields[cat]).length > 0
        );
        if (hasContent) {
            payload.tracked_fields = JSON.parse(JSON.stringify(trackedFields));
        }
    }

    // Per-character tracked_field_additions
    const charTFAdditions = getCharTrackedFieldAdditions();
    if (charTFAdditions) {
        payload.tracked_field_additions = charTFAdditions;
    }

    // Global prompt_settings (merged with per-character + persona overrides)
    // NOTE: ctx.characterFilter does not exist in the ST API — use ctx.characterId
    const charConfig = charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]
        || ctx.characters?.[ctx.characterId]?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]
        || ctx.chatMetadata?.[CHAR_CONFIG_EXT_KEY]
        || null;
    const charOverrides = charConfig?.prompt_settings_override || null;
    let promptSettings = buildPromptSettingsPayload(charOverrides);

    // Apply persona overrides on top (highest priority)
    applyPersonaOverrides(promptSettings, getPersonaPromptOverrides());

    payload.prompt_settings = promptSettings;

    console.log(`[${EXTENSION_NAME}] Single-char init: type=${cardType}, name="${cardName}"`);

    return payload;
}

// #############################################
// # Group Chat Payload
// #############################################

/**
 * Build init payload for a group chat.
 * Members are ordered by their first message in the chat.
 * Handles group_scenario logic and per-member card type classification.
 */
function buildGroupInitPayload() {
    const members = state.activeGroupCharacters.filter(c => !c._unresolved);

    // --- Determine member ordering by first message in chat ---
    // Build a map of char name -> first message index
    const gCtx = getFreshContext();
    const chat = gCtx.chat;
    const nameToFirstIndex = new Map();
    if (Array.isArray(chat) && chat.length > 0) {
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg.is_user && msg.name && !nameToFirstIndex.has(msg.name)) {
                nameToFirstIndex.set(msg.name, i);
            }
        }
    }

    // Sort members by their first message index (unseen members keep original order)
    const sortedMembers = [...members];
    sortedMembers.sort((a, b) => {
        const idxA = nameToFirstIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER;
        const idxB = nameToFirstIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER;
        // Both unseen: keep original order
        if (idxA === Number.MAX_SAFE_INTEGER && idxB === Number.MAX_SAFE_INTEGER) return 0;
        return idxA - idxB;
    });

    // --- Check if any member is a scenario-type card ---
    const groupScenarioMember = sortedMembers.find(m => {
        const config = readMemberCharConfig(m);
        return config.type === 'scenario';
    });

    // --- Get group_scenario: use the scenario-type member's scenario text ---
    const groupScenario = groupScenarioMember?.scenario || '';

    // --- Build member payloads ---
    const memberPayloads = sortedMembers.map(m => {
        const firstMes = getFirstMesFromChat(m.name);
        const member = buildGroupMemberPayload(m, firstMes);

        // If the group has a group_scenario, strip the scenario key from each member
        if (groupScenario && member.scenario) {
            delete member.scenario;
        }

        return member;
    });

    // --- Build final payload ---
    const payload = {
        is_group: true,
        group_name: state.activeGroup.name,
        group_members: memberPayloads,
        _chat_info: buildChatInfo(),
    };

        // Chat name (group name) — use activeGroup directly, not stale context
        const chatName = state.activeGroup?.name || '';
        if (chatName) payload.chat_name = chatName;

    // group_scenario: include only if non-empty
    if (groupScenario) {
        payload.group_scenario = groupScenario;
    }

    // Persona (top-level only for groups)
    const persona = buildPersona();
    if (persona) {
        payload.persona = persona;
    }

    // Global tracked_fields definition (from STe settings)
    const trackedFields = getTrackedFieldsForPayload();
    if (trackedFields && typeof trackedFields === 'object') {
        const hasContent = ['character', 'scenario', 'shared'].some(
            cat => trackedFields[cat] && Object.keys(trackedFields[cat]).length > 0
        );
        if (hasContent) {
            payload.tracked_fields = JSON.parse(JSON.stringify(trackedFields));
        }
    }

    // Global prompt_settings (merged with persona overrides)
    let promptSettings = buildPromptSettingsPayload(null);

    // Apply persona overrides on top (highest priority)
    applyPersonaOverrides(promptSettings, getPersonaPromptOverrides());

    payload.prompt_settings = promptSettings;

    console.log(`[${EXTENSION_NAME}] Group init: "${state.activeGroup.name}" with ${memberPayloads.length} members`);
    console.log(`[${EXTENSION_NAME}] group_scenario: ${groupScenario ? 'yes' : 'no'}`);

    return payload;
}