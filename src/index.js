#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApiError,
  apiRequest,
  collectPages,
  DEFAULT_CHUNK,
  downloadDir,
  formatAllocation,
  formatAllocations,
  formatAllocationVersions,
  formatCloudProviders,
  formatContentSets,
  formatErrataInContentSet,
  formatErratum,
  formatErratumImages,
  formatErratumPackages,
  formatGeneric,
  formatImages,
  formatMyErrata,
  formatOrganization,
  formatPackage,
  formatPackagesInContentSet,
  formatPools,
  formatSubscription,
  formatSubscriptions,
  formatSubscriptionSystems,
  formatSystem,
  formatSystemErrata,
  formatSystemPackages,
  formatSystems,
  getDownloadLink,
  normalizeAdvisoryId,
  normalizeAllocationName,
  normalizeArch,
  normalizeChecksum,
  normalizeContentSet,
  normalizeId,
  normalizeProvider,
  normalizeProviderAccountId,
  normalizeRhelVersion,
  normalizeSubscriptionNumber,
  normalizeUuid,
  PAGE_MAX,
  pageQuery,
  paginate,
  resolveDownloadPath,
  saveApiResponse,
  saveLink,
} from "./lib.js";

const paginationSchema = {
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe(`Character offset into the rendered response. Default 0. Use the value from the previous call's "[truncated]" footer to fetch the next chunk.`),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_CHUNK)
    .describe(`Maximum characters to return in this call. Default ${DEFAULT_CHUNK} keeps responses under typical MCP tool-result token caps.`),
};

const pageSchema = (kind) => ({
  maxResults: z.number().int().min(1).max(PAGE_MAX[kind]).optional().describe(`Results per call, 1-${PAGE_MAX[kind]} (default ${PAGE_MAX[kind]}, the API maximum)`),
  startAt: z.number().int().nonnegative().optional().default(0).describe("Skip this many results (for the next page)"),
});

const READ = { readOnlyHint: true, openWorldHint: true };
const textResult = (text) => ({ content: [{ type: "text", text }] });
const server = new McpServer({ name: "mcp-redhat-subscription", version: "3.0.0" });

// Register a read-only tool that lists one page of an RHSM collection
function listTool(name, { kind, description, input = {}, path, query, format, empty, label }) {
  server.registerTool(
    name,
    { description: `${description} Pages with maxResults and startAt; large output is paginated — call again with \`offset\`.`, inputSchema: { ...input, ...pageSchema(kind), ...paginationSchema }, annotations: READ },
    async (args) => {
      const { limit: pageLimit, offset: startAt } = pageQuery(kind, args.maxResults, args.startAt);
      const data = await apiRequest(path(args), { query: { ...(query ? query(args) : {}), limit: pageLimit, offset: startAt } });
      const items = data?.body || [];
      return textResult(paginate(format(items, { limit: pageLimit, startAt, empty }), args.offset, args.limit, label ? label(args) : name));
    }
  );
}

// === Subscriptions ===

server.registerTool(
  "listSubscriptions",
  {
    description: "List the account's subscriptions: number, name, SKU, quantity, status, dates, and pool usage. Filter by status or by text in the name or SKU (filters scan every subscription). Pages with maxResults and startAt; large output is paginated — call again with `offset`.",
    inputSchema: {
      status: z.enum(["Active", "Expired", "Future dated"]).optional().describe("Only subscriptions with this status"),
      search: z.string().optional().describe("Only subscriptions whose name or SKU contains this text (case-insensitive)"),
      ...pageSchema("subscriptions"),
      ...paginationSchema,
    },
    annotations: READ,
  },
  async ({ status, search, maxResults, startAt, offset, limit }) => {
    const { limit: pageLimit } = pageQuery("subscriptions", maxResults, startAt);
    if (!status && !search) {
      const data = await apiRequest("/subscriptions", { query: { limit: pageLimit, offset: startAt } });
      return textResult(paginate(formatSubscriptions(data?.body || [], { limit: pageLimit, startAt }), offset, limit, "listSubscriptions"));
    }
    const { items, truncated } = await collectPages("/subscriptions", "subscriptions");
    const s = search?.toLowerCase();
    const matches = items.filter((x) => (!status || x.status === status) && (!s || `${x.subscriptionName} ${x.sku}`.toLowerCase().includes(s)));
    const page = matches.slice(startAt, startAt + pageLimit);
    const more = startAt + page.length < matches.length ? `\n\n${matches.length - startAt - page.length} more match: call again with startAt=${startAt + page.length}.` : "";
    const note = truncated ? `\n\n> Only the first ${items.length} subscriptions were searched.` : "";
    const text = page.length ? `${formatSubscriptions(page, { startAt })}${more}${note}` : `No subscriptions match.${note}`;
    return textResult(paginate(text, offset, limit, "listSubscriptions"));
  }
);

server.registerTool(
  "getSubscription",
  {
    description: "Get one subscription by number: name, SKU, contract, quantity, status, dates, and pools. The API has no single-subscription endpoint, so this searches the subscription list.",
    inputSchema: { subscriptionNumber: z.string().describe("Subscription number") },
    annotations: READ,
  },
  async ({ subscriptionNumber }) => {
    const n = normalizeSubscriptionNumber(subscriptionNumber);
    const { items } = await collectPages("/subscriptions", "subscriptions");
    const sub = items.find((s) => String(s.subscriptionNumber) === n);
    return textResult(sub ? formatSubscription(sub) : `No subscription ${n} on this account.`);
  }
);

listTool("listSubscriptionContentSets", {
  kind: "contentSets",
  description: "List the content sets (repositories) a subscription provides: label, name, type, arch, and whether enabled.",
  input: { subscriptionNumber: z.string().describe("Subscription number") },
  path: (a) => `/subscriptions/${normalizeSubscriptionNumber(a.subscriptionNumber)}/contentSets`,
  format: formatContentSets,
  label: (a) => `listSubscriptionContentSets: ${a.subscriptionNumber}`,
});

listTool("listSubscriptionSystems", {
  kind: "subscriptionSystems",
  description: "List the systems consuming a subscription.",
  input: { subscriptionNumber: z.string().describe("Subscription number") },
  path: (a) => `/subscriptions/${normalizeSubscriptionNumber(a.subscriptionNumber)}/systems`,
  format: formatSubscriptionSystems,
  empty: "No systems use this subscription.",
  label: (a) => `listSubscriptionSystems: ${a.subscriptionNumber}`,
});

// === Systems ===

listTool("listSystems", {
  kind: "systems",
  description: "List systems registered to Red Hat Subscription Management: name, UUID, hostname, type, entitlement status, errata counts, and last check-in.",
  input: {
    name: z.string().optional().describe("Only systems whose name matches"),
    username: z.string().optional().describe("Only systems registered by this user (exact, no wildcards)"),
  },
  path: () => "/systems",
  query: (a) => ({ filter: a.name, username: a.username }),
  format: formatSystems,
  empty: "No registered systems match.",
});

server.registerTool(
  "getSystem",
  {
    description: "Get a registered system: status, compliance, service level, check-ins, and errata counts, plus optional installed products, attached entitlements, and facts (filterable). Large output is paginated — call again with `offset`.",
    inputSchema: {
      systemUuid: z.string().describe("System UUID"),
      include: z.array(z.enum(["installedProducts", "entitlements", "facts"])).optional().describe("Extra sections to include"),
      factsFilter: z.string().optional().describe("With facts: only facts whose name contains this text (e.g. 'memory', 'cpu', 'net.interface')"),
      ...paginationSchema,
    },
    annotations: READ,
  },
  async ({ systemUuid, include, factsFilter, offset, limit }) => {
    const u = normalizeUuid(systemUuid, "system UUID");
    const data = await apiRequest(`/systems/${u}`, { query: { include: include?.length ? [...new Set(include)].join(",") : undefined } });
    return textResult(paginate(formatSystem(data?.body || {}, { factsFilter }), offset, limit, `getSystem: ${u}`));
  }
);

listTool("listSystemErrata", {
  kind: "systemErrata",
  description: "List the errata (advisories) applicable to a system.",
  input: { systemUuid: z.string().describe("System UUID") },
  path: (a) => `/systems/${normalizeUuid(a.systemUuid, "system UUID")}/errata`,
  format: formatSystemErrata,
  label: (a) => `listSystemErrata: ${a.systemUuid}`,
});

listTool("listSystemPackages", {
  kind: "systemPackages",
  description: "List the packages installed on a system, optionally only upgradable ones or with their errata.",
  input: {
    systemUuid: z.string().describe("System UUID"),
    upgradableOnly: z.boolean().optional().describe("Only packages with available updates"),
    withErrata: z.boolean().optional().describe("Include the advisories that apply to each package"),
    name: z.string().optional().describe("Only packages whose name matches"),
  },
  path: (a) => `/systems/${normalizeUuid(a.systemUuid, "system UUID")}/packages`,
  query: (a) => ({ upgradeable: a.upgradableOnly ? "true" : undefined, errata_detail: a.withErrata ? "true" : undefined, filter: a.name }),
  format: formatSystemPackages,
  label: (a) => `listSystemPackages: ${a.systemUuid}`,
});

listTool("listSystemPools", {
  kind: "systemPools",
  description: "List the subscription pools a system can attach entitlements from (pool ID, subscription, service level, availability).",
  input: { systemUuid: z.string().describe("System UUID") },
  path: (a) => `/systems/${normalizeUuid(a.systemUuid, "system UUID")}/pools`,
  format: formatPools,
  label: (a) => `listSystemPools: ${a.systemUuid}`,
});

server.registerTool(
  "removeSystem",
  {
    description: "Unregister a system: delete its profile from Red Hat Subscription Management and release its entitlements.",
    inputSchema: { systemUuid: z.string().describe("System UUID") },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ systemUuid }) => {
    const u = normalizeUuid(systemUuid, "system UUID");
    await apiRequest(`/systems/${u}`, { method: "DELETE" });
    return textResult(`Removed system ${u}.`);
  }
);

server.registerTool(
  "attachSystemEntitlement",
  {
    description: "Attach an entitlement from a pool (see listSystemPools) to a system. Not used on accounts with simple content access.",
    inputSchema: {
      systemUuid: z.string().describe("System UUID"),
      poolId: z.string().describe("Pool ID from listSystemPools"),
      quantity: z.number().int().positive().optional().describe("Quantity to attach"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ systemUuid, poolId, quantity }) => {
    const u = normalizeUuid(systemUuid, "system UUID");
    const data = await apiRequest(`/systems/${u}/entitlements`, { method: "POST", query: { pool: normalizeId(poolId, "pool ID"), quantity } });
    return textResult(`Attached an entitlement from pool ${poolId} to system ${u}.\n\n${formatSystem(data?.body || {})}`);
  }
);

server.registerTool(
  "removeSystemEntitlement",
  {
    description: "Remove an attached entitlement (ID from getSystem with include entitlements) from a system.",
    inputSchema: {
      systemUuid: z.string().describe("System UUID"),
      entitlementId: z.string().describe("Entitlement ID"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ systemUuid, entitlementId }) => {
    const u = normalizeUuid(systemUuid, "system UUID");
    const id = normalizeId(entitlementId, "entitlement ID");
    await apiRequest(`/systems/${u}/${id}`, { method: "DELETE" });
    return textResult(`Removed entitlement ${id} from system ${u}.`);
  }
);

// === Allocations ===

listTool("listAllocations", {
  kind: "allocations",
  description: "List subscription allocations (Satellite and SAM manifests).",
  input: { type: z.enum(["Satellite", "SAM"]).optional().describe("Only allocations of this type") },
  path: () => "/allocations",
  query: (a) => ({ type: a.type }),
  format: formatAllocations,
});

server.registerTool(
  "getAllocation",
  {
    description: "Get a subscription allocation (manifest), optionally with its attached entitlements.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      includeEntitlements: z.boolean().optional().default(true).describe("Include attached entitlements (default true)"),
      ...paginationSchema,
    },
    annotations: READ,
  },
  async ({ allocationUuid, includeEntitlements, offset, limit }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const data = await apiRequest(`/allocations/${u}`, { query: { include: includeEntitlements ? "entitlements" : undefined } });
    return textResult(paginate(formatAllocation(data?.body || {}), offset, limit, `getAllocation: ${u}`));
  }
);

server.registerTool(
  "listAllocationVersions",
  {
    description: "List the Satellite versions an allocation can be created for.",
    inputSchema: {},
    annotations: READ,
  },
  async () => textResult(formatAllocationVersions((await apiRequest("/allocations/versions"))?.body))
);

listTool("listAllocationPools", {
  kind: "allocationPools",
  description: "List the subscription pools an allocation can attach entitlements from.",
  input: {
    allocationUuid: z.string().describe("Allocation UUID"),
    includeFuture: z.boolean().optional().describe("Include future-dated pools (Satellite 6.3 and later)"),
  },
  path: (a) => `/allocations/${normalizeUuid(a.allocationUuid, "allocation UUID")}/pools`,
  query: (a) => ({ future: a.includeFuture ? "true" : undefined }),
  format: formatPools,
  label: (a) => `listAllocationPools: ${a.allocationUuid}`,
});

server.registerTool(
  "createAllocation",
  {
    description: "Create a Satellite subscription allocation (manifest). Without a version, the latest Satellite version is used (see listAllocationVersions).",
    inputSchema: {
      name: z.string().describe("Allocation name: under 100 letters, digits, periods, underscores, or hyphens"),
      version: z.string().optional().describe("Satellite version value from listAllocationVersions (e.g. 'sat-6.15')"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ name, version }) => {
    const data = await apiRequest("/allocations", { method: "POST", query: { Name: normalizeAllocationName(name), version } });
    return textResult(`Created allocation ${name}.\n\n${formatAllocation(data?.body || {})}`);
  }
);

server.registerTool(
  "updateAllocation",
  {
    description: "Turn simple content access on or off for a Satellite allocation (Satellite 6.3 and later); it is the only setting the API can change.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      simpleContentAccess: z.enum(["enabled", "disabled"]).describe("Simple content access setting"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, simpleContentAccess }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    await apiRequest(`/allocations/${u}`, { method: "PUT", body: { simpleContentAccess } });
    return textResult(`Set simple content access to ${simpleContentAccess} on allocation ${u}.`);
  }
);

server.registerTool(
  "removeAllocation",
  {
    description: "Delete a subscription allocation (manifest). This affects every host and activation key that uses it; confirm must be true.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      confirm: z.literal(true).describe("Must be true: deleting an allocation can break hosts and activation keys"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    await apiRequest(`/allocations/${u}`, { method: "DELETE", query: { force: "true" } });
    return textResult(`Removed allocation ${u}.`);
  }
);

server.registerTool(
  "attachAllocationEntitlement",
  {
    description: "Attach an entitlement from a pool (see listAllocationPools) to an allocation.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      poolId: z.string().describe("Pool ID from listAllocationPools"),
      quantity: z.number().int().positive().optional().describe("Quantity to attach"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ allocationUuid, poolId, quantity }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const data = await apiRequest(`/allocations/${u}/entitlements`, { method: "POST", query: { pool: normalizeId(poolId, "pool ID"), quantity } });
    return textResult(`Attached an entitlement from pool ${poolId} to allocation ${u}.\n\n${formatAllocation(data?.body || {})}`);
  }
);

server.registerTool(
  "updateAllocationEntitlement",
  {
    description: "Change the quantity of an entitlement attached to an allocation (no more than the pool allows).",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      entitlementId: z.string().describe("Entitlement ID from getAllocation"),
      quantity: z.number().int().positive().describe("New quantity"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, entitlementId, quantity }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const id = normalizeId(entitlementId, "entitlement ID");
    await apiRequest(`/allocations/${u}/entitlements/${id}`, { method: "PUT", query: { quantity } });
    return textResult(`Set entitlement ${id} on allocation ${u} to quantity ${quantity}.`);
  }
);

server.registerTool(
  "removeAllocationEntitlement",
  {
    description: "Remove an attached entitlement from an allocation.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      entitlementId: z.string().describe("Entitlement ID from getAllocation"),
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ allocationUuid, entitlementId }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const id = normalizeId(entitlementId, "entitlement ID");
    await apiRequest(`/allocations/${u}/entitlements/${id}`, { method: "DELETE" });
    return textResult(`Removed entitlement ${id} from allocation ${u}.`);
  }
);

server.registerTool(
  "exportAllocation",
  {
    description: "Start generating a manifest export for an allocation. Returns an export job ID for getExportJobStatus.",
    inputSchema: { allocationUuid: z.string().describe("Allocation UUID") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ allocationUuid }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const data = await apiRequest(`/allocations/${u}/export`);
    const job = data?.body?.exportJobID;
    return textResult(job ? `Started manifest export job ${job} for allocation ${u}. Check it with getExportJobStatus.` : `Export started: ${JSON.stringify(data?.body ?? data)}`);
  }
);

server.registerTool(
  "getExportJobStatus",
  {
    description: "Check a manifest export job. When it is done, returns the export ID for downloadAllocationExport.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      exportJobId: z.string().describe("Export job ID from exportAllocation"),
    },
    annotations: READ,
  },
  async ({ allocationUuid, exportJobId }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const data = await apiRequest(`/allocations/${u}/exportJob/${normalizeId(exportJobId, "export job ID")}`);
    const body = data?.body || {};
    if (body.exportID) return textResult(`Export ready: export ID ${body.exportID}. Download it once with downloadAllocationExport (the link is single-use).`);
    return textResult(`Export not ready yet${body.message ? `: ${body.message}` : ""}. Check again shortly.`);
  }
);

server.registerTool(
  "downloadAllocationExport",
  {
    description: "Download a finished manifest export (a zip, single-use) into the download directory (REDHAT_DOWNLOAD_DIR, default ~/redhat-downloads). Never overwrites a file unless overwrite is true.",
    inputSchema: {
      allocationUuid: z.string().describe("Allocation UUID"),
      exportId: z.string().describe("Export ID from getExportJobStatus"),
      outputPath: z.string().optional().describe("File path relative to the download directory (default manifest_<allocation>.zip)"),
      overwrite: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ allocationUuid, exportId, outputPath, overwrite }) => {
    const u = normalizeUuid(allocationUuid, "allocation UUID");
    const target = await resolveDownloadPath(`manifest_${u}.zip`, outputPath);
    const bytes = await saveApiResponse(`/allocations/${u}/export/${normalizeId(exportId, "export ID")}`, target, overwrite);
    return textResult(`Downloaded the manifest (${bytes} bytes) to ${target}`);
  }
);

// === Errata ===

server.registerTool(
  "listErrata",
  {
    description: "List the errata that affect at least one of the account's systems, with affected-system counts. Pages with maxResults and startAt; large output is paginated — call again with `offset`.",
    inputSchema: { ...pageSchema("errata"), ...paginationSchema },
    annotations: READ,
  },
  async ({ maxResults, startAt, offset, limit }) => {
    const q = pageQuery("errata", maxResults, startAt);
    try {
      const data = await apiRequest("/errata", { query: q });
      return textResult(paginate(formatMyErrata(data?.body || [], { limit: q.limit, startAt }), offset, limit, "listErrata"));
    } catch (err) {
      // The API answers 404 when no errata apply to any of the account's systems
      if (err instanceof ApiError && err.status === 404) return textResult("No errata apply to this account's systems (the API answered 404 Not Found).");
      throw err;
    }
  }
);

listTool("listErrataByContentSetArch", {
  kind: "errataByContentSet",
  description: "List the errata published in a content set for an architecture.",
  input: {
    contentSet: z.string().describe("Content set label (e.g. 'rhel-9-for-x86_64-baseos-rpms')"),
    arch: z.string().describe("Architecture (e.g. 'x86_64')"),
  },
  path: (a) => `/errata/cset/${normalizeContentSet(a.contentSet)}/arch/${normalizeArch(a.arch)}`,
  format: formatErrataInContentSet,
  label: (a) => `listErrataByContentSetArch: ${a.contentSet}/${a.arch}`,
});

server.registerTool(
  "getErratum",
  {
    description: "Get an advisory (RHSA, RHBA, RHEA): synopsis, severity, dates, CVEs, affected products, description, solution, bugs, and references. Large output is paginated — call again with `offset`.",
    inputSchema: { advisoryId: z.string().describe("Advisory ID (e.g. 'RHSA-2024:1234')"), ...paginationSchema },
    annotations: READ,
  },
  async ({ advisoryId, offset, limit }) => {
    const id = normalizeAdvisoryId(advisoryId);
    const data = await apiRequest(`/errata/${encodeURIComponent(id)}`);
    return textResult(paginate(formatErratum(data?.body || {}), offset, limit, `getErratum: ${id}`));
  }
);

server.registerTool(
  "listErratumImages",
  {
    description: "List the container images an advisory updates.",
    inputSchema: { advisoryId: z.string().describe("Advisory ID"), ...paginationSchema },
    annotations: READ,
  },
  async ({ advisoryId, offset, limit }) => {
    const id = normalizeAdvisoryId(advisoryId);
    const data = await apiRequest(`/errata/${encodeURIComponent(id)}/images`);
    return textResult(paginate(formatErratumImages(data?.body), offset, limit, `listErratumImages: ${id}`));
  }
);

listTool("listErratumPackages", {
  kind: "erratumPackages",
  description: "List the packages an advisory ships, with checksums and content sets.",
  input: { advisoryId: z.string().describe("Advisory ID") },
  path: (a) => `/errata/${encodeURIComponent(normalizeAdvisoryId(a.advisoryId))}/packages`,
  format: formatErratumPackages,
  label: (a) => `listErratumPackages: ${a.advisoryId}`,
});

server.registerTool(
  "listErratumSystems",
  {
    description: "List the account's systems an advisory applies to. Pages with maxResults and startAt; large output is paginated — call again with `offset`.",
    inputSchema: { advisoryId: z.string().describe("Advisory ID"), ...pageSchema("erratumSystems"), ...paginationSchema },
    annotations: READ,
  },
  async ({ advisoryId, maxResults, startAt, offset, limit }) => {
    const id = normalizeAdvisoryId(advisoryId);
    const q = pageQuery("erratumSystems", maxResults, startAt);
    try {
      const data = await apiRequest(`/errata/${encodeURIComponent(id)}/systems`, { query: q });
      return textResult(paginate(formatGeneric("Affected systems", data?.body || [], { limit: q.limit, startAt }), offset, limit, `listErratumSystems: ${id}`));
    } catch (err) {
      // The API answers 404 when the advisory applies to none of the account's systems
      if (err instanceof ApiError && err.status === 404) return textResult(`${id} applies to none of this account's systems (the API answered 404 Not Found).`);
      throw err;
    }
  }
);

// === Images ===

listTool("listImagesByContentSet", {
  kind: "imagesByContentSet",
  description: "List the downloadable images (ISOs, cloud images) in a content set.",
  input: { contentSet: z.string().describe("Content set label (e.g. 'rhel-9-for-x86_64-baseos-isos')") },
  path: (a) => `/images/cset/${normalizeContentSet(a.contentSet)}`,
  format: formatImages,
  label: (a) => `listImagesByContentSet: ${a.contentSet}`,
});

server.registerTool(
  "listImageDownloads",
  {
    description: "List the RHEL images (ISOs and others) for a version and architecture, with checksums for downloadImage.",
    inputSchema: {
      version: z.string().describe("RHEL version (e.g. '9.4')"),
      arch: z.string().describe("Architecture (e.g. 'x86_64')"),
      ...paginationSchema,
    },
    annotations: READ,
  },
  async ({ version, arch, offset, limit }) => {
    const v = normalizeRhelVersion(version);
    const a = normalizeArch(arch);
    const data = await apiRequest(`/images/rhel/${v}/${a}`);
    return textResult(paginate(formatImages(data?.body || [], { empty: `No RHEL ${v} images for ${a}.` }), offset, limit, `listImageDownloads: ${v}/${a}`));
  }
);

// Shared by downloadImage and downloadPackage: return the CDN link, or stream it into the download directory
async function linkOrSave(kind, checksum, { save, outputPath, overwrite }) {
  const c = normalizeChecksum(checksum);
  const link = await getDownloadLink(`/${kind}/${c}/download`);
  const fileName = decodeURIComponent(new URL(link).pathname.split("/").pop() || c);
  if (!save) {
    return textResult(`Download link for ${fileName} (short-lived; request a new one for each download):\n${link}\n\nVerify the file against SHA-256 ${c}. Pass save: true to have the server download it into ${downloadDir()}.`);
  }
  const target = await resolveDownloadPath(fileName, outputPath);
  const bytes = await saveLink(link, target, overwrite);
  return textResult(`Downloaded ${fileName} (${bytes} bytes) to ${target}. Verify it against SHA-256 ${c}.`);
}

const downloadInput = {
  checksum: z.string().describe("SHA-256 checksum from a listing"),
  save: z.boolean().optional().default(false).describe("Download the file into the download directory instead of returning the link"),
  outputPath: z.string().optional().describe("With save: file path relative to the download directory"),
  overwrite: z.boolean().optional().default(false).describe("With save: replace an existing file"),
};

server.registerTool(
  "downloadImage",
  {
    description: `Get a short-lived download link for an image by its SHA-256 checksum (from listImageDownloads or listImagesByContentSet). With save: true, streams the file into the download directory (REDHAT_DOWNLOAD_DIR, default ~/redhat-downloads); images can be several GB.`,
    inputSchema: downloadInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => linkOrSave("images", args.checksum, args)
);

// === Packages ===

listTool("listPackagesByContentSetArch", {
  kind: "packagesByContentSet",
  description: "List the packages in a content set for an architecture, with checksums for getPackage and downloadPackage. The API cannot search by name, and a content set holds thousands of packages in no particular order; to find a package's checksum, prefer listErratumPackages for the advisory that ships it.",
  input: {
    contentSet: z.string().describe("Content set label (e.g. 'rhel-9-for-x86_64-baseos-rpms')"),
    arch: z.string().describe("Architecture (e.g. 'x86_64')"),
    latestOnly: z.boolean().optional().describe("Only the latest version of each package"),
  },
  path: (a) => `/packages/cset/${normalizeContentSet(a.contentSet)}/arch/${normalizeArch(a.arch)}`,
  query: (a) => ({ filter: a.latestOnly ? "latest" : undefined }),
  format: formatPackagesInContentSet,
  label: (a) => `listPackagesByContentSetArch: ${a.contentSet}/${a.arch}`,
});

server.registerTool(
  "getPackage",
  {
    description: "Get a package by its SHA-256 checksum: version, summary, size, build, license, content sets, and description.",
    inputSchema: { checksum: z.string().describe("SHA-256 checksum") },
    annotations: READ,
  },
  async ({ checksum }) => textResult(formatPackage((await apiRequest(`/packages/${normalizeChecksum(checksum)}`))?.body || {}))
);

server.registerTool(
  "downloadPackage",
  {
    description: "Get a short-lived download link for a package by its SHA-256 checksum. With save: true, streams it into the download directory (REDHAT_DOWNLOAD_DIR, default ~/redhat-downloads).",
    inputSchema: downloadInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => linkOrSave("packages", args.checksum, args)
);

// === Cloud Access ===

server.registerTool(
  "listCloudAccessProviders",
  {
    description: "List the account's enabled Red Hat Cloud Access providers with their products, provider accounts, verification, and gold image status.",
    inputSchema: { ...paginationSchema },
    annotations: READ,
  },
  async ({ offset, limit }) => textResult(paginate(formatCloudProviders((await apiRequest("/cloud_access_providers/enabled"))?.body), offset, limit, "listCloudAccessProviders"))
);

const providerSchema = z.string().describe("Provider short name from listCloudAccessProviders (e.g. 'AWS', 'MSAZ', 'GCE')");
const accountIdSchema = z.string().describe("Cloud provider account ID");

server.registerTool(
  "addCloudProviderAccounts",
  {
    description: "Add up to 100 cloud provider accounts, with optional nicknames, to an enabled Cloud Access provider.",
    inputSchema: {
      providerShortName: providerSchema,
      accounts: z.array(z.object({
        id: z.string().describe("Cloud account ID"),
        nickname: z.string().optional().describe("Nickname"),
      })).min(1).max(100).describe("Accounts to add"),
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ providerShortName, accounts }) => {
    const p = normalizeProvider(providerShortName);
    const body = accounts.map((a) => ({ id: normalizeProviderAccountId(a.id), ...(a.nickname ? { nickname: a.nickname } : {}) }));
    await apiRequest(`/cloud_access_providers/${p}/accounts`, { method: "POST", body });
    return textResult(`Added ${body.length} account(s) to ${p}: ${body.map((a) => a.id).join(", ")}.`);
  }
);

server.registerTool(
  "updateCloudProviderAccount",
  {
    description: "Change the nickname of a Cloud Access provider account.",
    inputSchema: { providerShortName: providerSchema, accountId: accountIdSchema, nickname: z.string().min(1).describe("New nickname") },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName, accountId, nickname }) => {
    const p = normalizeProvider(providerShortName);
    const id = normalizeProviderAccountId(accountId);
    await apiRequest(`/cloud_access_providers/${p}/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: { nickname } });
    return textResult(`Renamed ${p} account ${id} to "${nickname}".`);
  }
);

server.registerTool(
  "updateCloudProviderAccountTenantId",
  {
    description: "Set the Azure tenant ID of a Microsoft Azure (MSAZ) Cloud Access account.",
    inputSchema: { accountId: accountIdSchema, tenantId: z.string().describe("Azure tenant ID (a UUID)") },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ accountId, tenantId }) => {
    const id = normalizeProviderAccountId(accountId);
    const tenant = normalizeUuid(tenantId, "tenant ID");
    await apiRequest(`/cloud_access_providers/MSAZ/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: { tenantId: tenant } });
    return textResult(`Set tenant ID ${tenant} on Azure account ${id} (unchanged if it was already set).`);
  }
);

server.registerTool(
  "removeCloudProviderAccount",
  {
    description: "Remove a cloud provider account from a Cloud Access provider, including its gold image access.",
    inputSchema: { providerShortName: providerSchema, accountId: accountIdSchema },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName, accountId }) => {
    const p = normalizeProvider(providerShortName);
    const id = normalizeProviderAccountId(accountId);
    await apiRequest(`/cloud_access_providers/${p}/accounts`, { method: "DELETE", body: { id } });
    return textResult(`Removed ${p} account ${id}.`);
  }
);

server.registerTool(
  "removeCloudProviderAccountBySourceId",
  {
    description: "Remove a Cloud Access provider account that was linked through Sources on console.redhat.com, by its source ID.",
    inputSchema: { sourceId: z.string().describe("Source ID from listCloudAccessProviders") },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ sourceId }) => {
    const id = normalizeId(sourceId, "source ID");
    await apiRequest("/cloud_access_providers/accounts", { method: "DELETE", query: { source_id: id } });
    return textResult(`Removed the provider account with source ID ${id}.`);
  }
);

server.registerTool(
  "verifyCloudProviderAccount",
  {
    description: "Verify a cloud provider account for RHSM auto-registration, using an instance identity document and signature from the cloud's metadata service (AWS: instance identity document and its RSA-2048 signature; Azure: attested data; GCP: identity JWT with audience https://subscription.rhsm.redhat.com:443/subscription and format=full).",
    inputSchema: {
      providerShortName: z.enum(["AWS", "AGOV", "ACN", "MSAZ", "GCE"]).describe("Provider short name"),
      accountId: accountIdSchema,
      identity: z.string().min(1).describe("Instance identity document (or the GCP identity token)"),
      signature: z.string().optional().describe("Signature of the identity document (not used for GCP)"),
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName, accountId, identity, signature }) => {
    const id = normalizeProviderAccountId(accountId);
    await apiRequest(`/cloud_access_providers/${providerShortName}/accounts/${encodeURIComponent(id)}/verification`, {
      method: "PUT",
      body: { identity, ...(signature ? { signature } : {}) },
    });
    return textResult(`Verified ${providerShortName} account ${id} for auto-registration.`);
  }
);

server.registerTool(
  "enableGoldImages",
  {
    description: "Request Red Hat Gold Image access for the provider's enabled products and accounts (see listCloudAccessProviders for status).",
    inputSchema: { providerShortName: providerSchema },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ providerShortName }) => {
    const p = normalizeProvider(providerShortName);
    await apiRequest(`/cloud_access_providers/${p}/goldimage`, { method: "POST", body: {} });
    return textResult(`Requested gold image access for ${p}. Status appears in listCloudAccessProviders.`);
  }
);

// === Organization ===

server.registerTool(
  "getOrganization",
  {
    description: "Get the account's organization: ID, simple content access status, and optionally the system purpose values (roles, service levels, usage) it allows.",
    inputSchema: { includeSystemPurpose: z.boolean().optional().default(false).describe("Include allowed system purpose values") },
    annotations: READ,
  },
  async ({ includeSystemPurpose }) => {
    const data = await apiRequest("/organization", { query: { include: includeSystemPurpose ? "systemPurposeAttributes" : undefined } });
    return textResult(formatOrganization(data?.body || {}));
  }
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
