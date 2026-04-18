// File Version: 1.0.0
export default {
    "debug": false,
    "tracked_fields": {
        "character": {
            "physical": {
                "description": "Physical state of the character",
                "fields": {
                    "health": { "type": "string", "hint": "Overall health status (e.g. healthy, exhausted, bleeding from left arm)" },
                    "appearance": { "type": "string", "hint": "Notable changes to appearance" },
                    "position": { "type": "string", "hint": "Body posture or physical position (e.g. kneeling, sprawled)" },
                    "clothing": { "type": "string_or_list", "hint": "Current outfit or changes to it" },
                    "virginity": { "type": "string", "hint": "Status if narratively relevant (intact or lost)" }
                }
            },
            "sexuality": {
                "description": "Sexual preferences and discoveries",
                "fields": {
                    "known_kinks": { "type": "list", "hint": "Kinks the character is aware they have" },
                    "hidden_kinks": { "type": "list", "hint": "Kinks discovered through positive reaction ONLY. Be EXTREMELY conservative." }
                }
            },
            "location": {
                "description": "Where the character is",
                "fields": {
                    "current": { "type": "string", "hint": "Where the character is right now" },
                    "prev": { "type": "string", "hint": "Where they were before (only if they moved)" }
                }
            },
            "emotional": {
                "description": "Emotional and mental state",
                "fields": {
                    "mood": { "type": "string", "hint": "Current emotional state (e.g. furious, melancholic)" },
                    "mental_state": { "type": "string", "hint": "Cognitive condition (e.g. intoxicated, sleep-deprived)" },
                    "attitude": { "type": "string", "hint": "Disposition toward others or the situation" },
                    "stress": { "type": "string", "hint": "low, medium, high, breaking" }
                }
            },
            "equipment": {
                "description": "Items the character carries",
                "fields": {
                    "weapons": { "type": "list", "hint": "Weapons carried" },
                    "armor": { "type": "list", "hint": "Armor or protective gear" },
                    "tools": { "type": "list", "hint": "Tools or utility items" },
                    "other": { "type": "list", "hint": "Notable personal items" }
                }
            },
            "relationships": {
                "description": "Relationships with other characters",
                "is_dynamic": true,
                "hint": "Key each entry by the OTHER character's name.",
                "fields": {
                    "family_type": { "type": "string", "hint": "family, friend, rival, lover, enemy, ally, acquaintance, stranger, master, servant, mentor, student" },
                    "status": { "type": "string", "hint": "Current state of the relationship" },
                    "note": { "type": "string", "hint": "Brief reason or context (optional)" }
                }
            },
            "knowledge": {
                "description": "What the character knows or suspects",
                "fields": {
                    "known_facts": { "type": "list", "hint": "Facts the character learned" },
                    "suspicions": { "type": "list", "hint": "Things suspected but unconfirmed" },
                    "secrets": { "type": "list", "hint": "Secrets the character is keeping" }
                }
            },
            "active_effects": {
                "description": "Active buffs, debuffs, and temporary states",
                "fields": {
                    "buffs": { "type": "list", "hint": "Active positive effects" },
                    "debuffs": { "type": "list", "hint": "Active negative effects" },
                    "temporary": { "type": "list", "hint": "Temporary states with context" }
                }
            }
        },
        "shared": {
            "location": { "type": "string", "hint": "Current primary location" },
            "time": { "type": "string", "hint": "Time of day, date, or time passage" },
            "atmosphere": { "type": "string", "hint": "Current mood/tone of the scene" },
            "items": { "type": "dict", "hint": "Items in the environment (dict with acquired, lost, mentioned)" },
            "discoveries": { "type": "dict", "hint": "New information about the world" },
            "events": { "type": "list", "hint": "Notable events that occurred" }
        },
        "scenario": {
            "setting": {
                "fields": {
                    "location": { "type": "string", "hint": "Starting/current location" },
                    "time": { "type": "string", "hint": "Starting/current time period" },
                    "atmosphere": { "type": "string", "hint": "Current mood/tone" },
                    "environment": { "type": "string", "hint": "Environmental features, weather, conditions" }
                }
            },
            "factions": {
                "is_dynamic": true,
                "hint": "Key each entry by faction name.",
                "fields": {
                    "status": { "type": "string", "hint": "Current state" },
                    "goals": { "type": "list", "hint": "What the faction wants" },
                    "relationship_to_player": { "type": "string", "hint": "How they view the player" }
                }
            },
            "plot": {
                "fields": {
                    "active_quests": { "type": "list", "hint": "Ongoing objectives" },
                    "resolved_events": { "type": "list", "hint": "Completed events" },
                    "current_objective": { "type": "string", "hint": "What the player should focus on" },
                    "threats": { "type": "list", "hint": "Immediate dangers" }
                }
            },
            "world_details": {
                "fields": {
                    "rules": { "type": "list", "hint": "Important world rules" },
                    "customs": { "type": "list", "hint": "Cultural practices" },
                    "technology_level": { "type": "string", "hint": "Tech/magic level" },
                    "magic_system": { "type": "string", "hint": "Magic rules or limitations" }
                }
            },
            "items": {
                "fields": {
                    "acquired": { "type": "list", "hint": "Items recently obtained" },
                    "lost": { "type": "list", "hint": "Items recently lost" },
                    "mentioned": { "type": "list", "hint": "Items referenced" },
                    "key_items": { "type": "list", "hint": "Plot-important items" }
                }
            },
            "characters": {
                "is_dynamic": true,
                "hint": "Key each entry by character name.",
                "fields": {
                    "description": { "type": "string", "hint": "Brief physical/personality description" },
                    "role": { "type": "string", "hint": "Their function in the story" },
                    "location": { "type": "string", "hint": "Where they currently are" },
                    "disposition": { "type": "string", "hint": "How they feel toward the player" },
                    "first_seen": { "type": "string", "hint": "When/where first encountered (only on first appearance)" }
                }
            },
            "events": { "type": "list", "hint": "Notable narrative events" },
            "discoveries": { "type": "dict", "hint": "Key-value pairs of new information" }
        }
    }
};