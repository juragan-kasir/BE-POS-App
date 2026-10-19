'use strict'

// Client for ai-business-core's account-link API: binds one POS store to one
// Telegram chat so the AI assistant answers with that store's live data.
//
// Fail closed: without AI_CORE_URL and AI_CORE_API_KEY every call is a 503,
// so deploying this code changes nothing until the integration is configured.

const TIMEOUT_MS = 8000

const serviceError = (statusCode, code, message) =>
  Object.assign(new Error(message), { statusCode, code })

const call = async (method, path, body) => {
  const baseUrl = process.env.AI_CORE_URL
  const apiKey = process.env.AI_CORE_API_KEY
  if (!baseUrl || !apiKey) {
    throw serviceError(503, 'ASSISTANT_NOT_CONFIGURED', 'AI assistant is not configured')
  }

  let response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/links${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw serviceError(502, 'ASSISTANT_UNREACHABLE', 'AI assistant is unreachable')
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw serviceError(502, 'ASSISTANT_ERROR', payload?.error?.message || 'AI assistant request failed')
  }
  return payload.data
}

const createLink = ({ storeId, storeName }) =>
  call('POST', '', { externalAccountId: String(storeId), displayName: storeName })

const getLink = (storeId) => call('GET', `/${encodeURIComponent(String(storeId))}`)

const deleteLink = (storeId) => call('DELETE', `/${encodeURIComponent(String(storeId))}`)

module.exports = { createLink, getLink, deleteLink }
