const express = require('express')
const router = express.Router()
const posController = require('../controller/pos')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { requireCapability } = require('../../utils/financialCapabilities')
const { validate } = require('../middleware/validate')
const {
  createPosTransferSchema,
  createPosAdjustSchema,
  createPosReturnSchema,
  createSalesReturnSchema,
  updatePriceByStoreSchema,
  sendInvoiceWaSchema,
  sendInvoiceEmailSchema,
  addBatchSchema
} = require('../validation/schemas')

// Barcode lookup untuk POS scan
router.get(
  '/lookup-barcode',
  authorization,
  validateStoreAccess,
  posController.lookupBarcode
)

// Stock transfer antar toko — sent → received / cancelled
router.post(
  '/transfer',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPosTransferSchema),
  posController.transfer
)
router.get(
  '/transfer-history',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.getTransferHistory
)
router.get(
  '/transfer/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.getTransferById
)
router.put(
  '/transfer/:id/receive',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.receiveTransfer
)
router.put(
  '/transfer/:id/cancel',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.cancelTransfer
)

// Stock adjustment
router.post(
  '/adjust',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPosAdjustSchema),
  posController.adjust
)

// Purchase order return
router.post(
  '/purchase-order/:id/return',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPosReturnSchema),
  posController.returnPurchaseOrder
)

// Sales order return
router.post(
  '/order/:id/return',
  authorization,
  validateStoreAccess,
  requireCapability('refund.request', { entity: 'sales_return', entityIdFrom: (req) => req.params.id }),
  validate(createSalesReturnSchema),
  posController.returnSalesOrder
)

// Loyalty points
router.get(
  '/member/:id/point-history',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.getPointHistory
)

// Dashboard data
router.get(
  '/dashboard/summary',
  authorization,
  validateStoreAccess,
  posController.getDashboardSummary
)

// Super Admin global dashboard
router.get(
  '/dashboard/super-admin',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  posController.getSuperAdminDashboard
)

// Multi-store product price
router.get(
  '/product/price-by-store',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.getPriceByStore
)
router.put(
  '/product/update-price-by-store',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updatePriceByStoreSchema),
  posController.updatePriceByStore
)

// Digital receipt (WA)
// Text only (no send) — opened through wa.me on the cashier's WhatsApp.
router.get(
  '/invoice/wa-text/:orderId',
  authorization,
  validateStoreAccess,
  posController.getInvoiceWhatsAppText
)
router.post(
  '/invoice/send-wa',
  authorization,
  validateStoreAccess,
  validate(sendInvoiceWaSchema),
  posController.sendInvoiceWhatsApp
)
router.post(
  '/invoice/send-email',
  authorization,
  validateStoreAccess,
  validate(sendInvoiceEmailSchema),
  posController.sendInvoiceEmail
)

// WhatsApp connection management
router.get(
  '/whatsapp/status',
  authorization,
  validateStoreAccess,
  posController.getWhatsAppStatus
)
router.post(
  '/whatsapp/logout',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.logoutWhatsApp
)
router.post(
  '/whatsapp/restart',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.restartWhatsApp
)

// Stock by batch/expiry
router.post(
  '/product/add-batch',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(addBatchSchema),
  posController.addBatch
)
router.get(
  '/product/batches',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  posController.getBatches
)

module.exports = router
