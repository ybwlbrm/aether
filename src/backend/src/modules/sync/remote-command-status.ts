export const PROCESSABLE_REMOTE_COMMAND_STATUSES = ['pending', 'cancelled'] as const

export type ProcessableRemoteCommandStatus = (typeof PROCESSABLE_REMOTE_COMMAND_STATUSES)[number]

export const REMOTE_COMMAND_REALTIME_FILTER = `status=in.(${PROCESSABLE_REMOTE_COMMAND_STATUSES.join(',')})`

export function isProcessableRemoteCommandStatus(status: string): status is ProcessableRemoteCommandStatus {
  return status === 'pending' || status === 'cancelled'
}
