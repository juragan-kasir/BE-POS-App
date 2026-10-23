'use strict'

// Private-address detection for LAN-only endpoints. The caller decides which
// address to pass: X-Forwarded-For must only be used when the deployment
// explicitly declares its proxy count. The header is client-controlled, so
// trusting it by default would let any internet caller claim a private
// address and defeat the guard.

const PRIVATE_V4_RANGES = [
  { cidr: '10.0.0.0', bits: 8 },
  { cidr: '172.16.0.0', bits: 12 },
  { cidr: '192.168.0.0', bits: 16 }
]

const ipv4ToInt = (ip) =>
  ip
    .split('.')
    .map((part) => Number(part))
    .reduce((acc, part) => ((acc << 8) + part) >>> 0, 0)

const matchesCidr = (ip, cidr, bits) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(cidr) & mask)
}

const isPrivateIPv4 = (ip) => {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return false
  }
  if (ip === '127.0.0.1') return true
  return PRIVATE_V4_RANGES.some((range) =>
    matchesCidr(ip, range.cidr, range.bits)
  )
}

const isPrivateIPv6 = (ip) => {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  // Unique local addresses fc00::/7
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true
  return false
}

// Express reports IPv4 sockets as "::ffff:127.0.0.1".
const normalizeIp = (ip) => {
  if (typeof ip !== 'string') return ''
  const trimmed = ip.trim().toLowerCase()
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed
}

const isPrivateAddress = (ip) => {
  const normalized = normalizeIp(ip)
  if (!normalized) return false
  if (normalized.includes(':')) return isPrivateIPv6(normalized)
  return isPrivateIPv4(normalized)
}

module.exports = { isPrivateAddress }
