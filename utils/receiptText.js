'use strict'

// WhatsApp text of a receipt. Same sections, order and invoice-setting
// switches as the printed receipt (FE src/utils/receiptDocument.js):
// header (store name + address lines) → meta → member → items → totals →
// tender → footer + social media. Built server-side from the persisted
// order only; nothing in it comes from the request body.

const rupiah = (n) => `Rp${Math.round(Number(n) || 0).toLocaleString('id-ID')}`

const parseMaybeJson = (raw) => {
  if (!raw) return {}
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

// Invoice settings save social visibility by list position; an older
// platform-keyed map is honoured too. Visible unless explicitly false.
const socialVisible = (visibility, entry, index) => {
  const map = parseMaybeJson(visibility)
  if (map[index] === false || map[String(index)] === false) return false
  if (entry && entry.platform && map[entry.platform] === false) return false
  return true
}

const RULE = '--------------------------------'

/**
 * @param {object} p
 * @param {object} p.order    order row (orderNumber, createdAt, cashierName,
 *                            paymentMethod, subTotal, discountValue,
 *                            taxRate, taxAmount, redeemedPoints, totalPrice)
 * @param {object[]} p.items  order_item rows (productName, quantity, price,
 *                            totalPrice, options)
 * @param {object|null} p.store       location row
 * @param {object} p.regionNames      { province, city, district, village }
 * @param {object|null} p.settings    invoice_setting row
 * @param {string|null} p.tableName
 * @param {object|null} p.member      { name, tierName, totalPoints }
 * @param {object|null} p.tender      { cashReceived, changeGiven } (cash only)
 * @param {string} [p.timezone]
 * @returns {string}
 */
function buildReceiptText({
  order,
  items = [],
  store = null,
  regionNames = {},
  settings = null,
  tableName = null,
  member = null,
  tender = null,
  timezone = 'Asia/Jakarta'
}) {
  const s = settings || {}
  const on = (v) => v !== false
  const addressVis = parseMaybeJson(s.addressFieldsVisibility)
  const memberVis = parseMaybeJson(s.memberFieldsVisibility)
  const field = (key) => addressVis[key] !== false
  const lines = []

  // Header
  if (store && on(s.showStoreName) && field('storeName') && store.name) {
    lines.push(`*${String(store.name).toUpperCase()}*`)
  }
  if (store && on(s.showAddress)) {
    if (field('address') && store.address) lines.push(store.address)
    if (field('locationDetail') && store.detailLocation)
      lines.push(store.detailLocation)
    const region = [
      field('village') && regionNames.village,
      field('district') && regionNames.district,
      field('city') && regionNames.city,
      field('province') && regionNames.province
    ].filter(Boolean)
    if (region.length) lines.push(region.join(', '))
    if (field('postalCode') && store.postalCode)
      lines.push(`Kode Pos ${store.postalCode}`)
    if (field('phone') && store.phoneNumber)
      lines.push(`Telp ${store.phoneNumber}`)
    if (field('email') && store.email) lines.push(store.email)
  }
  if (lines.length) lines.push(RULE)

  // Meta
  const date = order.createdAt
    ? new Date(order.createdAt).toLocaleString('id-ID', {
        timeZone: timezone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''
  const meta = [
    ['No. Invoice', order.orderNumber || order.id],
    ['Tanggal', date],
    ['Kasir', order.cashierName],
    ['Meja', tableName],
    ['Pembayaran', order.paymentMethod]
  ].filter(([, v]) => v != null && v !== '' && v !== '-')
  meta.forEach(([k, v]) => lines.push(`${k}: ${v}`))
  lines.push(RULE)

  // Member
  if (member && on(s.showMemberInfo)) {
    const rows = []
    if (member.name && memberVis.name !== false)
      rows.push(`Nama: ${member.name}`)
    if (member.tierName && memberVis.tier !== false)
      rows.push(`Tier: ${member.tierName}`)
    if (member.totalPoints != null && memberVis.points !== false) {
      rows.push(`Poin: ${Number(member.totalPoints).toLocaleString('id-ID')}`)
    }
    if (rows.length) lines.push('*INFO MEMBER*', ...rows, RULE)
  }

  // Items
  if (!items.length) lines.push('-')
  items.forEach((it) => {
    const qty = Number(it.quantity) || 0
    const price = Number(it.price) || 0
    const total = it.totalPrice != null ? Number(it.totalPrice) : qty * price
    const opts = parseMaybeJson(it.options)
    const variant =
      Array.isArray(opts) && opts[0] && opts[0].name ? opts[0].name : ''
    lines.push(it.productName || 'Item')
    if (variant) lines.push(`  – ${variant}`)
    lines.push(`  ${qty} x ${rupiah(price)} = ${rupiah(total)}`)
  })
  lines.push(RULE)

  // Totals
  const subtotal = order.subTotal != null ? order.subTotal : order.totalPrice
  lines.push(`Subtotal: ${rupiah(subtotal)}`)
  if (Number(order.discountValue) > 0)
    lines.push(`Diskon: -${rupiah(order.discountValue)}`)
  if (Number(order.taxAmount) > 0) {
    const rate = Number(order.taxRate)
    const pct = rate > 1 ? Math.round(rate) : Math.round(rate * 100)
    lines.push(
      `Pajak${pct > 0 ? ` (${pct}%)` : ''}: ${rupiah(order.taxAmount)}`
    )
  }
  const redeemed = Number(order.redeemedPoints) || 0
  if (redeemed > 0)
    lines.push(
      `Redeem Poin (${redeemed.toLocaleString('id-ID')} Poin): -${rupiah(redeemed)}`
    )
  lines.push(`*TOTAL: ${rupiah(order.totalPrice)}*`)
  if (tender && Number(tender.cashReceived) > 0) {
    lines.push(`Tunai: ${rupiah(tender.cashReceived)}`)
    lines.push(`Kembali: ${rupiah(tender.changeGiven)}`)
  }

  // Footer
  const footer = s.footer || 'Terima kasih atas kunjungan Anda'
  const social =
    store && on(s.showSocialMedia) && Array.isArray(store.socialMedia)
      ? store.socialMedia
          .filter((sm, i) => socialVisible(s.socialMediaVisibility, sm, i))
          .map((sm) =>
            typeof sm === 'string'
              ? sm
              : `${sm.platform || ''}: ${sm.account || ''}`.trim()
          )
          .filter(Boolean)
      : []
  lines.push(RULE, `_${footer}_`, ...social)

  return lines.join('\n')
}

module.exports = { buildReceiptText, socialVisible }
