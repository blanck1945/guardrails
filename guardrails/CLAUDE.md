# Guardrails: working conventions

- Code, comments, prompts and docs are in English.
- `pnpm check` (typecheck and tests) and `pnpm build` must be green before every commit. No test calls a real model.
- Every batch of changes updates `CHANGELOG.md` and bumps `version` in `package.json` in the same commit.
- Each version section has exactly: `### What we did`, `### What we observed`, `### Next (vX.Y.Z+1)`.
- A version is never added without its "What we observed" section, linked to the previous version: the observations of vN (measurements, costs, cases) are what motivate the changes of vN+1.
- Never commit keys or tokens; they live in `guardrails/.env.local` (ignored).
