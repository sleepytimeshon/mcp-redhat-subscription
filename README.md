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

## Prerequisites

- Node.js 18+
- A Red Hat offline API token ([generate one here](https://access.redhat.com/management/api))

## Configuration

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "redhat-subscription": {
      "command": "node",
      "args": ["/path/to/mcp-redhat-subscription/src/index.js"],
      "env": {
        "REDHAT_TOKEN": "your-offline-token"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDHAT_TOKEN` | Yes | Red Hat offline API token for authentication |

## API Reference

This server wraps the [Red Hat Subscription Management API](https://access.redhat.com/articles/3626371) at `https://api.access.redhat.com/management/v1/`.

Authentication uses OAuth2 token exchange via Red Hat SSO (`sso.redhat.com`, client_id `rhsm-api`). Tokens are cached and refreshed automatically.

## Related MCP Servers

- [mcp-redhat-support](https://github.com/shonstephens/mcp-redhat-support) - Red Hat support case management
- [mcp-redhat-knowledge](https://github.com/shonstephens/mcp-redhat-knowledge) - Red Hat Knowledge Base search

## License

MIT
