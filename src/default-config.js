// default-config.js — Agent-StateSync Default Configuration
//
// Provides default values for prompt_settings and debug flag.
// Tracked field defaults are loaded from external JSON files:
//   - default-tracked-character.json
//   - default-tracked-scenario.json
//   - default-tracked-shared.json
// These are loaded at runtime by tracked-fields.js via fetch().
//
// File Version: 1.1.0

export default {
    "debug": false,
    "prompt_settings": {
        "perspective": "third_person_limited",
        "tense": "present",
        "tone": "literary",
        "content_rating": "nsfw",
        "extraction_strictness": "moderate",
        "detail_level": "standard",
        "language": "English",
        "relationship_depth": "standard",
        "character_voice_in_state": false,
        "state_granularity": "summary",
        "translation_length": "standard"
    }
};