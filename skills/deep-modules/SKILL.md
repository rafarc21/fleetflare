---
name: deep-modules
description: Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.
---

<!--
Vendored from https://github.com/mattpocock/skills (commit b0618bc436ad),
MIT License. Source: skills/engineering/codebase-design/SKILL.md.
Only change from upstream: the `name:` frontmatter field above, renamed from
`codebase-design` to `deep-modules` to match this repo's skill directory.
Body below is unchanged. See skills/VENDORED.md and
skills/THIRD-PARTY-LICENSES.md. The "Fleetflare addendum" section at the
end of this file is NOT vendored -- it's this repo's own addition, clearly
marked.
-->

# Codebase Design

Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean seam, testable through that interface. Use this language and these principles wherever code is being designed or restructured. The aim is leverage for callers, locality for maintainers, and testability for everyone.

## Glossary

Use these terms exactly: don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

**Module**: anything with an interface and an implementation. Deliberately scale-agnostic: a function, class, package, or tier-spanning slice. _Avoid_: unit, component, service.

**Interface**: everything a caller must know to use the module correctly: the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics. _Avoid_: API, signature (too narrow, they refer only to the type-level surface).

**Implementation**: what's inside a module, its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth**: leverage at the interface. The amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(Michael Feathers)_: a place where you can alter behaviour without editing in that place; the *location* at which a module's interface lives. Where to put the seam is its own design decision, distinct from what goes behind it. _Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**: a concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside).

**Leverage**: what callers get from depth. More capability per unit of interface they learn. One implementation pays back across N call sites and M tests.

**Locality**: what maintainers get from depth. Change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers. Fix once, fixed everywhere.

## Deep vs shallow

**Deep module** = small interface + lots of implementation:

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
└─────────────────────┘
```

**Shallow module** = large interface + little implementation (avoid):

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```

When designing an interface, ask:

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, mockable, swappable parts; they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it.

## Designing for testability

Good interfaces make testing natural:

1. **Accept dependencies, don't create them.**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway();
   }
   ```

2. **Return results, don't produce side effects.**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount;
   }
   ```

3. **Small surface area.** Fewer methods = fewer tests needed. Fewer params = simpler test setup.

## Relationships

- A **Module** has exactly one **Interface** (the surface it presents to callers and tests).
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**: too narrow: interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

## Going deeper

- **Deepening a cluster given its dependencies**, see [DEEPENING.md](DEEPENING.md): dependency categories, seam discipline, and replace-don't-layer testing.
- **Exploring alternative interfaces**, see [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md): spin up parallel sub-agents to design the interface several radically different ways, then compare on depth, locality, and seam placement.

---

## Fleetflare addendum (not vendored -- this repo's own)

Everything above this line is Matt Pocock's `codebase-design` skill, vendored
verbatim (only the frontmatter `name:` changed). Everything below is
fleetflare's own addition, written for this repo's review and sweep
workflow. Where an item below overlaps vendored vocabulary, the mapping is
named instead of restating the vendored text.

### Detection checklist

What a reviewer or a repo-wide sweep flags, one item at a time. Numbered so
other docs (e.g. a dry-run finding) can cite "checklist item N":

1. **Pass-through wrappers** -- a function/method whose body is mostly "call
   the next layer with the same arguments", repeated across a call chain.
   This is the vendored **deletion test** applied directly: delete the
   wrapper: if the caller could call the next layer itself with no loss,
   it was a pass-through.
2. **Many tiny exported functions the caller must sequence** -- a module's
   public surface is a pile of small pieces and the caller has to know the
   right order to call them in; the module hid nothing, it just split. A
   symptom of a **shallow module**: the interface (all those functions, in
   the right order) is nearly as complex as just inlining them.
3. **Config/flag parameters that leak internals** -- a boolean or enum
   parameter whose real job is to pick which internal code path runs,
   handed to every caller to decide instead of decided once, behind the
   interface. Shrinks **leverage**: the caller now has to learn an internal
   branch instead of getting it for free.
4. **Callers repeating the same 3-step dance** -- the same
   open/configure/use (or validate/transform/call) sequence copy-pasted at
   every call site is the module admitting it never built the interface
   that should have hidden that dance; the knowledge of "how to drive this"
   has no single **locality**, it's smeared across every call site.
5. **Tests that import internals or assert structure** -- a test reaching
   past the public interface to poke a private field, or asserting on
   *how* the module did something rather than *what* it produced, violates
   **the interface is the test surface**: it pins the implementation in
   place and makes every future refactor a test-breaking one even when
   behavior is unchanged.
6. **Files split by "step", not by "knowledge"** -- `step1.ts`, `step2.ts`,
   `step3.ts` (or `validate.ts` / `transform.ts` / `save.ts` for ONE
   concept) is organization by the ORDER work happens in rather than by
   what each piece knows. Not named in the vendored content above; it is
   the filesystem-level version of item 2 (many tiny pieces the caller/
   reader must sequence) made literal in the directory layout.

### Refactor recipes

- **Merge shallow siblings behind one interface.** Several small modules
  that always get called together, in the same order, by every caller are
  one deep module wearing a disguise -- collapse them and let only the
  combined interface be public.
- **Pull complexity downward.** When a caller is doing work that could
  instead be done once, inside the module, move it down. The module gets
  a little more complex; every caller gets simpler. Good trade whenever
  there are more callers than implementers.
- **Define errors out of existence.** The cheapest error handling is the
  kind the caller never has to write -- redesign the interface so the
  "error" case becomes a normal, handled-internally case (a sensible
  default, a no-op on an already-satisfied precondition) instead of a new
  checked exception every caller must remember to catch.
- **Replace flag params with distinct methods.** A boolean parameter that
  selects between two unrelated behaviors becomes two differently-named
  methods, each with its own smaller, honest interface -- the caller's
  intent is now in the call site, not buried in a `true`/`false` a reader
  has to go look up.
- **Move tests to the interface; characterization tests first.** Before
  refactoring a shallow module, write characterization tests against its
  PUBLIC interface that pin current behavior (not current structure).
  Those tests should still pass, unchanged, once the refactor is done -- if
  they don't, the test was pinned to structure, not behavior, and needs
  rewriting before the refactor, not after. Same discipline as the vendored
  "replace, don't layer" testing strategy in [DEEPENING.md](DEEPENING.md).

### When NOT to deepen

- **One-way-door code.** A change that can't be cheaply undone (a shipped
  migration, a public API contract already relied on externally) is not
  the place to experiment with a new interface shape -- depth matters less
  than not breaking something you can't take back.
- **Hot security paths.** Auth, crypto, secrets, payments -- correctness and
  auditability win over interface elegance. A deeper module here can also
  mean a harder-to-audit one; don't trade legibility for depth in code
  where a reviewer's ability to see everything that happens matters more
  than how little a caller has to know.
- **Generated code.** Nobody hand-edits it, and a generator's own shallow,
  mechanical structure is often the right shape for what it is -- depth is
  a property worth optimizing for hand-maintained code, not for output a
  tool regenerates on every run.

### Hook into superpowers

This repo doesn't own the `superpowers` plugin's skills, so nothing there
gets edited -- this section documents the intended cross-reference instead:

- `superpowers:brainstorming` and `superpowers:writing-plans`'s own design
  step should ask, for every module the plan touches: "does this deepen or
  shallow the touched modules?" -- a design that adds a shallow module, or
  makes a deep one shallower, is a design smell worth surfacing before
  implementation starts, not after.
- `superpowers:requesting-code-review` should read this skill's detection
  checklist as part of whatever it reviews -- a shallow-module finding is a
  real Standards-axis finding, not a style nitpick.

See `skills/delivery-standards/SKILL.md`'s review-fix-loop section for how a
Standards-axis finding (including one from this checklist) gets from a
reviewer's report into a landed fix, and `fleet/blueprint/studios/web-
studio/members/code-reviewer.md` for where this checklist sits inside that
studio's own Standards axis.
