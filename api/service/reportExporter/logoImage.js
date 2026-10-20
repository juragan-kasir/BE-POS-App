'use strict'

// Loads a store logo for embedding in PDF/Excel exports. Best-effort: any
// failure (timeout, too big, not PNG/JPEG, network) returns null and the
// report is produced without a logo instead of failing the export.

const MAX_BYTES = 1024 * 1024 // 1 MB
const TIMEOUT_MS = 3000

// The URL comes from store data an admin can edit, so the server only
// fetches from where store photos are uploaded (Cloudinary, over HTTPS) —
// never an arbitrary or internal address.
const isAllowedLogoUrl = (source) => {
  let url
  try {
    url = new URL(source)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  return url.protocol === 'https:' && (host === 'cloudinary.com' || host.endsWith('.cloudinary.com'))
}

const extensionOf = (contentType = '', buffer) => {
  const type = String(contentType).toLowerCase()
  if (type.includes('png')) return 'png'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpeg'
  if (buffer && buffer.length > 3) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) return 'png'
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  }
  return null
}

const fromDataUri = (uri) => {
  const match = /^data:(image\/(?:png|jpe?g));base64,(.+)$/i.exec(uri)
  if (!match) return null
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length > MAX_BYTES) return null
  const extension = extensionOf(match[1], buffer)
  return extension ? { buffer, extension } : null
}

/**
 * @param {string|null} source - http(s) URL or data: URI of the logo
 * @returns {Promise<{buffer: Buffer, extension: 'png'|'jpeg'}|null>}
 */
async function loadLogoImage(source) {
  if (!source || typeof source !== 'string') return null
  if (source.startsWith('data:')) return fromDataUri(source)
  if (!isAllowedLogoUrl(source) || typeof fetch !== 'function') return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(source, { signal: controller.signal, redirect: 'error' })
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_BYTES) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0 || buffer.length > MAX_BYTES) return null
    const extension = extensionOf(res.headers.get('content-type'), buffer)
    return extension ? { buffer, extension } : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { loadLogoImage, isAllowedLogoUrl }
