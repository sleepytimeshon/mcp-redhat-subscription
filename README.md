# mcp-redhat-subscription

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Subscription Management API. Lets AI assistants query subscriptions, registered systems, and subscription allocations.

## Tools

| Tool | Description |
|------|-------------|
| `listSubscriptions` | List Red Hat subscriptions for the authenticated account |
| `getSubscription` | Get details of a specific subscription including pools and consumed quantities |
| `listSystems` | List systems registered with Red Hat Subscription Management |
| `getSystem` | Get details of a specific registered system |
| `listAllocations` | List subscription allocations (Satellite manifests) |
| `getAllocation` | Get details of a specific subscription allocation |

All tools are read-only.

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
