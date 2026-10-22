const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('promo.js'))
const promoController = require('../controller/promo')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createPromoCampaignSchema,
  updatePromoCampaignSchema,
  applyPromoSchema
} = require('../validation/schemas')

// ─── Promo Campaigns ──────────────────────────────────────────────

router.get(
  '/campaigns',
  authorization,
  validateStoreAccess,
  promoController.getCampaigns
)

router.get(
  '/campaigns/stats',
  authorization,
  validateStoreAccess,
  promoController.getCampaignStats
)

router.get(
  '/campaigns/:id',
  authorization,
  validateStoreAccess,
  promoController.getCampaignById
)

router.post(
  '/campaigns',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPromoCampaignSchema),
  promoController.createCampaign
)

router.put(
  '/campaigns/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updatePromoCampaignSchema),
  promoController.updateCampaign
)

router.put(
  '/campaigns/:id/status',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  promoController.updateCampaignStatus
)

router.delete(
  '/campaigns/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  promoController.deleteCampaign
)

// ponytail: public endpoint — tampilkan promo aktif untuk customer app (no auth)
router.get('/customer-active', promoController.getCustomerActivePromos)

// ─── Promo Apply & Usage ──────────────────────────────────────────

router.post(
  '/apply',
  authorization,
  validateStoreAccess,
  validate(applyPromoSchema),
  promoController.applyPromo
)

router.post(
  '/usage',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin', 'kasir'),
  promoController.recordPromoUsage
)

router.post(
  '/auto-activate',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  promoController.autoActivateCampaigns
)

module.exports = router
