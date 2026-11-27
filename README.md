# mcp-redhat-subscription

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Subscription Management API. Full coverage of the RHSM API — subscriptions, systems, allocations, errata, packages, images, cloud access, and organization.

## Tools

### Subscriptions

| Tool | Description |
|------|-------------|
| `listSubscriptions` | List subscriptions with SKU, quantity, status, dates, and pool usage; filter by status or name/SKU text |
| `getSubscription` | Get one subscription by number, with its pools (searches the subscription list) |
| `listSubscriptionContentSets` | List all content sets for a subscription |
| `listSubscriptionSystems` | List all systems consuming a subscription |

### Systems

| Tool | Description |
|------|-------------|
| `listSystems` | List systems registered with Red Hat Subscription Management |
| `getSystem` | Get a system's status, compliance, and errata counts, plus optional installed products, entitlements, and filterable facts |
| `removeSystem` | Unregister a system |
| `attachSystemEntitlement` | Attach an entitlement to a system from a pool |
| `removeSystemEntitlement` | Remove an entitlement from a system |
| `listSystemErrata` | List all applicable errata for a system |
| `listSystemPackages` | List a system's packages, optionally only upgradable ones or with errata |
| `listSystemPools` | List the pools a system can attach entitlements from |

### Allocations (Satellite Manifests)

| Tool | Description |
|------|-------------|
| `listAllocations` | List subscription allocations |
| `getAllocation` | Get details of a specific allocation |
| `createAllocation` | Create a new Satellite allocation |
| `updateAllocation` | Turn simple content access on or off for an allocation |
| `removeAllocation` | Remove an allocation (requires `confirm: true`) |
| `listAllocationVersions` | List available Satellite versions |
| `listAllocationPools` | List all pools for an allocation |
| `attachAllocationEntitlement` | Attach an entitlement to an allocation |
| `updateAllocationEntitlement` | Update entitlement quantity on an allocation |
| `removeAllocationEntitlement` | Remove an entitlement from an allocation |
| `exportAllocation` | Trigger manifest export |
| `getExportJobStatus` | Check export job status |
| `downloadAllocationExport` | Download a completed manifest export into the download directory |

### Errata

| Tool | Description |
|------|-------------|
| `listErrata` | List all errata applicable to the user's systems |
| `listErrataByContentSetArch` | List errata for a content set and architecture |
| `getErratum` | Get details of a specific advisory |
| `listErratumImages` | List updated container images for an advisory |
| `listErratumPackages` | List all packages for an advisory |
| `listErratumSystems` | List the account's systems an advisory applies to |

### Images

| Tool | Description |
|------|-------------|
| `listImagesByContentSet` | List available images in a content set |
| `listImageDownloads` | List RHEL image downloads by version and architecture |
| `downloadImage` | Get a short-lived download link for an image, or stream it into the download directory |

### Packages

| Tool | Description |
|------|-------------|
| `listPackagesByContentSetArch` | List packages for a content set and architecture, optionally only the latest versions |
| `getPackage` | Get details of a package by checksum |
| `downloadPackage` | Get a short-lived download link for a package, or stream it into the download directory |

### Cloud Access

| Tool | Description |
|------|-------------|
| `listCloudAccessProviders` | List enabled cloud access providers |
| `addCloudProviderAccounts` | Add provider accounts (AWS, Azure, GCE) |
| `updateCloudProviderAccount` | Change a provider account's nickname |
| `updateCloudProviderAccountTenantId` | Set the Azure tenant ID of a Microsoft Azure account |
| `removeCloudProviderAccount` | Remove a provider account |
| `removeCloudProviderAccountBySourceId` | Remove a provider account by source ID |
| `verifyCloudProviderAccount` | Verify a provider account for auto-registration with an instance identity document and signature |
| `enableGoldImages` | Enable Gold image access for a provider |

### Organization

| Tool | Description |
|------|-------------|
| `getOrganization` | Get organization details including SCA capability |

## Pagination

Two kinds of paging apply:

- **Results:** list tools take `maxResults` and `startAt`. Each endpoint caps a page at its API maximum (50 subscriptions, 100 systems, 1000 system packages, and so on), and the API never reports a total, so a full page ends with a note that more results may exist and the `startAt` for the next page.
- **Output:** every tool that can return a lot accepts `offset` (default 0) and `limit` (default 30000), counted in characters of rendered output. When a response is truncated, it ends with a footer like:

```
[truncated: showing chars 0-30000 of 102783. Call again with offset=30000 for the next chunk.]
```

Pass that `offset` back to fetch the next chunk.

## Output

Tool output is Markdown written for a language model: tables for listings, labeled fields for details, and empty fields dropped. `listErrata` and `listErratumSystems` report "no errata apply" when the API answers 404, which it does when no errata match the account's systems.

## Downloads

`downloadImage` and `downloadPackage` return a short-lived Red Hat CDN link by default; request a new one for each download and verify the file against its SHA-256 checksum. With `save: true`, and for `downloadAllocationExport` (a single-use manifest zip), the server streams the file into the download directory, `REDHAT_DOWNLOAD_DIR` (default `~/redhat-downloads`). It refuses paths outside that directory, never overwrites a file unless `overwrite` is true, and never sends the Red Hat token to the CDN.

## Prerequisites

- Node.js 18.14.1+
- A Red Hat offline API token ([generate one here](https://access.redhat.com/management/api))

## Configuration

Set your Red Hat offline API token in your shell profile:

```bash
export REDHAT_TOKEN="your-offline-token-here"
```

In enterprise environments, provide `REDHAT_TOKEN` through your secrets management solution (e.g. HashiCorp Vault, Kubernetes secrets, or your CI platform's secret variables) rather than shell profiles.

The offline token expires if it is not used for 30 days; generate a new one from the same page if authentication starts failing.

### Pinning a version

The examples below run `npx -y mcp-redhat-subscription`, which fetches the latest published release each time the server starts. For operational use, pin a version so upgrades happen deliberately:

- Replace `mcp-redhat-subscription` in `args` with `mcp-redhat-subscription@<version>` (e.g. `mcp-redhat-subscription@2.1.0`), or
- Install it once with `npm install -g mcp-redhat-subscription@<version>` and use `mcp-redhat-subscription` as the `command` with no `args`.

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "redhat-subscription": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-subscription"],
      "env": {
        "REDHAT_TOKEN": "$REDHAT_TOKEN"
      }
    }
  }
}
```

### watsonx Orchestrate

```bash
# Add a connection for the Red Hat API token
orchestrate connections add --app-id "redhat-subscription"
orchestrate connections configure --app-id redhat-subscription --env draft --kind key_value --type team --url "https://access.redhat.com"
orchestrate connections set-credentials --app-id "redhat-subscription" --env draft -e REDHAT_TOKEN=your-offline-token-here

# Import the MCP toolkit
orchestrate toolkits import --kind mcp \
  --name redhat-subscription \
  --description "Red Hat Subscription Management" \
  --command "npx -y mcp-redhat-subscription" \
  --tools "*" \
  --app-id redhat-subscription
```

### Claude Code

Claude Code reads MCP servers from `~/.claude.json` (user and local scopes) or a project's `.mcp.json`, not from `settings.json`.

To make the server available in every project, add it at user scope:

```bash
claude mcp add redhat-subscription --scope user \
  -e REDHAT_TOKEN="$REDHAT_TOKEN" \
  -- npx -y mcp-redhat-subscription
```

This stores the token's value in `~/.claude.json`. To keep the token out of configuration files, add the server to a project's `.mcp.json` instead; Claude Code expands `${REDHAT_TOKEN}` from the environment when it starts the server:

```json
{
  "mcpServers": {
    "redhat-subscription": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-subscription"],
      "env": {
        "REDHAT_TOKEN": "${REDHAT_TOKEN}"
      }
    }
  }
}
```

Run `claude mcp list` to confirm the server connects.

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "redhat-subscription": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-redhat-subscription"],
      "env": {
        "REDHAT_TOKEN": "${env:REDHAT_TOKEN}"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your workspace, or `~/.cursor/mcp.json` for all workspaces:

```json
{
  "mcpServers": {
    "redhat-subscription": {
      "command": "npx",
      "args": ["-y", "mcp-redhat-subscription"],
      "env": {
        "REDHAT_TOKEN": "${env:REDHAT_TOKEN}"
      }
    }
  }
}
```

## Authentication

The server exchanges your Red Hat offline API token for a short-lived bearer token via Red Hat SSO. Tokens are cached, refreshed automatically, and exchanged again if the API rejects a cached one. Requests time out after 30 seconds (1 hour for file downloads).

## Releasing

Every push to `main` runs CI (`.github/workflows/ci.yml`): `npm ci`, a syntax check, and `npm test` on Node 18, 20, 22, and 24. `npm test` starts the server and checks that its tools match the tables in [Tools](#tools) and that it reports the `package.json` version.

To release, bump `version` in both `package.json` and the `McpServer` declaration in `src/index.js`, move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under a heading for the new version, then push to `main`. When that version is not yet on npm, CI publishes it with provenance through npm trusted publishing and creates a `vX.Y.Z` GitHub release. Pushes that keep the version only run the tests.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-knowledge](https://github.com/sleepytimeshon/mcp-redhat-knowledge) - Knowledge Base search
- [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) - RHEL man pages
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

MIT
