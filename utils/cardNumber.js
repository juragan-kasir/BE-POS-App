// BA DR-28 decision 5: a payment row keeps only the last 4 digits of a card
// number, never the full number. Anything else in the value (spaces, dashes,
// a masked '****' prefix) is dropped; no digits at all means no card number.
const lastFourDigits = (value) => {
  if (value === undefined || value === null) return null
  const digits = String(value).replace(/\D/g, '')
  return digits === '' ? null : digits.slice(-4)
}

module.exports = { lastFourDigits }
