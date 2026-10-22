const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('goodsRequest.js'))
const goodsRequestController = require('../controller/goodsRequest')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createGoodsRequestSchema,
  updateGoodsRequestSchema
} = require('../validation/schemas')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  goodsRequestController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  goodsRequestController.getById
)

router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createGoodsRequestSchema),
  goodsRequestController.create
)
router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateGoodsRequestSchema),
  goodsRequestController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  goodsRequestController.delete
)
router.patch(
  '/status/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  goodsRequestController.changeStatus
)

module.exports = router
