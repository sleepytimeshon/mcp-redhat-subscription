#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFile } from "node:fs/promises";

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

async function apiDownload(path, outputPath) {
  const token = await getAccessToken();
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Download failed (${res.status}): ${text}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(outputPath, buffer);
  return buffer.length;
}

function jsonResponse(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function paginationParams(limit, offset) {
  return new URLSearchParams({ limit: String(limit), offset: String(offset) });
}

const server = new McpServer({
  name: "mcp-redhat-subscription",
  version: "2.0.0",
});

// === Subscriptions ===

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
    const data = await apiRequest(`/subscriptions?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
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
  async ({ subscriptionNumber }) => jsonResponse(await apiRequest(`/subscriptions/${subscriptionNumber}`))
);

server.registerTool(
  "listSubscriptionContentSets",
  {
    description: "List all content sets for a subscription",
    inputSchema: {
      subscriptionNumber: z.string().describe("The subscription number"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ subscriptionNumber, limit, offset }) => {
    const data = await apiRequest(`/subscriptions/${subscriptionNumber}/contentSets?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "listSubscriptionSystems",
  {
    description: "List all systems consuming a subscription",
    inputSchema: {
      subscriptionNumber: z.string().describe("The subscription number"),
      limit: z.number().optional().default(100).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ subscriptionNumber, limit, offset }) => {
    const data = await apiRequest(`/subscriptions/${subscriptionNumber}/systems?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

// === Systems ===

server.registerTool(
  "listSystems",
  {
    description: "List systems registered with Red Hat Subscription Management",
    inputSchema: {
      limit: z.number().optional().default(100).describe("Maximum results to return (default 100)"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
      filter: z.string().optional().describe("Filter systems by system name"),
      username: z.string().optional().describe("Filter systems by registered username"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, offset, filter, username }) => {
    const params = paginationParams(limit, offset);
    if (filter) params.set("filter", filter);
    if (username) params.set("username", username);
    const data = await apiRequest(`/systems?${params}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "getSystem",
  {
    description: "Get details of a specific registered system",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
      include: z.string().optional().describe("Show more details (e.g. 'installedProducts')"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ systemUuid, include }) => {
    const params = include ? `?include=${encodeURIComponent(include)}` : "";
    return jsonResponse(await apiRequest(`/systems/${systemUuid}${params}`));
  }
);

server.registerTool(
  "removeSystem",
  {
    description: "Remove a system profile from Red Hat Subscription Management",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID to remove"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ systemUuid }) => {
    await apiRequest(`/systems/${systemUuid}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `System ${systemUuid} removed` }] };
  }
);

server.registerTool(
  "attachSystemEntitlement",
  {
    description: "Attach an entitlement to a system from a pool",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
      pool: z.string().describe("The pool ID to attach from"),
      quantity: z.number().optional().describe("Quantity to attach"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ systemUuid, pool, quantity }) => {
    const params = new URLSearchParams({ pool });
    if (quantity !== undefined) params.set("quantity", String(quantity));
    const data = await apiRequest(`/systems/${systemUuid}/entitlements?${params}`, { method: "POST" });
    return jsonResponse(data);
  }
);

server.registerTool(
  "removeSystemEntitlement",
  {
    description: "Remove an entitlement from a system",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
      entitlementId: z.string().describe("The entitlement ID to remove"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ systemUuid, entitlementId }) => {
    await apiRequest(`/systems/${systemUuid}/${entitlementId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Entitlement ${entitlementId} removed from system ${systemUuid}` }] };
  }
);

server.registerTool(
  "listSystemErrata",
  {
    description: "List all applicable errata for a system",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ systemUuid, limit, offset }) => {
    const data = await apiRequest(`/systems/${systemUuid}/errata?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "listSystemPackages",
  {
    description: "List all packages for a system",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
      errataDetail: z.boolean().optional().describe("Show errata details for packages"),
      upgradeable: z.boolean().optional().describe("Show upgradable packages only"),
      filter: z.string().optional().describe("Filter packages by name"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ systemUuid, limit, offset, errataDetail, upgradeable, filter }) => {
    const params = paginationParams(limit, offset);
    if (errataDetail) params.set("errata_detail", "true");
    if (upgradeable) params.set("upgradeable", "true");
    if (filter) params.set("filter", filter);
    const data = await apiRequest(`/systems/${systemUuid}/packages?${params}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "listSystemPools",
  {
    description: "List all pools for a system",
    inputSchema: {
      systemUuid: z.string().describe("The system UUID"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ systemUuid, limit, offset }) => {
    const data = await apiRequest(`/systems/${systemUuid}/pools?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

// === Allocations ===

server.registerTool(
  "listAllocations",
  {
    description: "List subscription allocations (Satellite manifests)",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
      type: z.string().optional().describe("Filter by allocation type"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, offset, type }) => {
    const params = paginationParams(limit, offset);
    if (type) params.set("type", type);
    const data = await apiRequest(`/allocations?${params}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "getAllocation",
  {
    description: "Get details of a specific subscription allocation (Satellite manifest)",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      include: z.string().optional().describe("Show more details about the allocation"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, include }) => {
    const params = include ? `?include=${encodeURIComponent(include)}` : "";
    return jsonResponse(await apiRequest(`/allocations/${allocationUuid}${params}`));
  }
);

server.registerTool(
  "createAllocation",
  {
    description: "Create a new Satellite allocation",
    inputSchema: {
      name: z.string().describe("Allocation name (max 100 chars, alphanumeric, periods, underscores, hyphens)"),
      version: z.string().optional().describe("Satellite version"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ name, version }) => {
    const params = new URLSearchParams({ Name: name });
    if (version) params.set("version", version);
    const data = await apiRequest(`/allocations?${params}`, { method: "POST" });
    return jsonResponse(data);
  }
);

server.registerTool(
  "updateAllocation",
  {
    description: "Update an allocation (name, version, simple content access)",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      name: z.string().optional().describe("New allocation name"),
      version: z.string().optional().describe("Satellite version"),
      simpleContentAccess: z.string().optional().describe("Simple content access setting"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, ...fields }) => {
    const body = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v;
    }
    const data = await apiRequest(`/allocations/${allocationUuid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return jsonResponse(data);
  }
);

server.registerTool(
  "removeAllocation",
  {
    description: "Remove a subscription allocation. Requires force=true to confirm.",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      force: z.boolean().describe("Must be true to confirm deletion — this can have significant impact"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, force }) => {
    const params = new URLSearchParams({ force: String(force) });
    await apiRequest(`/allocations/${allocationUuid}?${params}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Allocation ${allocationUuid} removed` }] };
  }
);

server.registerTool(
  "listAllocationVersions",
  {
    description: "List available Satellite versions for allocations",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => jsonResponse(await apiRequest("/allocations/versions"))
);

server.registerTool(
  "listAllocationPools",
  {
    description: "List all pools available for an allocation",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
      future: z.boolean().optional().describe("Include future dated pools (Satellite 6.3+)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, limit, offset, future }) => {
    const params = paginationParams(limit, offset);
    if (future) params.set("future", "true");
    const data = await apiRequest(`/allocations/${allocationUuid}/pools?${params}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "attachAllocationEntitlement",
  {
    description: "Attach an entitlement to an allocation from a pool",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      pool: z.string().describe("The pool ID to attach from"),
      quantity: z.number().optional().describe("Quantity to attach"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ allocationUuid, pool, quantity }) => {
    const params = new URLSearchParams({ pool });
    if (quantity !== undefined) params.set("quantity", String(quantity));
    const data = await apiRequest(`/allocations/${allocationUuid}/entitlements?${params}`, { method: "POST" });
    return jsonResponse(data);
  }
);

server.registerTool(
  "updateAllocationEntitlement",
  {
    description: "Update the quantity of an entitlement attached to an allocation",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      entitlementId: z.string().describe("The entitlement ID"),
      quantity: z.number().optional().describe("New quantity (must be <= pool maximum)"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, entitlementId, quantity }) => {
    const params = quantity !== undefined ? `?quantity=${quantity}` : "";
    const data = await apiRequest(`/allocations/${allocationUuid}/entitlements/${entitlementId}${params}`, { method: "PUT" });
    return jsonResponse(data);
  }
);

server.registerTool(
  "removeAllocationEntitlement",
  {
    description: "Remove an entitlement from an allocation",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      entitlementId: z.string().describe("The entitlement ID to remove"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, entitlementId }) => {
    await apiRequest(`/allocations/${allocationUuid}/entitlements/${entitlementId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Entitlement ${entitlementId} removed from allocation ${allocationUuid}` }] };
  }
);

server.registerTool(
  "exportAllocation",
  {
    description: "Trigger a manifest export for an allocation. Returns an export job ID to poll.",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ allocationUuid }) => jsonResponse(await apiRequest(`/allocations/${allocationUuid}/export`))
);

server.registerTool(
  "getExportJobStatus",
  {
    description: "Check the status of an allocation manifest export job",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      exportJobId: z.string().describe("The export job ID from exportAllocation"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, exportJobId }) => {
    return jsonResponse(await apiRequest(`/allocations/${allocationUuid}/exportJob/${exportJobId}`));
  }
);

server.registerTool(
  "downloadAllocationExport",
  {
    description: "Download a completed allocation manifest export to a local file",
    inputSchema: {
      allocationUuid: z.string().describe("The allocation UUID"),
      exportId: z.string().describe("The export ID"),
      outputPath: z.string().describe("Local file path to save the manifest"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ allocationUuid, exportId, outputPath }) => {
    const bytes = await apiDownload(`/allocations/${allocationUuid}/export/${exportId}`, outputPath);
    return { content: [{ type: "text", text: `Downloaded manifest (${bytes} bytes) to ${outputPath}` }] };
  }
);

// === Errata ===

server.registerTool(
  "listErrata",
  {
    description: "List all errata applicable to the user's systems",
    inputSchema: {
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ limit, offset }) => {
    const data = await apiRequest(`/errata?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "listErrataByContentSetArch",
  {
    description: "List all errata for a specific content set and architecture",
    inputSchema: {
      contentSet: z.string().describe("The content set label"),
      arch: z.string().describe("The architecture (e.g. 'x86_64')"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ contentSet, arch, limit, offset }) => {
    const data = await apiRequest(`/errata/cset/${encodeURIComponent(contentSet)}/arch/${encodeURIComponent(arch)}?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "getErratum",
  {
    description: "Get details of a specific advisory (RHSA, RHBA, RHEA)",
    inputSchema: {
      advisoryId: z.string().describe("The advisory ID (e.g. 'RHSA-2024:1234')"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ advisoryId }) => jsonResponse(await apiRequest(`/errata/${encodeURIComponent(advisoryId)}`))
);

server.registerTool(
  "listErratumImages",
  {
    description: "List all updated container images for an advisory",
    inputSchema: {
      advisoryId: z.string().describe("The advisory ID"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ advisoryId }) => jsonResponse(await apiRequest(`/errata/${encodeURIComponent(advisoryId)}/images`))
);

server.registerTool(
  "listErratumPackages",
  {
    description: "List all packages for an advisory",
    inputSchema: {
      advisoryId: z.string().describe("The advisory ID"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ advisoryId, limit, offset }) => {
    const data = await apiRequest(`/errata/${encodeURIComponent(advisoryId)}/packages?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "listErratumSystems",
  {
    description: "List all systems affected by an advisory",
    inputSchema: {
      advisoryId: z.string().describe("The advisory ID"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ advisoryId, limit, offset }) => {
    const data = await apiRequest(`/errata/${encodeURIComponent(advisoryId)}/systems?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

// === Images ===

server.registerTool(
  "listImagesByContentSet",
  {
    description: "List available images in a content set",
    inputSchema: {
      contentSet: z.string().describe("The content set label"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ contentSet, limit, offset }) => {
    const data = await apiRequest(`/images/cset/${encodeURIComponent(contentSet)}?${paginationParams(limit, offset)}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "listImageDownloads",
  {
    description: "List RHEL image downloads by version and architecture",
    inputSchema: {
      version: z.string().describe("RHEL version (e.g. '9.4')"),
      arch: z.string().describe("Architecture (e.g. 'x86_64')"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ version, arch }) => {
    return jsonResponse(await apiRequest(`/images/rhel/${encodeURIComponent(version)}/${encodeURIComponent(arch)}`));
  }
);

server.registerTool(
  "downloadImage",
  {
    description: "Download an image by its SHA256 checksum to a local file",
    inputSchema: {
      checksum: z.string().describe("The image SHA256 checksum"),
      outputPath: z.string().describe("Local file path to save the image"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ checksum, outputPath }) => {
    const bytes = await apiDownload(`/images/${encodeURIComponent(checksum)}/download`, outputPath);
    return { content: [{ type: "text", text: `Downloaded image (${bytes} bytes) to ${outputPath}` }] };
  }
);

// === Packages ===

server.registerTool(
  "listPackagesByContentSetArch",
  {
    description: "List all packages for a content set and architecture",
    inputSchema: {
      contentSet: z.string().describe("The content set label"),
      arch: z.string().describe("The architecture (e.g. 'x86_64')"),
      limit: z.number().optional().default(50).describe("Maximum results to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
      filter: z.string().optional().describe("Filter packages by name"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ contentSet, arch, limit, offset, filter }) => {
    const params = paginationParams(limit, offset);
    if (filter) params.set("filter", filter);
    const data = await apiRequest(`/packages/cset/${encodeURIComponent(contentSet)}/arch/${encodeURIComponent(arch)}?${params}`);
    return jsonResponse(data);
  }
);

server.registerTool(
  "getPackage",
  {
    description: "Get details of a specific package by its checksum",
    inputSchema: {
      checksum: z.string().describe("The package SHA256 checksum"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ checksum }) => jsonResponse(await apiRequest(`/packages/${encodeURIComponent(checksum)}`))
);

server.registerTool(
  "downloadPackage",
  {
    description: "Download a package by its SHA256 checksum to a local file",
    inputSchema: {
      checksum: z.string().describe("The package SHA256 checksum"),
      outputPath: z.string().describe("Local file path to save the package"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ checksum, outputPath }) => {
    const bytes = await apiDownload(`/packages/${encodeURIComponent(checksum)}/download`, outputPath);
    return { content: [{ type: "text", text: `Downloaded package (${bytes} bytes) to ${outputPath}` }] };
  }
);

// === Cloud Access ===

server.registerTool(
  "listCloudAccessProviders",
  {
    description: "List all enabled cloud access providers for the account",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => jsonResponse(await apiRequest("/cloud_access_providers/enabled"))
);

server.registerTool(
  "addCloudProviderAccounts",
  {
    description: "Add provider accounts for a cloud access provider",
    inputSchema: {
      providerShortName: z.string().describe("Provider short name (e.g. 'AWS', 'Azure', 'GCE')"),
      accounts: z.array(z.object({
        id: z.string().describe("Account ID"),
        nickname: z.string().optional().describe("Account nickname"),
      })).describe("Array of accounts to add"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ providerShortName, accounts }) => {
    const data = await apiRequest(`/cloud_access_providers/${encodeURIComponent(providerShortName)}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(accounts),
    });
    return jsonResponse(data);
  }
);

server.registerTool(
  "updateCloudProviderAccount",
  {
    description: "Update a provider account (e.g. nickname)",
    inputSchema: {
      providerShortName: z.string().describe("Provider short name"),
      accountId: z.string().describe("The account ID"),
      nickname: z.string().optional().describe("New nickname for the account"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName, accountId, nickname }) => {
    const body = {};
    if (nickname !== undefined) body.nickname = nickname;
    const data = await apiRequest(`/cloud_access_providers/${encodeURIComponent(providerShortName)}/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return jsonResponse(data);
  }
);

server.registerTool(
  "removeCloudProviderAccount",
  {
    description: "Remove a provider account from cloud access",
    inputSchema: {
      providerShortName: z.string().describe("Provider short name"),
      accountId: z.string().describe("The account ID to remove"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName, accountId }) => {
    await apiRequest(`/cloud_access_providers/${encodeURIComponent(providerShortName)}/accounts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: accountId }),
    });
    return { content: [{ type: "text", text: `Account ${accountId} removed from ${providerShortName}` }] };
  }
);

server.registerTool(
  "removeCloudProviderAccountBySourceId",
  {
    description: "Remove a provider account by its source ID",
    inputSchema: {
      sourceId: z.string().describe("The source ID of the provider account"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ sourceId }) => {
    const params = new URLSearchParams({ sourceID: sourceId });
    await apiRequest(`/cloud_access_providers/accounts?${params}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Provider account with source ID ${sourceId} removed` }] };
  }
);

server.registerTool(
  "verifyCloudProviderAccount",
  {
    description: "Verify a provider account",
    inputSchema: {
      providerShortName: z.string().describe("Provider short name"),
      accountId: z.string().describe("The account ID to verify"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ providerShortName, accountId }) => {
    const data = await apiRequest(`/cloud_access_providers/${encodeURIComponent(providerShortName)}/accounts/${encodeURIComponent(accountId)}/verification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return jsonResponse(data);
  }
);

server.registerTool(
  "enableGoldImages",
  {
    description: "Enable Gold image access for a cloud provider",
    inputSchema: {
      providerShortName: z.string().describe("Provider short name (e.g. 'AWS', 'Azure', 'GCE')"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName }) => {
    const data = await apiRequest(`/cloud_access_providers/${encodeURIComponent(providerShortName)}/goldimage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return jsonResponse(data);
  }
);

// === Organization ===

server.registerTool(
  "getOrganization",
  {
    description: "Get details of the user's organization including Simple Content Access capability",
    inputSchema: {
      include: z.string().optional().describe("Request additional details (e.g. 'systemPurposeAttributes')"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ include }) => {
    const params = include ? `?include=${encodeURIComponent(include)}` : "";
    return jsonResponse(await apiRequest(`/organization${params}`));
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
