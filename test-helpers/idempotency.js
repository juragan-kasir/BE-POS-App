// BA gap 005 (DR-23 §K): a counter sale (POST /order/create) requires an
// idempotency key. Tests that do not exercise idempotency itself send their
// body through this helper, which adds a fresh key only when the body has
// none — an explicit key (or an explicit absence under test) is untouched.
let seq = 0

const withIdempotencyKey = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  if (Object.prototype.hasOwnProperty.call(body, 'idempotencyKey')) return body
  seq += 1
  return { ...body, idempotencyKey: `test-sale-${process.pid}-${Date.now()}-${seq}` }
}

module.exports = { withIdempotencyKey }
