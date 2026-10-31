// ponytail: sumber tunggal kebijakan CORS untuk Express & Socket.IO.
// Produksi ketat via CORS_ORIGIN env (+FRONTEND_URL), dev bebas untuk
// localhost/127.0.0.1 dengan port apa pun agar tidak kena CORS saat Vite
// pindah port atau diakses via 127.0.0.1.

const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  [
    // Production Admin Website
    'https://bisa-nota-demo.vercel.app',
    // Production Order Website
    'https://order-app-dun.vercel.app',
    // Local Development Admin Website
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    // Local Development Order Website
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ].join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

if (process.env.FRONTEND_URL && !allowedOrigins.includes(process.env.FRONTEND_URL)) {
  allowedOrigins.push(process.env.FRONTEND_URL)
}

// ponytail: URL constructor, bukan regex (Codacy: hindari pola rawan ReDoS)
const isDevLocalhost = (origin) => {
  if (process.env.NODE_ENV === 'production') return false
  try {
    const url = new URL(origin)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

const corsOriginCheck = (origin, callback) => {
  // !origin = request non-browser (curl/mobile/same-origin) -> izinkan
  if (!origin || allowedOrigins.includes(origin) || isDevLocalhost(origin)) {
    return callback(null, true)
  }
  // ponytail: tolak tanpa melempar error agar tidak membanjiri log & tidak bocor
  return callback(null, false)
}

const corsOptions = {
  origin: corsOriginCheck,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Accept-Language',
    'Origin'
  ],
  exposedHeaders: ['Content-Language'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}

module.exports = { allowedOrigins, corsOriginCheck, corsOptions }
