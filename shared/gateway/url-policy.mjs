// Keep URL-only helpers dependency-free: the desktop settings renderer loads
// these modules directly from file URLs, without a bundler or Node resolution.
export function isLiteralIpv4GatewayUrl(value, { protocol = 'http:' } = {}) {
  try {
    const url = new URL(value)
    const octets = url.hostname.split('.')
    return url.protocol === protocol
      && octets.length === 4
      && octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  } catch {
    return false
  }
}
