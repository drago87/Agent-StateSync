// agent-url.js — Agent-StateSync URL Resolution & Health Checks
//
// Auto-detects the Agent URL from SillyTavern's Custom Endpoint setting.
// Manages health check pinging, LLM status display (sourced from Agent),
// and reconnect logic.
//
// LLM config is now managed by the Agent. STe displays it read-only
// via fetchLlmConfig() and checkLlmHealth(), which update the
// state.agentLlmConfig object and the read-only UI displays.
// File Version: 2.0.0

import state from './state.js';
import {
    EXTENSION_NAME,
    getSettings,
    isBypassMode,
    syncConfigToAgent,
    storeLlmConfig,
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
// # LLM Config & Display Helpers
// #############################################

/**
 * Extract host:port from a full URL for display purposes.
 * @param {string} url - Full URL like "http://192.168.0.50:5001"
 * @returns {string} Host:port like "192.168.0.50:5001"
 */
function extractHostPort(url) {
    if (!url) return '';
    try {
        const urlObj = new URL(url);
        const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
        return `${urlObj.hostname}:${port}`;
    } catch (e) {
        return url; // fallback: return as-is
    }
}

/**
 * Get the CSS class for an LLM health dot based on health status.
 * @param {string} health - "online" | "degraded" | "offline" | "unknown"
 * @returns {string} CSS class name
 */
function getHealthDotClass(health) {
    switch (health) {
        case 'online':  return 'ass-llm-dot-green';
        case 'degraded': return 'ass-llm-dot-yellow';
        case 'offline': return 'ass-llm-dot-red';
        default:        return 'ass-llm-dot-off';
    }
}

/**
 * Fetch LLM config from Agent via GET /api/config/ste.
 * Stores result in state.agentLlmConfig and updates the read-only display.
 * Called on first connect, reconnect, and when config changes are detected.
 */
export async function fetchLlmConfig() {
    const origin = getAgentOrigin();
    if (!origin) return;

    if (isBypassMode()) {
        console.log(`[${EXTENSION_NAME}] [BYPASS] LLM config fetch skipped`);
        return;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const resp = await fetch(`${origin}/api/config/ste`, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) return;
        const data = await resp.json();

        storeLlmConfig(data);
        updateLlmDisplay();
        console.log(`[${EXTENSION_NAME}] LLM config fetched from Agent:`, state.agentLlmConfig);
    } catch (e) {
        console.debug(`[${EXTENSION_NAME}] LLM config fetch failed:`, e.message);
    }
}

/**
 * Update the read-only LLM displays in the settings panel.
 * Reads from state.agentLlmConfig and renders the RP LLM display
 * and dynamic Instruct LLM backends list.
 */
export function updateLlmDisplay() {
    // --- RP LLM display ---
    const $rpText = $('#ass-rp-llm-text');
    const $rpDot = $('#ass-rp-dot');
    const $rpTemplate = $('#ass-rp-llm-template');

    if ($rpText.length) {
        const rpLlm = state.agentLlmConfig.rp_llm;
        if (rpLlm.url) {
            $rpText.text(extractHostPort(rpLlm.url));
            $rpText.css('color', '');
        } else {
            $rpText.text('Not configured (Agent side)');
            $rpText.css('color', '#d9534f');
        }
    }

    if ($rpDot.length) {
        const rpLlm = state.agentLlmConfig.rp_llm;
        $rpDot.removeClass('ass-llm-dot-green ass-llm-dot-yellow ass-llm-dot-red ass-llm-dot-off');
        $rpDot.addClass(getHealthDotClass(rpLlm.health));
        $rpDot.attr('title', `RP LLM: ${rpLlm.health || 'not checked'}`);
    }

    if ($rpTemplate.length) {
        const template = state.agentLlmConfig.rp_llm.template;
        if (template) {
            $rpTemplate.text(template);
            $rpTemplate.show();
        } else {
            $rpTemplate.hide();
        }
    }

    // --- Instruct LLM backends display ---
    const $container = $('#ass-instruct-backends-container');
    if ($container.length) {
        const backends = state.agentLlmConfig.instruct_llm.backends;

        // Always show at least one row; if no backends from Agent,
        // show a single "Not configured" placeholder.
        const displayBackends = backends.length > 0
            ? backends
            : [{ url: '', health: 'unknown' }];

        $container.empty();

        displayBackends.forEach((backend, index) => {
            const hostPort = backend.url ? extractHostPort(backend.url) : 'Not configured (Agent side)';
            const dotClass = getHealthDotClass(backend.health);
            const dotTitle = `Instruct LLM ${index + 1}: ${backend.health || 'not checked'}`;
            const valueStyle = !backend.url ? 'color:#d9534f;' : '';

            const $row = $(`
                <div class="ass-url-display ass-instruct-backend-row" style="margin-bottom:4px;">
                    <span class="ass-llm-dot ${dotClass} ass-instruct-dot" data-index="${index}" title="${dotTitle}"></span>
                    <i class="fa-solid fa-database" style="opacity:0.5;"></i>
                    <span class="ass-url-value" style="${valueStyle}">${hostPort}</span>
                </div>
            `);
            $container.append($row);
        });
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
 * On success, also checks LLM health and fetches config on first connect.
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

            // Ping the dashboard so the ST Extension light stays green
            pingAgent(url);

            // Check LLM backend health via the new endpoint
            // (fire-and-forget, don't block health check)
            checkLlmHealth();

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
 * Reset LLM status dots to "not checked" state.
 */
function resetLlmDots(reason) {
    const rpDot = $('#ass-rp-dot');
    if (rpDot.length) {
        rpDot.removeClass('ass-llm-dot-green ass-llm-dot-yellow ass-llm-dot-red');
        rpDot.addClass('ass-llm-dot-off');
        rpDot.attr('title', `RP LLM: ${reason}`);
    }
    // Reset all instruct backend dots
    $('.ass-instruct-dot').each(function () {
        $(this).removeClass('ass-llm-dot-green ass-llm-dot-yellow ass-llm-dot-red');
        $(this).addClass('ass-llm-dot-off');
        $(this).attr('title', `Instruct LLM: ${reason}`);
    });
}

/**
 * Check LLM backend health via GET /api/llm/health.
 *
 * The Agent returns per-backend health status (online/degraded/offline)
 * and a `changed` flag. If the Agent's LLM config was modified,
 * STe updates its stored config and refreshes the display.
 *
 * Response format:
 * {
 *   "changed": false,
 *   "rp_llm": { "url": "...", "template": "...", "health": "online" },
 *   "instruct_llm": { "backends": [{ "url": "...", "health": "online" }, ...] }
 * }
 */
async function checkLlmHealth() {
    const origin = getAgentOrigin();
    if (!origin) return;

    if (isBypassMode()) {
        console.log(`[${EXTENSION_NAME}] [BYPASS] LLM health check skipped`);
        return;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const resp = await fetch(`${origin}/api/llm/health`, {
            method: 'GET',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!resp.ok) return;
        const data = await resp.json();

        // Store LLM config from the health response (always includes URLs + health)
        storeLlmConfig(data);

        // If Agent config changed, refresh the full config and display.
        // The health endpoint already returns URLs, so storeLlmConfig()
        // handles the update. The `changed` flag is for informational logging.
        if (data.changed) {
            console.log(`[${EXTENSION_NAME}] Agent LLM config changed — updating local state.`);
            // Also fetch full config to ensure we have everything (e.g. config_version)
            fetchLlmConfig();
        }

        // Update the read-only LLM displays with new health data
        updateLlmDisplay();
    } catch (e) {
        // Silent — will retry on next health check cycle
        console.debug(`[${EXTENSION_NAME}] LLM health check failed:`, e.message);
    }
}

/**
 * POST /api/ping - lights the "ST Extension" indicator on the Agent dashboard.
 * Now sends config_version so the Agent can tell STe if its config changed.
 */
async function pingAgent(healthUrl) {
    const origin = getAgentOrigin();
    if (!origin) return;
    if (isBypassMode()) return;

    try {
        const body = {};
        if (state.configVersion !== null) {
            body.config_version = state.configVersion;
        }

        const resp = await fetch(`${origin}/api/ping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
        });

        // If the Agent says config changed, fetch the new LLM config.
        if (resp.ok) {
            try {
                const data = await resp.json();
                if (data && data.config_changed) {
                    console.log(`[${EXTENSION_NAME}] Ping reports config changed — fetching LLM config.`);
                    fetchLlmConfig();
                }
            } catch (e) {
                // Ping response may not include config_changed — that's OK
            }
        }
    } catch (e) {
        // Silent - best-effort
    }
}

/**
 * Start the periodic health check loop.
 */
export function startHealthChecks() {
    stopHealthChecks();

    // On first start, fetch LLM config from the Agent
    fetchLlmConfig();

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
            // Fetch the Agent's LLM config on reconnect
            await fetchLlmConfig();

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

// #############################################
// # Event Listeners
// #############################################

// When settings.js stores LLM config from POST /api/config response,
// it dispatches 'ass-llm-config-changed'. Listen here to update the display.
window.addEventListener('ass-llm-config-changed', () => {
    updateLlmDisplay();
});