const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { emitToStore } = require('../service/socket')
const { arrayStoreScope } = require('../../utils/tenantScope')
const { incrementPromoUsage } = require('../service/promoUsageService')
const { createAudit } = require('../../utils/auditLog')

const promoController = {
  async getCampaigns(req, res) {
    try {
      const { search, status, type, page = 1, limit = 10 } = req.query
      const store = req.query.store

      const where = {}
      const andConditions = []

      const storeFilter = req.user?.roleType !== 'super_admin'
        ? (req.user?.store ? Number(req.user.store) : null)
        : (store && store !== '' ? Number(store) : null)

      if (storeFilter) {
        andConditions.push({
          [Op.or]: [
            { store: { [Op.contains]: [storeFilter] } },
            { store: null }
          ]
        })
      }

      if (status && status !== 'all') {
        where.status = status
      }
      if (type && type !== 'all') {
        where.type = type
      }
      if (search) {
        andConditions.push({
          [Op.or]: [
            { name: { [Op.iLike]: `%${search}%` } },
            { code: { [Op.iLike]: `%${search}%` } },
            { description: { [Op.iLike]: `%${search}%` } }
          ]
        })
      }

      if (andConditions.length > 0) {
        where[Op.and] = andConditions
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [campaigns, total] = await Promise.all([
        db.promo_campaign.findAll({
          where,
          order: [
            ['priority', 'DESC'],
            ['createdAt', 'DESC']
          ],
          limit: parseInt(limit),
          offset,
          include: [
            {
              model: db.promo_rule,
              as: 'rules',
              where: { isActive: true },
              required: false
            },
            {
              model: db.promo_reward,
              as: 'rewards',
              where: { isActive: true },
              required: false
            }
          ]
        }),
        db.promo_campaign.count({ where })
      ])

      await enrichAuditFields(db, campaigns)

      return res.status(200).json({
        success: true,
        message: 'Success get campaigns',
        data: campaigns,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getCampaignById(req, res) {
    try {
      const { id } = req.params

      // Same IDOR fix as updateCampaign — was findByPk(id) with no
      // ownership check, leaking another store's campaign config.
      const campaign = await db.promo_campaign.findOne({
        where: arrayStoreScope(req, { id }),
        include: [
          { model: db.promo_rule, as: 'rules' },
          { model: db.promo_reward, as: 'rewards' }
        ]
      })

      if (!campaign) {
        return res
          .status(404)
          .json({ success: false, message: 'Campaign not found' })
      }

      await enrichAuditFields(db, [campaign])

      return res.status(200).json({
        success: true,
        message: 'Success get campaign',
        data: campaign
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async createCampaign(req, res) {
    try {
      const {
        store,
        name,
        description,
        code,
        type,
        discountType,
        discountValue,
        maxDiscount,
        minPurchase,
        startDate,
        endDate,
        startTime,
        endTime,
        daysOfWeek,
        applicableTo,
        applicableIds,
        maxUsageTotal,
        maxUsagePerMember,
        priority,
        isCombinable,
        autoActivate,
        status,
        rules,
        rewards
      } = req.body

      const campaign = await db.promo_campaign.create({
        store,
        name,
        description,
        code,
        type,
        discountType: discountType || 'percentage',
        discountValue: discountValue || 0,
        maxDiscount,
        minPurchase: minPurchase || 0,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        startTime: startTime || null,
        endTime: endTime || null,
        daysOfWeek,
        applicableTo: applicableTo || 'all',
        applicableIds,
        maxUsageTotal,
        maxUsagePerMember,
        priority: priority || 0,
        isCombinable: isCombinable || false,
        autoActivate: autoActivate || false,
        // ponytail: FE kirim status eksplisit (Simpan vs Simpan Draft);
        // fallback ke perilaku lama dari autoActivate
        status: ['draft', 'active'].includes(status)
          ? status
          : autoActivate
            ? 'active'
            : 'draft',
        createdBy: req.user?.id
      })

      if (rules && rules.length > 0) {
        await db.promo_rule.bulkCreate(
          rules.map((rule) => ({
            campaignId: campaign.id,
            ruleType: rule.ruleType,
            condition: rule.condition,
            priority: rule.priority || 0,
            createdBy: req.user?.id
          }))
        )
      }

      if (rewards && rewards.length > 0) {
        await db.promo_reward.bulkCreate(
          rewards.map((reward) => ({
            campaignId: campaign.id,
            rewardType: reward.rewardType,
            rewardValue: reward.rewardValue,
            maxRewardValue: reward.maxRewardValue,
            productId: reward.productId,
            productIds: reward.productIds,
            quantity: reward.quantity || 1,
            condition: reward.condition,
            priority: reward.priority || 0,
            createdBy: req.user?.id
          }))
        )
      }

      const fullCampaign = await db.promo_campaign.findByPk(campaign.id, {
        include: [
          { model: db.promo_rule, as: 'rules' },
          { model: db.promo_reward, as: 'rewards' }
        ]
      })

      await enrichAuditFields(db, [fullCampaign])

      emitToStore(store, 'promo:created', fullCampaign)

      createAudit(req, 'create', 'promo_campaign', campaign.id, `Created promo campaign: ${campaign.id}`)
      return res.status(201).json({
        success: true,
        message: 'Campaign created',
        data: fullCampaign
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateCampaign(req, res) {
    try {
      const { id } = req.params
      const updateData = req.body

      // `store` here is a JSONB array (a campaign can be assigned to
      // several stores) and `store: null` means "global" — arrayStoreScope
      // deliberately does NOT match null for non-super-admin, so a
      // store-level admin can edit campaigns assigned to their own store
      // but not a company-wide global campaign; only super_admin can. IDOR
      // fix: was findByPk(id) with no ownership check at all, so any store
      // admin could edit any other store's campaign (rules/rewards
      // included).
      const campaign = await db.promo_campaign.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!campaign) {
        return res
          .status(404)
          .json({ success: false, message: 'Campaign not found' })
      }

      if (updateData.startDate)
        updateData.startDate = new Date(updateData.startDate)
      if (updateData.endDate) updateData.endDate = new Date(updateData.endDate)

      if (updateData.startTime === '') updateData.startTime = null
      if (updateData.endTime === '') updateData.endTime = null

      updateData.modifiedBy = req.user?.id

      await campaign.update(updateData)

      if (updateData.rules) {
        await db.promo_rule.destroy({ where: { campaignId: id } })
        if (updateData.rules.length > 0) {
          await db.promo_rule.bulkCreate(
            updateData.rules.map((rule) => ({
              campaignId: id,
              ruleType: rule.ruleType,
              condition: rule.condition,
              priority: rule.priority || 0,
              createdBy: req.user?.id
            }))
          )
        }
      }

      if (updateData.rewards) {
        await db.promo_reward.destroy({ where: { campaignId: id } })
        if (updateData.rewards.length > 0) {
          await db.promo_reward.bulkCreate(
            updateData.rewards.map((reward) => ({
              campaignId: id,
              rewardType: reward.rewardType,
              rewardValue: reward.rewardValue,
              maxRewardValue: reward.maxRewardValue,
              productId: reward.productId,
              productIds: reward.productIds,
              quantity: reward.quantity || 1,
              condition: reward.condition,
              priority: reward.priority || 0,
              createdBy: req.user?.id
            }))
          )
        }
      }

      const fullCampaign = await db.promo_campaign.findByPk(id, {
        include: [
          { model: db.promo_rule, as: 'rules' },
          { model: db.promo_reward, as: 'rewards' }
        ]
      })

      await enrichAuditFields(db, [fullCampaign])

      emitToStore(campaign.store, 'promo:updated', fullCampaign)

      createAudit(req, 'update', 'promo_campaign', campaign.id, `Updated promo campaign: ${campaign.id}`)
      return res.status(200).json({
        success: true,
        message: 'Campaign updated',
        data: fullCampaign
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateCampaignStatus(req, res) {
    try {
      const { id } = req.params
      const { status } = req.body

      // Same IDOR fix as updateCampaign.
      const campaign = await db.promo_campaign.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!campaign) {
        return res
          .status(404)
          .json({ success: false, message: 'Campaign not found' })
      }

      await campaign.update({
        status,
        modifiedBy: req.user?.id
      })

      emitToStore(campaign.store, 'promo:statusChanged', { id, status })

      createAudit(req, 'update', 'promo_campaign', campaign.id, `Promo campaign ${campaign.id} status: ${campaign.status}`)
      return res.status(200).json({
        success: true,
        message: `Campaign status updated to ${status}`,
        data: campaign
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async deleteCampaign(req, res) {
    try {
      const { id } = req.params

      // Same IDOR fix as updateCampaign.
      const campaign = await db.promo_campaign.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!campaign) {
        return res
          .status(404)
          .json({ success: false, message: 'Campaign not found' })
      }

      await campaign.update({ status: 'cancelled', modifiedBy: req.user?.id })
      await campaign.destroy()

      emitToStore(campaign.store, 'promo:deleted', { id })

      createAudit(req, 'delete', 'promo_campaign', campaign.id, `Deleted promo campaign: ${campaign.id}`)
      return res.status(200).json({
        success: true,
        message: 'Campaign deleted'
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async applyPromo(req, res) {
    try {
      const { store, _orderId, memberId, code, cartItems, subtotal } = req.body

      const now = new Date()
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
      const currentDay = now.getDay()

      const where = {
        status: 'active',
        startDate: { [Op.lte]: now },
        endDate: { [Op.gte]: now }
      }

      const storeFilter = req.user?.roleType !== 'super_admin'
        ? (req.user?.store ? Number(req.user.store) : null)
        : (store ? Number(store) : null)

      if (storeFilter) {
        where[Op.and] = [
          { [Op.or]: [{ store: { [Op.contains]: [storeFilter] } }, { store: null }] }
        ]
      }

      if (code) {
        where.code = code
      }

      const campaigns = await db.promo_campaign.findAll({
        where,
        include: [
          { model: db.promo_rule, as: 'rules', where: { isActive: true } },
          { model: db.promo_reward, as: 'rewards', where: { isActive: true } }
        ],
        order: [['priority', 'DESC']]
      })

      const applicablePromos = []

      for (const campaign of campaigns) {
        if (
          campaign.maxUsageTotal &&
          campaign.currentUsage >= campaign.maxUsageTotal
        ) {
          continue
        }

        if (campaign.daysOfWeek && !campaign.daysOfWeek.includes(currentDay)) {
          continue
        }

        if (campaign.startTime && campaign.endTime) {
          if (
            currentTime < campaign.startTime ||
            currentTime > campaign.endTime
          ) {
            continue
          }
        }

        let isEligible = true

        if (campaign.type === 'birthday' && memberId) {
          const member = await db.member.findByPk(memberId)
          if (member) {
            const today = new Date()
            const memberDob = new Date(member.dateOfBirth)
            if (
              today.getMonth() !== memberDob.getMonth() ||
              today.getDate() !== memberDob.getDate()
            ) {
              isEligible = false
            }
          } else {
            isEligible = false
          }
        }

        if (campaign.type === 'buy_x_get_y' && cartItems) {
          const rule = campaign.rules.find((r) => r.ruleType === 'buy_x_get_y')
          if (rule) {
            const { buyProductId, buyQuantity } = rule.condition
            const cartItem = cartItems.find(
              (item) => item.productId === buyProductId
            )
            if (!cartItem || cartItem.quantity < buyQuantity) {
              isEligible = false
            }
          }
        }

        if (campaign.type === 'spend_get' && subtotal) {
          if (subtotal < campaign.minPurchase) {
            isEligible = false
          }
        }

        if (isEligible) {
          const reward = campaign.rewards[0]
          let discountAmount = 0

          if (reward) {
            if (reward.rewardType === 'discount_percentage') {
              discountAmount = Math.round(
                (subtotal || 0) * (reward.rewardValue / 100)
              )
              if (
                reward.maxRewardValue &&
                discountAmount > reward.maxRewardValue
              ) {
                discountAmount = reward.maxRewardValue
              }
            } else if (reward.rewardType === 'discount_fixed') {
              discountAmount = reward.rewardValue
            }
          }

          applicablePromos.push({
            campaignId: campaign.id,
            name: campaign.name,
            code: campaign.code,
            type: campaign.type,
            discountAmount,
            reward: reward
              ? {
                  type: reward.rewardType,
                  value: reward.rewardValue,
                  productId: reward.productId,
                  quantity: reward.quantity
                }
              : null
          })
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Promos evaluated',
        data: {
          applicablePromos,
          bestPromo: applicablePromos[0] || null
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async recordPromoUsage(req, res) {
    try {
      const {
        campaignId,
        orderId,
        memberId,
        discountApplied,
        freeItemsGiven,
        pointsMultiplier,
        cashbackAmount
      } = req.body

      // Was an unlocked read-check-write (findByPk, compare currentUsage,
      // then a separate .update()) — two concurrent requests for the same
      // capped campaign could both read currentUsage below the limit and
      // both increment, letting a capped campaign be used more times than
      // maxUsageTotal allows. incrementPromoUsage locks the campaign row
      // and re-validates both limits under that lock, inside a real
      // transaction, closing the race.
      const result = await db.sequelize.transaction(async (t) => {
        return incrementPromoUsage({
          campaignId,
          orderId,
          memberId,
          discountApplied,
          freeItemsGiven,
          pointsMultiplier,
          cashbackAmount,
          createdBy: req.user?.id,
          transaction: t
        })
      })

      if (result.notFound) {
        return res
          .status(404)
          .json({ success: false, message: 'Campaign not found' })
      }
      if (result.limitReached) {
        return res
          .status(400)
          .json({ success: false, message: 'Campaign usage limit reached' })
      }
      if (result.memberLimitReached) {
        return res
          .status(400)
          .json({ success: false, message: 'Member usage limit reached' })
      }

      const { campaign, usage } = result
      await enrichAuditFields(db, [usage])

      emitToStore(campaign.store, 'promo:used', usage)

      return res.status(201).json({
        success: true,
        message: 'Promo usage recorded',
        data: usage
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getCampaignStats(req, res) {
    try {
      const store = req.query.store

      const where = {}
      const storeFilter = req.user?.roleType !== 'super_admin'
        ? (req.user?.store ? Number(req.user.store) : null)
        : (store && store !== '' ? Number(store) : null)

      if (storeFilter) {
        where[Op.and] = [
          { [Op.or]: [{ store: { [Op.contains]: [storeFilter] } }, { store: null }] }
        ]
      }

      const usageWhere = storeFilter
        ? { store: { [Op.contains]: [storeFilter] } }
        : {}

      const [totalCampaigns, activeCampaigns, totalUsage, totalDiscountGiven] =
        await Promise.all([
          db.promo_campaign.count({ where }),
          db.promo_campaign.count({ where: { ...where, status: 'active' } }),
          db.promo_usage.count({ where: usageWhere }),
          db.promo_usage.sum('discountApplied', {
            where: usageWhere
          })
        ])

      return res.status(200).json({
        success: true,
        message: 'Success get campaign stats',
        data: {
          totalCampaigns,
          activeCampaigns,
          totalUsage,
          totalDiscountGiven: totalDiscountGiven || 0
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async autoActivateCampaigns(req, res) {
    try {
      const now = new Date()

      const campaignsToActivate = await db.promo_campaign.findAll({
        where: {
          autoActivate: true,
          status: 'draft',
          startDate: { [Op.lte]: now },
          endDate: { [Op.gte]: now }
        }
      })

      let activatedCount = 0
      for (const campaign of campaignsToActivate) {
        await campaign.update({ status: 'active', modifiedBy: req.user?.id })
        emitToStore(campaign.store, 'promo:activated', campaign)
        activatedCount++
      }

      const campaignsToExpire = await db.promo_campaign.findAll({
        where: {
          status: 'active',
          endDate: { [Op.lt]: now }
        }
      })

      let expiredCount = 0
      for (const campaign of campaignsToExpire) {
        await campaign.update({ status: 'expired', modifiedBy: req.user?.id })
        emitToStore(campaign.store, 'promo:expired', campaign)
        expiredCount++
      }

      return res.status(200).json({
        success: true,
        message: 'Auto-activation completed',
        data: {
          activated: activatedCount,
          expired: expiredCount
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // ponytail: public endpoint — tanpa auth, khusus tampilkan promo aktif untuk customer app
  async getCustomerActivePromos(req, res) {
    try {
      const { store } = req.query
      const now = new Date()
      const currentDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()]
      const currentTime = now.toTimeString().slice(0, 8)

      const where = {
        status: 'active',
        startDate: { [Op.lte]: now },
        endDate: { [Op.gte]: now }
      }

      if (store && store !== '') {
        const storeId = Number(store)
        if (!isNaN(storeId)) {
          where[Op.or] = [
            { store: { [Op.contains]: [storeId] } },
            { store: null }
          ]
        }
      }

      const campaigns = await db.promo_campaign.findAll({
        where,
        order: [
          ['priority', 'DESC'],
          ['createdAt', 'DESC']
        ],
        limit: 3,
        attributes: [
          'id', 'name', 'description', 'code', 'type',
          'discountType', 'discountValue', 'maxDiscount', 'minPurchase',
          'startDate', 'endDate', 'startTime', 'endTime',
          'daysOfWeek', 'applicableTo', 'priority'
        ]
      })

      const filtered = campaigns.filter((c) => {
        if (c.startTime && c.endTime) {
          if (currentTime < c.startTime || currentTime > c.endTime) return false
        }
        if (c.daysOfWeek && Array.isArray(c.daysOfWeek) && c.daysOfWeek.length > 0) {
          if (!c.daysOfWeek.includes(currentDay)) return false
        }
        return true
      })

      return res.status(200).json({
        success: true,
        message: 'Success get customer active promos',
        data: filtered
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = promoController
