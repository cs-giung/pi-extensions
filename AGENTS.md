# Repository instructions

## Artifact language

- Write all maintained artifacts in English, including code identifiers, documentation, comments, user-facing messages, and Git commit messages.
- Conversation replies may follow the user's language; repository artifacts must remain in English.
- Preserve multilingual and Unicode test coverage. Represent non-English fixture text with Unicode escape sequences rather than literal non-English prose in source files or snapshots.

## Verification

- Use `~/git/pi-extensions` as the default checkout path in installation examples.
- Run development installs and checks from the repository root so its dependency overrides apply.
- Run `npm run check`, `npm audit --audit-level=high`, and `git diff --check` before committing changes.
- Do not include credentials, personal Pi settings, or generated session files in commits.
