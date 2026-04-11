# Agent-StateSync

SillyTavern extension that manages world state synchronization with the [Pinokio-LangGraph Agent](https://github.com/drago87/Pinokio-LangGraph). Intercepts chat completion requests, injects session metadata, trims history, detects message types (new/continue/swipe/redo), and communicates with the FastAPI + LangGraph Agent backend.

> **Need the Agent?** [github.com/drago87/Pinokio-LangGraph](https://github.com/drago87/Pinokio-LangGraph)

---

## What It Does

This extension hooks into SillyTavern's fetch calls and adds a state management layer on top of any OpenAI-compatible LLM endpoint. Without the Agent, SillyTavern just sends your chat to a single LLM. With this extension and the Agent running, every turn follows this flow:

```
You type a message in SillyTavern
        │
        ▼
Extension intercepts the request
        │
        ├─ Creates/resumes a session (per-chat UUID)
        ├─ Detects message type (new / continue / swipe / redo)
        ├─ Trims history to configured limit
        ├─ Injects [SYSTEM_META] tag with session data
        │
        ▼ POST /v1/chat/completions
[PinokioLangGraph Agent](https://github.com/drago87/PinokioLangGraph)
        │
        ├─ Reads [SYSTEM_META], routes to RP LLM + Instruct LLM
        ├─ Handles swipe/redo (reverts old state changes)
        ├─ Translates world state (JSON → natural language)
        ├─ Streams narrative response back via SSE
        └─ Background: extracts state changes, updates database
        │
        ▼
SillyTavern displays the streamed response
```

You get narrative continuity that persists across an entire conversation — locations, time, character states, items, relationships — all tracked automatically by a second model in the background.

---

## Requirements

- **SillyTavern** (latest release or 1.12+)
- **[PinokioLangGraph Agent](https://github.com/drago87/PinokioLangGraph)** running on your network
- **RP LLM** — A creative narrative model (Koboldcpp, Ollama, or any OpenAI-compatible endpoint)
- **Instruct LLM** — A smaller model for JSON state extraction (Ollama, Koboldcpp, or any OpenAI-compatible endpoint)

---

## Installation

### Option 1: SillyTavern Built-in (Recommended)

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste: `https://github.com/drago87/Agent-StateSync`
4. Restart SillyTavern

### Option 2: Manual

1. Navigate to your SillyTavern installation directory
2. Go to `public/scripts/extensions/third-party/`
3. Clone this repo into a folder named `Agent-StateSync`:
   ```bash
   git clone https://github.com/drago87/Agent-StateSync.git Agent-StateSync
   ```
4. Restart SillyTavern

---

## Setup

### 1. Start the Agent

Install and launch the [PinokioLangGraph Agent](https://github.com/drago87/PinokioLangGraph) first (via Pinokio or manually). Make sure both your RP LLM and Instruct LLM endpoints are running.

### 2. Configure SillyTavern's API Connection

In SillyTavern's API settings:
- Set the **Chat Completion API** to the Agent's address (e.g. `http://192.168.0.1:8001`)
- The extension will redirect requests to the Agent automatically

### 3. Configure the Extension

Open SillyTavern → **Extensions** panel → **Agent-StateSync**:

| Setting | What to enter |
|---------|---------------|
| **Enable State Sync** | Check the box to activate |
| **Agent IP:Port** | The Agent server (e.g. `192.168.0.1:8001`). Leave blank to auto-detect from ST's API URL. |
| **RP LLM IP:Port** | Your creative model endpoint (e.g. `192.168.0.1:5001`) |
| **RP LLM Template** | Message format: ChatML, Llama 3, Alpaca, Mistral, or Raw (default) |
| **Instruct LLM IP:Port** | Your extraction model endpoint (e.g. `192.168.0.1:11434`) |
| **Instruct LLM Template** | Message format for the Instruct LLM |
| **Thinking Steps** | 0 (disabled), 1 (fast), or 2 (thorough) — internal planning passes before the RP LLM writes |
| **Refinement Steps** | 0 (disabled) or 1 — post-generation review pass |
| **History Messages** | How many user/assistant pairs to send to the RP LLM (2-8, or 0 for all) |

### 4. Start Chatting

Open a character chat, enable the extension, and start chatting. The extension will:
- Create a session on the first message
- Send character card data to the Agent for initial world state extraction
- Inject world state context into every subsequent request
- Track state changes automatically in the background

---

## Features

### Session Management
- Each chat gets a unique session ID (stored in SillyTavern's chat metadata)
- Session databases are created on the Agent side (one SQLite file per chat)
- Character card data is sent to the Agent on first load for initial state extraction

### Message Type Detection
The extension detects what the user is doing by comparing the current request against the previous one:

| Type | Trigger | What happens |
|------|---------|--------------|
| **new** | Different user message | New turn — message counter increments |
| **continue** | Same messages, same length | SillyTavern continuation — no counter change |
| **swipe** | Same user, different assistant | Regenerate — old state changes reverted |
| **redo** | Shorter conversation + changed user | Edited a previous message — all changes from that point reverted |

### History Trimming
Controls how many user/assistant message pairs are sent to the RP LLM. System messages (character card, lorebook entries, prompts) are always sent. This reduces context window usage without losing character consistency.

### [SYSTEM_META] Protocol
Every request includes a metadata tag as `messages[0]`:
```
[SYSTEM_META] session_id=abc-123 message_id=5 type=new swipe_index=0
```
The Agent parses this, strips it, and uses it for session routing and database operations.

### Config Sync
When you change settings in the extension UI, they are pushed to the Agent via `POST /api/config`. The Agent stores them so it knows where to route requests without receiving the full config on every call.

### Chat Event Hooks
When you switch characters or open a different chat, the extension resets its detection state (message hashes, swipe index, etc.) to prevent cross-contamination between sessions.

---

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | SillyTavern extension metadata |
| `index.js` | Main extension — fetch interceptor, settings UI, session management |

---

## Templates

Different models expect different prompt formatting. Set the template to match your model:

| Template | Use with |
|----------|----------|
| **Raw** | Ollama, Koboldcpp, or any endpoint that handles its own formatting (default) |
| **ChatML** | Qwen, ChatGLM, fine-tuned models using `<\|im_start\|>` tokens |
| **Llama 3** | Meta Llama 3 / 3.1 / 3.2 models |
| **Alpaca** | Alpaca, Vicuna, WizardLM instruction-tuned models |
| **Mistral** | Mistral 7B Instruct, Mixtral models |

---

## Troubleshooting

**Extension doesn't appear in SillyTavern** — Make sure the folder is in `public/scripts/extensions/third-party/` and contains both `manifest.json` and `index.js`. Restart SillyTavern.

**"Cannot connect to Agent"** — Verify the Agent is running and the IP:Port is correct. Open `http://your-agent:8001/health` in a browser — you should see `{"status": "ok"}`.

**"Cannot sync config" warning in console** — This is normal on first load if the Agent hasn't started yet. It will retry on the next request.

**Responses look normal, no state tracking** — Check that the extension is enabled (checkbox is checked). Also check the browser console (F12) for `[Agent-StateSync]` log entries to confirm requests are being intercepted.

**Swipe doesn't revert state** — Open browser console and look for the `Message type: swipe` log entry. If it says `new` instead, the detection heuristic may not match your usage pattern.

---

## Links

- **Agent Backend**: [github.com/drago87/PinokioLangGraph](https://github.com/drago87/PinokioLangGraph)
- **SillyTavern**: [github.com/SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern)
