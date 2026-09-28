// One pin helper, three surfaces: test/houserules.prompt.test.ts (vitest),
// test/studio.files.test.ts and test/bun/vendored-skills.test.ts (bun:test).
// Pure string work, no node:fs — so it loads under workerd too.
//
// Every pinned sentence hard-wraps somewhere: HOUSE_RULES is an array of ~72
// col lines, markdown wraps at ~76. A full clause therefore straddles a
// newline and can NEVER match the raw text, which is why the old pins had
// shrunk to single words like /twice/ — and a single word that also appears
// elsewhere on the surface pins nothing. Collapse whitespace first: a rewrap
// at any width must not break a pin, deleting the sentence must.
export const collapseWs = (text: string): string => text.replace(/\s+/g, " ");
