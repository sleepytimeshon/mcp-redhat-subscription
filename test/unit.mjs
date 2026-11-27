#!/usr/bin/env node
// Offline tests of src/lib.js: validation, paging, the API client, download links and file
// safety, and the Markdown formatters, with a stubbed fetch and synthetic data. Never put real
// account data (subscriptions, systems, facts) in these fixtures.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as lib from "../src/lib.js";

const realFetch = globalThis.fetch;
const realEnv = { token: process.env.REDHAT_TOKEN, dir: process.env.REDHAT_DOWNLOAD_DIR };
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "subscription-test-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.REDHAT_TOKEN = "offline";
  process.env.REDHAT_DOWNLOAD_DIR = join(dir, "downloads");
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of [["REDHAT_TOKEN", realEnv.token], ["REDHAT_DOWNLOAD_DIR", realEnv.dir]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  lib.clearTokenCache();
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(handler) {
  const calls = [];
  let issued = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === lib.TOKEN_URL) {
      issued += 1;
      return json({ access_token: `access-${issued}`, expires_in: 900 });
    }
    return handler(u, init);
  };
  return calls;
}

describe("validation", () => {
  it("accepts well-formed identifiers and rejects path tricks", () => {
    assert.equal(lib.normalizeUuid("0F8FAD5B-D9CB-469F-A165-70867728950E"), "0F8FAD5B-D9CB-469F-A165-70867728950E");
    assert.throws(() => lib.normalizeUuid("../x", "system UUID"), /Invalid system UUID/);
    assert.equal(lib.normalizeChecksum("A".repeat(64)), "a".repeat(64));
    assert.throws(() => lib.normalizeChecksum("abc"), /Invalid SHA-256 checksum/);
    assert.equal(lib.normalizeAdvisoryId(" rhsa-2024:3138 ".trim()), "RHSA-2024:3138");
    assert.throws(() => lib.normalizeAdvisoryId("RHSA-2024-3138"), /Invalid advisory ID/);
    assert.equal(lib.normalizeContentSet("rhel-9-for-x86_64-baseos-rpms"), "rhel-9-for-x86_64-baseos-rpms");
    assert.throws(() => lib.normalizeContentSet("a/../b"), /Invalid content set/);
    assert.throws(() => lib.normalizeArch("x86/64"), /Invalid architecture/);
    assert.equal(lib.normalizeProvider("msaz"), "MSAZ");
    assert.throws(() => lib.normalizeAllocationName("bad name"), /Invalid allocation name/);
    assert.throws(() => lib.normalizeSubscriptionNumber("12a"), /Invalid subscription number/);
  });
});

describe("paging", () => {
  it("caps page sizes at each endpoint's API maximum", () => {
    assert.deepEqual(lib.pageQuery("subscriptions", undefined, 0), { limit: 50, offset: 0 });
    assert.deepEqual(lib.pageQuery("subscriptions", 500, 100), { limit: 50, offset: 100 });
    assert.deepEqual(lib.pageQuery("systems", 10, 0), { limit: 10, offset: 0 });
  });

  it("says more results may exist only when a page is full", () => {
    assert.match(lib.pageNote(50, 50, 0), /more results may exist: call again with startAt=50/);
    assert.equal(lib.pageNote(6, 50, 50), "");
    assert.equal(lib.pageNote(0, 50, 0), "");
  });

  it("collects pages until a short one", async () => {
    const calls = stubFetch((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      return json({ pagination: {}, body: offset === 0 ? Array(50).fill({ n: 1 }) : [{ n: 2 }] });
    });
    const { items, truncated } = await lib.collectPages("/subscriptions", "subscriptions");
    assert.equal(items.length, 51);
    assert.equal(truncated, false);
    assert.equal(calls.filter((c) => c.url.includes("/subscriptions")).length, 2);
  });
});

describe("apiRequest", () => {
  it("sends the token and query, retries once on 401, and parses errors", async () => {
    let first = true;
    const calls = stubFetch(() => {
      if (first) { first = false; return json({ error: { code: 401, message: "expired" } }, 401); }
      return json({ body: { ok: 1 } });
    });
    assert.deepEqual(await lib.apiRequest("/systems/x", { query: { include: "facts", empty: "" } }), { body: { ok: 1 } });
    assert.equal(calls.at(-1).url, `${lib.API_BASE}/systems/x?include=facts`);
    assert.equal(calls.at(-1).init.headers.Authorization, "Bearer access-2");
    assert.equal(calls.at(-1).init.redirect, "manual");

    stubFetch(() => json({ error: { code: 404, message: "Not Found" } }, 404));
    await assert.rejects(lib.apiRequest("/errata"), (err) => err instanceof lib.ApiError && err.status === 404 && /error 404: Not Found$/.test(err.message));
  });

  it("needs REDHAT_TOKEN", async () => {
    delete process.env.REDHAT_TOKEN;
    await assert.rejects(lib.apiRequest("/systems"), /REDHAT_TOKEN environment variable is required/);
  });
});

describe("downloads", () => {
  const sha = "b".repeat(64);

  it("returns the CDN redirect without following it", async () => {
    const calls = stubFetch(() => new Response(null, { status: 307, headers: { Location: "https://access.cdn.redhat.com/content/rhel.iso?sig=1" } }));
    assert.equal(await lib.getDownloadLink(`/images/${sha}/download`), "https://access.cdn.redhat.com/content/rhel.iso?sig=1");
    assert.equal(calls.filter((c) => c.url.startsWith("https://access.cdn")).length, 0);
  });

  it("streams a link to a new file without the Red Hat token and never overwrites by default", async () => {
    const calls = stubFetch(() => new Response("iso-bytes"));
    const target = await lib.resolveDownloadPath("rhel.iso");
    assert.equal(target, join(process.env.REDHAT_DOWNLOAD_DIR, "rhel.iso"));
    assert.equal(await lib.saveLink("https://access.cdn.redhat.com/rhel.iso", target, false), 9);
    assert.equal(await readFile(target, "utf8"), "iso-bytes");
    assert.equal(calls[0].init.headers?.Authorization, undefined);
    await assert.rejects(lib.saveLink("https://access.cdn.redhat.com/rhel.iso", target, false), /already exists; pass overwrite: true/);
    await assert.rejects(lib.saveLink("http://access.cdn.redhat.com/rhel.iso", target, true), /non-HTTPS/);
  });

  it("keeps downloads inside the download directory", async () => {
    const root = process.env.REDHAT_DOWNLOAD_DIR;
    assert.equal(await lib.resolveDownloadPath("../../evil.zip"), join(root, "evil.zip"));
    await assert.rejects(lib.resolveDownloadPath("x", "../../escape"), /Refusing to write/);
    await mkdir(root, { recursive: true });
    await symlink(dir, join(root, "link-out"));
    await assert.rejects(lib.resolveDownloadPath("x", "link-out/file"), /resolves outside/);
  });

  it("streams an authenticated API response (manifest zip) to a file", async () => {
    stubFetch(() => new Response("PK\u0003\u0004zip"));
    const target = await lib.resolveDownloadPath("manifest.zip");
    assert.equal(await lib.saveApiResponse("/allocations/u/export/e", target, false), 7);
  });
});

describe("formatters", () => {
  it("formats subscriptions with pool usage and a next-page hint", () => {
    const subs = [{ subscriptionNumber: "123", subscriptionName: "Example Premium", sku: "RH00001", quantity: 10, status: "Active", startDate: "2026-01-01T00:00:00.000Z", endDate: "2027-01-01T00:00:00.000Z", pools: [{ id: "p1", consumed: 2, quantity: 10, type: "NORMAL" }] }];
    const out = lib.formatSubscriptions(subs, { limit: 1, startAt: 0 });
    assert.match(out, /^## Subscriptions: 1\n\n\| Number \| Name \| SKU/);
    assert.match(out, /\| 123 \| Example Premium \| RH00001 \| 10 \| Active \| 2026-01-01 \| 2027-01-01 \| 2\/10 NORMAL \|/);
    assert.match(out, /startAt=1/);
    assert.match(lib.formatSubscription(subs[0]), /^# Subscription 123: Example Premium\n\*\*SKU:\*\* RH00001[\s\S]*## Pools/);
  });

  it("formats a system with counts, products, and filtered facts", () => {
    const out = lib.formatSystem({
      name: "host1", uuid: "u", type: "RHEL", entitlementStatus: "valid", autoAttachSetting: false,
      errataApplicabilityCounts: { valid: true, value: { securityCount: 2, bugfixCount: 1, enhancementCount: 0 } },
      installedProducts: [{ productName: "Red Hat Enterprise Linux for x86_64", productID: "479", version: "9.4", arch: "x86_64", status: "subscribed" }],
      entitlementsAttached: { valid: false, reason: "No Entitlements are attached to the System" },
      facts: { "memory.memtotal": "16000000", "cpu.cpu_socket(s)": "2", "memory.swaptotal": "0" },
    }, { factsFilter: "memory" });
    assert.match(out, /\*\*Auto-attach:\*\* no/);
    assert.match(out, /\*\*Applicable errata:\*\* 2 security, 1 bug fix, 0 enhancement/);
    assert.match(out, /\| Red Hat Enterprise Linux for x86_64 \| 479 \| 9\.4 \| x86_64 \| subscribed \|/);
    assert.match(out, /> Entitlements not available: No Entitlements are attached/);
    assert.match(out, /## Facts matching "memory" \(2\)\n\n- memory\.memtotal: 16000000\n- memory\.swaptotal: 0$/);
  });

  it("formats an erratum, cloud providers, and versions", () => {
    const e = lib.formatErratum({ id: "RHSA-2024:1", synopsis: "Important: kernel update", severity: "Important", cves: "CVE-2024-1 CVE-2024-2", issued: "2024-05-22T00:00:00Z", affectedProducts: ["RHEL 9"], references: [{ href: "https://example.com/a", title: "Ref", type: "self" }] });
    assert.match(e, /^# RHSA-2024:1: Important: kernel update\n\*\*Severity:\*\* Important\n\*\*Issued:\*\* 2024-05-22\n\*\*CVEs:\*\* CVE-2024-1 CVE-2024-2/);
    assert.match(e, /## References\n\n- \[Ref\]\(https:\/\/example\.com\/a\) \(self\)/);
    const cloud = lib.formatCloudProviders([{ shortName: "AWS", name: "Amazon Web Services", products: [{ name: "RHEL", sku: "S1", enabledQuantity: 1, totalQuantity: 2 }], accounts: [{ id: "123456789012", nickname: "prod", verified: true, goldImageStatus: [{ name: "rhel", status: "Granted" }] }] }]);
    assert.match(cloud, /## Amazon Web Services \(`AWS`\)[\s\S]*### Accounts \(1\)[\s\S]*\| 123456789012 \| prod \|  \| yes \|  \|  \| rhel: Granted \|/);
    assert.equal(lib.formatCloudProviders([]), "No cloud access providers are enabled for this account.");
    assert.match(lib.formatAllocationVersions([{ value: "sat-6.15", description: "Satellite 6.15" }]), /- `sat-6\.15`: Satellite 6\.15/);
  });

  it("escapes table cells and formats package versions", () => {
    const out = lib.formatPackagesInContentSet([{ name: "a|b", epoch: "1", version: "2", release: "3.el9", arch: "x86_64", checksum: "c" }], {});
    assert.match(out, /\| a\\\|b-1:2-3\.el9\.x86_64 \| c \|/);
  });

  it("paginates by characters", () => {
    assert.match(lib.paginate("abcdef", 0, 4, "t"), /\[truncated: showing chars 0-4 of 6\. Call again with offset=4/);
  });
});
