'use strict'
const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { getStoreLocalDate } = require('../../utils/businessDate')
const { FIELD_MAX } = require('../validation/fieldLimits')
const { bodyFor } = require('../../utils/valueTooLong')
const {
  ensureDefaultAccounts,
  makeEntryNumber,
  nextEntrySeq,
  createJournalEntry
} = require('../service/accountingService')

const getStore = (req) => {
  if (req.user?.roleType === 'super_admin') return req.storeId || null
  return (
    req.storeId ||
    req.body.storeId ||
    req.body.store ||
    req.query.store ||
    req.cookies.store ||
    req.cookies.activeStore ||
    req.user?.store
  )
}

const toNumber = (v) => Math.round((Number(v) || 0) * 100) / 100

const accountIncludes = () => ({
  model: db.account,
  as: 'accountData'
})

const isSuperAdmin = (req) => req.user?.roleType === 'super_admin'

// FG-ACC-03: a reversed entry stays in the books next to its reversal, so
// every balance reads both — the pair nets to zero across the two dates.
const BOOKED_STATUSES = ['posted', 'reversed']

// Aggregates journal entry balances across one store (or all stores for super_admin),
// keyed by account code so duplicate charts of accounts consolidate correctly.
const buildBalanceMap = async ({ store, dateWhere }) => {
  const storeWhere = store ? { store } : {}
  const entries = await db.journal_entry.findAll({
    where: { ...storeWhere, ...(dateWhere || {}), status: BOOKED_STATUSES },
    include: [{ model: db.journal_entry_line, as: 'lines' }]
  })
  const accounts = await db.account.findAll({ where: storeWhere })
  const accountById = new Map(accounts.map((a) => [String(a.id), a]))
  const accountByCode = new Map()
  for (const a of accounts) {
    if (!accountByCode.has(a.code)) accountByCode.set(a.code, a)
  }
  const balances = new Map()
  for (const entry of entries) {
    for (const line of entry.lines) {
      const acc = accountById.get(String(line.account))
      const code = acc?.code || String(line.account)
      const cur = balances.get(code) || { debit: 0, credit: 0 }
      cur.debit += toNumber(line.debit)
      cur.credit += toNumber(line.credit)
      balances.set(code, cur)
    }
  }
  return { balances, accountByCode }
}

// Aggregates financial summary from balance map and account data.
// Returns revenue, expense, net income, and balance sheet totals.
const aggregateFinancialSummary = ({ balances, accountByCode }) => {
  const toNumber = (v) => Math.round((Number(v) || 0) * 100) / 100
  let totalRevenue = 0
  let totalExpense = 0
  let cashBank = 0
  const typeGroups = { asset: [], liability: [], equity: [] }

  for (const acc of accountByCode.values()) {
    const b = balances.get(acc.code) || { debit: 0, credit: 0 }
    const net = toNumber(b.debit - b.credit)
    if (acc.type === 'revenue') {
      totalRevenue += Math.abs(net)
    } else if (acc.type === 'expense') {
      totalExpense += Math.abs(net)
    } else if (typeGroups[acc.type]) {
      typeGroups[acc.type].push({
        code: acc.code,
        name: acc.name,
        normalBalance: acc.normalBalance,
        net
      })
    }
    if (acc.type === 'asset' && (acc.name?.toLowerCase().includes('cash') || acc.name?.toLowerCase().includes('bank'))) {
      cashBank += net
    }
  }

  const revenue = toNumber(totalRevenue)
  const expense = toNumber(totalExpense)
  const netIncome = toNumber(revenue - expense)

  const computeBalance = (rows) =>
    rows.reduce((sum, r) => {
      if (r.normalBalance === 'debit') return sum + r.net
      return sum - r.net
    }, 0)

  const totalAssets = toNumber(computeBalance(typeGroups.asset))
  const totalLiabilities = toNumber(computeBalance(typeGroups.liability))
  const totalEquity = toNumber(
    computeBalance(typeGroups.equity) + netIncome
  )
  const totalLiabilitiesEquity = toNumber(totalLiabilities + totalEquity)

  return {
    cashBank: toNumber(cashBank),
    totalRevenue: revenue,
    totalExpense: expense,
    netIncome,
    isProfit: netIncome >= 0,
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalLiabilitiesEquity,
    balanced: Math.abs(totalAssets - totalLiabilitiesEquity) <= 0.01
  }
}

module.exports = {
  async listAccounts(req, res) {
    try {
      const store = getStore(req)
      if (!store && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }
      if (store) await ensureDefaultAccounts(store, req.user?.id)
      const accounts = await db.account.findAll({
        where: store
          ? { store, ...(req.query.status ? { status: req.query.status } : {}) }
          : {},
        order: [['code', 'ASC']]
      })
      let data = accounts
      if (!store) {
        // All-stores: consolidate the per-store chart of accounts by code
        const byCode = new Map()
        for (const acc of accounts) {
          if (!byCode.has(acc.code)) byCode.set(acc.code, acc)
        }
        data = [...byCode.values()]
      }
      return res.status(200).json({ success: true, data })
    } catch (error) {
      console.error('listAccounts error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async createAccount(req, res) {
    try {
      const store = getStore(req)
      if (!store)
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      const { code, name, type, normalBalance, parentId, description } =
        req.body
      if (!code || !name || !type || !normalBalance) {
        return res.status(400).json({
          success: false,
          message: 'Code, name, type and normalBalance are required'
        })
      }
      const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense']
      const validBalances = ['debit', 'credit']
      if (
        !validTypes.includes(type) ||
        !validBalances.includes(normalBalance)
      ) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid type or normalBalance' })
      }
      const existing = await db.account.findOne({ where: { store, code } })
      if (existing) {
        return res.status(400).json({
          success: false,
          message: `Account code ${code} already exists`
        })
      }
      const account = await db.account.create({
        store,
        code: String(code).trim(),
        name,
        type,
        normalBalance,
        parentId: parentId || null,
        description,
        createdBy: req.user?.id
      })
      createAudit(
        req,
        'create',
        'account',
        account.id,
        `Created account: ${code} ${name}`
      )
      return res
        .status(201)
        .json({ success: true, data: account, message: 'Account created' })
    } catch (error) {
      console.error('createAccount error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateAccount(req, res) {
    try {
      const store = getStore(req)
      if (!store)
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      const { id } = req.params
      const account = await db.account.findOne({ where: { id, store } })
      if (!account)
        return res
          .status(404)
          .json({ success: false, message: 'Account not found' })
      const { code, name, type, normalBalance, parentId, description, status } =
        req.body
      if (code && String(code) !== account.code) {
        const safeCode = String(code).trim()
        // BA DR-28: account.code is VARCHAR(20); a longer code is refused, never cut.
        if (safeCode.length > FIELD_MAX.ACCOUNT_CODE) {
          return res.status(400).json(bodyFor({ field: 'code', max: FIELD_MAX.ACCOUNT_CODE }))
        }
        const clash = await db.account.findOne({ // codacy-ignore-line
          where: { store, code: safeCode }
        })
        if (clash)
          return res.status(400).json({
            success: false,
            message: `Account code ${code} already exists`
          })
      }
      await account.update({
        ...(code ? { code: String(code).trim() } : {}),
        ...(name ? { name } : {}),
        ...(type ? { type } : {}),
        ...(normalBalance ? { normalBalance } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status ? { status } : {}),
        modifiedBy: req.user?.id
      })
      createAudit(
        req,
        'update',
        'account',
        id,
        `Updated account: ${account.code} ${account.name}`
      )
      return res
        .status(200)
        .json({ success: true, data: account, message: 'Account updated' })
    } catch (error) {
      console.error('updateAccount error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async deleteAccount(req, res) {
    try {
      const store = getStore(req)
      if (!store)
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      const { id } = req.params
      const account = await db.account.findOne({ where: { id, store } })
      if (!account)
        return res
          .status(404)
          .json({ success: false, message: 'Account not found' })
      if (account.isSystem) {
        return res.status(400).json({
          success: false,
          message: 'System accounts cannot be deleted'
        })
      }
      const used = await db.journal_entry_line.count({ where: { account: id } })
      if (used > 0) {
        return res.status(400).json({
          success: false,
          message: 'Account has journal activity and cannot be deleted'
        })
      }
      await account.destroy()
      createAudit(
        req,
        'delete',
        'account',
        id,
        `Deleted account: ${account.code} ${account.name}`
      )
      return res.status(200).json({ success: true, message: 'Account deleted' })
    } catch (error) {
      console.error('deleteAccount error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async listJournals(req, res) {
    try {
      const store = getStore(req)
      if (!store && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }
      const where = store ? { store } : {}
      if (req.query.sourceType) where.sourceType = req.query.sourceType
      if (req.query.startDate || req.query.endDate) {
        where.date = {}
        if (req.query.startDate) where.date[Op.gte] = req.query.startDate
        if (req.query.endDate) where.date[Op.lte] = req.query.endDate
      }
      const limit = Math.min(Number(req.query.limit) || 50, 500)
      const offset = Number(req.query.offset) || 0
      const { rows, count } = await db.journal_entry.findAndCountAll({
        where,
        order: [
          ['date', 'DESC'],
          ['id', 'DESC']
        ],
        limit,
        offset,
        include: [
          {
            model: db.journal_entry_line,
            as: 'lines',
            include: [accountIncludes()]
          }
        ]
      })
      let data = rows
      if (!store) {
        const locations = await db.location.findAll({
          attributes: ['id', 'name']
        })
        const locMap = new Map(
          locations.map((l) => [String(l.id), l.name || `Toko ${l.id}`])
        )
        data = rows.map((row) => {
          const plain = row.get({ plain: true })
          plain.storeName =
            locMap.get(String(plain.store)) || `Toko ${plain.store}`
          return plain
        })
      }
      return res.status(200).json({ success: true, data, count, limit, offset })
    } catch (error) {
      console.error('listJournals error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async createManualJournal(req, res) {
    try {
      const store = getStore(req)
      if (!store)
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      const { date, description, lines } = req.body
      if (!date || !Array.isArray(lines) || lines.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Date and at least two lines are required'
        })
      }
      let totalDebit = 0
      let totalCredit = 0
      const safeAccountIds = lines.map((line) => String(line.account || '').trim())
      const missingIds = safeAccountIds.filter((id) => !id)
      if (missingIds.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Account ID is required for each line'
        })
      }
      const uniqueAccountIds = [...new Set(safeAccountIds)]
      const accounts = await db.account.findAll({
        where: { id: uniqueAccountIds, store, status: 'active' }
      })
      const accountMap = new Map(accounts.map((a) => [String(a.id), a]))
      for (const line of lines) {
        const safeAccountId = String(line.account || '').trim()
        const account = accountMap.get(safeAccountId)
        if (!account) {
          return res.status(400).json({
            success: false,
            message: `Account ${line.account} not found`
          })
        }
        const debit = toNumber(line.debit)
        const credit = toNumber(line.credit)
        if (debit < 0 || credit < 0 || (debit === 0 && credit === 0)) {
          return res.status(400).json({
            success: false,
            message: 'Each line needs a positive debit or credit'
          })
        }
        totalDebit += debit
        totalCredit += credit
      }
      totalDebit = toNumber(totalDebit)
      totalCredit = toNumber(totalCredit)
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        return res.status(400).json({
          success: false,
          message: `Total debit (${totalDebit}) must equal total credit (${totalCredit})`
        })
      }
      // Header + lines must commit or fail together — a crash partway
      // through the old per-line create loop could leave a journal entry
      // whose header claims balanced debit/credit totals but whose lines
      // don't actually sum to them.
      const entry = await db.sequelize.transaction(async (t) => {
        // Same per-store counter as the automatic postings: the old
        // `MAX(id) + 1` could hand out a number the counter had already
        // used (or would use next), and (store, entryNumber) is unique.
        const seq = await nextEntrySeq(store, t)
        const created = await db.journal_entry.create(
          {
            store,
            entryNumber: makeEntryNumber(store, seq),
            date,
            description,
            sourceType: 'manual',
            totalDebit,
            totalCredit,
            createdBy: req.user?.id
          },
          { transaction: t }
        )
        await db.journal_entry_line.bulkCreate(
          lines.map((line) => ({
            journalEntry: created.id,
            account: line.account,
            debit: toNumber(line.debit),
            credit: toNumber(line.credit),
            description: line.description || null,
            createdBy: req.user?.id
          })),
          { transaction: t }
        )
        return created
      })
      createAudit(
        req,
        'create',
        'journal_entry',
        entry.id,
        `Created journal entry: ${entry.entryNumber}`
      )
      return res
        .status(201)
        .json({ success: true, data: entry, message: 'Journal entry created' })
    } catch (error) {
      console.error('createManualJournal error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // FG-ACC-03: a posted manual journal is never removed from the books.
  // "Delete" posts its mirror (debit <-> credit) on the store's today and
  // marks the original 'reversed'; both stay readable and the trial balance
  // nets the pair to zero. Automatic entries are corrected through their
  // source document (order, expense, purchase), not here.
  async deleteJournal(req, res) {
    try {
      const store = getStore(req)
      if (!store)
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      const { id } = req.params
      const reason =
        String(req.body?.reason || req.query.reason || '')
          .trim()
          .slice(0, 500) || null
      const location = await db.location.findByPk(store, {
        attributes: ['timezone']
      })
      const today = getStoreLocalDate(location?.timezone)

      const result = await db.sequelize.transaction(async (t) => {
        const entry = await db.journal_entry.findOne({
          where: { id, store },
          transaction: t,
          lock: t.LOCK.UPDATE
        })
        if (!entry) {
          return {
            status: 404,
            body: { success: false, message: 'Journal entry not found' }
          }
        }
        if (entry.sourceType !== 'manual') {
          return {
            status: 400,
            body: {
              success: false,
              code: 'JOURNAL_NOT_MANUAL',
              message: 'Only manual journal entries can be reversed'
            }
          }
        }
        if (entry.status !== 'posted') {
          return {
            status: 409,
            body: {
              success: false,
              code: 'JOURNAL_ALREADY_REVERSED',
              message: `Journal entry ${entry.entryNumber} is already reversed`
            }
          }
        }
        const lines = await db.journal_entry_line.findAll({
          where: { journalEntry: entry.id },
          transaction: t
        })
        const reversal = await createJournalEntry({
          store,
          // Never before the entry it reverses (manual entries may be
          // future-dated).
          date: entry.date > today ? entry.date : today,
          description: `Reversal of ${entry.entryNumber}${
            reason ? `: ${reason}` : ''
          }`,
          sourceType: 'manual_reversal',
          referenceId: entry.id,
          lines: lines.map((l) => ({
            account: l.account,
            debit: l.credit,
            credit: l.debit,
            description: l.description ? `Reversal: ${l.description}` : null
          })),
          createdBy: req.user?.id,
          transaction: t
        })
        await entry.update(
          { status: 'reversed', modifiedBy: req.user?.id },
          { transaction: t }
        )
        return { entry, reversal }
      })
      if (result.status) return res.status(result.status).json(result.body)

      createAudit(
        req,
        'delete',
        'journal_entry',
        id,
        `Reversed journal entry ${result.entry.entryNumber} with ${
          result.reversal.entryNumber
        }${reason ? ` — ${reason}` : ''}`
      )
      return res.status(200).json({
        success: true,
        message: 'Journal entry reversed',
        data: { original: result.entry, reversal: result.reversal }
      })
    } catch (error) {
      console.error('deleteJournal error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getTrialBalance(req, res) {
    try {
      const store = getStore(req)
      if (!store && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }
      if (store) await ensureDefaultAccounts(store, req.user?.id)
      const dateWhere = {}
      if (req.query.startDate || req.query.endDate) {
        dateWhere.date = {}
        if (req.query.startDate) dateWhere.date[Op.gte] = req.query.startDate
        if (req.query.endDate) dateWhere.date[Op.lte] = req.query.endDate
      }
      const { balances, accountByCode } = await buildBalanceMap({
        store,
        dateWhere
      })
      const rows = [...balances.entries()]
        .map(([code, b]) => {
          const acc = accountByCode.get(code)
          return {
            accountId: acc ? Number(acc.id) : 0,
            code,
            name: acc?.name || 'Unknown',
            type: acc?.type || '',
            debit: toNumber(b.debit),
            credit: toNumber(b.credit),
            net: toNumber(b.debit - b.credit)
          }
        })
        .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
      const totalDebit = toNumber(rows.reduce((s, r) => s + r.debit, 0))
      const totalCredit = toNumber(rows.reduce((s, r) => s + r.credit, 0))
      return res.status(200).json({
        success: true,
        data: rows,
        totalDebit,
        totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) <= 0.01
      })
    } catch (error) {
      console.error('getTrialBalance error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getIncomeStatement(req, res) {
    try {
      const store = getStore(req)
      if (!store && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }
      if (store) await ensureDefaultAccounts(store, req.user?.id)
      const dateWhere = {}
      if (req.query.startDate || req.query.endDate) {
        dateWhere.date = {}
        if (req.query.startDate) dateWhere.date[Op.gte] = req.query.startDate
        if (req.query.endDate) dateWhere.date[Op.lte] = req.query.endDate
      }
      const { balances, accountByCode } = await buildBalanceMap({
        store,
        dateWhere
      })
      const revenues = []
      const expenses = []
      let totalRevenue = 0
      let totalExpense = 0
      for (const acc of accountByCode.values()) {
        const b = balances.get(acc.code) || { debit: 0, credit: 0 }
        const net = Math.abs(toNumber(b.debit - b.credit))
        if (acc.type === 'revenue') {
          revenues.push({ code: acc.code, name: acc.name, value: net })
          totalRevenue += net
        } else if (acc.type === 'expense') {
          expenses.push({ code: acc.code, name: acc.name, value: net })
          totalExpense += net
        }
      }
      revenues.sort((a, b) => a.code.localeCompare(b.code))
      expenses.sort((a, b) => a.code.localeCompare(b.code))
      const netIncome = toNumber(totalRevenue - totalExpense)
      return res.status(200).json({
        success: true,
        data: {
          revenues,
          expenses,
          totalRevenue: toNumber(totalRevenue),
          totalExpense: toNumber(totalExpense),
          netIncome
        }
      })
    } catch (error) {
      console.error('getIncomeStatement error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getBalanceSheet(req, res) {
    try {
      const store = getStore(req)
      if (!store && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }
      if (store) await ensureDefaultAccounts(store, req.user?.id)
      const asOf = req.query.asOf || null
      const dateWhere = asOf ? { date: { [Op.lte]: asOf } } : {}
      const { balances, accountByCode } = await buildBalanceMap({
        store,
        dateWhere
      })

      // Revenue/expense are closed into equity for the balance sheet (current period profit)
      const typeGroups = {
        asset: [],
        liability: [],
        equity: []
      }
      let currentNetIncome = 0
      for (const acc of accountByCode.values()) {
        const b = balances.get(acc.code) || { debit: 0, credit: 0 }
        const net = toNumber(b.debit - b.credit)
        if (acc.type === 'revenue') {
          currentNetIncome += net // revenue net is typically negative (credit)
        } else if (acc.type === 'expense') {
          currentNetIncome += net // expense net is typically positive (debit)
        } else if (typeGroups[acc.type]) {
          typeGroups[acc.type].push({
            code: acc.code,
            name: acc.name,
            normalBalance: acc.normalBalance,
            net
          })
        }
      }
      const netIncome = toNumber(-currentNetIncome)
      const computeBalance = (rows) =>
        rows.reduce((sum, r) => {
          if (r.normalBalance === 'debit') return sum + r.net
          return sum - r.net
        }, 0)

      for (const type of ['asset', 'liability', 'equity']) {
        typeGroups[type].sort((a, b) => a.code.localeCompare(b.code))
      }
      typeGroups.equity.push({
        code: 'RETAINED',
        name: 'Current Period Net Income',
        normalBalance: 'credit',
        net: toNumber(-netIncome),
        isComputed: true
      })

      const totalAssets = toNumber(computeBalance(typeGroups.asset))
      const totalLiabilities = toNumber(computeBalance(typeGroups.liability))
      const totalEquity = toNumber(computeBalance(typeGroups.equity))
      const totalLiabilitiesEquity = toNumber(totalLiabilities + totalEquity)

      return res.status(200).json({
        success: true,
        data: {
          asOf,
          assets: typeGroups.asset,
          liabilities: typeGroups.liability,
          equity: typeGroups.equity,
          totalAssets,
          totalLiabilities,
          totalEquity,
          totalLiabilitiesEquity,
          balanced: Math.abs(totalAssets - totalLiabilitiesEquity) <= 0.01
        }
      })
    } catch (error) {
      console.error('getBalanceSheet error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getOverview(req, res) {
    try {
      const store = getStore(req)
      if (!store && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }
      if (store) await ensureDefaultAccounts(store, req.user?.id)
      const dateWhere = {}
      if (req.query.startDate || req.query.endDate) {
        dateWhere.date = {}
        if (req.query.startDate) dateWhere.date[Op.gte] = req.query.startDate
        if (req.query.endDate) dateWhere.date[Op.lte] = req.query.endDate
      }
      const { balances, accountByCode } = await buildBalanceMap({
        store,
        dateWhere
      })

      const summary = aggregateFinancialSummary({ balances, accountByCode })

      const journalEntryCount = await db.journal_entry.count({
        where: {
          ...(store ? { store } : {}),
          ...(Object.keys(dateWhere).length ? dateWhere : {}),
          status: BOOKED_STATUSES
        }
      })

      return res.status(200).json({
        success: true,
        data: {
          ...summary,
          journalEntryCount
        }
      })
    } catch (error) {
      console.error('getOverview error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}
