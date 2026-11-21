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
  CustomerInput,
  PaymentMethod,
  SlotQuery,
  DateRange,
  AppointmentInput,
  RescheduleInput,
  TRANSITIONS,
  TransitionInput,
  WaTextQuery
}
