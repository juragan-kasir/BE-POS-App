'use strict'

const { ZodError } = require('zod')
const { hasSalonPermission } = require('../../../utils/salonCapabilities')
const { SalonError, resolveSalonActor, resolveSalonStore } = require('../../service/salonContext')

// One wrapper for every /salon/* handler, so each route states its permission
// and outlet need in one place and every error has the contract body
// { code, message, details? } (FE-SALON-App ApiErrorBody).
//
//   salonRoute({ perm: 'appointment.manage', store: true }, async (c) => …)
//
// c = { req, user, salon, store (location row | undefined), body, query, params }

const fail = (res, status, code, message, details) =>
  res.status(status).json({ code, message, ...(details ? { details } : {}) })

const salonRoute = ({ perm = null, store = false } = {}, handler) => async (req, res) => {
  try {
    if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk lagi')
    const salon = await resolveSalonActor(req)
    if (perm && !hasSalonPermission(req.user, perm)) {
      return fail(res, 403, 'FORBIDDEN', 'Kamu tidak punya akses untuk aksi ini', {
        required: Array.isArray(perm) ? perm : [perm]
      })
    }
    const activeStore = store ? resolveSalonStore(salon, req.query?.store ?? req.body?.store) : undefined
    const result = await handler({
      req,
      user: req.user,
      salon,
      store: activeStore,
      body: req.body || {},
      query: req.query || {},
      params: req.params || {}
    })
    if (result && result.__status) return res.status(result.__status).json(result.body)
    return res.status(200).json(result ?? { ok: true })
  } catch (err) {
    if (err instanceof SalonError) return fail(res, err.status, err.code, err.message, err.details)
    if (err instanceof ZodError) {
      return fail(res, 400, 'VALIDATION_FAILED', 'Data tidak valid', {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      })
    }
    console.error('[salon]', err)
    return fail(res, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan server')
  }
}

/** Reply with a non-200 status from a handler: return created(body). */
const withStatus = (status, body) => ({ __status: status, body })

module.exports = { salonRoute, withStatus, fail }
