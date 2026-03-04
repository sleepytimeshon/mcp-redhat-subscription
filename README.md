# mcp-redhat-subscription

An [MCP](https://modelcontextprotocol.io/) server for the Red Hat Subscription Management API. Lets AI assistants query entitlements, subscriptions, and product access.

## Planned Tools

| Tool | Description |
|------|-------------|
| `getEntitlements` | List active subscriptions and entitlements |
| `getSubscriptionDetails` | Get details of a specific subscription |
| `listProducts` | List products available under current subscriptions |
| `listVersions` | List available versions for a product |
| `checkEntitlement` | Verify entitlement for a specific product/SLA |

## Prerequisites

- Node.js 18+
- A Red Hat offline API token ([generate one here](https://access.redhat.com/management/api))

## Status

Under development. See [mcp-redhat-support](https://github.com/shonstephens/mcp-redhat-support) for the case management MCP which is available now.

## License

MIT
