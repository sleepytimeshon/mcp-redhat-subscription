// Red Hat Subscription Management API client, input validation, and Markdown formatters for
// mcp-redhat-subscription. Kept separate from src/index.js, which starts the stdio transport, so
// tests can import it.

import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TOKEN_URL = "https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token";
export const API_BASE = "https://api.access.redhat.com/management/v1";
const CLIENT_ID = "rhsm-api";

export const FETCH_TIMEOUT_MS = 30000;
export const TRANSFER_TIMEOUT_MS = 3600000;

// --- HTTP ---

export async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new Error(`Request to ${new URL(url).host} timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

// --- Authentication ---

let cachedToken = null;
let tokenExpiry = 0;

export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
}

export async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const offlineToken = process.env.REDHAT_TOKEN;
  if (!offlineToken) {
    throw new Error("REDHAT_TOKEN environment variable is required (Red Hat offline API token)");
  }

  const res = await fetchWithTimeout(TOKEN_URL, {
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
  if (!data.access_token) {
    throw new Error("Token exchange returned no access_token");
  }
  const lifetime = Number.isFinite(data.expires_in) ? data.expires_in : 300;
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + Math.max(lifetime - 60, 0) * 1000;
  return cachedToken;
}

// RHSM errors look like { "error": { "code": 404, "message": "Not Found" } }
function apiErrorText(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error ?? j;
    const parts = [e.message, e.detail, e.details, j.message].filter((x) => typeof x === "string" && x);
    if (parts.length) return [...new Set(parts)].join(": ");
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 500);
}

export class ApiError extends Error {
  constructor(status, message) {
    super(`Red Hat Subscription Management API error ${status}: ${message}`);
    this.status = status;
  }
}

// Send an authenticated request; retries once with a fresh access token on 401. Returns the raw
// Response (redirects are not followed, so a 307 to the CDN comes back as is).
async function send(path, { method = "GET", body, query, timeoutMs } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const attempt = async () => {
    const token = await getAccessToken();
    return fetchWithTimeout(url.href, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, timeoutMs);
  };
  let res = await attempt();
  if (res.status === 401) {
    clearTokenCache();
    res = await attempt();
  }
  return res;
}

// Call the API and return parsed JSON (null for an empty body)
export async function apiRequest(path, options = {}) {
  const res = await send(path, options);
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, apiErrorText(text) || res.statusText);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Request a download link: the API answers 307 with a short-lived CDN URL
export async function getDownloadLink(path) {
  const res = await send(path);
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    return new URL(location, API_BASE).href;
  }
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, apiErrorText(text) || res.statusText);
  try {
    const j = JSON.parse(text);
    const href = j?.body?.href || j?.href;
    if (href) return href;
  } catch {
    // fall through
  }
  throw new Error("The API returned no download link");
}

// --- Paging ---

// Per-endpoint maximum page sizes from the API reference; the API silently caps larger limits
export const PAGE_MAX = {
  subscriptions: 50,
  contentSets: 1000,
  subscriptionSystems: 100,
  systems: 100,
  systemErrata: 100,
  systemPackages: 1000,
  systemPools: 50,
  allocations: 100,
  allocationPools: 50,
  errata: 1000,
  errataByContentSet: 100,
  erratumPackages: 50,
  erratumSystems: 1000,
  imagesByContentSet: 100,
  packagesByContentSet: 100,
};

export function pageQuery(kind, maxResults, startAt) {
  const max = PAGE_MAX[kind];
  const limit = Math.min(maxResults ?? max, max);
  return { limit, offset: startAt ?? 0 };
}

// The API reports only the count on this page, never a total
export function pageNote(count, limit, startAt) {
  if (count > 0 && count >= limit) {
    return `\n\nThis page is full, so more results may exist: call again with startAt=${startAt + count}.`;
  }
  return "";
}

// Read pages until done or `cap` items, for lookups and filters the API does not offer
export async function collectPages(path, kind, { cap = 2000, query = {} } = {}) {
  const max = PAGE_MAX[kind];
  const items = [];
  for (let offset = 0; offset < cap; offset += max) {
    const page = await apiRequest(path, { query: { ...query, limit: max, offset } });
    const body = page?.body || [];
    items.push(...body);
    if (body.length < max) return { items, truncated: false };
  }
  return { items, truncated: true };
}

// --- Identifier validation ---

function check(value, pattern, what, example) {
  const v = String(value ?? "").trim();
  if (!pattern.test(v)) throw new Error(`Invalid ${what} "${value}": expected ${example}`);
  return v;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const normalizeUuid = (v, what = "UUID") => check(v, UUID, what, "a UUID such as 0f8fad5b-d9cb-469f-a165-70867728950e");
export const normalizeSubscriptionNumber = (v) => check(v, /^\d{1,20}$/, "subscription number", "digits only, e.g. 12345678");
export const normalizeId = (v, what) => check(v, /^[A-Za-z0-9_-]{4,64}$/, what, "an ID from a listing");
export const normalizeChecksum = (v) => check(v, /^[0-9a-fA-F]{64}$/, "SHA-256 checksum", "64 hexadecimal characters").toLowerCase();
export const normalizeContentSet = (v) => check(v, /^[A-Za-z0-9][A-Za-z0-9._+-]{1,200}$/, "content set label", "a label such as rhel-9-for-x86_64-baseos-rpms");
export const normalizeArch = (v) => check(v, /^[A-Za-z0-9_]{2,20}$/, "architecture", "x86_64, aarch64, ppc64le, or s390x");
export const normalizeRhelVersion = (v) => check(v, /^\d{1,2}(\.\d{1,2})?$/, "RHEL version", "e.g. 9.4 or 10.0");
export const normalizeProvider = (v) => check(v, /^[A-Za-z]{2,10}$/, "provider short name", "e.g. AWS, MSAZ, GCE (see listCloudAccessProviders)").toUpperCase();
export const normalizeProviderAccountId = (v) => check(v, /^[A-Za-z0-9._:@-]{1,128}$/, "provider account ID", "the cloud account ID");
export const normalizeAllocationName = (v) => check(v, /^[A-Za-z0-9._-]{1,99}$/, "allocation name", "under 100 letters, digits, periods, underscores, or hyphens");

export function normalizeAdvisoryId(input) {
  return check(String(input ?? "").toUpperCase(), /^RH[SBE]A-\d{4}:\d{4,}$/, "advisory ID", "RHSA-, RHBA-, or RHEA- followed by YYYY:NNNN (e.g. RHSA-2024:1234)");
}

// --- Local files for downloads ---

// Downloads are written only under one directory, never overwriting unless asked
export function downloadDir() {
  return resolve(process.env.REDHAT_DOWNLOAD_DIR || join(homedir(), "redhat-downloads"));
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveDownloadPath(defaultName, outputPath) {
  const root = downloadDir();
  const safeName = basename(String(defaultName || "download")).replace(/[\0/\\]/g, "_") || "download";
  const target = resolve(root, outputPath || safeName);
  if (!inside(root, target)) {
    throw new Error(`Refusing to write ${target}: downloads go under ${root} (set REDHAT_DOWNLOAD_DIR to change it).`);
  }
  await mkdir(dirname(target), { recursive: true });
  const [realParent, realRoot] = await Promise.all([realpath(dirname(target)), realpath(root)]);
  if (!inside(realRoot, realParent)) {
    throw new Error(`Refusing to write ${target}: its directory resolves outside ${root}.`);
  }
  return target;
}

export async function writeResponseToFile(res, target, overwrite) {
  const handle = await open(target, overwrite ? "w" : "wx").catch((err) => {
    if (err.code === "EEXIST") throw new Error(`${target} already exists; pass overwrite: true to replace it`);
    throw err;
  });
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk);
      bytes += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

// Stream a CDN link to a file. The link carries its own authorization; never send the token.
export async function saveLink(url, target, overwrite) {
  if (!/^https:\/\//.test(url)) throw new Error("Refusing a non-HTTPS download link");
  const res = await fetchWithTimeout(url, {}, TRANSFER_TIMEOUT_MS);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  return writeResponseToFile(res, target, overwrite);
}

// Stream an authenticated API response (the allocation manifest zip) to a file
export async function saveApiResponse(path, target, overwrite) {
  const res = await send(path, { timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, apiErrorText(text) || res.statusText);
  }
  return writeResponseToFile(res, target, overwrite);
}

// --- Formatting helpers ---

const present = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const cell = (v) => oneLine(v).replace(/\|/g, "\\|");
export const date = (v) => (v ? String(v).replace(/T00:00:00(\.0+)?Z$/, "").replace(/\.\d{3}(?=Z)/, "").replace("T", " ").replace(/Z$/, " UTC") : "");

export function table(headers, rows) {
  if (!rows.length) return "";
  return `| ${headers.join(" | ")} |\n|${" --- |".repeat(headers.length)}\n${rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n")}`;
}

function fields(pairs) {
  return pairs.filter(([, v]) => present(v)).map(([k, v]) => `**${k}:** ${v === true ? "yes" : v === false ? "no" : v}`).join("\n");
}

function listing(title, headers, rows, { empty, limit, startAt = 0, footer = "" } = {}) {
  if (!rows.length) return empty || `No ${title.toLowerCase()} found.`;
  const range = startAt ? ` (from #${startAt + 1})` : "";
  return `## ${title}${range}: ${rows.length}\n\n${table(headers, rows)}${limit ? pageNote(rows.length, limit, startAt) : ""}${footer}`;
}

const nevra = (p) => `${p.name}-${p.epoch && String(p.epoch) !== "0" ? `${p.epoch}:` : ""}${p.version}-${p.release}${p.arch ? `.${p.arch}` : ""}`;

// --- Subscriptions ---

export function formatSubscriptions(items, opts) {
  return listing("Subscriptions", ["Number", "Name", "SKU", "Quantity", "Status", "Start", "End", "Pools (consumed/quantity)"],
    items.map((s) => [s.subscriptionNumber, s.subscriptionName, s.sku, s.quantity, s.status, date(s.startDate), date(s.endDate),
      (s.pools || []).map((p) => `${p.consumed ?? 0}/${p.quantity ?? "?"}${p.type ? ` ${p.type}` : ""}`).join(", ")]),
    { ...opts, footer: "\n\nUse listSubscriptionSystems or listSubscriptionContentSets with a subscription number for more." });
}

export function formatSubscription(s) {
  return [
    `# Subscription ${s.subscriptionNumber}: ${oneLine(s.subscriptionName)}`,
    fields([["SKU", s.sku], ["Contract", s.contractNumber], ["Quantity", s.quantity], ["Status", s.status], ["Start", date(s.startDate)], ["End", date(s.endDate)]]),
    s.pools?.length ? `\n## Pools\n\n${table(["Pool ID", "Type", "Consumed", "Quantity"], s.pools.map((p) => [p.id, p.type, p.consumed, p.quantity]))}` : "",
  ].filter(Boolean).join("\n");
}

export function formatContentSets(items, opts) {
  return listing("Content sets", ["Label", "Name", "Type", "Arch", "Enabled"],
    items.map((c) => [c.label, c.name, c.type, c.arch, c.enabled ? "yes" : "no"]), opts);
}

export function formatSubscriptionSystems(items, opts) {
  return listing("Systems using the subscription", ["Name", "UUID", "Type", "Compliance", "Entitlements", "Last check-in"],
    items.map((s) => [s.systemName, s.uuid, s.type, s.complianceStatus, s.totalEntitlementQuantity, date(s.lastCheckin)]), opts);
}

// --- Systems ---

const errataCounts = (c) => (c ? `${c.securityCount ?? 0} security, ${c.bugfixCount ?? 0} bug fix, ${c.enhancementCount ?? 0} enhancement` : "");

export function formatSystems(items, opts) {
  return listing("Systems", ["Name", "UUID", "Hostname", "Type", "Entitlement status", "Entitlements", "Errata (sec/bug/enh)", "Last check-in", "Registered by"],
    items.map((s) => [s.name, s.uuid, s.hostname, s.type, s.entitlementStatus, s.entitlementCount,
      s.errataCounts ? `${s.errataCounts.securityCount ?? 0}/${s.errataCounts.bugfixCount ?? 0}/${s.errataCounts.enhancementCount ?? 0}` : "",
      date(s.lastCheckin), s.username]),
    { ...opts, footer: "\n\nUse getSystem with a UUID for details." });
}

// Facts arrive as a key/value object (or a list of { key, value }); filter by key substring
function factList(facts, filter) {
  const entries = Array.isArray(facts) ? facts.map((f) => [f.key, f.value]) : Object.entries(facts || {});
  const f = filter?.toLowerCase();
  return entries.filter(([k]) => !f || String(k).toLowerCase().includes(f)).sort(([a], [b]) => String(a).localeCompare(String(b)));
}

export function formatSystem(s, { factsFilter } = {}) {
  const parts = [`# System ${oneLine(s.name)}`];
  const counts = s.errataApplicabilityCounts?.value;
  parts.push(fields([
    ["UUID", s.uuid], ["Hostname", s.hostname], ["Type", s.type], ["Entitlement status", s.entitlementStatus],
    ["Compliance", s.complianceStatus], ["Service level", s.serviceLevelPreference], ["Auto-attach", s.autoAttachSetting],
    ["Registered", [date(s.createdDate), s.createdBy && `by ${s.createdBy}`].filter(Boolean).join(" ")],
    ["Last check-in", date(s.lastCheckin)], ["Applicable errata", errataCounts(counts)],
    ["Installed products", s.installedProductsCount], ["Entitlements attached", s.entitlementsAttachedCount], ["Facts", s.factsCount],
  ]));

  const products = Array.isArray(s.installedProducts) ? s.installedProducts : s.installedProducts ? [s.installedProducts] : [];
  if (products.length) {
    parts.push(`\n## Installed products\n\n${table(["Product", "ID", "Version", "Arch", "Status"], products.map((p) => [p.productName, p.productID, p.version, p.arch, p.status]))}`);
  }
  const ents = s.entitlementsAttached?.value || [];
  if (ents.length) {
    parts.push(`\n## Attached entitlements\n\n${table(["Entitlement ID", "Subscription", "SKU", "Contract", "Quantity", "Start", "End"], ents.map((e) => [e.id, e.subscriptionName, e.sku, e.contractNumber, e.entitlementQuantity, date(e.startDate), date(e.endDate)]))}`);
  } else if (s.entitlementsAttached && s.entitlementsAttached.valid === false && s.entitlementsAttached.reason) {
    parts.push(`\n> Entitlements not available: ${s.entitlementsAttached.reason}`);
  }
  if (s.facts) {
    const facts = factList(s.facts, factsFilter);
    parts.push(`\n## Facts${factsFilter ? ` matching "${factsFilter}"` : ""} (${facts.length})\n\n${facts.map(([k, v]) => `- ${k}: ${oneLine(v)}`).join("\n") || "None."}`);
  }
  return parts.join("\n");
}

export function formatSystemErrata(items, opts) {
  return listing("Applicable errata", ["Advisory", "Type", "Severity", "Synopsis", "Published"],
    items.map((e) => [e.id, e.type, e.severity, e.synopsis, date(e.published)]), { ...opts, empty: "No errata apply to this system." });
}

export function formatSystemPackages(items, opts) {
  return listing("Packages", ["Package", "Errata", "Advisories"],
    items.map((p) => [nevra(p), p.errataCount ?? "", (p.advisories || []).map((a) => a?.id || a?.advisoryId || a).filter((x) => typeof x === "string").join(", ")]), opts);
}

export function formatPools(items, opts) {
  return listing("Available pools", ["Pool ID", "Subscription", "Number", "SKU", "Contract", "Service level", "Available", "Start", "End"],
    items.map((p) => [p.id, p.subscriptionName, p.subscriptionNumber, p.sku, p.contractNumber, p.serviceLevel, p.entitlementsAvailable, date(p.startDate), date(p.endDate)]), opts);
}

// --- Allocations ---

export function formatAllocations(items, opts) {
  return listing("Allocations", ["Name", "UUID", "Type", "Version", "Content access", "Entitlements", "Created", "By"],
    items.map((a) => [a.name, a.uuid, a.type, a.version, a.contentAccessMode || a.simpleContentAccess, a.entitlementsAttachedQuantity ?? a.entitlementQuantity, date(a.createdDate), a.createdBy]),
    { ...opts, empty: "No subscription allocations (manifests) on this account." });
}

export function formatAllocation(a) {
  const parts = [`# Allocation ${oneLine(a.name)}`, fields([
    ["UUID", a.uuid], ["Type", a.type], ["Version", a.version], ["Simple content access", a.simpleContentAccess || a.contentAccessMode],
    ["Entitlements attached", a.entitlementsAttachedQuantity ?? a.entitlementQuantity], ["Created", [date(a.createdDate), a.createdBy && `by ${a.createdBy}`].filter(Boolean).join(" ")],
    ["Last modified", date(a.lastModified)],
  ])];
  const ents = a.entitlementsAttached?.value || [];
  if (ents.length) {
    parts.push(`\n## Attached entitlements\n\n${table(["Entitlement ID", "Subscription", "SKU", "Contract", "Quantity", "Start", "End"], ents.map((e) => [e.id, e.subscriptionName, e.sku, e.contractNumber, e.entitlementQuantity, date(e.startDate), date(e.endDate)]))}`);
  }
  return parts.join("\n");
}

export function formatAllocationVersions(items) {
  if (!items?.length) return "No Satellite versions listed.";
  return `## Satellite versions for allocations (${items.length})\n\n${items.map((v) => `- \`${v.value}\`${v.description ? `: ${v.description}` : ""}`).join("\n")}\n\nPass the value as createAllocation's version.`;
}

// --- Errata ---

export function formatMyErrata(items, opts) {
  return listing("Errata affecting your systems", ["Advisory", "Type", "Synopsis", "Affected systems", "Published"],
    items.map((e) => [e.advisoryId, e.type, e.synopsis, e.affectedSystemCount, date(e.publishDate)]), { ...opts, footer: "\n\nUse getErratum with an advisory ID for details." });
}

export function formatErrataInContentSet(items, opts) {
  return listing("Errata", ["Advisory", "Type", "Severity", "Synopsis", "Published"],
    items.map((e) => [e.advisoryId, e.type, e.severity, e.synopsis, date(e.publishDate)]), opts);
}

export function formatErratum(e) {
  const refs = (list) => (list || []).map((r) => `- ${r.href ? `[${oneLine(r.title || r.id)}](${r.href})` : oneLine(r.title || r.id)}${r.type ? ` (${r.type})` : ""}`).join("\n");
  const cves = Array.isArray(e.cves) ? e.cves.join(", ") : oneLine(e.cves);
  return [
    `# ${e.id}: ${oneLine(e.synopsis)}`,
    fields([["Type", e.typeSeverity || e.type], ["Severity", e.severity], ["Issued", date(e.issued)], ["Updated", date(e.lastUpdated)], ["CVEs", cves], ["Affected products", (e.affectedProducts || []).join(", ")]]),
    e.summary ? `\n## Summary\n\n${e.summary.trim()}` : "",
    e.description ? `\n## Description\n\n${e.description.trim()}` : "",
    e.solution ? `\n## Solution\n\n${e.solution.trim()}` : "",
    e.bugzillas?.length ? `\n## Bugs\n\n${refs(e.bugzillas)}` : "",
    e.references?.length ? `\n## References\n\n${refs(e.references)}` : "",
  ].filter(Boolean).join("\n");
}

export function formatErratumPackages(items, opts) {
  return listing("Packages in the advisory", ["File", "Arch", "Checksum", "Content sets"],
    items.map((p) => [p.filename || nevra(p), p.arch, p.checksum, (p.contentSets || []).join(", ")]), opts);
}

// The reference does not describe this listing; show whatever scalar fields it has
export function formatGeneric(title, items, opts) {
  if (!items?.length) return opts?.empty || `No ${title.toLowerCase()} found.`;
  const keys = [...new Set(items.flatMap((i) => Object.keys(i || {})))].filter((k) => items.some((i) => present(i?.[k]) && typeof i[k] !== "object"));
  return listing(title, keys, items.map((i) => keys.map((k) => i?.[k])), opts);
}

export function formatErratumImages(items) {
  if (!items?.length) return "No container images are updated by this advisory.";
  return `## Updated container images (${items.length})\n\n${table(["Image", "Architecture", "Digest"], items.map((i) => [i.imagePlusDigest || i.name, i.architecture, i.digest]))}`;
}

// --- Images and packages ---

export function formatImages(items, opts) {
  return listing("Images", ["Image", "File", "Arch", "Published", "Checksum"],
    items.map((i) => [i.imageName, i.filename, i.arch, date(i.datePublished), i.checksum]), { ...opts, footer: "\n\nUse downloadImage with a checksum to get a download link." });
}

export function formatPackagesInContentSet(items, opts) {
  return listing("Packages", ["Package", "Checksum"], items.map((p) => [nevra(p), p.checksum]), { ...opts, footer: "\n\nUse getPackage or downloadPackage with a checksum." });
}

export function formatPackage(p) {
  return [
    `# ${nevra(p)}`,
    fields([["Summary", p.summary], ["Checksum (SHA-256)", p.checksum], ["Size", p.size != null ? `${p.size} bytes` : ""], ["Built", [date(p.buildDate), p.buildHost && `on ${p.buildHost}`].filter(Boolean).join(" ")], ["License", p.license], ["Group", p.group], ["Content sets", (p.contentSets || []).join(", ")]]),
    p.description ? `\n## Description\n\n${p.description.trim()}` : "",
  ].filter(Boolean).join("\n");
}

// --- Cloud access and organization ---

export function formatCloudProviders(items) {
  if (!items?.length) return "No cloud access providers are enabled for this account.";
  return items.map((p) => {
    const products = (p.products || []).map((x) => [x.name, x.sku, x.enabledQuantity, x.totalQuantity, x.nextRenewal, (x.imageGroups || []).join(", ")]);
    const accounts = (p.accounts || []).map((a) => [a.id, a.nickname, date(a.dateAdded), a.verified === undefined ? "" : a.verified ? "yes" : "no", a.tenantId, a.sourceId,
      (a.goldImageStatus || []).map((g) => `${g.name}: ${g.status}`).join(", ")]);
    return [
      `## ${p.name} (\`${p.shortName}\`)`,
      products.length ? `\n### Products\n\n${table(["Product", "SKU", "Enabled", "Total", "Next renewal", "Image groups"], products)}` : "",
      `\n### Accounts (${accounts.length})\n\n${accounts.length ? table(["Account ID", "Nickname", "Added", "Verified", "Tenant ID", "Source ID", "Gold images"], accounts) : "None."}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

export function formatOrganization(o) {
  const purpose = o.systemPurposeAttributes;
  return [
    "# Organization",
    fields([["ID", o.id], ["Simple content access", o.simpleContentAccess], ["Simple content access capable", o.simpleContentAccessCapable]]),
    purpose ? `\n## System purpose values\n\n${fields([["Roles", (purpose.roles || []).join(", ")], ["Service levels", (purpose.serviceLevel || []).join(", ")], ["Usage", (purpose.usage || []).join(", ")]])}` : "",
  ].filter(Boolean).join("\n");
}

// --- Character pagination ---

export const DEFAULT_CHUNK = 30000;

export function paginate(text, offset, limit, label) {
  const total = text.length;
  const start = Math.min(offset, total);
  const end = Math.min(start + limit, total);
  const slice = text.slice(start, end);
  const header = `# ${label}\n# chars ${start}-${end} of ${total}\n\n`;
  let footer = "";
  if (end < total) {
    footer = `\n\n[truncated: showing chars ${start}-${end} of ${total}. Call again with offset=${end} for the next chunk.]`;
  } else if (offset > 0 && offset >= total) {
    footer = `[offset ${offset} is past the end of the ${total}-character response. Call again with a smaller offset.]`;
  }
  return `${header}${slice}${footer}`;
}
