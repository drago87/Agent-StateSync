// tracked-fields.js — Agent-StateSync Tracked Fields: Facade
// File Version: 1.0.0
//
// Thin facade that imports from all sub-modules and re-exports the
// public API. The original monolithic file exported:
//   - getTrackedFieldsForPayload  (from tf-data.js)
//   - initTrackedFieldsUI         (from tf-modal.js)
//
// This file maintains backward compatibility — consumers can import
// from this module using the same names as before.

// Public API exports
export { getTrackedFieldsForPayload } from './tf-data.js';
export { initTrackedFieldsUI } from './tf-modal.js';
