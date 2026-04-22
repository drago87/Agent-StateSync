// pipeline.js — Agent-StateSync Core Pipeline
//
// The main interception pipeline: message type detection, history trimming,
// [SYSTEM_META] tag construction, dummy bypass responses, and the
// fetch interceptor that ties everything together.
// File Version: 1.1.0

import state from './state.js';
import {
    EXTENSION_NAME, META_KEY_SESSION, META_KEY_COUNTER, META_KEY_INITIALIZED,
    getSettings, isBypassMode, syncConfigToAgent, updateStatus,
} from './settings.js';
import { resolveBackendOrigin, getAgentOrigin } from './agent-url.js';
import { loadGroupData } from './groups.js';
import { ensureSession } from './session.js';
import { getCharInitType } from './char-config.js';

// #############################################
// # 8. Dummy Response (Bypass Mode)
// #############################################

/**
 * Creates a fake Response object that mimics an OpenAI-compatible
 * chat completion streaming response. SillyTavern expects SSE format.
 */
export function createDummyResponse() {
    const dummyContent = '[Agent-StateSync BYPASS MODE — no actual LLM call was made. Check browser console (F12) for the full intercepted request data.]';

    // Build a minimal SSE stream body
    const sseBody = [
        `data: ${JSON.stringify({ id: 'bypass-fake-id', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'bypass-model', choices: [{ index: 0, delta: { role: 'assistant', content: dummyContent }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'bypass-fake-id', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'bypass-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
    ].join('');

    return new Response(sseBody, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}

// #############################################
// # 16. Message Type Detection
// #############################################

/**
 * Detect the type of turn: 'new', 'continue', 'swipe', 'redo'
 */
export function detectMessageType(messages) {
    const convMsgs = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const convCount = convMsgs.length;

    const userMsgs = convMsgs.filter(m => m.role === 'user');
    const assistantMsgs = convMsgs.filter(m => m.role === 'assistant');
    const currentUserHash = hashStr(userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : '');
    const currentAssistantHash = hashStr(assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : '');

    let type = 'new';

    if (state.lastUserMsgHash === null) {
        type = 'new';
    }
    else if (convCount === state.lastConversationCount && currentUserHash === state.lastUserMsgHash && currentAssistantHash === state.lastAssistantMsgHash) {
        type = 'continue';
    }
    else if (currentUserHash === state.lastUserMsgHash && currentAssistantHash !== state.lastAssistantMsgHash) {
        type = 'swipe';
        state.currentSwipeIndex++;
    }
    else if (convCount < state.lastConversationCount && currentUserHash !== state.lastUserMsgHash) {
        type = 'redo';
        state.currentSwipeIndex = 0;
    }
    else if (currentUserHash !== state.lastUserMsgHash) {
        type = 'new';
        state.currentSwipeIndex = 0;
    }

    state.lastUserMsgHash = currentUserHash;
    state.lastAssistantMsgHash = currentAssistantHash;
    state.lastConversationCount = convCount;

    return type;
}

/**
 * Simple string hash for comparing message content across requests.
 * (Imported from settings.js would create a circular dependency via
 * session.js, so we keep a private copy here.)
 */
function hashStr(str) {
    let hash = 0;
    const s = str || '';
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash = hash & hash;
    }
    return hash.toString(36);
}

/**
 * Get or increment the message counter.
 */
export function getMessageId() {
    return (state.context.chatMetadata?.[META_KEY_COUNTER] || 0);
}

export async function incrementMessageId() {
    state.context.chatMetadata = state.context.chatMetadata || {};
    state.context.chatMetadata[META_KEY_COUNTER] = (state.context.chatMetadata[META_KEY_COUNTER] || 0) + 1;
    await state.context.saveMetadata();
    return state.context.chatMetadata[META_KEY_COUNTER];
}

// #############################################
// # 17. History Trimming
// #############################################

/**
 * Trim the messages array to the last N user/assistant messages.
 * System messages are always preserved.
 */
export function trimHistory(messages, maxConversationMessages) {
    if (maxConversationMessages === 0) return messages;

    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs = messages.filter(m => m.role !== 'system');

    const trimmed = convMsgs.slice(-maxConversationMessages);

    if (convMsgs.length > 0 && trimmed.length > 0 && trimmed[trimmed.length - 1] !== convMsgs[convMsgs.length - 1]) {
        trimmed.push(convMsgs[convMsgs.length - 1]);
    }

    return [...systemMsgs, ...trimmed];
}

// #############################################
// # 18. [SYSTEM_META] Construction
// #############################################

/**
 * Build the [SYSTEM_META] tag with all per-request data.
 * In group mode, includes group_id and member names.
 * Includes card_type for non-group chats.
 */
export function buildMetaTag(sessionId, messageId, type, swipeIndex) {
    let tag = `[SYSTEM_META] session_id=${sessionId} message_id=${messageId} type=${type} swipe_index=${swipeIndex}`;

    // Card type classification (single-char mode only)
    if (!state.isGroupChat) {
        const cardType = getCharInitType();
        tag += ` card_type=${cardType}`;
    }

    if (state.isGroupChat && state.activeGroup) {
        tag += ` group_id=${state.activeGroup.id} group_name=${state.activeGroup.name}`;

        // Include member names for the Agent to know who is in the scene
        const memberNames = state.activeGroupCharacters
            .filter(c => !c._unresolved)
            .map(c => c.name)
            .join(',');
        if (memberNames) {
            tag += ` members=${memberNames}`;
        }

        // Include disabled members so Agent knows who is muted
        if (Array.isArray(state.activeGroup.disabled_members) && state.activeGroup.disabled_members.length > 0) {
            const disabledNames = state.activeGroup.disabled_members
                .map(avatar => {
                    const char = state.activeGroupCharacters.find(c => c.avatar === avatar);
                    return char ? char.name : avatar;
                })
                .filter(n => n)
                .join(',');
            if (disabledNames) {
                tag += ` disabled_members=${disabledNames}`;
            }
        }
    }

    return tag;
}

// #############################################
// # 19. Fetch Interception (Core Pipeline)
// #############################################

export function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = async function (url, options) {
        const settings = getSettings();

        if (!settings.enabled) {
            return originalFetch.call(window, url, options);
        }

        // --- Check if this is a chat completion request ---
        let isChatRequest = false;
        let bodyObject = null;

        if (options && options.method === 'POST' && options.body) {
            try {
                bodyObject = JSON.parse(options.body);
                if (bodyObject.messages && Array.isArray(bodyObject.messages)) {
                    isChatRequest = true;
                }
            } catch (e) { /* Not JSON, pass through */ }
        }

        if (!isChatRequest) {
            return originalFetch.call(window, url, options);
        }

        updateStatus('Processing request...', '#5bc0de');

        try {
            const urlString = (url instanceof Request) ? url.url : String(url);
            const backendOrigin = resolveBackendOrigin(urlString);

            if (!backendOrigin) {
                throw new Error('Could not determine Agent URL. Set Custom Endpoint in ST.');
            }

            // --- Load group data if not cached yet (lazy load on first request) ---
            if (state.cachedGroups === null) {
                try {
                    await loadGroupData();
                } catch (e) {
                    console.warn(`[${EXTENSION_NAME}] Group data load failed (continuing in single-char mode):`, e.message);
                }
            }

            // --- Ensure session exists (fallback if proactive didn't run) ---
            const sessionId = await ensureSession(backendOrigin);
            if (!sessionId) {
                throw new Error('Failed to acquire session ID.');
            }

            // --- Sync config on first request ---
            if (!state.configSynced) {
                await syncConfigToAgent(settings, backendOrigin);
            }

            // --- Detect message type ---
            const messageType = detectMessageType(bodyObject.messages);
            console.log(`[${EXTENSION_NAME}] Message type: ${messageType}, swipe_index: ${state.currentSwipeIndex}`);
            console.log(`[${EXTENSION_NAME}] Group mode: ${state.isGroupChat}${state.isGroupChat && state.activeGroup ? ' ("' + state.activeGroup.name + '")' : ''}`);

            // --- Update message counter ---
            let messageId = getMessageId();
            if (messageType === 'new') {
                messageId = await incrementMessageId();
            }

            // --- Trim history ---
            bodyObject.messages = trimHistory(bodyObject.messages, settings.historyCount);

            // --- Build and inject [SYSTEM_META] tag ---
            const metaTag = buildMetaTag(sessionId, messageId, messageType, state.currentSwipeIndex);
            bodyObject.messages.unshift({
                role: 'system',
                content: metaTag,
            });

            // --- Build fetch options ---
            const newOptions = { ...options, body: JSON.stringify(bodyObject) };

            // --- Forward to Agent ---
            let targetUrl = url;
            const stOrigin = getAgentOrigin();
            if (stOrigin) {
                try {
                    const urlObj = new URL(urlString);
                    targetUrl = `${stOrigin}${urlObj.pathname}${urlObj.search}`;
                } catch (e) {
                    targetUrl = `${stOrigin}/v1/chat/completions`;
                }
            }

            console.log(`[${EXTENSION_NAME}] Injected [SYSTEM_META] -> ${metaTag}`);
            console.log(`[${EXTENSION_NAME}] Messages trimmed to ${bodyObject.messages.length} (${settings.historyCount} conversation limit)`);
            console.log(`[${EXTENSION_NAME}] Forwarding to: ${targetUrl}`);

            updateStatus(`Active (${messageType})`, '#5cb85c');

            // --- BYPASS MODE: return a dummy response, don't call Agent ---
            if (isBypassMode()) {
                const logEntry = {
                    timestamp: new Date().toISOString(),
                    messageType,
                    sessionId,
                    messageId,
                    swipeIndex: state.currentSwipeIndex,
                    targetUrl,
                    metaTag,
                    groupMode: state.isGroupChat,
                    activeGroup: state.isGroupChat && state.activeGroup ? state.activeGroup.name : null,
                    messagesCount: bodyObject.messages.length,
                    messages: bodyObject.messages.map(m => ({
                        role: m.role,
                        contentPreview: typeof m.content === 'string'
                            ? m.content.substring(0, 200) + (m.content.length > 200 ? '...' : '')
                            : '(non-string content)',
                    })),
                    fullBody: bodyObject,
                };
                state.lastInterceptLog = logEntry;

                console.log(`[${EXTENSION_NAME}] [BYPASS] ========== INTERCEPTED REQUEST ==========`);
                console.log(`[${EXTENSION_NAME}] [BYPASS] Target URL: ${targetUrl}`);
                console.log(`[${EXTENSION_NAME}] [BYPASS] Meta tag: ${metaTag}`);
                console.log(`[${EXTENSION_NAME}] [BYPASS] Messages (${bodyObject.messages.length}):`);
                bodyObject.messages.forEach((m, i) => {
                    const preview = typeof m.content === 'string'
                        ? m.content.substring(0, 150) + (m.content.length > 150 ? '...' : '')
                        : '(non-string)';
                    console.log(`[${EXTENSION_NAME}] [BYPASS]   [${i}] ${m.role}: ${preview}`);
                });
                console.log(`[${EXTENSION_NAME}] [BYPASS] Full body:`, JSON.stringify(bodyObject, null, 2));
                console.log(`[${EXTENSION_NAME}] [BYPASS] ==========================================`);

                updateStatus(`Bypass (${messageType})`, '#5bc0de');

                // Return a dummy streaming response that ST can parse
                return createDummyResponse();
            }

            const response = await originalFetch.call(window, targetUrl, newOptions);

            // Scan response for push notifications from the Agent (non-blocking).
            // Tees the stream: one copy goes to ST, one is scanned in background.
            if (response.body) {
                const [streamForST, streamForScan] = response.body.tee();
                scanForPushNotifications(streamForScan);

                return new Response(streamForST, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            }

            return response;

        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Interception error:`, err);

            if (typeof toastr !== 'undefined') {
                toastr.error(
                    err.message || 'Check console (F12) for details.',
                    'Agent-StateSync Error'
                );
            }

            updateStatus('Error - check console', '#d9534f');

            return originalFetch.call(window, url, options);
        }
    };
}

// #############################################
// # Push Notification Detection
// #############################################

const PUSH_NOTIFICATION_REGEX = /state\.push_notification\s*\(\s*["'](\w+)["']\s*,\s*([\s\S]*?)\s*\)/g;

/**
 * Read a teed stream copy and scan for push_notification() calls.
 * Non-blocking — runs in the background, doesn't block ST's stream.
 */
async function scanForPushNotifications(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
        }
    } catch (e) {
        // Stream cancelled (e.g. user swiped) — that's fine
    }

    fullText += decoder.decode(); // flush remaining bytes

    // Find all push_notification() calls in the full response text
    const regex = new RegExp(PUSH_NOTIFICATION_REGEX.source, 'g');
    let match;
    while ((match = regex.exec(fullText)) !== null) {
        handlePushNotification(match[1], match[2]);
    }
}

/**
 * Extract JSON payload from the raw text between the outer { and }.
 * Handles nested braces correctly by using lastIndexOf.
 */
function extractJsonPayload(raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return raw.substring(start, end + 1);
}

/**
 * Route a push notification to the appropriate handler.
 * Extensible — add new cases for future notification types.
 */
function handlePushNotification(type, rawPayload) {
    try {
        const jsonStr = extractJsonPayload(rawPayload);
        if (!jsonStr) {
            console.warn(`[${EXTENSION_NAME}] Push notification "${type}": no JSON payload found`);
            return;
        }
        const payload = JSON.parse(jsonStr);
        console.log(`[${EXTENSION_NAME}] Push notification: ${type}`, payload);

        switch (type) {
            case 'session_deleted':
                handleSessionDeleted(payload);
                break;
            // Future types: case 'state_updated': ...
            default:
                console.warn(`[${EXTENSION_NAME}] Unknown push notification type: ${type}`);
        }
    } catch (e) {
        console.warn(`[${EXTENSION_NAME}] Failed to parse push notification "${type}":`, e);
    }
}

/**
 * Handle a session_deleted notification from the Agent.
 * Clears session metadata, shows Init button, updates status.
 */
async function handleSessionDeleted(payload) {
    if (!state.context.chatMetadata) return;

    // Verify this is our current session (ignore stale notifications)
    const currentSessionId = state.context.chatMetadata[META_KEY_SESSION];
    if (currentSessionId && payload.session_id !== currentSessionId) {
        console.log(`[${EXTENSION_NAME}] session_deleted for different session (${payload.session_id} vs ours ${currentSessionId}), ignoring`);
        return;
    }

    // Clear session metadata
    delete state.context.chatMetadata[META_KEY_SESSION];
    delete state.context.chatMetadata[META_KEY_INITIALIZED];
    state.context.chatMetadata[META_KEY_COUNTER] = 0;
    await state.context.saveMetadata();

    // Update runtime state
    state.sessionInitialized = false;
    state.configSynced = false;

    // Update UI
    updateStatus('Session deleted', '#f0ad4e');

    console.log(`[${EXTENSION_NAME}] Session ${payload.session_id} deleted by Agent — Init button now visible`);

    if (typeof toastr !== 'undefined') {
        toastr.info(
            `Session deleted by Agent${payload.character_name ? ' (' + payload.character_name + ')' : ''}`,
            'Agent-StateSync'
        );
    }
}