process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const { translateMessage, languageFrom } = require('../api/i18n/translate')

describe('translateMessage', () => {
  test('a catalogued English message reads in Indonesian, and stays in English', () => {
    expect(translateMessage('Supplier not found', 'id')).toBe('Supplier tidak ditemukan')
    expect(translateMessage('Supplier not found', 'en')).toBe('Supplier not found')
  })

  test('a catalogued Indonesian message reads in English, and stays in Indonesian', () => {
    expect(translateMessage('Karyawan tidak ditemukan', 'en')).toBe('Employee not found')
    expect(translateMessage('Karyawan tidak ditemukan', 'id')).toBe('Karyawan tidak ditemukan')
  })

  test('runtime messages are translated with their values', () => {
    expect(
      translateMessage('Insufficient stock for ingredient "Gula": have 2, need 5', 'id')
    ).toBe('Stok bahan baku "Gula" tidak cukup: tersedia 2, dibutuhkan 5')
    expect(translateMessage('Stok "Bakso" tidak mencukupi. Tersedia: 1, diminta: 3', 'en')).toBe(
      'Not enough stock of "Bakso". Available: 1, requested: 3'
    )
  })

  test('validation issues are translated per field', () => {
    expect(translateMessage('discount: must not be negative; name: maksimal 100 karakter', 'en')).toBe(
      'discount: must not be negative; name: at most 100 characters'
    )
    expect(translateMessage('store: Required', 'id')).toBe('store: wajib diisi')
  })

  test('an unknown message is returned as written', () => {
    expect(translateMessage('Something nobody catalogued', 'id')).toBe('Something nobody catalogued')
  })

  test('the language is the first supported tag, Indonesian otherwise', () => {
    expect(languageFrom('en-US,en;q=0.9')).toBe('en')
    expect(languageFrom('id-ID,id;q=0.9')).toBe('id')
    expect(languageFrom('fr-FR')).toBe('id')
  })
})

describe('error responses follow Accept-Language', () => {
  const protectedPath = '/supplier'

  test('Indonesian when asked for id', async () => {
    const res = await request(app).get(protectedPath).set('Accept-Language', 'id')
    expect(res.status).toBe(401)
    expect(res.headers['content-language']).toBe('id')
    expect(res.body.message).toBe('User Belum Login')
  })

  test('English when asked for en', async () => {
    const res = await request(app).get(protectedPath).set('Accept-Language', 'en-US,en;q=0.9')
    expect(res.status).toBe(401)
    expect(res.headers['content-language']).toBe('en')
    expect(res.body.message).toBe('You are not signed in')
  })

  test('as written when the client names no language', async () => {
    const res = await request(app).get(protectedPath)
    expect(res.status).toBe(401)
    expect(res.headers['content-language']).toBeUndefined()
    expect(res.body.message).toBe('User Belum Login')
  })
})
