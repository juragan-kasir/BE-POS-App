'use strict'

// Salon & barbershop API (SALON-BARBERSHOP-PLAN §3.2). Every handler goes
// through controller/salon/http.js salonRoute(), which resolves the salon
// tenant + outlet from the session and checks the salon permission.
const express = require('express')
const router = express.Router()
const authorization = require('../../utils/authorization')
const context = require('../controller/salon/context')
const settings = require('../controller/salon/settings')
const catalog = require('../controller/salon/catalog')
const staff = require('../controller/salon/staff')
const hr = require('../controller/salon/hr')
const customers = require('../controller/salon/customers')
const appointments = require('../controller/salon/appointments')
const shift = require('../controller/salon/shift')
const checkout = require('../controller/salon/checkout')
const me = require('../controller/salon/me')

router.use(authorization)

router.get('/context', context.getContext)

// pengaturan & outlet
router.patch('/settings', settings.updateSettings)
router.post('/stores', settings.createStore)
router.patch('/stores/:id', settings.updateStore)
router.put('/stores/:id/owner-pin', settings.setOwnerPin)
router.delete('/stores/:id/owner-pin', settings.clearOwnerPin)

// katalog
router.get('/services', catalog.listServices)
router.post('/services', catalog.createService)
router.patch('/services/:id', catalog.updateService)
router.get('/products', catalog.listProducts)
router.post('/products', catalog.createProduct)
router.patch('/products/:id', catalog.updateProduct)

// staff
router.get('/staff', staff.listStaff)
router.post('/staff', staff.createStaff)
router.put('/staff/:userId/profile', staff.updateProfile)
router.put('/staff/:userId/skills', staff.updateSkills)
router.put('/staff/:userId/availability', staff.updateAvailability)
router.post('/staff/:userId/time-off', staff.addTimeOff)
router.delete('/staff/:userId/time-off/:id', staff.removeTimeOff)

// SDM: jabatan & shift kerja
router.get('/positions', hr.listPositions)
router.post('/positions', hr.createPosition)
router.patch('/positions/:id', hr.updatePosition)
router.delete('/positions/:id', hr.deletePosition)
router.get('/work-shifts', hr.listWorkShifts)
router.post('/work-shifts', hr.createWorkShift)
router.patch('/work-shifts/:id', hr.updateWorkShift)
router.delete('/work-shifts/:id', hr.deleteWorkShift)

// pelanggan
router.get('/customers', customers.listCustomers)
router.post('/customers', customers.createCustomer)
router.patch('/customers/:id', customers.updateCustomer)
router.get('/customers/:id/history', customers.customerHistory)

// jadwal
router.get('/slots', appointments.listSlots)
router.get('/appointments', appointments.listAppointments)
router.post('/appointments', appointments.createAppointment)
router.get('/appointments/:id', appointments.getAppointment)
router.post('/appointments/:id/reschedule', appointments.rescheduleAppointment)
for (const [transition, handler] of Object.entries(appointments.transitions)) {
  router.post(`/appointments/:id/${transition}`, handler)
}
router.get('/appointments/:id/wa-text', appointments.waText)

// kasir: shift (= cash register outlet), checkout, order hari ini, refund
router.get('/shift/current', shift.currentShift)
router.get('/shifts', shift.listShifts)
router.post('/shift/open', shift.openShift)
router.post('/shift/close', shift.closeShift)
router.post('/checkout/quote', checkout.quote)
router.post('/checkout', checkout.checkout)
router.get('/orders', checkout.listOrders)
router.post('/orders/:id/refund', checkout.refund)

// S2-b: stylist phone app (own data only) and shift-swap approval.
router.get('/me/schedule', me.schedule)
router.get('/me/commission', me.commission)
router.get('/me/attendance', me.attendance)
router.post('/me/attendance', me.clock)
router.get('/me/shift-swaps', me.mySwaps)
router.get('/me/shift-swaps/candidates', me.swapCandidates)
router.post('/me/shift-swaps', me.requestSwap)
router.post('/me/shift-swaps/:id/cancel', me.cancelSwap)
router.get('/shift-swaps', me.listSwaps)
router.patch('/shift-swaps/:id', me.decideSwap)

module.exports = router
