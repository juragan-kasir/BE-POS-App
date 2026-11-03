'use strict'
const db = require('../../../db/models')
const { assertReportStore, getReportStores } = require('./getReportStore')
const { bucketCashFlowTenders } = require('../canonicalPayment')
const { DEFAULT_TIMEZONE, getStoreDayBounds } = require('../../../utils/businessDate')

const defaultColumns = [
  { key: 'keterangan', label: 'Keterangan', type: 'string', width: 28, align: 'left' },
  { key: 'nominal', label: 'Nominal', type: 'currency', width: 22, align: 'right' }
]
const totals = []
const filename = () => 'arus-kas'
const label = 'Arus Kas'

const getData = async (req) => {
  const store = assertReportStore(req)
  // PGA-11: aggregate the whole outlet set (a multi-outlet owner's
  // tenant); `store` is only the timezone / label outlet.
  const stores = getReportStores(req)
  const { startDate, endDate } = req.query
  const replacements = {}
  let txConditions = '1=1'

  if (stores.length) { txConditions += ` AND o."store" IN (:storeIds)`; replacements.storeIds = stores }
  // Store-local day windows (same contract as the HTTP cash-flow controller):
  // never derive bounds from the server machine's clock — the old
  // setHours(23, 59, 59, 999) dropped 00:00-07:00 WIB orders on machines
  // whose timezone differs from the store's.
  let storeTimezone = DEFAULT_TIMEZONE
  if (store) {
    try {
      const loc = await db.location.findByPk(store, { attributes: ['timezone'] })
      if (loc?.timezone) storeTimezone = loc.timezone
    } catch {}
  }
  if (startDate) {
    const startBounds = getStoreDayBounds(String(startDate).slice(0, 10), storeTimezone)
    txConditions += ` AND o."createdAt" >= :startDate`
    replacements.startDate = startBounds.start
  }
  if (endDate) {
    const endBounds = getStoreDayBounds(String(endDate).slice(0, 10), storeTimezone)
    txConditions += ` AND o."createdAt" <= :endDate`
    replacements.endDate = endBounds.end
  }

  const paymentRows = await db.sequelize.query(
    `SELECT t."typePayment", COALESCE(SUM(t."amount"), 0) as total
     FROM "transaction" t JOIN "order" o ON o.id = t."order"
     WHERE ${txConditions} GROUP BY t."typePayment"`,
    { replacements, type: db.sequelize.QueryTypes.SELECT }
  )

  // Same shared taxonomy as the HTTP cash-flow report (see
  // bucketCashFlowTenders): only CASH feeds Tunai. Lainnya renders as its
  // own row — without it, reclassified CARD/OTHER/POINTS money would vanish
  // from the export entirely (the previous `_lainnya` was computed but
  // never rendered).
  const {
    tunai: penerimaanTunai,
    qris: penerimaanQris,
    transfer: penerimaanTransfer,
    lainnya
  } = bucketCashFlowTenders(paymentRows)

  const expReplacements = {}
  let expConditions = `"status" = 'approved'`
  if (stores.length) { expConditions += ` AND "store" IN (:storeIds)`; expReplacements.storeIds = stores }
  if (startDate) { expConditions += ` AND "date" >= :startDate`; expReplacements.startDate = replacements.startDate }
  if (endDate) { expConditions += ` AND "date" <= :endDate`; expReplacements.endDate = replacements.endDate }

  const [expAgg] = await db.sequelize.query(
    `SELECT COALESCE(SUM("amount"), 0) as total
     FROM expense WHERE ${expConditions}`,
    { replacements: expReplacements, type: db.sequelize.QueryTypes.SELECT }
  )

  const ppReplacements = {}
  let ppConditions = '1=1'
  if (stores.length) { ppConditions += ` AND "store" IN (:storeIds)`; ppReplacements.storeIds = stores }
  if (startDate) { ppConditions += ` AND COALESCE("paymentDate", "createdAt") >= :startDate`; ppReplacements.startDate = replacements.startDate }
  if (endDate) { ppConditions += ` AND COALESCE("paymentDate", "createdAt") <= :endDate`; ppReplacements.endDate = replacements.endDate }

  const [ppAgg] = await db.sequelize.query(
    `SELECT COALESCE(SUM("amount"), 0) as total
     FROM purchase_payment WHERE ${ppConditions}`,
    { replacements: ppReplacements, type: db.sequelize.QueryTypes.SELECT }
  )
  const pengeluaranExpense = Number(expAgg.total || 0)
  const pengeluaranPurchasePayment = Number(ppAgg.total || 0)

  const refReplacements = {}
  let refConditions = `r."status" = 'approved' AND r."resolution" = 'credit'`
  if (stores.length) { refConditions += ` AND r."store" IN (:storeIds)`; refReplacements.storeIds = stores }
  if (startDate) { refConditions += ` AND r."createdAt" >= :startDate`; refReplacements.startDate = replacements.startDate }
  if (endDate) { refConditions += ` AND r."createdAt" <= :endDate`; refReplacements.endDate = replacements.endDate }

  const [refAgg] = await db.sequelize.query(
    `SELECT COALESCE(SUM(ri."qty" * COALESCE((
       SELECT poi."price"
       FROM purchase_order_item poi
       WHERE poi."purchaseOrder" = r."purchaseOrder"
         AND (
           (ri."ingredient" IS NOT NULL AND poi."ingredient" = ri."ingredient")
           OR (ri."product" IS NOT NULL AND poi."product" = ri."product")
           OR (
             ri."ingredient" IS NULL AND ri."product" IS NULL
             AND poi."ingredientName" = ri."ingredientName"
           )
         )
       LIMIT 1
     ), 0)), 0) as total
     FROM purchase_return r
     INNER JOIN purchase_return_item ri ON ri."purchaseReturn" = r.id
     WHERE ${refConditions}`,
    { replacements: refReplacements, type: db.sequelize.QueryTypes.SELECT }
  )
  const penerimaanReturPembelian = Number(refAgg.total || 0)

  const rows = [
    { keterangan: 'Penerimaan Tunai', nominal: penerimaanTunai, flow: 'in' },
    { keterangan: 'Penerimaan QRIS', nominal: penerimaanQris, flow: 'in' },
    { keterangan: 'Penerimaan Transfer', nominal: penerimaanTransfer, flow: 'in' },
    { keterangan: 'Lainnya', nominal: lainnya, flow: 'in' },
    { keterangan: 'Penerimaan Retur Pembelian', nominal: penerimaanReturPembelian, flow: 'in' },
    { keterangan: 'Pengeluaran Expense', nominal: pengeluaranExpense, flow: 'out' },
    { keterangan: 'Pengeluaran Purchase Payment', nominal: pengeluaranPurchasePayment, flow: 'out' }
  ]

  return {
    rows,
    title: label,
    subtitle: [startDate, endDate].filter(Boolean).join(' - ') || 'Periode'
  }
}

const archetype = 'statement'

module.exports = { getData, defaultColumns, totals, filename, label, archetype }
