# OpenMontage

Read `AGENT_GUIDE.md` when starting substantive work in this project, when it changes, or when its relevant contents are no longer in context. Reuse an unchanged, already-read guide within the same task; a short acknowledgement does not require reading it again.

The guide routes production work. A request to inspect or edit project instructions/code is not permission to start video production, paid generation, installation, or publishing. Apply only the workflow relevant to the user's request.

Preserve the global safety boundaries. For production approval and completion, use the Human Checkpoint and Reviewer protocols in `AGENT_GUIDE.md`; a task-specific skill must not silently bypass those protocols or discard an existing scoped authorization.

## Development evidence for future defenses

The user explicitly requested ongoing work records on 2026-10-03 for future PPT defenses. Use `docs/defense-evidence/README.md` as the local archive entry point. For each substantive implementation or acceptance task, append a dated record using `ENTRY_TEMPLATE.md`, update the change index and relevant feature descriptions, and save useful screenshots or link existing verified artifacts. Routine acknowledgements do not need a new entry.

Record the concrete before/after behavior, user benefit, tools and technologies actually used, source/license attribution, validation commands and results, remaining limits, and reusable Chinese PPT captions. Separate real-project read-only screenshots, real local test runs, real authorized API runs, mock responses, and unverified catalog entries. A screenshot of a button is not evidence that its production workflow passed. Date historical evidence and do not silently relabel it as current validation.

Keep original screenshots, project files, existing receipts and dirty work intact. Add new dated copies rather than overwriting the only evidence. Preserve image aspect ratios; name derived crops separately. Never put credentials, authorization headers, raw private configuration or unrelated personal material in the presentation archive. Evidence capture does not authorize paid calls, media uploads, new production, publishing or extra permissions. Rebuild the offline image index with `python3 docs/defense-evidence/build_gallery.py` after adding image entries to its manifest.
