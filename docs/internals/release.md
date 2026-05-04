# Release Process

Saivage's release process is **manual and minimal**. The package is
distributed via GitHub for now; npm publishing is gated on stabilization.

## Versioning

`package.json` is the single source of truth for the package version.
Saivage follows SemVer with a strong "until 1.0, anything can break"
caveat:

- **0.minor.patch** — major-bumps are reserved for the post-1.0 future.
- **minor** bumps for any spec-visible change (new tool, new schema field
  with a behavior implication, agent-prompt rewrite).
- **patch** bumps for fixes and internal refactors.

## Release checklist

1. Ensure `main` is green: `npm run lint && npm test && npm run typecheck`.
2. Update `package.json` version.
3. Build artifacts: `npm run build`.
4. Regenerate docs: `npm run docs:build`.
5. Tag: `git tag -a v<version> -m "release v<version>"`.
6. Push: `git push --follow-tags`.
7. Create a GitHub release with the changelog excerpt.
8. (When applicable) `npm publish --access public`.

## Changelog

There is no separate `CHANGELOG.md` file yet — the GitHub release
description is the canonical changelog. When the project stabilizes the
release process will adopt Conventional Commits + `changesets`.

## Pre-release builds

For experimental work cut a tag of the form `v<version>-rc.<n>` and
publish via `npm publish --tag next` (when npm is enabled). LXC users
can pin to a specific tag with:

```bash
git -C ~/saivage fetch
git -C ~/saivage checkout v0.1.0-rc.2
make -C deploy deploy
```

## Backward compatibility

Until 1.0, schemas evolve. The mitigation:

- All Zod schemas use `default()` for new optional fields so existing
  files load.
- Breaking shape changes ship with a `readDocOrNull → upgrade → writeDoc`
  migration in the relevant call site. Operators see the upgrade as a
  single commit on first daemon start after upgrade.
