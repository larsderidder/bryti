/**
 * Shared SSRF protection utilities.
 *
 * Used by fetch_url, skill_install, and anywhere else that fetches external URLs.
 */

import dns from "node:dns";
import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * Check if a resolved IP address is private or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  const lowerIp = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:x.x.x.x): extract the IPv4 part
  const v4Mapped = lowerIp.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4Mapped ? v4Mapped[1] : ip;

  if (net.isIPv4(addr)) {
    const parts = addr.split(".").map((part) => parseInt(part, 10));
    const [first, second] = parts;

    // Local, private, link-local, carrier-grade NAT, benchmarking, multicast,
    // and reserved ranges are not valid public fetch targets.
    if (first === 0) return true;
    if (first === 10) return true;
    if (first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 192 && second === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first === 198 && second === 51 && parts[2] === 100) return true;
    if (first === 203 && second === 0 && parts[2] === 113) return true;
    if (first >= 224) return true;
    return false;
  }

  // IPv6 local, private, link-local, multicast, and unspecified ranges.
  if (lowerIp === "::" || lowerIp === "::1") return true;
  if (lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) return true;
  if (lowerIp.startsWith("fe8") || lowerIp.startsWith("fe9") || lowerIp.startsWith("fea") || lowerIp.startsWith("feb")) return true;
  if (lowerIp.startsWith("ff")) return true;
  if (lowerIp.startsWith("2001:db8") || lowerIp.startsWith("2001:2") || lowerIp.startsWith("2001:10")) return true;

  return false;
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

export async function assertSafePublicUrl(rawUrl: string, requireHttps = true): Promise<SafePublicUrl> {
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
    : await lookup(hostname, { all: true, verbatim: true });
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
