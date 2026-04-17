// agent-url.js — Agent-StateSync URL Resolution & Health Checks
//
// Auto-detects the Agent URL from SillyTavern's Custom Endpoint setting.
// Manages health check pinging, LLM status display, and reconnect logic.

import state from './state.js';
import {
    EXTENSION_NAME,
    getSettings,
    isBypassMode,
    syncConfigToAgent,
    updateStatus,
    HEALTH_CHECK_INTERVAL_MS,
    HEALTH_CHECK_TIMEOUT_MS,
} from './settings.js';

// #############################################
// # 3. Agent URL Resolution (Auto-Detect)
// #############################################

/**
 * Resolve the Agent URL from SillyTavern's Custom Endpoint setting.
 * Falls back to parsing the request URL at interception time.
 * No manual override - the user configures the URL in ST's API connection panel.
 */
export function getAgentOrigin() {
    try {
        const customUrl = state.context.chatCompletionSettings?.custom_url;
        if (customUrl) {
            const urlObj = new URL(customUrl);
            return urlObj.origin; // e.g. "http://localhost:8001"
        }
    } catch (e) {
        // ST setting not a valid URL or not set
    }
    return null;
}

/**
 * Get Agent origin, falling back to parsing a request URL.
 */
export function resolveBackendOrigin(requestUrl) {
    const fromST = getAgentOrigin();
    if (fromST) return fromST;

    try {
        const urlObj = new URL(requestUrl);
        return urlObj.origin;
    } catch (e) {
        console.error(`[${EXTENSION_NAME}] Failed to parse URL:`, e);
        return null;
    }
}

/**
 * Resolve just the host:port string for display / health checks.
 */
export function getAgentHostPort() {
    const origin = getAgentOrigin();
    if (!origin) return null;
    try {
        const urlObj = new URL(origin);
        const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
        return `${urlObj.hostname}:${port}`;
    } catch (e) {
        return null;
    }
}

// #############################################
// # 5. Connection Health Check
// #############################################

/**
 * Get the health check URL. Auto-detected from ST's Custom Endpoint.
 */
function getHealthCheckUrl() {
    const settings = getSettings();
    if (!settings.enabled) return null;

    const origin = getAgentOrigin();
    if (!origin) return null;

    return `${origin}/health`;
}

/**
 * Ping the Agent's /health endpoint.
 */
export async function checkAgentHealth() {
    const url = getHealthCheckUrl();
    if (!url) return false;

    if (isBypassMode()) {
        setConnectionStatus(true, 'Bypass mode (no Agent)');
        console.log(`[${EXTENSION_NAME}] [BYPASS] Health check skipped — bypass mode active`);
        return true;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

        const resp = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const sessionCount = data.sessions || 0;
            setConnectionStatus(true, `Connected - ${sessionCount} session(s)`);

            // Also ping the dashboard so the ST Extension light stays green
            pingAgent(url);

            // Check LLM backend status (fire-and-forget, don't block health check)
            checkLlmStatuses();

            return true;
        } else {
            setConnectionStatus(false, `Agent returned ${resp.status}`);
            return false;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            setConnectionStatus(false, 'Connection timed out');
        } else {
            setConnectionStatus(false, 'Agent not reachable');
        }
        return false;
    }
}

/**
 * Update the LLM status dots in the extension settings panel.
 * Asks the Agent to probe both backends (the Agent runs server-side
 * and has the actual URLs from config.ini — the browser may not be
 * able to reach the backends directly due to CORS or networking).
 */
async function checkLlmStatuses() {
    const origin = getAgentOrigin();
    if (!origin) return;

    if (isBypassMode()) {
        console.log(`[${EXTENSION_NAME}] [BYPASS] LLM status check skipped`);
        return;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const resp = await fetch(`${origin}/api/dashboard/status`, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) return;
        const status = await resp.json();

        // RP LLM
        const rpDot = $('#ass-rp-dot');
        if (rpDot.length) {
            rpDot.removeClass('ass-llm-dot-green ass-llm-dot-red ass-llm-dot-off');
            if (status.rp_llm_disabled) {
                rpDot.addClass('ass-llm-dot-off');
                rpDot.attr('title', 'RP LLM: disabled (config.ini)');
            } else if (status.rp_llm_connected) {
                rpDot.addClass('ass-llm-dot-green');
                rpDot.attr('title', 'RP LLM: online (via Agent)');
            } else {
                rpDot.addClass('ass-llm-dot-red');
                rpDot.attr('title', 'RP LLM: offline (via Agent)');
            }
        }

        // Instruct LLM
        const instructDot = $('#ass-instruct-dot');
        if (instructDot.length) {
            instructDot.removeClass('ass-llm-dot-green ass-llm-dot-red ass-llm-dot-off');
            if (status.instruct_llm_disabled) {
                instructDot.addClass('ass-llm-dot-off');
                instructDot.attr('title', 'Instruct LLM: disabled (config.ini)');
            } else if (status.instruct_llm_connected) {
                instructDot.addClass('ass-llm-dot-green');
                instructDot.attr('title', 'Instruct LLM: online (via Agent)');
            } else {
                instructDot.addClass('ass-llm-dot-red');
                instructDot.attr('title', 'Instruct LLM: offline (via Agent)');
            }
        }
    } catch (e) {
        // Silent — will retry on next health check cycle
        console.debug(`[${EXTENSION_NAME}] LLM status check via Agent failed:`, e.message);
    }
}

/**
 * POST /api/ping - lights the "ST Extension" indicator on the dashboard.
 */
async function pingAgent(healthUrl) {
    const origin = getAgentOrigin();
    if (!origin) return;
    if (isBypassMode()) return;
    try {
        await fetch(`${origin}/api/ping`, { method: 'POST' });
    } catch (e) {
        // Silent - best-effort
    }
}

/**
 * Start the periodic health check loop.
 */
export function startHealthChecks() {
    stopHealthChecks();
    checkAgentHealth();
    state.healthCheckTimer = setInterval(() => {
        checkAgentHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop the periodic health check loop.
 */
export function stopHealthChecks() {
    if (state.healthCheckTimer !== null) {
        clearInterval(state.healthCheckTimer);
        state.healthCheckTimer = null;
    }
}

/**
 * Update the connection status indicator in the UI.
 */
export function setConnectionStatus(connected, text) {
    state.agentConnected = connected;

    const dot = $('#ass-connection-dot');
    if (dot.length) {
        dot.removeClass('ass-dot-green ass-dot-red')
           .addClass(connected ? 'ass-dot-green' : 'ass-dot-red');
        dot.attr('title', text || (connected ? 'Connected' : 'Disconnected'));
    }
}

/**
 * Handle the Reconnect button click.
 */
export async function handleReconnect() {
    const settings = getSettings();
    if (!settings.enabled) {
        toastr.info('Enable State Sync first.', 'Agent-StateSync');
        return;
    }
    if (state.isReconnecting) return;
    state.isReconnecting = true;

    const btn = $('#ass-reconnect-btn');
    btn.addClass('fa-spin');
    btn.prop('disabled', true);
    setConnectionStatus(false, 'Reconnecting...');

    try {
        const url = getHealthCheckUrl();

        if (!url) {
            setConnectionStatus(false, 'No Agent URL - set Custom Endpoint in ST');
            toastr.warning('Set a Custom Endpoint URL in SillyTavern\'s API connection settings.', 'Agent-StateSync');
            return;
        }

        const healthy = await checkAgentHealth();

        if (healthy) {
            state.configSynced = false;
            await syncConfigToAgent(settings, getAgentOrigin());
            toastr.success('Reconnected to Agent!', 'Agent-StateSync');
        } else {
            toastr.error(
                'Could not reach the Agent. Make sure it\'s running and the Custom Endpoint URL is correct.',
                'Agent-StateSync'
            );
        }
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Reconnect error:`, err);
        setConnectionStatus(false, 'Reconnect failed');
        toastr.error('Reconnect failed. Check console (F12).', 'Agent-StateSync');
    } finally {
        state.isReconnecting = false;
        btn.removeClass('fa-spin');
        btn.prop('disabled', false);
    }
}

/**
 * Refresh the read-only Agent URL display.
 */
export function refreshAgentUrlDisplay() {
    const $text = $('#ass-url-text');
    if (!$text.length) return;

    const origin = getAgentOrigin();
    if (origin) {
        $text.text(origin);
    } else {
        $text.text('Not detected - set Custom Endpoint in ST');
        $text.css('color', '#d9534f');
    }
}
