'use strict'

const { z } = require('zod')

// Request schemas of the /salon/* API, ported 1:1 from FE-SALON-App
// src/api/contract.ts (the S0 contract draft). Keep both files in sync: the
// FE parses every response with the same shapes, so a drift fails loudly.

const Money = z.number().int().nonnegative()
const Id = z.union([z.string().min(1), z.number().int().positive()]).transform(String)
const IsoDateTime = z.iso.datetime({ offset: true })
const IsoDate = z.iso.date()
const HHmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:mm')
const Phone = z
  .string()
  .trim()
  .regex(/^(\+62|62|0)8\d{7,12}$/, 'Nomor HP Indonesia, mis. 0812xxxx')

const StaffLevel = z.enum(['junior', 'senior', 'master'])
const SalonProfile = z.enum(['salon', 'barbershop', 'spa'])

const Commission = z
  .object({
    type: z.enum(['percent', 'flat']),
    value: z.number().nonnegative()
  })
  .refine((c) => c.type !== 'percent' || c.value <= 100, {
    message: 'Komisi persen maksimal 100',
    path: ['value']
  })
  .refine((c) => c.type !== 'flat' || Number.isInteger(c.value), {
    message: 'Komisi nominal harus rupiah bulat',
    path: ['value']
  })

// ---------- katalog ----------
const ServiceConfig = z.object({
  durationMin: z.number().int().min(5).max(600),
  bufferMin: z.number().int().min(0).max(120),
  levelPrices: z.object({ junior: Money, senior: Money, master: Money }),
  commission: Commission
})

const ServiceInput = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 huruf').max(80),
  category: z.string().trim().min(2, 'Kategori wajib diisi').max(40),
  basePrice: Money,
  serviceConfig: ServiceConfig,
  active: z.boolean()
})

const RetailProductInput = z.object({
  name: z.string().trim().min(2).max(80),
  price: Money,
  stock: z.number().int().min(0).max(100000),
  commission: Commission,
  active: z.boolean()
})

// ---------- staff ----------
const StaffSkill = z.object({
  productId: Id,
  durationOverride: z.number().int().min(5).max(600).nullable(),
  priceOverride: Money.nullable()
})

const Availability = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: HHmm,
  endTime: HHmm
})

const StaffInput = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 huruf').max(60),
  username: z
    .string()
    .trim()
    .min(3, 'Username minimal 3 huruf')
    .max(30)
    .regex(/^[a-z0-9_.]+$/, 'Huruf kecil, angka, titik, garis bawah'),
  position: z.string().trim().min(2).max(40),
  positionId: Id.nullable(),
  level: StaffLevel,
  colorTag: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  acceptsOnline: z.boolean(),
  active: z.boolean(),
  commissionOverride: Commission.nullable()
})
const StaffProfileInput = StaffInput.omit({ username: true })

const TimeOffInput = z
  .object({ startAt: IsoDateTime, endAt: IsoDateTime, reason: z.string().trim().min(2).max(120) })
  .refine((v) => new Date(v.endAt) > new Date(v.startAt), {
    message: 'Selesai harus setelah mulai',
    path: ['endAt']
  })

// ---------- SDM ----------
const PositionInput = z.object({
  name: z.string().trim().min(2, 'Nama jabatan minimal 2 huruf').max(40),
  description: z.string().trim().max(160),
  active: z.boolean()
})

const WorkShiftInput = z
  .object({
    name: z.string().trim().min(2, 'Nama shift minimal 2 huruf').max(60),
    type: z.enum(['harian', 'mingguan']),
    startDate: IsoDate,
    endDate: IsoDate.nullable(),
    startTime: HHmm,
    endTime: HHmm,
    employeeIds: z.array(Id).max(200),
    status: z.enum(['draft', 'active', 'inactive'])
  })
  .refine((v) => v.endTime > v.startTime, { message: 'Jam selesai harus setelah jam mulai', path: ['endTime'] })
  .refine((v) => (v.type === 'harian' ? v.endDate === null : !!v.endDate && v.endDate >= v.startDate), {
    message: 'Shift mingguan wajib punya tanggal selesai setelah tanggal mulai',
    path: ['endDate']
  })

const WorkShiftRange = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional()
})

// ---------- pengaturan ----------
const SettingsInput = z.object({
  salonProfile: SalonProfile,
  slotStepMin: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30)]),
  depositDefault: Money,
  pointsPer: z.number().int().min(1000).max(1000000)
})

const StoreInput = z
  .object({
    name: z.string().trim().min(3, 'Nama outlet minimal 3 huruf').max(60),
    address: z.string().trim().max(160),
    phone: z.union([Phone, z.literal('')]),
    timezone: z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']),
    openTime: HHmm,
    closeTime: HHmm,
    active: z.boolean()
  })
  .refine((v) => v.closeTime > v.openTime, { message: 'Jam tutup harus setelah jam buka', path: ['closeTime'] })

// Owner PIN (BR-SLN-015): 4–6 digits, not one repeated digit and not a
// straight run (1234, 987654), the first guesses of anyone trying.
const isGuessablePin = (pin) => {
  if (/^(\d)\1+$/.test(pin)) return true
  const steps = [...pin].slice(1).map((d, i) => Number(d) - Number(pin[i]))
  return steps.every((x) => x === 1) || steps.every((x) => x === -1)
}
const OwnerPinInput = z.object({
  pin: z
    .string()
    .regex(/^\d{4,6}$/, 'PIN 4–6 angka')
    .refine((pin) => !isGuessablePin(pin), 'PIN terlalu mudah ditebak (angka sama atau berurutan)')
})

// ---------- pelanggan ----------
const CustomerInput = z.object({
  name: z.string().trim().min(2, 'Nama minimal 2 huruf').max(60),
  phone: Phone,
  notes: z.string().max(500)
})

// ---------- jadwal ----------
const PaymentMethod = z.enum(['cash', 'qris', 'transfer', 'card'])
const AppointmentSource = z.enum(['walk_in', 'phone', 'online'])

const SlotQuery = z.object({
  date: IsoDate,
  serviceIds: z.array(Id).min(1).max(6),
  staffId: Id.nullable()
})

const DateRange = z
  .object({ from: IsoDate, to: IsoDate })
  .refine((v) => v.to >= v.from, { message: 'Tanggal akhir harus setelah tanggal awal', path: ['to'] })

const AppointmentInput = z.object({
  serviceIds: z.array(Id).min(1, 'Pilih minimal satu layanan').max(6),
  staffId: Id.nullable(),
  startAt: IsoDateTime,
  memberId: Id.nullable(),
  customerName: z.string().trim().min(2, 'Nama minimal 2 huruf').max(60),
  customerPhone: z.union([Phone, z.literal('')]),
  source: AppointmentSource,
  depositAmount: Money,
  depositMethod: PaymentMethod.nullable(),
  notes: z.string().max(300),
  idempotencyKey: z.string().min(8).max(100)
})

const RescheduleInput = z.object({ startAt: IsoDateTime, staffId: Id })

const TRANSITIONS = ['confirm', 'check-in', 'start', 'complete', 'no-show', 'cancel']
const TransitionInput = z.object({ reason: z.string().max(200).nullable() })

const WaTextQuery = z.object({ kind: z.enum(['reminder', 'thanks']).default('reminder') })

// ---------- kasir (S2-a) ----------
const CartExtra = z.object({ productId: Id, qty: z.number().int().min(1).max(99), staffId: Id.nullable() })

const Discount = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('percent'), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal('amount'), value: Money })
])

const QuoteInput = z.object({
  appointmentId: Id.nullable(),
  extras: z.array(CartExtra).max(30),
  tip: z.object({ amount: Money, staffId: Id.nullable() }),
  discount: Discount
})

const PaymentInput = z.object({
  method: PaymentMethod,
  amount: Money,
  tendered: Money.nullable(),
  reference: z.string().trim().max(60).nullable()
})

const CheckoutInput = QuoteInput.extend({
  payments: z.array(PaymentInput).max(4),
  customerName: z.string().trim().max(60),
  memberId: Id.nullable(),
  idempotencyKey: z.string().min(8).max(100)
})

const RefundInput = z.object({
  reason: z.string().trim().min(5, 'Alasan minimal 5 huruf').max(200),
  ownerPin: z.string().regex(/^\d{4,6}$/, 'PIN 4–6 angka').nullable()
})

const OpenShiftInput = z.object({ openingCash: Money })
const CloseShiftInput = z.object({ countedCash: Money })
const OrdersQuery = z.object({ date: IsoDate.optional() })

// ---------- antrian walk-in (S2-b) ----------
const QueueInput = z.object({
  customerName: z.string().trim().min(2, 'Nama minimal 2 huruf').max(60),
  customerPhone: z.union([Phone, z.literal('')]),
  memberId: Id.nullable(),
  serviceIds: z.array(Id).min(1, 'Pilih minimal satu layanan').max(6),
  preferredStaffId: Id.nullable(),
  idempotencyKey: z.string().min(8).max(100)
})
const QueueCallInput = z.object({ staffId: Id.nullable().optional().default(null) })

// ---------- HP stylist: absensi & tukar shift (S2-b) ----------
const DateQuery = z.object({ date: IsoDate.optional() })
const AttendanceInput = z.object({
  store: Id,
  shiftId: Id.nullable(),
  type: z.enum(['check_in', 'check_out']),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().max(100000),
  note: z.string().trim().max(200).optional().default(''),
  idempotencyKey: z.string().min(8).max(100)
})
const ShiftSwapInput = z.object({
  requesterShiftId: Id,
  targetShiftId: Id,
  targetId: Id,
  date: IsoDate,
  note: z.string().trim().max(200).optional().default(''),
  idempotencyKey: z.string().min(8).max(100)
})
const ShiftSwapDecisionInput = z.object({ decision: z.enum(['approved', 'rejected']) })
const ShiftSwapListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional()
})

module.exports = {
  Money,
  Id,
  HHmm,
  Phone,
  Commission,
  ServiceConfig,
  ServiceInput,
  RetailProductInput,
  StaffSkill,
  Availability,
  StaffInput,
  StaffProfileInput,
  TimeOffInput,
  PositionInput,
  WorkShiftInput,
  WorkShiftRange,
  SettingsInput,
  StoreInput,
  OwnerPinInput,
  CustomerInput,
  PaymentMethod,
  SlotQuery,
  DateRange,
  AppointmentInput,
  RescheduleInput,
  TRANSITIONS,
  TransitionInput,
  CartExtra,
  Discount,
  QuoteInput,
  PaymentInput,
  CheckoutInput,
  RefundInput,
  OpenShiftInput,
  CloseShiftInput,
  OrdersQuery,
  DateQuery,
  QueueInput,
  QueueCallInput,
  AttendanceInput,
  ShiftSwapInput,
  ShiftSwapDecisionInput,
  ShiftSwapListQuery,
  WaTextQuery
}
