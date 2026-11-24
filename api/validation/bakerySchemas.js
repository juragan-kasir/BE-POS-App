'use strict'

// Request schemas of /bakery/* — server side of FE-BAKERY-App
// src/api/contract.ts. Same names, same limits.
const { z } = require('zod')

const Money = z.number().int().nonnegative()
const Id = z.union([z.string().min(1), z.number().int().positive()]).transform(String)
const IsoDateTime = z.iso.datetime({ offset: true })
const IsoDate = z.iso.date()
const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:mm')
const BAKERY_STATUSES = ['PENDING_CONFIRMATION', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PICKED_UP', 'DELIVERED', 'CANCELLED']
const BakeryStatus = z.enum(BAKERY_STATUSES)
const PaymentMethod = z.enum(['cash', 'qris', 'transfer', 'card', 'other'])
const optionalText = (max) => z.string().trim().max(max).nullable().optional()

const TenantSettings = z.object({
  leadTimeMinutes: z.number().int().min(0).max(60 * 24 * 30),
  pickupOpen: HHmm,
  pickupClose: HHmm,
  deliveryEnabled: z.boolean(),
  waNoteTemplate: z.string().max(1000),
  waReadyTemplate: z.string().max(1000),
  waReminderTemplate: z.string().max(1000)
}).partial().refine((v) => !v.pickupOpen || !v.pickupClose || v.pickupClose > v.pickupOpen, {
  message: 'Jam tutup harus setelah jam buka',
  path: ['pickupClose']
})

const StoreInput = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']),
  address: optionalText(255),
  phone: optionalText(30),
  active: z.boolean().default(true)
})

const OrderItemInput = z.object({
  productId: Id,
  qty: z.number().positive().max(100000),
  note: optionalText(300)
})

const CreateOrderInput = z.object({
  idempotencyKey: z.string().min(8).max(100),
  memberId: Id.nullable().optional(),
  customerName: z.string().trim().min(1).max(120),
  customerPhone: optionalText(30),
  fulfillmentType: z.enum(['pickup', 'delivery']),
  scheduledAt: IsoDateTime,
  deliveryAddress: optionalText(500),
  deliveryNote: optionalText(300),
  customerNote: optionalText(500),
  adminNote: optionalText(500),
  items: z.array(OrderItemInput).min(1).max(100),
  dpAmount: Money.optional().default(0),
  dpMethod: PaymentMethod.optional(),
  dpNote: optionalText(200)
})

const UpdateStatusInput = z.object({
  status: BakeryStatus,
  reason: optionalText(300),
  idempotencyKey: z.string().min(8).max(100)
})

const AddPaymentInput = z.object({
  amount: Money.min(1),
  method: PaymentMethod,
  note: optionalText(200),
  idempotencyKey: z.string().min(8).max(100)
})

const CancelOrderInput = z.object({
  reason: z.string().trim().min(1).max(300),
  idempotencyKey: z.string().min(8).max(100)
})

const OrdersQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: BakeryStatus.optional(),
  q: z.string().trim().max(100).optional()
})
const DateRange = z.object({ from: IsoDate, to: IsoDate }).refine((v) => v.to >= v.from, { message: 'Tanggal akhir harus setelah tanggal awal', path: ['to'] })
const DateQuery = z.object({ date: IsoDate.optional() })
const WaTextQuery = z.object({ template: z.enum(['note', 'ready', 'reminder']).default('note') })

module.exports = {
  BAKERY_STATUSES,
  TenantSettings,
  StoreInput,
  CreateOrderInput,
  UpdateStatusInput,
  AddPaymentInput,
  CancelOrderInput,
  OrdersQuery,
  DateRange,
  DateQuery,
  WaTextQuery
}
