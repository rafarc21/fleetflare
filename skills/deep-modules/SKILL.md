---
name: deep-modules
description: Use when designing, reviewing, or sweeping code for maintainability — judging whether a module's interface is small relative to what it hides. Covers Ousterhout's "A Philosophy of Software Design" vocabulary (module, interface, depth, information hiding, shallow module, temporal decomposition...), a detection checklist for pass-through wrappers and leaky callers, refactor recipes, and when NOT to deepen a module. Read by superpowers:requesting-code-review and the brainstorming/writing-plans design step; apply it yourself when reviewing a diff or sweeping a repo for shallow-module findings.
---

# Deep modules

A module is deep when its interface is small relative to the functionality
it hides. Depth, not size, is the target — a deep module is cheap to call
and expensive to rebuild from scratch; a shallow one is the reverse: cheap to
rebuild, expensive to call correctly every time. This skill is Ousterhout's
vocabulary (*A Philosophy of Software Design*), applied to this fleet's own
code.

## Vocabulary

- **Module** — any unit with a boundary a caller crosses: a function, a
  class, a package, a service. Not tied to a file.
- **Interface** — everything a caller must know to use the module: its
  signature, its preconditions, its side effects, its error shapes. Smaller
  interface = less for a caller to hold in their head.
- **Implementation** — everything the module hides behind that interface.
  Can change freely as long as the interface's promises still hold.
- **Depth = functionality ÷ interface size.** A deep module does a lot
  behind a little; a shallow one does a little behind a lot. Depth is a
  ratio, not a size — a tiny module with a tiny interface can still be deep
  if it genuinely hides something (e.g. a well-chosen default), and a huge
  module with a huge interface is shallow no matter how much code is behind
  it.
- **Information hiding** — the implementation detail a module keeps from
  its callers on purpose, so changing that detail never ripples outward.
  The mechanism depth is built from.
- **Seam** — a boundary in the code deliberately placed so one side can
  change (or be tested, or be replaced) without touching the other. A real
  seam sits at a genuine interface; a fake one just adds a layer with
  nothing hidden behind it.
- **Pass-through method** — a method that does almost nothing itself,
  mostly forwarding its arguments to another method with a similar
  signature. Each one on its own is cheap; a chain of them adds interface
  without adding depth, and the caller now has to read through all of them
  to find out what actually happens.
- **Shallow module** — interface size close to implementation size. Costs
  as much to call as it would to just inline its body — the opposite of
  what a module is for.
- **Temporal decomposition** — structuring code around the ORDER operations
  happen in ("step 1, step 2, step 3") rather than around the KNOWLEDGE each
  piece needs. Produces modules that must be called in a fixed sequence and
  that all leak the same piece of shared state between them.
- **Change amplification** — a single conceptual change that requires
  edits in many places because the design scattered that one piece of
  knowledge across several shallow modules instead of hiding it in one deep
  one.
- **Cognitive load** — how much a developer must hold in their head to use
  or modify a module safely. A deep module lowers it by hiding detail; a
  shallow one raises it by exposing detail the caller never asked for.
- **Unknown unknowns** — the worst cost a design can impose: it isn't
  obvious WHAT needs to change, or where, when a requirement shifts. A deep
  module with a clean interface at least makes the known unknowns
  (figuring out HOW to make a known change) tractable; a tangle of shallow,
  temporally-decomposed modules produces unknown unknowns instead.

## Detection checklist

What a reviewer or a repo-wide sweep flags, one item at a time:

1. **Pass-through wrappers** — a function/method whose body is mostly "call
   the next layer with the same arguments", repeated across a call chain.
2. **Many tiny exported functions the caller must sequence** — a module's
   public surface is a pile of small pieces and the caller has to know the
   right order to call them in; the module hid nothing, it just split.
3. **Config/flag parameters that leak internals** — a boolean or enum
   parameter whose real job is to pick which internal code path runs,
   handed to every caller to decide instead of decided once, behind the
   interface.
4. **Callers repeating the same 3-step dance** — the same
   open/configure/use (or validate/transform/call) sequence copy-pasted at
   every call site is the module admitting it never built the interface
   that should have hidden that dance.
5. **Tests that import internals or assert structure** — a test reaching
   past the public interface to poke a private field, or asserting on
   *how* the module did something rather than *what* it produced, pins the
   implementation in place and makes every future refactor a test-breaking
   one even when behavior is unchanged.
6. **Files split by "step", not by "knowledge"** — `step1.ts`, `step2.ts`,
   `step3.ts` (or `validate.ts` / `transform.ts` / `save.ts` for ONE
   concept) is temporal decomposition made literal in the filesystem; the
   same piece of domain knowledge usually ends up smeared across all three.

## Refactor recipes

- **Merge shallow siblings behind one interface.** Several small modules
  that always get called together, in the same order, by every caller are
  one deep module wearing a disguise — collapse them and let only the
  combined interface be public.
- **Pull complexity downward.** When a caller is doing work that could
  instead be done once, inside the module, move it down. The module gets
  a little more complex; every caller gets simpler. Good trade whenever
  there are more callers than implementers.
- **Define errors out of existence.** The cheapest error handling is the
  kind the caller never has to write — redesign the interface so the
  "error" case becomes a normal, handled-internally case (a sensible
  default, a no-op on an already-satisfied precondition) instead of a new
  checked exception every caller must remember to catch.
- **Replace flag params with distinct methods.** A boolean parameter that
  selects between two unrelated behaviors becomes two differently-named
  methods, each with its own smaller, honest interface — the caller's
  intent is now in the call site, not buried in a `true`/`false` a reader
  has to go look up.
- **Move tests to the interface; characterization tests first.** Before
  refactoring a shallow module, write characterization tests against its
  PUBLIC interface that pin current behavior (not current structure).
  Those tests should still pass, unchanged, once the refactor is done — if
  they don't, the test was pinned to structure, not behavior, and needs
  rewriting before the refactor, not after.

## When NOT to deepen

- **One-way-door code.** A change that can't be cheaply undone (a shipped
  migration, a public API contract already relied on externally) is not
  the place to experiment with a new interface shape — depth matters less
  than not breaking something you can't take back.
- **Hot security paths.** Auth, crypto, secrets, payments — correctness and
  auditability win over interface elegance. A deeper module here can also
  mean a harder-to-audit one; don't trade legibility for depth in code
  where a reviewer's ability to see everything that happens matters more
  than how little a caller has to know.
- **Generated code.** Nobody hand-edits it, and a generator's own shallow,
  mechanical structure is often the right shape for what it is — depth is
  a property worth optimizing for hand-maintained code, not for output a
  tool regenerates on every run.

## Hook into superpowers

This repo doesn't own the `superpowers` plugin's skills, so nothing there
gets edited — this section documents the intended cross-reference instead:

- `superpowers:brainstorming` and `superpowers:writing-plans`'s own design
  step should ask, for every module the plan touches: "does this deepen or
  shallow the touched modules?" — a design that adds a shallow module, or
  makes a deep one shallower, is a design smell worth surfacing before
  implementation starts, not after.
- `superpowers:requesting-code-review` should read this skill's detection
  checklist as part of whatever it reviews — a shallow-module finding is a
  real Standards-axis finding, not a style nitpick.

See `skills/delivery-standards/SKILL.md`'s review-fix-loop section for how a
Standards-axis finding (including one from this checklist) gets from a
reviewer's report into a landed fix, and `fleet/blueprint/studios/web-
studio/members/code-reviewer.md` for where this checklist sits inside that
studio's own Standards axis.
