// Field-length standard (BA DR-28, 2026-10-24): the most characters a field
// of each kind accepts. Same values as the FE (FE-POS-App
// src/constants/fieldLimits.js) — the BE limit is the one that holds, the FE
// only stops typing earlier. Notes and descriptions accept 255 here; the FE
// stops a one-line note at 140.
//
// A column still narrower than the standard keeps its current length until
// it is widened (DR-28 step 4): URL_COLUMN, ACCOUNT_CODE, CURRENCY_CODE,
// LEAD_TIME_UNIT.
const FIELD_MAX = Object.freeze({
  PERSON_NAME: 100,
  BUSINESS_NAME: 150,
  SHORT_LABEL: 50,
  UNIT: 20,
  REGION: 50,
  POSTAL_CODE: 10,
  ADDRESS: 255,
  PHONE: 20,
  EMAIL: 254,
  DOCUMENT_NUMBER: 50,
  CODE: 50,
  BARCODE: 50,
  REFERENCE: 255,
  NPWP: 20,
  NITKU: 22,
  BANK_ACCOUNT: 34,
  VEHICLE_PLATE: 15,
  HEX_COLOR: 9,
  TEXT: 255,
  // narrower columns (current DB length)
  URL_COLUMN: 255,
  ACCOUNT_CODE: 20,
  CURRENCY_CODE: 10,
  LEAD_TIME_UNIT: 10
})

const tooLong = (max) => `maksimal ${max} karakter`

module.exports = { FIELD_MAX, tooLong }
