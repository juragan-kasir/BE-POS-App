const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = rateLimit

const createUserEndpointLimiter = ({ windowMs, max }) =>
  rateLimit({
    windowMs,
    max,
    keyGenerator: (req) => {
      const userId = req.user?.id
      return userId ? `endpoint-user:${userId}` : ipKeyGenerator(req.ip)
    },
    message: {
      success: false,
      message: 'Too many requests, please try again later.'
    }
  })

module.exports = { createUserEndpointLimiter }
