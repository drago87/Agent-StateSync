// commands.js — Agent-StateSync Slash Commands
//
// Registers all /ass-* slash commands with SillyTavern.
// File Version: 1.0.2

import { EXTENSION_NAME } from './settings.js';
import state from './state.js';
import { buildInitPayload } from './init-payload.js';

// #############################################
// # Helpers
// #############################################

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showPayloadPopup(title, payload) {
    const json = JSON.stringify(payload, null, 2);

    $('#ass-preview-popup').remove();

    const $popup = $(`
        <div id="ass-preview-popup" style="
            position:fixed; top:0; left:0; right:0; bottom:0;
            background:rgba(0,0,0,0.7); z-index:9999;
            display:flex; align-items:center; justify-content:center;
        ">
            <div style="
                background:var(--SmartThemeBlurTintColor, rgba(25,25,35,0.95));
                border:1px solid rgba(128,128,128,0.4); border-radius:8px;
                padding:16px; width:90%; max-width:850px; max-height:85vh;
                display:flex; flex-direction:column;
            ">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <b style="font-size:14px;">Agent-StateSync — ${title}</b>
                    <button id="ass-preview-close" class="menu_button" type="button">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <textarea readonly style="
                    flex:1; width:100%; min-height:300px;
                    font-family:monospace; font-size:12px; line-height:1.5;
                    background:rgba(0,0,0,0.3); color:var(--fg);
                    border:1px solid rgba(128,128,128,0.3); border-radius:4px;
                    padding:12px; resize:none; overflow:auto; white-space:pre;
                ">${escapeHtml(json)}</textarea>
                <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
                    <small style="color:var(--fg_dim);">Read-only preview. Close or press Escape.</small>
                </div>
            </div>
        </div>
    `);

    $('body').append($popup);

    $popup.on('click', function (e) {
        if (e.target === this) $popup.remove();
    });
    $popup.find('#ass-preview-close').on('click', function () {
        $popup.remove();
    });
    function onEscape(e) {
        if (e.key === 'Escape') {
            $popup.remove();
            $(document).off('keydown', onEscape);
        }
    }
    $(document).on('keydown', onEscape);
}

// #############################################
// # Commands
// #############################################

/** /ass-init — Preview the init payload with chat info */
function cmdAssInit(args, text) {
    try {
        const chatId = typeof state.context.getCurrentChatId === 'function'
            ? state.context.getCurrentChatId() || '(none)'
            : '(getCurrentChatId not available)';

        const payload = buildInitPayload();

        const chatInfo = {
            _chat_info: {
                chat_id: chatId,
                mode: state.isGroupChat ? 'group' : 'single-character',
            },
        };

        showPayloadPopup('Init Payload Preview', { ...chatInfo, ...payload });
    } catch (err) {
        toastr.error(`Failed to build payload: ${err.message}`, 'Agent-StateSync');
        console.error(`[${EXTENSION_NAME}] buildInitPayload error:`, err);
    }
    return '';
}

// --- Add more commands here as cmdAssXxx functions ---

// #############################################
// # Registration
// #############################################

export function registerSlashCommands() {
    try {
        // Uses ST's getContext().registerSlashCommand (deprecated but still works
        // and avoids webpack resolve issues with ST internal module paths)
        const ctx = state.context;
        ctx.registerSlashCommand(
            'ass-init',        // command name
            cmdAssInit,        // callback
            [],                // aliases
            'Preview the init payload that would be sent to the Agent.'
        );

        // --- Add more ctx.registerSlashCommand(...) here ---

        console.log(`[${EXTENSION_NAME}] Slash commands registered.`);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Failed to register slash commands:`, err);
    }
}