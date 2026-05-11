// ui.js — Agent-StateSync UI Orchestrator & Initialization
// File Version: 2.2.0
//
// Thin orchestrator that wires together the settings panel (ui-settings),
// injected buttons (ui-buttons), chat event hooks, and the main init()
// entry point.  Keeps the initialization flow in one place while
// delegating rendering to focused modules.

import state from './state.js';
import {
    EXTENSION_NAME, SETTINGS_KEY,
    defaultSettings, getSettings,
} from './settings.js';
import { getAgentOrigin, refreshAgentUrlDisplay, startHealthChecks } from './agent-url.js';
import { proactiveChatChanged } from './session.js';
import { interceptFetch } from './pipeline.js';
import { initCharConfig } from './char-config.js';
import { initPersonaConfig } from './persona-config.js';
import { renderSettingsUI } from './ui-settings.js';
import { injectCharConfigButton, injectInitButton, updateInitButtonVisibility } from './ui-buttons.js';

// #############################################
// # Chat Event Hooks
// #############################################

/**
 * Schedule a debounced proactive chat-changed check.
 *
 * When "Auto-load Last Chat" is enabled, ST fires two rapid chat-changed
 * events on startup: first for the default "SillyTavern System" empty chat,
 * then for the actual last chat. Without debouncing, the first event
 * triggers a premature "New chat detected" popup.
 *
 * This function cancels any previously scheduled check and starts a new
 * 1500ms timer, so only the LAST chat in a rapid sequence is acted upon.
 */
function scheduleProactiveCheck() {
    // Cancel any previously scheduled check
    if (state.chatChangedDebounceTimer) {
        clearTimeout(state.chatChangedDebounceTimer);
    }

    state.chatChangedDebounceTimer = setTimeout(async () => {
        state.chatChangedDebounceTimer = null;
        try {
            await proactiveChatChanged();
            updateInitButtonVisibility();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] Proactive check failed:`, e.message);
        }
    }, 3000);
}

export function hookChatEvents() {
    // Listen for session deletion notifications from the polling system
    $(window).on('ass-session-deleted', updateInitButtonVisibility);

    // Listen for session confirmation from ping (Agent confirms session exists)
    $(window).on('ass-session-confirmed', updateInitButtonVisibility);

    const eventBus = state.context.eventBus;
    if (eventBus) {
        eventBus.on('chat-changed', () => {
            console.log(`[${EXTENSION_NAME}] Chat changed - debouncing proactive check`);
            state.lastUserMsgHash = null;
            state.lastAssistantMsgHash = null;
            state.lastConversationCount = 0;
            state.currentSwipeIndex = 0;
            state.configSynced = false;

            // Reset session state — the new chat may not be initialized.
            // proactiveChatChanged() will set it back to true if the Agent
            // has an existing session for this chat (via ping response).
            state.sessionInitialized = false;
            state.initializing = false;

            // Reset group cache so it reloads for the new chat
            state.cachedGroups = null;
            state.activeGroup = null;
            state.activeGroupCharacters = [];
            state.isGroupChat = false;

            // Refresh the Agent URL display
            refreshAgentUrlDisplay();

            const settings = getSettings();
            if (settings.enabled) {
                startHealthChecks();
                // Debounced proactive check: waits 1500ms so rapid
                // chat-changed events (e.g. Auto-load Last Chat) cancel
                // each other and only the final chat is checked.
                scheduleProactiveCheck();
            }
        });
    }
}

// #############################################
// # Initialization
// #############################################

export function init(debug = false) {
    // Store debug flag in state before anything else
    state.debug = debug;
    console.log(`[${EXTENSION_NAME}] Debug mode: ${state.debug}`);

    // Wait for SillyTavern to be ready
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
        while (!window.SillyTavern || !window.SillyTavern.getContext) {
            await new Promise(r => setTimeout(r, 100));
        }

        state.context = window.SillyTavern.getContext();

        // --- Migrate old settings format ---
        if (state.context.extensionSettings[SETTINGS_KEY]) {
            const stored = state.context.extensionSettings[SETTINGS_KEY];

            // Remove deprecated agentUrl (now auto-detected)
            if (stored.agentUrl !== undefined) {
                delete stored.agentUrl;
                console.log(`[${EXTENSION_NAME}] Removed deprecated agentUrl setting (now auto-detected).`);
            }
            if (stored.manualOverride !== undefined) {
                delete stored.manualOverride;
            }

            // Migrate old single-URL format to array format (intermediate migration)
            if (stored.instructLlmUrl !== undefined) {
                if (stored.instructLlmUrl && !stored.instructLlmBackends) {
                    stored.instructLlmBackends = [{ url: stored.instructLlmUrl, api_key: 'none' }];
                }
                delete stored.instructLlmUrl;
                console.log(`[${EXTENSION_NAME}] Migrated instructLlmUrl to instructLlmBackends.`);
            }

            // Remove LLM settings now managed by the Agent
            if (stored.rpLlmUrl !== undefined) {
                delete stored.rpLlmUrl;
                console.log(`[${EXTENSION_NAME}] Removed deprecated rpLlmUrl setting (now Agent-managed).`);
            }
            if (stored.instructLlmBackends !== undefined) {
                delete stored.instructLlmBackends;
                console.log(`[${EXTENSION_NAME}] Removed deprecated instructLlmBackends setting (now Agent-managed).`);
            }
            if (stored.rpTemplate !== undefined) {
                delete stored.rpTemplate;
                console.log(`[${EXTENSION_NAME}] Removed deprecated rpTemplate setting (now Agent-managed).`);
            }
            if (stored.instructTemplate !== undefined) {
                delete stored.instructTemplate;
                console.log(`[${EXTENSION_NAME}] Removed deprecated instructTemplate setting (now Agent-managed).`);
            }
        }

        // Initialize defaults if first run
        if (!state.context.extensionSettings[SETTINGS_KEY]) {
            state.context.extensionSettings[SETTINGS_KEY] = { ...defaultSettings };
            state.context.saveSettingsDebounced();
        }

        // Render UI, hook events, install interceptor
        renderSettingsUI();
        hookChatEvents();
        interceptFetch();

        // Inject Char Config button into action bar
        injectCharConfigButton();

        // Inject Init Session button into chat controls
        injectInitButton();

        // Inject brain button into Character Sheet Bar
        initCharConfig();

        // Inject brain button into Persona controls
        initPersonaConfig();

        console.log(`[${EXTENSION_NAME}] Extension loaded. Version 3.0`);
        console.log(`[${EXTENSION_NAME}] Settings:`, getSettings());
        console.log(`[${EXTENSION_NAME}] Agent URL (auto-detected):`, getAgentOrigin());

        // --- Initial proactive session check (for the chat that's open on page load) ---
        // Does NOT auto-create or auto-initialize sessions.
        // If the Agent has an existing session for this chat, STe re-attaches to it.
        // Otherwise, the user must press the Init (rocket) button manually.
        //
        // Uses scheduleProactiveCheck() (debounced 1500ms) so that if ST fires
        // chat-changed events during startup (e.g. Auto-load Last Chat), they
        // share the same debounce timer and only the final chat is checked.
        // The 2000ms fallback below only fires if NO chat-changed event occurs.
        const settings = getSettings();
        if (settings.enabled) {
            state.sessionInitialized = false;  // Start as false — proactive will set true if session exists
            // Schedule the debounced check. If a chat-changed event fires
            // within the 1500ms window, it resets the timer automatically.
            scheduleProactiveCheck();

            // Safety net: if no chat-changed event fires at all (rare edge
            // case), schedule a second check after 3 seconds. The debounce
            // in scheduleProactiveCheck ensures only one check actually runs.
            setTimeout(() => {
                if (!state.proactiveInProgress && !state.sessionInitialized) {
                    scheduleProactiveCheck();
                }
            }, 3000);
        }

        resolve();
    });
}