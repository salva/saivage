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

1. From a fresh checkout, install root and dashboard dependencies: `npm ci && (cd web && npm ci)`.
2. Ensure `master` is green: `npm run lint && npm test && npm run typecheck`.
3. Update `package.json` version.
4. Build artifacts: `npm run build`.
5. Regenerate docs: `npm run docs:build`.
6. Tag: `git tag -a v<version> -m "release v<version>"`.
7. Push: `git push --follow-tags`.
8. Create a GitHub release with the changelog excerpt.
9. (When applicable) `npm publish --access public`.

## Changelog

There is no separate `CHANGELOG.md` file yet — the GitHub release
description is the canonical changelog. When the project stabilizes the
release process will adopt Conventional Commits + `changesets`.

## Pre-release builds

For experimental work cut a tag of the form `v<version>-rc.<n>`. Npm
pre-release publication should wait until npm publishing is enabled. LXC users
can pin to a specific tag with:

```bash
git -C ~/saivage fetch
git -C ~/saivage checkout v0.1.0-rc.2
make -C deploy deploy
```

## Compatibility

Until 1.0, schemas evolve without compatibility guarantees. Prefer clean schema
and runtime shapes over preserving old on-disk formats. A breaking release
should update source, tests, fixtures, prompts, and docs together rather than
adding compatibility shims for retired structures.

Operators should reset or regenerate affected `.saivage/` state when a release
changes required document shapes.
