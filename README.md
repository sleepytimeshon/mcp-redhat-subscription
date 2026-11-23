# mcp-redhat-subscription

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Subscription Management API. Full coverage of the RHSM API — subscriptions, systems, allocations, errata, packages, images, cloud access, and organization.

## Tools

### Subscriptions

| Tool | Description |
|------|-------------|
| `listSubscriptions` | List Red Hat subscriptions for the authenticated account |
| `getSubscription` | Get details of a specific subscription including pools and consumed quantities |
| `listSubscriptionContentSets` | List all content sets for a subscription |
| `listSubscriptionSystems` | List all systems consuming a subscription |

### Systems

| Tool | Description |
|------|-------------|
| `listSystems` | List systems registered with Red Hat Subscription Management |
| `getSystem` | Get details of a specific registered system |
| `removeSystem` | Remove a system profile |
| `attachSystemEntitlement` | Attach an entitlement to a system from a pool |
| `removeSystemEntitlement` | Remove an entitlement from a system |
| `listSystemErrata` | List all applicable errata for a system |
| `listSystemPackages` | List all packages for a system |
| `listSystemPools` | List all pools for a system |

### Allocations (Satellite Manifests)

| Tool | Description |
|------|-------------|
| `listAllocations` | List subscription allocations |
| `getAllocation` | Get details of a specific allocation |
| `createAllocation` | Create a new Satellite allocation |
| `updateAllocation` | Update an allocation (name, version, SCA) |
| `removeAllocation` | Remove an allocation (requires force) |
| `listAllocationVersions` | List available Satellite versions |
| `listAllocationPools` | List all pools for an allocation |
| `attachAllocationEntitlement` | Attach an entitlement to an allocation |
| `updateAllocationEntitlement` | Update entitlement quantity on an allocation |
| `removeAllocationEntitlement` | Remove an entitlement from an allocation |
| `exportAllocation` | Trigger manifest export |
| `getExportJobStatus` | Check export job status |
| `downloadAllocationExport` | Download a completed manifest export |

### Errata

| Tool | Description |
|------|-------------|
| `listErrata` | List all errata applicable to the user's systems |
| `listErrataByContentSetArch` | List errata for a content set and architecture |
| `getErratum` | Get details of a specific advisory |
| `listErratumImages` | List updated container images for an advisory |
| `listErratumPackages` | List all packages for an advisory |
| `listErratumSystems` | List all systems affected by an advisory |

### Images

| Tool | Description |
|------|-------------|
| `listImagesByContentSet` | List available images in a content set |
| `listImageDownloads` | List RHEL image downloads by version and architecture |
| `downloadImage` | Download an image by SHA256 checksum |

### Packages

| Tool | Description |
|------|-------------|
| `listPackagesByContentSetArch` | List packages for a content set and architecture |
| `getPackage` | Get details of a package by checksum |
| `downloadPackage` | Download a package by SHA256 checksum |

### Cloud Access

| Tool | Description |
|------|-------------|
| `listCloudAccessProviders` | List enabled cloud access providers |
| `addCloudProviderAccounts` | Add provider accounts (AWS, Azure, GCE) |
| `updateCloudProviderAccount` | Update a provider account |
| `removeCloudProviderAccount` | Remove a provider account |
| `removeCloudProviderAccountBySourceId` | Remove a provider account by source ID |
| `verifyCloudProviderAccount` | Verify a provider account |
| `enableGoldImages` | Enable Gold image access for a provider |

### Organization

| Tool | Description |
|------|-------------|
| `getOrganization` | Get organization details including SCA capability |

## Pagination

All `list*` tools accept optional `respOffset` (default 0) and `respLimit` (default 30000) parameters to chunk response output. Large list results (e.g. `listSystemPackages` for a system with thousands of packages, `listSystems` at scale) can exceed typical MCP tool-result token caps when returned whole. When a response is truncated, the output ends with a footer like:

```
[truncated: showing chars 0-30000 of 102783. Call again with respOffset=30000 for the next chunk.]
```

Pass that `respOffset` back to fetch the next chunk. Small responses return in one call.

**Naming note:** `limit`/`offset` are reserved on most tools for upstream Red Hat API row-pagination (e.g. `limit=1000` to fetch 1000 system records from the API). Response-character pagination uses `respOffset`/`respLimit` to avoid collision. Both layers can be used together — for example, `limit=1000` to retrieve many rows, then `respOffset` to page through the rendered JSON in chunks.

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

The server exchanges your Red Hat offline API token for a short-lived bearer token via Red Hat SSO. Tokens are cached and refreshed automatically.

## Related MCP Servers

- [mcp-redhat-account](https://github.com/sleepytimeshon/mcp-redhat-account) - Account management
- [mcp-redhat-knowledge](https://github.com/sleepytimeshon/mcp-redhat-knowledge) - Knowledge Base search
- [mcp-redhat-manpage](https://github.com/sleepytimeshon/mcp-redhat-manpage) - RHEL man pages
- [mcp-redhat-support](https://github.com/sleepytimeshon/mcp-redhat-support) - Support case management

## License

MIT
