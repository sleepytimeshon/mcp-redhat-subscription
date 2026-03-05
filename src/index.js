#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN_URL = "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token";
const API_BASE = "https://api.access.redhat.com/management/v1";
const CLIENT_ID = "rhsm-api";

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const offlineToken = process.env.REDHAT_TOKEN;
  if (!offlineToken) {
    throw new Error("REDHAT_TOKEN environment variable is required (Red Hat offline API token)");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: offlineToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function apiRequest(path, options = {}) {
  const token = await getAccessToken();
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API request failed (${res.status} ${res.statusText}): ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const server = new McpServer({
  name: "mcp-redhat-subscription",
  version: "1.0.0",
});

// --- Tools ---

server.registerTool(
  "listSubscriptions",
  {
    description: "List Red Hat subscriptions for the authenticated account",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Maximum results to return (default 50)"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, offset }) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const data = await apiRequest(`/subscriptions?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "getSubscription",
  {
    description: "Get details of a specific Red Hat subscription including pools and consumed quantities",
    inputSchema: {
      subscriptionNumber: z.string().describe("The subscription number"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ subscriptionNumber }) => {
    const data = await apiRequest(`/subscriptions/${subscriptionNumber}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "listSystems",
  {
    description: "List systems registered with Red Hat Subscription Management",
    inputSchema: {
      limit: z.number().optional().default(100).describe("Maximum results to return (default 100)"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, offset }) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const data = await apiRequest(`/systems?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "getSystem",
  {
    description: "Get details of a specific registered system",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ systemUuid }) => {
    const data = await apiRequest(`/systems/${systemUuid}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "listAllocations",
  {
    description: "List subscription allocations (Satellite manifests)",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Maximum results to return (default 50)"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, offset }) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const data = await apiRequest(`/allocations?${params}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

server.registerTool(
  "getAllocation",
  {
    description: "Get details of a specific subscription allocation (Satellite manifest) including its entitlements",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ allocationUuid }) => {
    const data = await apiRequest(`/allocations/${allocationUuid}`);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
