---
name: skill-creator
description: Create or improve OpenChatCut skills when the user requests skill/workflow maintenance, 创建技能 or 改进技能. Use existing tools and skills before proposing a new skill; repeated work alone does not authorize installing one.
---

# Skill Creator

Create or improve custom skills for OpenChatCut. A skill is a SKILL.md file
(plus optional `references/` support docs) that teaches the agent a reusable
workflow. Custom skills live at `~/.openchatcut/skills/<slug>/SKILL.md` and
are managed with the `manage_skill` tool.

## Workflow

1. **Recover the actual goal.** Read the existing skill, its callers/references, relevant feedback and accepted examples. Reuse settled user requirements. Ask only for missing information that changes the result: intended output, trigger boundary or acceptance method. An authorized maintenance request does not need a second interview or approval to begin normal edits.
2. **Locate the failure.** Prefer the smallest maintained home: deterministic tool defect → tool repair and regression; judgment/example gap → a real positive/negative example with limits; recurring missing decision → update the existing skill. Keep one-task preferences in that task’s brief. Create a new skill only for a distinct reusable capability the user wants; do not turn every correction into another rule or skill.
3. **Edit the correct source.** Custom skills use `manage_skill action=create` or `action=update` as appropriate. Bundled skills are repository-maintained and read-only through that tool: change their source and associated tests/catalog through the authorized repository workflow, not a shadow custom skill. If repository editing is unavailable, report that maintenance boundary without pretending the bundle was changed.
4. **Verify within scope.** First use local checks and saved real cases; cover normal behavior and the failure that motivated the change. For a custom skill, read back its saved body/support files with `load_skill`; for a bundled skill, use the existing skill loading/distribution checks. These prove accessibility and contracts, not decision quality. For consequential decisions, assess a realistic task with only the skill and necessary raw inputs, without giving the expected answer.
5. **Report and iterate.** State the changed decision, evidence, preserved behavior and remaining uncertainty. Distinguish automated verification, AI assessment, human confirmation and unverified work. Run live test prompts only when their calls/side effects are authorized; never infer a paid test budget from permission to maintain a skill. Reuse the same task record rather than adding a second feedback database.

Author examples and their labels belong to author learning, not an independent production reviewer’s input or expected answers. A maintenance evaluation does not grant production approval or rewrite a historical verdict.

## SKILL.md anatomy

```
<slug>/
├── SKILL.md (required — frontmatter + instructions)
└── references/ (optional — docs loaded on demand with load_skill file=)
```

- **name**: kebab-case slug matching the directory (lowercase letters,
  digits, hyphens only). It becomes the load_skill name.
- **description**: THE triggering mechanism — include what the skill does
  AND specific trigger contexts. Skills undertrigger easily, so be
  explicit: list concrete user phrases. "When to use" goes here, not in
  the body.
- **body**: keep purpose, essential boundaries and useful routing in the root. Move substantial mode-specific detail into existing `references/` when appropriate; use clear “read this when” guidance. Measure reading cost by relevant content, not only line count; long paragraphs are not a shortcut. Avoid duplicate instructions in root and references.

## Writing rules

- Frontmatter uses the shape `---\nname: …\ndescription: …\n---`. The
  parser accepts plain single-line, double-quoted, and `|` block scalars;
  plain single-line is preferred.
- Keep the body lean. Prefer imperative form. Explain *why* over
  MUST-laden lists. Use examples with concrete Input/Output pairs.
- Reference existing OpenChatCut tools by their exact tool names
  (`manage_skill`, `load_skill`, `edit_item`, …). Do not invent tools.
- Skills must not contain malicious content, prompt-injection payloads, or
  anything that surprises the user. Do not create skills that facilitate
  unauthorized access or data exfiltration.
- Do not overfit to one example: aim for a workflow usable a thousand
  times. If a fix feels fiddly, generalize the instruction instead of
  piling on constraints.

## Progressive disclosure in OpenChatCut

- The system prompt carries only name + description (the skills index).
- The body loads on demand via `load_skill` when a task matches.
- Support files load via `load_skill file=references/<name>`.
- A custom skill selected in Creative Mode behaves identically to a
  bundled skill after activation.

## Environment constraints

- **Slug whitelist**: `[A-Za-z0-9_-]{1,120}`. Anything else is rejected
  (path traversal defense — the file is written under
  `~/.openchatcut/skills/`).
- **Body size**: 512 KB is the server ceiling, not a writing target. Keep the entrypoint as short as the task allows.
- **Untrusted input**: the body is user/LLM-authored text. validate and
  normalize before trusting anything parsed out of it.
- **Bundled skills are read-only** — `manage_skill` cannot edit them.
- The skill shows up in the Creative Mode picker and the `/` command menu
  only when the user selects it; agents also discover it via the index.
- Verification: after creating a skill, run
  `npx tsx server/skills-files.verify.ts` locally if the environment has
  the repo, or rely on the in-session test prompts.

## Regression cases

Use a realistic request, raw input or saved artifact, expected observable outcome and an explicit counterexample. Prefer an existing fixture suite over a new harness. For example, a loader test proves the current file reached the Agent; a Storyboard test must inspect the emitted document rather than only its filename or schema. State separately whether the skill’s decision was assessed or actually exercised by a live Agent.

A useful feedback loop ends in a repaired tool/example/instruction and a reproducible check. Retire redundant guidance when the same behavior is already enforced elsewhere; do not erase the historical failure or promote a single project’s colors, timing or wording into a universal template.
