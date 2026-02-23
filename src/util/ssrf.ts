/**
 * Shared SSRF protection utilities.
 *
 * Used by fetch_url, skill_install, and anywhere else that fetches external URLs.
 */

import dns from "node:dns";

/**
 * Check if a resolved IP address is private or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:x.x.x.x): extract the IPv4 part
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const addr = v4Mapped ? v4Mapped[1] : ip;

  // Localhost
  if (addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.")) return true;

  // Private IPv4 ranges
  if (addr.startsWith("10.")) return true;
  if (addr.startsWith("192.168.")) return true;
  if (addr.startsWith("172.")) {
    const parts = addr.split(".");
    if (parts.length >= 2) {
      const second = parseInt(parts[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
  }

  // Link-local
  if (addr.startsWith("169.254.")) return true;

  // IPv6 private ranges
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA
  if (ip.startsWith("fe80")) return true; // link-local

  return false;
}

/**
 * Check if a URL's hostname is obviously private (fast, pre-DNS check).
 */
export function isPrivateHostname(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (hostname === "localhost") return true;
    // If hostname is an IP literal, check it directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return isPrivateIp(hostname);
    if (hostname.startsWith("[")) return isPrivateIp(hostname.slice(1, -1));
    return false;
  } catch {
    return true; // Invalid URLs are treated as private
  }
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
