const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('reservation.js'))
const reservationController = require('../controller/reservation')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createReservationSchema,
  updateReservationSchema
} = require('../validation/schemas')

router.get(
  '/',
  authorization,
  validateStoreAccess,
  reservationController.getAll
)
router.get(
  '/available-tables/list',
  authorization,
  validateStoreAccess,
  reservationController.getAvailableTables
)
router.get(
  '/:id',
  authorization,
  validateStoreAccess,
  reservationController.getById
)

router.post(
  '/',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createReservationSchema),
  reservationController.create
)
router.put(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateReservationSchema),
  reservationController.update
)
router.delete(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  reservationController.remove
)

module.exports = router
