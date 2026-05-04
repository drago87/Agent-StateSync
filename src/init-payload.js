// init-payload.js — Agent-StateSync Init Payload Builder (v3.0)
//
// Constructs the character/scenario data payloads sent to
// POST /api/sessions/{id}/init.  Handles single-character,
// multi-character, scenario, and group chat formats.
//
// Extracted from session.js to keep the payload builder
// separate from the session lifecycle management.
// File Version: 1.0.0

import state from './state.js';
import {
    EXTENSION_NAME, CHAR_CONFIG_EXT_KEY,
    buildPromptSettingsPayload,
} from './settings.js';
import { getCharInitType, getCharInitNames } from './char-config.js';
import { getPersonaPromptOverrides, getPersonaTrackedFieldAdditions } from './persona-config.js';
import { getTrackedFieldsForPayload } from './tracked-fields.js';

// #############################################
// # Payload Helper Functions
// #############################################

/**
 * Build the character/scenario data object from a character's card fields.
 * Uses the first message from the chat (not the card's first_mes field).
 * Excludes empty fields.
 *
 * @param {object} charData - Character object (from context.characters[] or context itself)
 * @param {string|null} firstMesOverride - Override first_mes (from chat messages)
 * @returns {object} Clean data object with only non-empty fields
 */
function buildCardData(charData, firstMesOverride) {
    const data = {};

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
    const persona = {};

    const name = state.context.name1 || '';
    if (name) persona.name = name;

    const desc = state.context.powerUserSettings?.persona_description || '';
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
    const chat = state.context.chat;
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
    const extData = charObj?.data?.extensions?.[CHAR_CONFIG_EXT_KEY];
    if (extData) {
        if (Array.isArray(extData.tracked_field_additions) && extData.tracked_field_additions.length > 0) {
            member.tracked_field_additions = extData.tracked_field_additions;
        }
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
 * @returns {object} The complete init payload
 */
export function buildInitPayload() {
    if (state.isGroupChat && state.activeGroupCharacters.length > 0) {
        return buildGroupInitPayload();
    }
    return buildSingleCharInitPayload();
}

// #############################################
// # Single-Character Payload
// #############################################

/**
 * Build init payload for a single character (non-group) chat.
 */
function buildSingleCharInitPayload() {
    const cardType = getCharInitType();      // 'character' | 'multi-character' | 'scenario'
    const cardNames = getCharInitNames();   // [] for character/scenario, ['Alice','Bob'] for multi
    const cardName = state.context.name2 || '';
    const firstMes = getFirstMesFromChat(null);
    const cardData = buildCardData(state.context, firstMes);
    const persona = buildPersona();

    const payload = {
        is_group: false,
        is_multi_character: cardType === 'multi-character',
        is_scenario: cardType === 'scenario',
        card_name: cardName,
    };
        // Chat name (character card name)
        const chatName = state.context.name2 || '';
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

    // Global prompt_settings (merged with per-character + persona overrides)
    const charConfig = state.context.characters?.[state.context.characterFilter]
        ?.data?.extensions?.[CHAR_CONFIG_EXT_KEY]
        || state.context.chatMetadata?.[CHAR_CONFIG_EXT_KEY]
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
    const chat = state.context.chat;
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
    };

        // Chat name (group name)
        const chatName = state.context.groups?.find(g => g.id === state.context.groupId)?.name || '';
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