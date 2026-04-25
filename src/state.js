// state.js — Agent-StateSync Shared State
//
// Single source of truth for all mutable state shared across modules.
// All modules import this object and read/write its properties.
// Since it's an object reference, mutations are visible everywhere.
// File Version: 1.0.1

const state = {
    // SillyTavern context (set once during init)
    context: null,
        // Debug mode (set from config.json at startup)
    debug: false,

    // Config sync tracking
    configSynced: false,

    // Message-type detection (hash comparison across requests)
    lastUserMsgHash: null,
    lastAssistantMsgHash: null,
    lastConversationCount: 0,
    currentSwipeIndex: 0,

    // Connection health tracking
    agentConnected: false,
    healthCheckTimer: null,
    isReconnecting: false,

    // Group chat data
    cachedGroups: null,            // All groups from /api/groups/all
    activeGroup: null,             // Currently active group object
    activeGroupCharacters: [],     // Full Character objects for active group members
    isGroupChat: false,            // Whether current chat is a group chat

    // Session tracking
    proactiveInProgress: false,    // Prevents overlapping proactive calls
    sessionInitialized: false,     // Whether the current chat has an initialized Agent session

    // Interceptor log for debug display
    lastInterceptLog: null,
};

export default state;