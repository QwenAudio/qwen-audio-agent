import { createHash } from 'node:crypto'

// Alibaba Cloud ARTC single-parameter token, generated only on the local server.
// https://help.aliyun.com/zh/live/user-guide/token-based-authentication
export function createArtcToken({ appId, appKey, channelId, userId, expiresAt }) {
  if (![appId, appKey, channelId, userId].every(value => typeof value === 'string' && value.trim())) {
    throw new TypeError('ARTC AppID, AppKey, channel ID, and user ID are required')
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new RangeError('ARTC token expiry must be in the future')
  }
  const timestamp = expiresAt
  const token = createHash('sha256').update(`${appId}${appKey}${channelId}${userId}${timestamp}`).digest('hex')
  return Buffer.from(JSON.stringify({ appid: appId, channelid: channelId, userid: userId, nonce: '', timestamp, token })).toString('base64')
}
