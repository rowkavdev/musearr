import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
const PASSWORD_KEY_LENGTH = 64
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64')
  if (key.byteLength !== 32) {
    throw new Error('MUSEARR_ENCRYPTION_KEY must be a base64-encoded 32-byte key.')
  }

  return key
}

function derivePasswordKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }
      resolve(derivedKey)
    })
  })
}

export function encryptSecret(plaintext: string, encodedKey: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', decodeKey(encodedKey), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function decryptSecret(ciphertext: string, encodedKey: string): string {
  const [version, ivValue, tagValue, encryptedValue] = ciphertext.split('.')
  if (version !== 'v1' || !ivValue || !tagValue || encryptedValue === undefined) {
    throw new Error('The encrypted value is malformed or uses an unsupported version.')
  }

  const decipher = createDecipheriv('aes-256-gcm', decodeKey(encodedKey), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ])

  return plaintext.toString('utf8')
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await derivePasswordKey(password, salt, PASSWORD_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  })

  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelization, saltValue, derivedValue] = encodedHash.split('$')
  if (
    algorithm !== 'scrypt' ||
    !cost ||
    !blockSize ||
    !parallelization ||
    !saltValue ||
    !derivedValue
  ) {
    return false
  }

  const expected = Buffer.from(derivedValue, 'base64url')
  const actual = await derivePasswordKey(password, Buffer.from(saltValue, 'base64url'), expected.byteLength, {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelization),
    maxmem: 64 * 1024 * 1024,
  })

  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}
