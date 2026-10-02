import { z } from 'zod'

const HttpOriginSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      context.addIssue({ code: 'custom', message: 'Expected an HTTP(S) origin without credentials.' })
    }
  })
  .transform((value) => new URL(value).origin)

const EnvironmentBooleanSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true')

const reconciliationIntervals = [15, 30, 60, 120, 180, 240, 360, 480, 720, 1_440] as const

const ReconciliationIntervalSchema = z
  .coerce
  .number()
  .int()
  .refine((value) => reconciliationIntervals.includes(value as (typeof reconciliationIntervals)[number]), {
    message: `Choose one of: ${reconciliationIntervals.join(', ')} minutes.`,
  })

const IanaTimeZoneSchema = z.string().trim().min(1).superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format()
  } catch {
    context.addIssue({ code: 'custom', message: 'Use a valid IANA timezone, such as Europe/London.' })
  }
})

const DailyBriefTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 08:00.')

const DiscordWebhookUrlSchema = z.string().url().superRefine((value, context) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }
  const isDiscordHost = url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com')
  if (
    url.protocol !== 'https:' ||
    !isDiscordHost ||
    !url.pathname.startsWith('/api/webhooks/') ||
    url.username ||
    url.password ||
    url.search
  ) {
    context.addIssue({ code: 'custom', message: 'Use an HTTPS Discord webhook URL.' })
  }
})

const OptionalPlexWebhookSecretSchema = z
  .union([z.string().min(32).max(256), z.literal('').transform(() => undefined)])
  .optional()

const OptionalHttpUrlSchema = z
  .union([
    z
      .string()
      .trim()
      .url()
      .superRefine((value, context) => {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          context.addIssue({ code: 'custom', message: 'Expected an HTTP(S) URL without credentials.' })
        }
      }),
    z.literal('').transform(() => undefined),
  ])
  .optional()

const OptionalNonEmptyStringSchema = z
  .union([z.string().trim().min(1).max(256), z.literal('').transform(() => undefined)])
  .optional()

const OptionalDiscordWebhookUrlSchema = z
  .union([DiscordWebhookUrlSchema, z.literal('').transform(() => undefined)])
  .optional()

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url().default('postgresql://musearr:musearr@localhost:5432/musearr'),
  MUSEARR_API_HOST: z.string().default('127.0.0.1'),
  MUSEARR_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  MUSEARR_WEB_ORIGIN: HttpOriginSchema.default('http://localhost:3000'),
  MUSEARR_TRUST_PROXY: EnvironmentBooleanSchema,
  MUSEARR_RECONCILIATION_INTERVAL_MINUTES: ReconciliationIntervalSchema.default(360),
  MUSEARR_TIMEZONE: IanaTimeZoneSchema.default('UTC'),
  MUSEARR_DAILY_BRIEF_TIME: DailyBriefTimeSchema.default('08:00'),
  MUSEARR_DISCORD_WEBHOOK_URL: OptionalDiscordWebhookUrlSchema,
  MUSEARR_PLEX_WEBHOOK_SECRET: OptionalPlexWebhookSecretSchema,
  MUSEARR_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').byteLength === 32, {
      message: 'MUSEARR_ENCRYPTION_KEY must be a base64-encoded 32-byte key.',
    })
    .optional(),
  MUSEARR_SESSION_SECRET: z.string().min(32).optional(),
  // Local AI is optional and off by default. When disabled, every ranking and
  // playlist decision stays fully deterministic.
  MUSEARR_LOCAL_AI_ENABLED: EnvironmentBooleanSchema,
  MUSEARR_LOCAL_AI_PROVIDER: z.enum(['none', 'ollama']).default('none'),
  MUSEARR_LOCAL_AI_BASE_URL: OptionalHttpUrlSchema,
  MUSEARR_LOCAL_AI_MODEL: OptionalNonEmptyStringSchema,
  // MusicBrainz + ListenBrainz are the deterministic similar-track source for
  // playlist generation. Off by default; enabling it sends the seed artist and
  // title to MetaBrainz (or a mirror you configure). A contact string is
  // required by MusicBrainz policy when enabled.
  MUSEARR_MUSICBRAINZ_ENABLED: EnvironmentBooleanSchema,
  MUSEARR_MUSICBRAINZ_CONTACT: OptionalNonEmptyStringSchema,
  MUSEARR_MUSICBRAINZ_BASE_URL: OptionalHttpUrlSchema,
  MUSEARR_LISTENBRAINZ_BASE_URL: OptionalHttpUrlSchema,
  MUSEARR_MUSICBRAINZ_ALGORITHM: OptionalNonEmptyStringSchema,
})

export type MusearrConfig = z.infer<typeof EnvironmentSchema>

export function getConfig(environment: NodeJS.ProcessEnv = process.env): MusearrConfig {
  return EnvironmentSchema.parse(environment)
}
