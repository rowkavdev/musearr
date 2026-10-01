import {
  beginDiscordDailyBriefDelivery,
  completeDiscordDailyBriefDelivery,
  createDailyBrief,
  failDiscordDailyBriefDelivery,
  getDailyBriefDelivery,
  getDailyBriefForDate,
  getDashboardOverview,
  type Database,
  type DailyBriefRecord,
} from '@musearr/db'
import { DiscordDeliveryError, deliverDiscordDailyBrief } from '@musearr/integrations'
import {
  DAILY_BRIEF_ALGORITHM_VERSION,
  buildDailyBrief,
  localDateInTimeZone,
} from '@musearr/intelligence'
import { generateRecommendationRun } from './recommendation-run.js'

type DailyBriefOptions = {
  timezone: string
  discordWebhookUrl?: string
  now?: Date
}

export async function generateDailyBrief(
  database: Database,
  userId: string,
  options: DailyBriefOptions,
): Promise<{ brief: DailyBriefRecord; created: boolean; delivered: boolean }> {
  const briefDate = localDateInTimeZone(options.timezone, options.now)
  let brief = await getDailyBriefForDate(database, userId, briefDate)
  let created = false

  if (!brief) {
    await generateRecommendationRun(database, userId, 'daily_mix', 20)
    const overview = await getDashboardOverview(database, userId)
    brief = await createDailyBrief(database, {
      userId,
      briefDate,
      timezone: options.timezone,
      algorithmVersion: DAILY_BRIEF_ALGORITHM_VERSION,
      content: buildDailyBrief(overview),
    })
    created = true
  }

  if (!options.discordWebhookUrl) {
    return { brief, created, delivered: false }
  }

  const previousDelivery = await getDailyBriefDelivery(database, brief.id)
  if (previousDelivery?.status === 'delivered') {
    return { brief, created, delivered: true }
  }

  await beginDiscordDailyBriefDelivery(database, brief.id)
  try {
    await deliverDiscordDailyBrief(options.discordWebhookUrl, brief.content)
  } catch (error) {
    await failDiscordDailyBriefDelivery(database, brief.id, deliveryFailureSummary(error))
    throw error
  }
  await recordDeliveryCompleted(database, brief.id)
  return { brief, created, delivered: true }
}

const COMPLETE_ATTEMPTS = 3

// The Discord post has already landed. A failure to record it must not be
// reported as a delivery failure, because the retry would post the brief again.
async function recordDeliveryCompleted(database: Database, briefId: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await completeDiscordDailyBriefDelivery(database, briefId)
      return
    } catch (error) {
      if (attempt >= COMPLETE_ATTEMPTS) throw error
    }
  }
}

function deliveryFailureSummary(error: unknown): string {
  if (error instanceof DiscordDeliveryError) {
    return error.message
  }
  return 'Discord delivery could not be completed.'
}
