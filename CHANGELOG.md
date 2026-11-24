# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.2] - 2026-11-23

### Added
- This changelog, included in the published package.

### Security
- Upgrade `@modelcontextprotocol/sdk` to 1.32.2 and `zod` to 4.6.7, and refresh the lockfile, clearing every `npm audit` advisory (1 critical, 8 high, 2 moderate) in the SDK, zod, and their transitive dependencies.

## [2.1.1] - 2026-11-23

### Added
- Continuous integration on Node.js 18, 20, 22, and 24 for every push and pull request to `main`, with a stdio smoke test that checks the registered tools against the README and the reported server version against `package.json`.
- Automated npm publishing with provenance through npm trusted publishing, plus a GitHub release for each version.
- `engines.node` declares the supported Node.js range (18.14.1 or later).
- README sections on pagination, version pinning, and the release process.

### Changed
- The published package contains only `src/`, `README.md`, `LICENSE`, and `package.json`.

### Fixed
- README setup for Claude Code (MCP servers belong in `~/.claude.json` or `.mcp.json`, not `settings.json`), VS Code (`servers` key and `${env:...}` variables), and Cursor, now documented separately.
- The `bin` path no longer uses a `./` prefix, which npm 11 drops on publish.

## [2.1.0] - 2026-05-06

### Added
- Optional `respOffset` and `respLimit` parameters on all 19 `list*` tools split large responses into chunks; truncated responses end with a footer giving the next `respOffset`. They are separate from the upstream API's `offset` and `limit` row pagination, and both can be used together.

### Fixed
- The server reports its package version; earlier releases reported 2.0.0.

## [2.0.3] - 2026-03-20

### Changed
- Repository and issue URLs point to the `sleepytimeshon` GitHub account after the repository transfer.

## [2.0.2] - 2026-03-12

### Changed
- README lists `mcp-redhat-manpage` under Related MCP Servers, in a standard order across all servers.

## [2.0.1] - 2026-03-10

### Added
- README configuration for Gemini CLI and watsonx Orchestrate, a Related MCP Servers section, and guidance on supplying `REDHAT_TOKEN` through a secrets manager.

### Changed
- README client examples run the server with `npx`.

## [2.0.0] - 2026-03-08

### Added
- First public release: an MCP server covering the Red Hat Subscription Management API with 45 tools for subscriptions, systems, allocations, errata, packages, images, cloud access, and organization.

[Unreleased]: https://github.com/sleepytimeshon/mcp-redhat-subscription/compare/v2.1.2...HEAD
[2.1.2]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.1.2
[2.1.1]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.1.1
[2.1.0]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.1.0
[2.0.3]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.0.3
[2.0.2]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.0.2
[2.0.1]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.0.1
[2.0.0]: https://www.npmjs.com/package/mcp-redhat-subscription/v/2.0.0
