'use strict'
const db = require('../../db/models')

const DEFAULT_ACCOUNTS = [
  {
    code: '1000',
    name: 'Cash',
    type: 'asset',
    normalBalance: 'debit',
    description: 'Kas dan setara kas'
  },
  {
    code: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    normalBalance: 'debit',
    description: 'Piutang usaha'
  },
  {
    code: '1200',
    name: 'Inventory',
    type: 'asset',
    normalBalance: 'debit',
    description: 'Persediaan barang dagang'
  },
  {
    code: '1250',
    name: 'Input Tax (Purchases)',
    type: 'asset',
    normalBalance: 'debit',
    description: 'Pajak masukan atas pembelian'
  },
  {
    code: '1300',
    name: 'Fixed Assets',
    type: 'asset',
    normalBalance: 'debit',
    description: 'Aset tetap'
  },
  {
    code: '1400',
    name: 'Bank & E-Wallet',
    type: 'asset',
    normalBalance: 'debit',
    description: 'Kas di bank dan saldo dompet digital'
  },
  {
    code: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    normalBalance: 'credit',
    description: 'Utang usaha'
  },
  {
    code: '2100',
    name: 'Tax Payable',
    type: 'liability',
    normalBalance: 'credit',
    description: 'Utang pajak'
  },
  {
    code: '2200',
    name: 'Salaries Payable',
    type: 'liability',
    normalBalance: 'credit',
    description: 'Hutang gaji & lembur'
  },
  {
    code: '3000',
    name: 'Owner Capital',
    type: 'equity',
    normalBalance: 'credit',
    description: 'Modal pemilik'
  },
  {
    code: '3100',
    name: 'Retained Earnings',
    type: 'equity',
    normalBalance: 'credit',
    description: 'Laba ditahan'
  },
  {
    code: '4000',
    name: 'Sales Revenue',
    type: 'revenue',
    normalBalance: 'credit',
    description: 'Pendapatan penjualan'
  },
  {
    code: '4100',
    name: 'Service Charge Revenue',
    type: 'revenue',
    normalBalance: 'credit',
    description: 'Pendapatan service charge'
  },
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    type: 'expense',
    normalBalance: 'debit',
    description: 'Harga pokok penjualan'
  },
  {
    code: '6000',
    name: 'Operating Expenses',
    type: 'expense',
    normalBalance: 'debit',
    description: 'Beban operasional'
  },
  {
    code: '6100',
    name: 'Salaries & Wages',
    type: 'expense',
    normalBalance: 'debit',
    description: 'Beban gaji'
  }
]

const toNumber = (v) => Math.round((Number(v) || 0) * 100) / 100

// PostgreSQL reports this unique constraint as 'account_store_code_unique'
// (and, in some error paths, its 21-char prefix 'account_store_code').
const ACCOUNT_UNIQUE_CONSTRAINTS = ['account_store_code_unique', 'account_store_code']

const isAccountStoreCodeUniqueError = (err) => {
  if (err?.name !== 'SequelizeUniqueConstraintError') return false
  const constraint = err?.parent?.constraint || err?.original?.constraint
  return ACCOUNT_UNIQUE_CONSTRAINTS.includes(constraint)
}

const findAccount = async (store, code) => {
  return db.account.findOne({
    where: { store, code, status: 'active' }
  })
}

const findOrCreateAccount = async (
  store,
  code,
  overrides = {},
  createdBy = null,
  options = {}
) => {
  const transaction = options.transaction || undefined
  const existing = await db.account.findOne({
    where: { store, code },
    transaction
  })
  if (existing) return existing
  const defaults = DEFAULT_ACCOUNTS.find((a) => a.code === code)
  if (!defaults && !overrides.name) return null
  try {
    return await db.account.create(
      {
        store,
        code,
        name: overrides.name || defaults.name,
        type: overrides.type || defaults.type,
        normalBalance: overrides.normalBalance || defaults.normalBalance,
        description: overrides.description || defaults.description || null,
        isSystem: true,
        createdBy
      },
      { transaction }
    )
  } catch (err) {
    // F-08: two postings provisioning the SAME (store, code) can both reach
    // the INSERT before either commits. The unique index
    // account_store_code_unique lets exactly one win; the loser re-reads the
    // winner's row instead of failing the whole posting. Only THIS constraint
    // is retried this way — any other unique violation keeps propagating.
    if (isAccountStoreCodeUniqueError(err)) {
      const winner = await db.account.findOne({ where: { store, code }, transaction })
      if (winner) return winner
      throw err
    }
    throw err
  }
}

async function ensureDefaultAccounts(store, createdBy = null) {
  if (!store) return []
  const existing = await db.account.count({ where: { store } })
  if (existing > 0) return []
  const created = []
  for (const acc of DEFAULT_ACCOUNTS) {
    try {
      created.push(
        await db.account.create({
          store,
          ...acc,
          isSystem: true,
          createdBy
        })
      )
    } catch (err) {
      // F-08: concurrent first postings may both see the count-0 fast path
      // above and both INSERT the same DEFAULT_ACCOUNTS rows. The (store,
      // code) unique index lets exactly one row forward; a losing insert is
      // skipped (the winner created the same row) instead of failing a
      // legitimate posting. Anything OTHER than that specific collision keeps
      // throwing — a real provisioning failure must not be silently hidden.
      if (isAccountStoreCodeUniqueError(err)) {
        continue
      }
      throw err
    }
  }
  return created
}

function makeEntryNumber(store, seq) {
  const pad = String(seq || 1).padStart(6, '0')
  return `JV-${String(store).padStart(4, '0')}-${pad}`
}

// Per-store atomic entryNumber source.
//
// The old implementation read MAX(id)+1 inside a quick SELECT — two concurrent
// postings for the same store both read the same MAX(id) and both issued the
// SAME entryNumber (and, combined with the non-atomic duplicate check, both
// created a full journal for the same business event). The counter lives in
// its own table (journal_entry_sequence, seeded from MAX(id) by the Phase 3
// migration) and is bumped while holding a FOR UPDATE lock on that store's row
// — which ALSO serializes concurrent journal creation for a store, so the
// duplicate check below never races against an in-flight concurrent insert.
async function nextEntrySeq(store, transaction) {
  await db.sequelize.query(
    `INSERT INTO journal_entry_sequence (store, counter, "createdAt", "updatedAt")
     VALUES ($1, 0, NOW(), NOW())
     ON CONFLICT (store) DO NOTHING`,
    { bind: [store], transaction }
  )
  const [rows] = await db.sequelize.query(
    `SELECT counter FROM journal_entry_sequence WHERE store = $1 FOR UPDATE`,
    { bind: [store], transaction }
  )
  const seq = Number(rows[0]?.counter || 0) + 1
  await db.sequelize.query(
    `UPDATE journal_entry_sequence SET counter = $2 WHERE store = $1`,
    { bind: [store, seq], transaction }
  )
  return seq
}

async function existingEntry(store, sourceType, referenceId, transaction) {
  return db.journal_entry.findOne({
    where: { store, sourceType, referenceId: referenceId || null },
    transaction
  })
}

// Core double-entry writer: balances lines, dedupes by (sourceType, referenceId)
// and posts atomically. The entry + lines are written inside ONE transaction
// (its own when the caller doesn't supply one). The DB unique index on
// (store, sourceType, referenceId) is the final backstop — if it fires anyway,
// the existing entry is replayed instead of creating a duplicate.
//
// SEMANTIC CHANGE: genuine DB failures now THROW instead of returning null.
// Every posting is dispatched through the accounting outbox, whose attemptJob
// catches the error and leaves the job pending for a bounded retry — silently
// returning null made the caller mark a job 'posted' while no entry existed.
// The null returns below are deliberate no-ops (nothing to post), not errors.
async function createJournalEntry({
  store,
  date,
  description,
  sourceType,
  referenceId,
  lines,
  createdBy,
  transaction
}) {
  if (!store || !lines || lines.length === 0) return null
  await ensureDefaultAccounts(store, createdBy)

  const clean = lines
    .filter((l) => toNumber(l.debit) > 0 || toNumber(l.credit) > 0)
    .map((l) => ({
      account: l.account,
      debit: toNumber(l.debit),
      credit: toNumber(l.credit),
      description: l.description || null
    }))
  if (clean.length === 0) return null

  const totalDebit = toNumber(clean.reduce((s, l) => s + l.debit, 0))
  const totalCredit = toNumber(clean.reduce((s, l) => s + l.credit, 0))
  if (totalDebit <= 0 && totalCredit <= 0) return null

  const insertEntry = async (t) => {
    const seq = await nextEntrySeq(store, t)

    // Dedupe runs AFTER acquiring the store's counter lock, so any
    // concurrent posting either joined the queue (it will see our commit
    // below) or already committed the exact same entry (we see it here).
    const dup = await existingEntry(store, sourceType, referenceId, t)
    if (dup) return dup

    let entry
    try {
      entry = await db.journal_entry.create(
        {
          store,
          entryNumber: makeEntryNumber(store, seq),
          date: date || new Date(),
          description: description || sourceType,
          sourceType,
          referenceId: referenceId || null,
          totalDebit,
          totalCredit,
          createdBy
        },
        { transaction: t }
      )
    } catch (insertError) {
      // Final DB backstop. Only the own-transaction path can replay safely —
      // the caller-supplied-transaction path exposes the conflict instead.
      if (insertError.name === 'SequelizeUniqueConstraintError' && !transaction) {
        const existing = await existingEntry(store, sourceType, referenceId)
        if (existing) return existing
      }
      throw insertError
    }
    for (const line of clean) {
      await db.journal_entry_line.create(
        { ...line, journalEntry: entry.id, createdBy },
        { transaction: t }
      )
    }
    return entry
  }

  if (transaction) return insertEntry(transaction)
  return db.sequelize.transaction(insertEntry)
}

// Reverse an existing entry by creating a new entry with swapped debit/credit.
async function createReversalEntry({
  store,
  originalEntry,
  description,
  sourceType,
  referenceId,
  date,
  createdBy
}) {
  const lines = await db.journal_entry_line.findAll({
    where: { journalEntry: originalEntry.id }
  })
  const reversed = lines.map((l) => ({
    account: l.account,
    debit: toNumber(l.credit),
    credit: toNumber(l.debit),
    description: l.description ? `Reversal: ${l.description}` : null
  }))
  return createJournalEntry({
    store,
    date,
    description:
      description ||
      `Reversal of ${originalEntry.description || originalEntry.sourceType}`,
    sourceType,
    referenceId: referenceId ?? originalEntry.referenceId,
    lines: reversed,
    createdBy
  })
}

async function postOrderJournal({
  store,
  orderId,
  orderNumber,
  subTotal,
  discountAmount,
  taxAmount,
  serviceChargeAmount,
  totalPrice,
  date,
  createdBy,
  paymentMethod
}) {
  const sub = toNumber(subTotal)
  const disc = toNumber(discountAmount)
  const tax = toNumber(taxAmount)
  const sc = toNumber(serviceChargeAmount)
  const total = toNumber(totalPrice)

  const revenueAmount = toNumber(sub - disc)
  if (total <= 0) return null

  // DR-04/DR-23: the debit follows the settled tender — cash sales debit
  // 1000 Cash, QR/non-cash sales debit 1400 Bank & E-Wallet (same rule as
  // the refund leg and payoutAccountCode helper). `paymentMethod` arrives
  // via the outbox payload (already canonical at the settlement boundary);
  // absent/legacy values fall back to cash behavior, never throw here.
  const debitCode = payoutAccountCode(paymentMethod)
  const cashEntry = await findOrCreateAccount(store, debitCode)
  const revenueEntry = await findOrCreateAccount(store, '4000')
  if (!cashEntry || !revenueEntry) return null

  const lines = [
    {
      account: cashEntry.id,
      debit: total,
      credit: 0,
      description: `Payment received for ${orderNumber}`
    }
  ]
  if (revenueAmount > 0) {
    lines.push({
      account: revenueEntry.id,
      debit: 0,
      credit: revenueAmount,
      description: `Sales revenue for ${orderNumber}`
    })
  }
  if (tax > 0) {
    const taxAcc = await findOrCreateAccount(store, '2100')
    if (taxAcc)
      lines.push({
        account: taxAcc.id,
        debit: 0,
        credit: tax,
        description: `Tax collected for ${orderNumber}`
      })
  }
  if (sc > 0) {
    const scAcc = await findOrCreateAccount(store, '4100')
    if (scAcc)
      lines.push({
        account: scAcc.id,
        debit: 0,
        credit: sc,
        description: `Service charge for ${orderNumber}`
      })
  }

  const totalDebit = toNumber(lines.reduce((s, l) => s + l.debit, 0))
  const totalCredit = toNumber(lines.reduce((s, l) => s + l.credit, 0))
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    lines.push({
      account: revenueEntry.id,
      debit: 0,
      credit: toNumber(totalDebit - totalCredit),
      description: `Rounding adjustment for ${orderNumber}`
    })
  }

  return createJournalEntry({
    store,
    date,
    description: `Sales ${orderNumber}`,
    sourceType: 'order',
    referenceId: orderId,
    lines,
    createdBy
  })
}

// COGS = Σ (hppSnapshot × quantity). Bundles use current component cost.
async function computeOrderCogs(orderId) {
  const items = await db.order_item.findAll({ where: { order: orderId } })
  let total = 0
  for (const item of items) {
    const qty = Number(item.quantity) || 0
    if (qty <= 0) continue
    if (item.bundleId) {
      const comps = await db.product_bundle_item.findAll({
        where: { bundleId: item.bundleId }
      })
      let bundleCost = 0
      for (const c of comps) {
        const p = await db.product.findByPk(c.product)
        if (p)
          bundleCost +=
            (Number(c.quantity) || 0) * (Number(p.costPrice || p.price) || 0)
      }
      total += bundleCost * qty
    } else {
      total += (Number(item.hppSnapshot) || 0) * qty
    }
  }
  return toNumber(total)
}

async function postOrderCogsJournal({
  store,
  orderId,
  orderNumber,
  date,
  createdBy
}) {
  const cogsTotal = await computeOrderCogs(orderId)
  if (cogsTotal <= 0) return null

  const cogsAcc = await findOrCreateAccount(store, '5000')
  const inventoryAcc = await findOrCreateAccount(store, '1200')
  if (!cogsAcc || !inventoryAcc) return null

  return createJournalEntry({
    store,
    date,
    description: `COGS for ${orderNumber}`,
    sourceType: 'cogs',
    referenceId: orderId,
    lines: [
      {
        account: cogsAcc.id,
        debit: cogsTotal,
        credit: 0,
        description: `Cost of goods sold for ${orderNumber}`
      },
      {
        account: inventoryAcc.id,
        debit: 0,
        credit: cogsTotal,
        description: `Inventory consumed for ${orderNumber}`
      }
    ],
    createdBy
  })
}

// Purchase journal at goods receipt: Dr Inventory (+ Input Tax), Cr AP
// (net of PO discount, inclusive of pro-rated PO tax).
async function postPurchaseJournal({
  store,
  receiptId,
  receiptNumber,
  poNumber,
  totalAmount,
  discount,
  taxAmount,
  items,
  date,
  createdBy
}) {
  const gross = items.reduce(
    (s, i) =>
      s + Math.round((Number(i.costPrice) || 0) * (Number(i.qtyReceived) || 0)),
    0
  )
  if (gross <= 0) return null

  let net = gross
  const disc = toNumber(discount)
  const poTotal = toNumber(totalAmount)
  if (disc > 0 && poTotal > 0) {
    net = Math.round(gross - (gross * disc) / poTotal)
  }
  if (net <= 0) return null

  const inventoryAcc = await findOrCreateAccount(store, '1200')
  const apAcc = await findOrCreateAccount(store, '2000')
  if (!inventoryAcc || !apAcc) return null

  // F22-B2-01: PO-level tax was never posted here — AP was credited only
  // for the tax-exclusive `net`, while purchasePayment.js debits AP up to
  // the tax-inclusive po.finalAmount, leaving a permanent residual AP
  // balance for every taxed PO. Pro-rate PO tax across partial receipts
  // using the same gross/poTotal ratio already used for discount, and post
  // it as a separate Input Tax debit (Inventory stays tax-exclusive, so
  // batch/COGS valuation is unaffected) offset by a matching extra AP
  // credit.
  const tax = toNumber(taxAmount)
  let taxPortion = 0
  let taxAcc = null
  if (tax > 0 && poTotal > 0) {
    taxPortion = Math.round((tax * gross) / poTotal)
    if (taxPortion > 0) taxAcc = await findOrCreateAccount(store, '1250')
    if (!taxAcc) taxPortion = 0
  }

  const lines = [
    {
      account: inventoryAcc.id,
      debit: net,
      credit: 0,
      description: `Inventory received ${receiptNumber}`
    }
  ]
  if (taxPortion > 0) {
    lines.push({
      account: taxAcc.id,
      debit: taxPortion,
      credit: 0,
      description: `Purchase tax for ${receiptNumber}`
    })
  }
  lines.push({
    account: apAcc.id,
    debit: 0,
    credit: net + taxPortion,
    description: `Accounts payable for ${receiptNumber}${disc > 0 ? ` (net of PO discount ${disc})` : ''}`
  })

  return createJournalEntry({
    store,
    date,
    description: `Goods receipt ${receiptNumber}${poNumber ? ` (PO: ${poNumber})` : ''}`,
    sourceType: 'purchase',
    referenceId: receiptId,
    lines,
    createdBy
  })
}

// Supplier payment: Dr AP, Cr Cash.
async function postPurchasePaymentJournal({
  store,
  paymentId,
  poNumber,
  amount,
  date,
  createdBy
}) {
  const amt = toNumber(amount)
  if (amt <= 0) return null

  const apAcc = await findOrCreateAccount(store, '2000')
  const cashAcc = await findOrCreateAccount(store, '1000')
  if (!apAcc || !cashAcc) return null

  return createJournalEntry({
    store,
    date,
    description: `Payment for PO ${poNumber || ''}`.trim(),
    sourceType: 'purchase_payment',
    referenceId: paymentId,
    lines: [
      {
        account: apAcc.id,
        debit: amt,
        credit: 0,
        description: `Settle accounts payable ${poNumber || ''}`.trim()
      },
      {
        account: cashAcc.id,
        debit: 0,
        credit: amt,
        description: `Cash paid for PO ${poNumber || ''}`.trim()
      }
    ],
    createdBy
  })
}

// Purchase return reversal: goods go back to supplier → Dr AP, Cr Inventory.
// Batch 32-B (PR-06): reverses the returned base value plus its proportional
// PO-tax share (Dr AP total, Cr Inventory base, Cr Input Tax 1250) — mirroring
// how postPurchaseJournal posts tax separately on the forward path. The
// optional taxAmount defaults to 0, preserving the exact previous lines when
// absent. additionalCost treatment is intentionally untouched (separately
// scoped).
async function postPurchaseReturnJournal({
  store,
  purchaseReturnId,
  returnNumber,
  amount,
  taxAmount = 0,
  date,
  createdBy
}) {
  const amt = toNumber(amount)
  if (amt <= 0) return null

  const apAcc = await findOrCreateAccount(store, '2000')
  const inventoryAcc = await findOrCreateAccount(store, '1200')
  if (!apAcc || !inventoryAcc) return null

  let taxPortion = 0
  let taxAcc = null
  const tax = toNumber(taxAmount)
  if (tax > 0) {
    taxAcc = await findOrCreateAccount(store, '1250')
    if (taxAcc) taxPortion = tax
  }

  const lines = [
    {
      account: apAcc.id,
      debit: amt + taxPortion,
      credit: 0,
      description: `Return credit ${returnNumber}`
    },
    {
      account: inventoryAcc.id,
      debit: 0,
      credit: amt,
      description: `Inventory returned ${returnNumber}`
    }
  ]
  if (taxPortion > 0) {
    lines.push({
      account: taxAcc.id,
      debit: 0,
      credit: taxPortion,
      description: `Purchase tax reversed ${returnNumber}`
    })
  }

  return createJournalEntry({
    store,
    date,
    description: `Purchase return ${returnNumber}`,
    sourceType: 'purchase_return',
    referenceId: purchaseReturnId,
    lines,
    createdBy
  })
}

// Sales return reversal: refund revenue, restore inventory at cost.
async function postSalesReturnJournal({
  store,
  returnId,
  returnNumber,
  orderId,
  refundAmount,
  refundMethod,
  items,
  date,
  createdBy
}) {
  const refund = toNumber(refundAmount)

  let cogsReturned = 0
  for (const it of items || []) {
    const qty = Math.floor(Number(it.qty)) || 0
    if (qty <= 0) continue
    let hpp = 0
    if (it.orderItem) {
      const oi = await db.order_item.findByPk(it.orderItem)
      hpp = Number(oi?.hppSnapshot) || 0
    }
    cogsReturned += hpp * qty
  }
  cogsReturned = toNumber(cogsReturned)

  if (refund <= 0 && cogsReturned <= 0) return null

  const lines = []
  if (refund > 0) {
    const revenueAcc = await findOrCreateAccount(store, '4000')
    const isCashRefund = ['cash', 'tunai', 'banknote'].includes(
      String(refundMethod || 'cash').toLowerCase()
    )
    const payoutAcc = await findOrCreateAccount(
      store,
      isCashRefund ? '1000' : '1400'
    )
    if (!revenueAcc || !payoutAcc) return null
    const payoutName = isCashRefund ? 'Cash' : 'Bank & E-Wallet'
    lines.push(
      {
        account: revenueAcc.id,
        debit: refund,
        credit: 0,
        description: `Refund revenue for ${returnNumber}`
      },
      {
        account: payoutAcc.id,
        debit: 0,
        credit: refund,
        description: `${payoutName} refunded for ${returnNumber}`
      }
    )
  }
  if (cogsReturned > 0) {
    const inventoryAcc = await findOrCreateAccount(store, '1200')
    const cogsAcc = await findOrCreateAccount(store, '5000')
    if (inventoryAcc && cogsAcc) {
      lines.push(
        {
          account: inventoryAcc.id,
          debit: cogsReturned,
          credit: 0,
          description: `Stock restored for ${returnNumber}`
        },
        {
          account: cogsAcc.id,
          debit: 0,
          credit: cogsReturned,
          description: `COGS reversed for ${returnNumber}`
        }
      )
    }
  }

  return createJournalEntry({
    store,
    date,
    description: `Sales return ${returnNumber}${orderId ? ` (order ${orderId})` : ''}`,
    sourceType: 'sales_return',
    referenceId: returnId,
    lines,
    createdBy
  })
}

// Reverse revenue + COGS journals when an order is cancelled/voided.
async function reverseOrderJournals({
  store,
  orderId,
  orderNumber,
  date,
  createdBy
}) {
  const orderEntry = await db.journal_entry.findOne({
    where: { store, sourceType: 'order', referenceId: orderId }
  })
  if (orderEntry) {
    await createReversalEntry({
      store,
      originalEntry: orderEntry,
      description: `Reversal of cancelled order ${orderNumber}`,
      sourceType: 'order_reversal',
      referenceId: orderId,
      date,
      createdBy
    })
  }

  const cogsEntry = await db.journal_entry.findOne({
    where: { store, sourceType: 'cogs', referenceId: orderId }
  })
  if (cogsEntry) {
    await createReversalEntry({
      store,
      originalEntry: cogsEntry,
      description: `Reversal of cancelled order COGS ${orderNumber}`,
      sourceType: 'cogs_reversal',
      referenceId: orderId,
      date,
      createdBy
    })
  }
}

const payoutAccountCode = (paymentMethod) => {
  const method = String(paymentMethod || 'cash').toLowerCase()
  return method === 'cash' ? '1000' : '1400'
}

const payoutAccountName = (paymentMethod) => {
  const method = String(paymentMethod || 'cash').toLowerCase()
  return method === 'cash' ? 'Cash' : 'Bank & E-Wallet'
}

async function postExpenseJournal({
  store,
  expenseId,
  expenseNumber,
  category,
  categoryAccountCode,
  amount,
  date,
  paymentMethod,
  createdBy,
  transaction
}) {
  const amt = toNumber(amount)
  if (amt <= 0) return null

  const expenseAcc = await findOrCreateAccount(
    store,
    categoryAccountCode || '6000',
    {
      name: category || 'Operating Expenses',
      type: 'expense',
      normalBalance: 'debit'
    },
    createdBy,
    { transaction }
  )
  const payoutAcc = await findOrCreateAccount(
    store,
    payoutAccountCode(paymentMethod),
    {},
    createdBy,
    { transaction }
  )
  if (!expenseAcc || !payoutAcc) return null

  return createJournalEntry({
    store,
    date,
    description: `Expense ${expenseNumber || ''}`.trim(),
    sourceType: 'expense',
    referenceId: expenseId,
    lines: [
      {
        account: expenseAcc.id,
        debit: amt,
        credit: 0,
        description: category
          ? `${category}: ${expenseNumber || ''}`.trim()
          : `Expense ${expenseNumber || ''}`.trim()
      },
      {
        account: payoutAcc.id,
        debit: 0,
        credit: amt,
        description: `${payoutAccountName(paymentMethod)} paid for ${expenseNumber || 'expense'}`
      }
    ],
    createdBy,
    transaction
  })
}

// Rewrites the existing expense journal entry (amount, accounts, date) in place.
// Falls back to posting a new entry when none exists yet.
// The line destruction + recreation is atomic: it runs inside a transaction when
// none is provided by the caller.
async function updateExpenseJournal({
  store,
  expenseId,
  expenseNumber,
  category,
  categoryAccountCode,
  amount,
  date,
  paymentMethod,
  createdBy,
  transaction
}) {
  const amt = toNumber(amount)
  if (amt <= 0) return null

  const existing = await db.journal_entry.findOne({
    where: { store, sourceType: 'expense', referenceId: expenseId },
    transaction
  })
  if (!existing) {
    return postExpenseJournal({
      store,
      expenseId,
      expenseNumber,
      category,
      categoryAccountCode,
      amount,
      date,
      paymentMethod,
      createdBy,
      transaction
    })
  }

  const expenseAcc = await findOrCreateAccount(
    store,
    categoryAccountCode || '6000',
    {
      name: category || 'Operating Expenses',
      type: 'expense',
      normalBalance: 'debit'
    },
    createdBy,
    { transaction }
  )
  const payoutAcc = await findOrCreateAccount(
    store,
    payoutAccountCode(paymentMethod),
    {},
    createdBy,
    { transaction }
  )
  if (!expenseAcc || !payoutAcc) return null

  // F22-B8: two reconciliations for the SAME expense (e.g. an immediate
  // post-commit attempt racing a scheduler drain tick) can each run this
  // function in their own transaction. The lookup above isn't locked, so
  // without a lock here both can destroy+recreate the line rows in an
  // interleaved way — proven by a concurrent-workers test to produce
  // duplicate lines (4 instead of 2). Re-fetching under FOR UPDATE inside
  // the transaction that actually does the rewrite serializes the two:
  // the second rewrite blocks until the first commits, then re-reads the
  // now-current row and cleanly replaces its lines. Same lock idiom
  // already used elsewhere (batchService.js, stockMutationService.js,
  // promoUsageService.js, loyaltyService.js) — not a new locking system.
  const rewrite = async (t) => {
    const locked = await db.journal_entry.findByPk(existing.id, {
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    // Soft-deleted by a concurrent delete-reconciliation while this one
    // was waiting for the lock — leave it deleted, don't resurrect it.
    if (!locked) return existing

    await db.journal_entry_line.destroy({
      where: { journalEntry: locked.id },
      transaction: t
    })
    await db.journal_entry_line.create(
      {
        journalEntry: locked.id,
        account: expenseAcc.id,
        debit: amt,
        credit: 0,
        description: category
          ? `${category}: ${expenseNumber || ''}`.trim()
          : `Expense ${expenseNumber || ''}`.trim(),
        createdBy
      },
      { transaction: t }
    )
    await db.journal_entry_line.create(
      {
        journalEntry: locked.id,
        account: payoutAcc.id,
        debit: 0,
        credit: amt,
        description: `${payoutAccountName(paymentMethod)} paid for ${expenseNumber || 'expense'}`,
        createdBy
      },
      { transaction: t }
    )
    await locked.update(
      {
        date: date ? new Date(date) : locked.date,
        description: `Expense ${expenseNumber || ''}`.trim(),
        totalDebit: amt,
        totalCredit: amt,
        modifiedBy: createdBy
      },
      { transaction: t }
    )
    return locked
  }

  if (transaction) return rewrite(transaction)
  return db.sequelize.transaction(rewrite)
}

// Removes the journal entry (+ lines) tied to an expense so the ledger no
// longer reflects it (used when an approved expense is reverted/edited/deleted).
// The line destruction + entry removal is atomic.
async function deleteExpenseJournal({
  store,
  expenseId,
  createdBy,
  transaction
}) {
  const existing = await db.journal_entry.findOne({
    where: { store, sourceType: 'expense', referenceId: expenseId },
    transaction
  })
  if (!existing) return null

  const remove = async (t) => {
    await db.journal_entry_line.destroy({
      where: { journalEntry: existing.id },
      transaction: t
    })
    await existing.update({ modifiedBy: createdBy }, { transaction: t })
    await existing.destroy({ transaction: t })
    return true
  }

  if (transaction) return remove(transaction)
  return db.sequelize.transaction(remove)
}

// Overtime payroll closing: agregasi approved lembur satu bulan per employee,
// menghasilkan jurnal Dr Beban Gaji (6100) ↔ Cr Hutang Gaji (2200), dan
// mencegah double posting lewat (sourceType, referenceId) periode YYYYMM.
async function postOvertimePayrollJournal({
  store,
  period,
  lines,
  date,
  createdBy,
  transaction
}) {
  const total = toNumber(lines.reduce((s, l) => s + toNumber(l.amount), 0))
  if (!store || total <= 0 || lines.length === 0) return null

  const expenseAcc = await findOrCreateAccount(store, '6100')
  const payableAcc = await findOrCreateAccount(store, '2200')
  if (!expenseAcc || !payableAcc) return null

  const clean = lines.filter((l) => toNumber(l.amount) > 0)
  const journalLines = clean.map((l) => ({
    account: expenseAcc.id,
    debit: toNumber(l.amount),
    credit: 0,
    description: `Lembur ${l.employeeName || `#${l.employeeId}`} (${String(l.hours).replace('.', ',')} jam) — ${period}`
  }))
  journalLines.push({
    account: payableAcc.id,
    debit: 0,
    credit: total,
    description: `Hutang lembur periode ${period}`
  })

  return createJournalEntry({
    store,
    date,
    description: `Payroll lembur ${period}`,
    sourceType: 'overtime_payroll',
    referenceId: toNumber(period.replace('-', '')) || null,
    lines: journalLines,
    createdBy,
    transaction
  })
}

// Keeps the ledger consistent with the expense's current state:
// approved + active  -> post (or rewrite) the journal entry
// otherwise          -> remove any existing journal entry
async function syncExpenseJournal({
  store,
  expenseId,
  expenseNumber,
  category,
  categoryAccountCode,
  amount,
  date,
  paymentMethod,
  status,
  isActive = true,
  createdBy,
  transaction
}) {
  if (!store || !expenseId) return null
  if (status === 'approved' && isActive !== false) {
    return updateExpenseJournal({
      store,
      expenseId,
      expenseNumber,
      category,
      categoryAccountCode,
      amount,
      date,
      paymentMethod,
      createdBy,
      transaction
    })
  }
  return deleteExpenseJournal({ store, expenseId, createdBy, transaction })
}

// Outbox handler for jobType 'expense_journal_sync'. Deliberately trusts
// nothing from the caller except `expenseId` — always re-reads the LIVE
// expense row and reconciles the journal to match it. This is what makes
// replaying an old/stale job safe: an event enqueued before a later
// mutation, if processed after that later mutation already landed, just
// re-derives the SAME current truth instead of replaying a stale snapshot,
// so it can never revert or resurrect a journal (see Batch 7 design,
// PHASE-22-BATCH-7-EXPENSE-OUTBOX-DESIGN.md, sections 7-8).
//
// `paranoid: false` is required here: delete() soft-deletes the expense
// itself, and a soft-deleted row must still converge to "no journal" —
// the default paranoid scope would hide it from findByPk and this would
// silently no-op instead of removing the stale journal.
async function syncExpenseJournalFromState({ expenseId, transaction }) {
  if (!expenseId) return null
  const expense = await db.expense.findByPk(expenseId, {
    include: [{ model: db.expense_category, as: 'categoryData' }],
    paranoid: false,
    transaction
  })
  if (!expense) return null

  const createdBy = expense.modifiedBy || expense.createdBy

  if (expense.deletedAt) {
    return deleteExpenseJournal({
      store: expense.store,
      expenseId: expense.id,
      createdBy,
      transaction
    })
  }

  return syncExpenseJournal({
    store: expense.store,
    expenseId: expense.id,
    expenseNumber: expense.expenseNumber,
    category:
      expense.categoryData?.name || expense.description || null,
    categoryAccountCode: expense.categoryData?.accountCode || null,
    amount: expense.amount,
    date: expense.date,
    paymentMethod: expense.paymentMethod,
    status: expense.status,
    isActive: expense.isActive,
    createdBy,
    transaction
  })
}

module.exports = {
  DEFAULT_ACCOUNTS,
  ensureDefaultAccounts,
  findAccount,
  findOrCreateAccount,
  makeEntryNumber,
  postOrderJournal,
  postOrderCogsJournal,
  computeOrderCogs,
  postPurchaseJournal,
  postPurchasePaymentJournal,
  postPurchaseReturnJournal,
  postSalesReturnJournal,
  reverseOrderJournals,
  postExpenseJournal,
  updateExpenseJournal,
  deleteExpenseJournal,
  syncExpenseJournal,
  syncExpenseJournalFromState,
  postOvertimePayrollJournal
}
