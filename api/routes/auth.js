const express = require('express')
const rateLimit = require('express-rate-limit')
const authController = require('../controller/auth')

// ponytail: 30 login attempts per 15min window (per-IP; POS terminals behind
// NAT share one IP, so a store-wide shift change must not lock everyone out)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: 'Too many login attempts, try again later.'
  }
})

// Reset-password requests are limited harder to prevent abuse/account probing.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: 'Too many reset requests, try again later.'
  }
})

const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const { loginSchema, registerSchema } = require('../validation/schemas')

const fs = require('fs')
const multer = require('multer')

const uploadDir = '/tmp/uploads'

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
})

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }
}).single('image')

const router = express.Router()

// Login Post
router.post('/login', loginLimiter, validate(loginSchema), authController.login)

// DR-24 D-08: public self-registration is closed — staff accounts are
// created by the owner (Employee → Add). The route answers only when it is
// explicitly opened with PUBLIC_REGISTRATION_ENABLED=true (e.g. a local
// demo); read per request so the switch needs no redeploy-time code path.
const requirePublicRegistration = (req, res, next) => {
  if (process.env.PUBLIC_REGISTRATION_ENABLED === 'true') return next()
  return res.status(403).json({
    code: 'REGISTRATION_CLOSED',
    message: 'Pendaftaran akun mandiri ditutup. Akun karyawan dibuat oleh pemilik toko.'
  })
}

// Register (public — closed unless explicitly enabled, see above)
router.post(
  '/register',
  requirePublicRegistration,
  validate(registerSchema),
  authController.registerNewUser
)

// Get User By Location (all authenticated users)
// CRIT-2: validateStoreAccess pins req.storeId from the trusted token; the
// controller never lets a caller-omitted `location` widen beyond their store.
router.get(
  '/get-user',
  authorization,
  validateStoreAccess,
  authController.userByLocation
)

// Get All User - Super Admin only
router.get(
  '/get-all-user',
  authorization,
  requireRole('super_admin'),
  authController.getAllUser
)

// Change Role User By Id & Location - Admin/Super Admin
router.put(
  '/change-profile-user',
  authorization,
  requireRole('super_admin', 'admin'),
  authController.changeUserByIdAndLocation
)

// Change User Status (activate/deactivate) By Id - Admin/Super Admin
router.put(
  '/change-user-status',
  authorization,
  requireRole('super_admin', 'admin'),
  authController.changeUserStatusById
)

// Generate Employee ID
router.get(
  '/generate-employee-id',
  authorization,
  authController.generateEmployeeId
)

// Reset Password - step 1: request a reset token (public, rate-limited)
router.post(
  '/reset-password/request',
  resetLimiter,
  authController.requestResetPassword
)

// Reset Password - step 2: redeem the emailed token (public, rate-limited)
router.post('/reset-password', resetLimiter, authController.resetPassword)

// Edit User - based on role
router.put('/edit-user', authorization, upload, authController.editUser)

// Logout
router.post('/logout', authorization, authController.logout)

module.exports = router
