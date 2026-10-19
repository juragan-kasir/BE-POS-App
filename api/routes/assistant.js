'use strict'
const crypto = require('crypto')
const express = require('express')
const { z } = require('zod')
const authorization = require('../../utils/authorization')
const { requireCanonicalPermission } = require('../../utils/authorization')
const { authorizationContextMiddleware } = require('../../utils/authorizationContextMiddleware')
const { validate } = require('../middleware/validate')
const controller = require('../controller/assistant')

const router = express.Router()

// Service-to-service auth for the AI assistant (ai-business-core).
// Fail closed: without ASSISTANT_SERVICE_SECRET (min. 32 chars) every call is
// refused with 503, so deploying this code exposes nothing until configured.
const MIN_SECRET_LENGTH = 32
const MAX_RANGE_DAYS = 92

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest()

const requireAssistantSecret = (req, res, next) => {
  const secret = process.env.ASSISTANT_SERVICE_SECRET
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return res.status(503).json({
      code: 'ASSISTANT_NOT_CONFIGURED',
      message: 'Assistant endpoints are not configured'
    })
  }
  const header = req.get('authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!presented || !crypto.timingSafeEqual(digest(presented), digest(secret))) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
  }
  return next()
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

const storeParamsSchema = z.object({ storeId: z.coerce.number().int().positive() })

const stockQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  lowOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(50).default(20)
})

const rangeQuerySchema = z
  .object({
    from: dateStr.optional(),
    to: dateStr.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10)
  })
  .refine((r) => !r.from || !r.to || r.from <= r.to, { message: 'from must be before to', path: ['from'] })
  .refine(
    (r) => !r.from || !r.to || (Date.parse(r.to) - Date.parse(r.from)) / 86400000 < MAX_RANGE_DAYS,
    { message: `Range must be at most ${MAX_RANGE_DAYS} days`, path: ['to'] }
  )

const service = [requireAssistantSecret, validate(storeParamsSchema, 'params')]

router.get('/stores/:storeId/summary', ...service, controller.getSummary)
router.get('/stores/:storeId/stock', ...service, validate(stockQuerySchema, 'query'), controller.getStock)
router.get('/stores/:storeId/sales', ...service, validate(rangeQuerySchema, 'query'), controller.getSales)
router.get(
  '/stores/:storeId/best-sellers',
  ...service,
  validate(rangeQuerySchema, 'query'),
  controller.getBestSellers
)

// Owner-facing: connect / inspect / disconnect the store's Telegram assistant.
const owner = [
  authorization,
  authorizationContextMiddleware,
  requireCanonicalPermission('store.manage', controller.ownerStoreScope)
]

router.post('/telegram-link', ...owner, controller.createTelegramLink)
router.get('/telegram-link', ...owner, controller.getTelegramLink)
router.delete('/telegram-link', ...owner, controller.deleteTelegramLink)

module.exports = router
