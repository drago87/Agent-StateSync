// ui-buttons.js — Agent-StateSync Injected UI Buttons
// File Version: 1.0.0
//
// Char Config button (action bar), Init Session button (rocket),
// and visibility management for the init button.
//
// Extracted from ui.js to keep injected UI elements separate
// from the settings panel and initialization orchestrator.

import state from './state.js';
import {
    getSettings,
} from './settings.js';
import { getAgentOrigin } from './agent-url.js';
import { manualInitSession } from './session.js';

// #############################################
// # Character Config Button (Action Bar)
// #############################################

/**
 * Inject a "Char Config" button into SillyTavern's action button bar,
 * just before the Delete button.
 * Pings Agent config endpoint with current character's data.
 */
export function injectCharConfigButton() {
    if ($('#ass-char-config-btn').length) return; // Already injected

    const $deleteBtn = $('#delete_character_button');
    if (!$deleteBtn.length) {
        // ST not ready yet - retry
        setTimeout(injectCharConfigButton, 1000);
        return;
    }

    const $btn = $(`
        <div id="ass-char-config-btn" class="ass-char-config-wrap" style="display:inline-flex; margin:0 2px;">
            <button class="menu_button" type="button" title="Send character config to Agent">
                <i class="fa-solid fa-gear"></i>
                Char Config
            </button>
        </div>
    `);

    $deleteBtn.before($btn);

    $btn.on('click', async function () {
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.info('Enable State Sync first.', 'Agent-StateSync');
            return;
        }

        const origin = getAgentOrigin();
        if (!origin) {
            toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
            return;
        }

        toastr.info('Sending character config to Agent...', 'Agent-StateSync');

        try {
            const configPayload = {
                rp_template: settings.rpTemplate,
                instruct_template: settings.instructTemplate,
                thinking_steps: settings.thinkingSteps,
                refinement_steps: settings.refinementSteps,
            };

            // Only include URL fields if they have actual values
            if (settings.rpLlmUrl && settings.rpLlmUrl.trim()) {
                configPayload.rp_llm_url = settings.rpLlmUrl.trim();
            }
            if (Array.isArray(settings.instructLlmBackends) && settings.instructLlmBackends.length > 0) {
                const valid = settings.instructLlmBackends.filter(b => b.url && b.url.trim());
                if (valid.length > 0) {
                    configPayload.instruct_llm_backends = valid.map(b => ({
                        url: b.url.trim(),
                        api_key: b.api_key || 'none',
                    }));
                }
            }

            const resp = await fetch(`${origin}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(configPayload),
            });

            if (resp.ok) {
                state.configSynced = true;
                toastr.success('Config synced to Agent!', 'Agent-StateSync');
            } else {
                toastr.error(`Agent returned ${resp.status}`, 'Agent-StateSync');
            }
        } catch (err) {
            toastr.error(`Config sync failed: ${err.message}`, 'Agent-StateSync');
        }
    });
}

// #############################################
// # Init Session Button (Rocket Icon)
// #############################################

/**
 * Inject an "Init Session" button into the GG menu buttons container.
 * Hidden by default; shown when a chat needs initialization.
 * Hidden again after a successful init.
 */
export function injectInitButton() {
    if ($('#ass-init-session-btn').length) return; // Already injected

    const $container = $('#gg-menu-buttons-container');
    if (!$container.length) {
        // GG container not ready yet - retry
        setTimeout(injectInitButton, 1000);
        return;
    }

    const $btn = $(`
        <div id="ass-init-session-btn" class="gg-menu-button fa-solid fa-rocket interactable" style="display:none;" title="Initialize the current chat" tabindex="0"></div>
    `);

    $container.append($btn);

    $btn.on('click', async function () {
        const settings = getSettings();
        if (!settings.enabled) {
            toastr.info('Enable State Sync first.', 'Agent-StateSync');
            return;
        }

        const origin = getAgentOrigin();
        if (!origin) {
            toastr.error('No Agent URL detected. Set Custom Endpoint in ST.', 'Agent-StateSync');
            return;
        }

        $btn.css('opacity', '0.5').css('pointer-events', 'none');
        toastr.info('Initializing Agent session...', 'Agent-StateSync');

        try {
            const success = await manualInitSession();
            if (success) {
                toastr.success('Agent session initialized!', 'Agent-StateSync');
                $btn.hide(); // Hide after successful init
                state.sessionInitialized = true;
            } else {
                toastr.warning('Init failed. Check console for details.', 'Agent-StateSync');
            }
        } catch (err) {
            toastr.error(`Init failed: ${err.message}`, 'Agent-StateSync');
        } finally {
            $btn.css('opacity', '').css('pointer-events', '');
        }
    });
}

/**
 * Show or hide the init button based on whether the current chat
 * already has an initialized session.
 * Call this on chat-changed and after page load.
 */
export function updateInitButtonVisibility() {
    const $btn = $('#ass-init-session-btn');
    if (!$btn.length) return;

    if (state.sessionInitialized) {
        $btn.hide();
    } else {
        $btn.show();
    }
}