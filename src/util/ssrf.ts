/**
 * Shared SSRF protection utilities.
 *
 * Used by fetch_url, skill_install, and anywhere else that fetches external URLs.
 */

import dns from "node:dns";
import { lookup } from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

/**
 * Check if a resolved IP address is private or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  try {
    return ipaddr.process(ip).range() !== "unicast";
  } catch {
    return true;
  }
}

/**
 * Check if a URL's hostname is obviously private (fast, pre-DNS check).
 */
export function isPrivateHostname(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (isInternalHostname(hostname)) return true;
    // If hostname is an IP literal, check it directly.
    const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
    if (net.isIP(unbracketed)) return isPrivateIp(unbracketed);
    return false;
  } catch {
    return true; // Invalid URLs are treated as private
  }
}

export interface SafePublicUrl {
  normalizedUrl: string;
  hostname: string;
  addresses: string[];
}

export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".corp") ||
    host.endsWith(".lan")
  );
}

/** Cancel waiting for DNS without allowing a late resolver completion to start a request. */
export function lookupWithSignal(hostname: string, signal?: AbortSignal): Promise<dns.LookupAddress[]> {
  if (!signal) {
    return lookup(hostname, { all: true });
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    lookup(hostname, { all: true }).then((addresses) => {
      signal.removeEventListener("abort", abort);
      resolve(addresses);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}
export async function assertSafePublicUrl(rawUrl: string, requireHttps = true, signal?: AbortSignal): Promise<SafePublicUrl> {
  if (rawUrl.length > 2048) {
    throw new Error("URL is too long.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (requireHttps && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${parsed.protocol || "missing"}. Use HTTPS URLs only.`);
  }
  if (!requireHttps && parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Blocked URL scheme: ${parsed.protocol || "missing"}. Use HTTP or HTTPS URLs only.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are blocked.");
  }
  if (!parsed.hostname) {
    throw new Error("URL is missing a hostname.");
  }

  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isInternalHostname(hostname)) {
    throw new Error(`Blocked internal hostname: ${hostname}`);
  }

  const literalVersion = net.isIP(hostname);
  if (literalVersion && isPrivateIp(hostname)) {
    throw new Error(`Blocked non-public IP address: ${hostname}`);
  }

  const records = literalVersion
    ? [{ address: hostname }]
    : await lookupWithSignal(hostname, signal);
  const addresses = records.map((record) => record.address);
  if (addresses.length === 0) {
    throw new Error(`No DNS records found for ${hostname}`);
  }

  const blocked = addresses.find(isPrivateIp);
  if (blocked) {
    throw new Error(`Blocked non-public DNS result for ${hostname}: ${blocked}`);
  }

  return { normalizedUrl: parsed.toString(), hostname, addresses };
}

/**
 * DNS lookup that rejects private IPs (SSRF protection against DNS rebinding).
 * Use as the `lookup` option for axios or http.get.
 *
 * The callback signature matches dns.lookup with { all: false } (single result).
 */
export function safeLookup(
  hostname: string,
  options: object,
  callback: (err: Error | null, address: string, family: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: false } as dns.LookupOptions, (err, address, family) => {
    if (err) return callback(err, "", 0);
    const addr = typeof address === "string" ? address : "";
    if (isPrivateIp(addr)) {
      return callback(
        Object.assign(new Error(`SSRF: ${hostname} resolved to private IP ${addr}`), { code: "ECONNREFUSED" }),
        "",
        0,
      );
    }
    callback(null, addr, family as number);
  });
}
