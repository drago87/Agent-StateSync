// brain-tf-additions.js — Agent-StateSync Tracked Field Additions Editor (Facade)
//
// Thin facade that re-exports everything from the sub-modules so that
// existing consumers can continue to import from this single file
// without any changes.
//
// Original exports preserved:
//   renderTFAdditions, normalizeAdditions, readTFAdditionsFromUI,
//   renderTFContainer, bindTFAdditionEvents, injectBtfCSS

export { renderTFAdditions, normalizeAdditions, renderTFContainer } from './btf-render.js';
export { readTFAdditionsFromUI } from './btf-dom.js';
export { bindTFAdditionEvents } from './btf-events.js';
export { injectBtfCSS } from './btf-css.js';
