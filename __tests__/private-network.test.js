const { isPrivateAddress } = require('../utils/privateNetwork')

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.5.4',
    '172.31.255.254',
    '192.168.1.10',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fc00::abcd'
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  test.each([
    '8.8.8.8',
    '172.32.0.1',
    '172.15.255.255',
    '2001:4860:4860::8888',
    '',
    null,
    undefined,
    'not-an-ip'
  ])('%s is not private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
})
