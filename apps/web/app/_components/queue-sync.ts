type SyncReply = { ok: boolean; status: number }

export type QueueSyncResult = 'queued' | 'signed_out' | 'failed'

// POST /api/v1/sync. Anything other than a 2xx or a 401 reads as a failure the user can retry.
export async function queueLibrarySync(post: () => Promise<SyncReply>): Promise<QueueSyncResult> {
  try {
    const response = await post()
    if (response.ok) return 'queued'
    return response.status === 401 ? 'signed_out' : 'failed'
  } catch {
    return 'failed'
  }
}
