import { expect, test } from 'vitest'
import { decryptSecret, encryptSecret } from './secrets.js'

const key = Buffer.alloc(32, 7).toString('base64')

test('authenticated encryption round-trips an empty plaintext', () => {
  const encrypted = encryptSecret('', key)
  expect(encrypted.split('.')).toHaveLength(4)
  expect(decryptSecret(encrypted, key)).toBe('')
})

test('an empty ciphertext still authenticates its tag', () => {
  const fields = encryptSecret('', key).split('.')
  fields[2] = Buffer.alloc(16).toString('base64url')
  expect(() => decryptSecret(fields.join('.'), key)).toThrow()
})

test('a missing ciphertext field is not an empty authenticated ciphertext', () => {
  const fields = encryptSecret('', key).split('.')
  expect(() => decryptSecret(fields.slice(0, 3).join('.'), key)).toThrow(/malformed/)
})
