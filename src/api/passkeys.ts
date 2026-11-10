import { copyPrfOutput, createWrappedMasterKey, getVaultKey, parseWrappedMasterKey, serializeWrappedMasterKey, setVaultKeyHeader, unlockWrappedMasterKey, wrapExistingMasterKey } from '../lib/passkeyVault'
import type { WrappedMasterKeyPayload } from '../lib/passkeyVault'
import { AuthFlowError } from '../lib/authFeedback'
import type { PasskeyPhase } from '../lib/authFeedback'

export interface PasskeyCredentialSummary {
  credentialId: string
  createdAt: number
  name?: string | null
  lastUsedAt?: number | null
}

export interface PasskeyCredentialList {
  credentials: PasskeyCredentialSummary[]
  currentCredentialId: string | null
}

type JsonObject = Record<string, unknown>
interface OptionsEnvelope { options: JsonObject; wrapOptions?: JsonObject; prfInput: string; prfSalt?: string; userId?: string }
interface VerifyEnvelope { userId: string; credentialId?: string; wrapper?: WrappedMasterKeyPayload }

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function encodeBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = copyPrfOutput(value)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeOptions(input: JsonObject, prfInput: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...input }
  if (typeof input.challenge === 'string') result.challenge = decodeBase64Url(input.challenge)
  const user = input.user as JsonObject | undefined
  if (user && typeof user.id === 'string') result.user = { ...user, id: decodeBase64Url(user.id) }
  for (const key of ['allowCredentials', 'excludeCredentials'] as const) {
    const list = input[key]
    if (Array.isArray(list)) result[key] = list.map(item => {
      const descriptor = item as JsonObject
      return { ...descriptor, id: typeof descriptor.id === 'string' ? decodeBase64Url(descriptor.id) : descriptor.id }
    })
  }
  const extensions = input.extensions as JsonObject | undefined
  result.extensions = { ...extensions, prf: { ...((extensions?.prf as JsonObject | undefined) ?? {}), eval: { first: decodeBase64Url(prfInput) } } }
  return result
}

function prepareJsonOptions(input: JsonObject, prfInput: string): JsonObject {
  const extensions = input.extensions as JsonObject | undefined
  return { ...input, extensions: { ...extensions, prf: { ...((extensions?.prf as JsonObject | undefined) ?? {}), eval: { first: prfInput } } } }
}

function creationOptions(envelope: OptionsEnvelope): PublicKeyCredentialCreationOptions {
  const json = prepareJsonOptions(envelope.options, envelope.prfInput)
  const browser = PublicKeyCredential as unknown as { parseCreationOptionsFromJSON?: (options: JsonObject) => PublicKeyCredentialCreationOptions }
  if (browser.parseCreationOptionsFromJSON) return browser.parseCreationOptionsFromJSON(json)
  return decodeOptions(json, envelope.prfInput) as unknown as PublicKeyCredentialCreationOptions
}

function requestOptions(envelope: OptionsEnvelope): PublicKeyCredentialRequestOptions {
  const json = prepareJsonOptions(envelope.options, envelope.prfInput)
  const browser = PublicKeyCredential as unknown as { parseRequestOptionsFromJSON?: (options: JsonObject) => PublicKeyCredentialRequestOptions }
  if (browser.parseRequestOptionsFromJSON) return browser.parseRequestOptionsFromJSON(json)
  return decodeOptions(json, envelope.prfInput) as unknown as PublicKeyCredentialRequestOptions
}

async function post<T>(path: string, body?: unknown, userId?: string, signal?: AbortSignal): Promise<T> {
  const headers = new Headers()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (userId) setVaultKeyHeader(headers, userId)
  const response = await fetch(`/auth/passkey/${path}`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    signal,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: unknown }
    throw new AuthFlowError(response.status === 408 || response.status === 429 || response.status >= 500 ? 'network' : 'verification_failed', typeof data.error === 'string' ? data.error : `Passkey request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function extensionResults(credential: PublicKeyCredential, registration = false): { prfOutput?: Uint8Array; clientExtensionResults: JsonObject } {
  const results = credential.getClientExtensionResults() as JsonObject & { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } }
  const output = results.prf?.results?.first
  if (registration && results.prf?.enabled !== true) {
    throw new Error('This passkey provider does not support the PRF feature required to protect your data')
  }
  if (!registration && !output) throw new Error('This passkey provider cannot unlock the PRF-protected vault')
  // Only the boolean capability signal is sent to the server. PRF bytes never leave this module.
  return { prfOutput: output ? copyPrfOutput(output) : undefined, clientExtensionResults: { ...results, prf: { enabled: true } } }
}

function serializeCredential(credential: PublicKeyCredential, clientExtensionResults: JsonObject): JsonObject {
  const json = (credential as PublicKeyCredential & { toJSON?: () => JsonObject }).toJSON?.()
  if (json) return { ...json, clientExtensionResults }
  const response = credential.response
  const serialized: JsonObject = {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults,
  }
  if (response instanceof AuthenticatorAttestationResponse) {
    serialized.response = {
      attestationObject: encodeBase64Url(response.attestationObject),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    }
  } else if (response instanceof AuthenticatorAssertionResponse) {
    serialized.response = {
      authenticatorData: encodeBase64Url(response.authenticatorData),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      signature: encodeBase64Url(response.signature),
      userHandle: response.userHandle ? encodeBase64Url(response.userHandle) : null,
    }
  } else {
    throw new Error('The browser returned an unsupported passkey response')
  }
  return serialized
}

function requireWebAuthn(): void {
  if (!window.isSecureContext || !navigator.credentials || !window.PublicKeyCredential) {
    throw new Error('Passkeys require a supported browser on a secure connection')
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Passkey operation cancelled', 'AbortError')
}

async function createCredential(envelope: OptionsEnvelope, signal?: AbortSignal, onPhase?: (phase: PasskeyPhase) => void): Promise<{ credential: PublicKeyCredential; prfOutput: Uint8Array; serialized: JsonObject; assertion: JsonObject }> {
  onPhase?.('create')
  const options = creationOptions(envelope)
  const credential = await navigator.credentials.create({ publicKey: options, signal })
  throwIfAborted(signal)
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey registration was cancelled')
  const prf = extensionResults(credential, true)
  if (!envelope.wrapOptions) throw new Error('Passkey registration did not include PRF verification options')
  const wrapOptions = requestOptions({ ...envelope, options: envelope.wrapOptions })
  wrapOptions.allowCredentials = [{ type: 'public-key', id: credential.rawId }]
  onPhase?.('verify')
  const prfAssertion = await navigator.credentials.get({ publicKey: wrapOptions, signal })
  throwIfAborted(signal)
  if (!(prfAssertion instanceof PublicKeyCredential) || prfAssertion.id !== credential.id) throw new Error('The new passkey could not be checked for vault support')
  const assertionPrf = extensionResults(prfAssertion)
  if (!assertionPrf.prfOutput) throw new Error('The new passkey did not return a PRF result')
  try {
    return {
      credential,
      prfOutput: assertionPrf.prfOutput,
      serialized: serializeCredential(credential, prf.clientExtensionResults),
      assertion: serializeCredential(prfAssertion, assertionPrf.clientExtensionResults),
    }
  } catch (error) {
    assertionPrf.prfOutput.fill(0)
    throw error
  }
}

async function supportsImmediateSignIn(): Promise<boolean> {
  try {
    const browser = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }
    return (await browser.getClientCapabilities?.())?.immediateGet === true
  } catch { return false }
}

async function getCredential(envelope: OptionsEnvelope, signal?: AbortSignal, immediate = false): Promise<{ credential: PublicKeyCredential; prfOutput: Uint8Array; serialized: JsonObject }> {
  const options = requestOptions(envelope)
  throwIfAborted(signal)
  // Immediate UI cannot be dismissed programmatically. Still discard any late
  // result after cancellation before reading PRF bytes or verifying it.
  const request: CredentialRequestOptions & { uiMode?: 'immediate' } = immediate
    ? { publicKey: options, uiMode: 'immediate' }
    : { publicKey: options, signal }
  const credential = await navigator.credentials.get(request)
  throwIfAborted(signal)
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey sign-in was cancelled')
  const prf = extensionResults(credential)
  try { return { credential, prfOutput: prf.prfOutput!, serialized: serializeCredential(credential, prf.clientExtensionResults) } }
  catch (error) { prf.prfOutput?.fill(0); throw error }
}

export async function registerPasskey(signal?: AbortSignal, email?: string, onPhase?: (phase: PasskeyPhase) => void): Promise<{ userId: string }> {
  requireWebAuthn()
  const envelope = await post<OptionsEnvelope>('register/options', undefined, undefined, signal)
  if (email) envelope.options.user = { ...(envelope.options.user as JsonObject), name: email, displayName: email }
  throwIfAborted(signal)
  if (!envelope.userId) throw new Error('Passkey registration did not include an internal account identifier')
  const { credential, prfOutput, serialized, assertion } = await createCredential(envelope, signal, onPhase)
  try {
    throwIfAborted(signal)
    if (!envelope.prfSalt) throw new Error('Passkey registration did not include a wrapping salt')
    const wrappedMasterKey = serializeWrappedMasterKey(await createWrappedMasterKey(prfOutput, envelope.userId, encodeBase64Url(credential.rawId), decodeBase64Url(envelope.prfSalt), () => !signal?.aborted))
    const verified = await post<VerifyEnvelope>('register/verify', {
      response: serialized,
      assertion,
      ...wrappedMasterKey,
    }, envelope.userId, signal)
    throwIfAborted(signal)
    if (verified.userId !== envelope.userId) throw new Error('Passkey registration returned a mismatched account')
    return { userId: verified.userId }
  } finally { prfOutput.fill(0) }
}

export async function loginWithPasskey(signal?: AbortSignal, preferImmediate = false): Promise<{ userId: string }> {
  requireWebAuthn()
  const immediate = preferImmediate && await supportsImmediateSignIn()
  throwIfAborted(signal)
  const envelope = await post<OptionsEnvelope>('login/options', undefined, undefined, signal)
  throwIfAborted(signal)
  const { prfOutput, serialized } = await getCredential(envelope, signal, immediate)
  try {
    const verified = await post<VerifyEnvelope & { credentialId?: string; wrapper?: WrappedMasterKeyPayload }>('login/verify', { response: serialized }, undefined, signal)
    throwIfAborted(signal)
    if (!verified.userId || !verified.credentialId || !verified.wrapper) throw new Error('Passkey sign-in returned an incomplete vault record')
    await unlockWrappedMasterKey(prfOutput, verified.userId, parseWrappedMasterKey(verified.wrapper, verified.credentialId), () => !signal?.aborted)
    return { userId: verified.userId }
  } finally { prfOutput.fill(0) }
}

async function verifyManagementAction(userId: string, action: 'add' | 'delete', signal?: AbortSignal): Promise<void> {
  requireWebAuthn()
  const envelope = await post<OptionsEnvelope>('login/options', undefined, undefined, signal)
  const options = requestOptions(envelope)
  // This assertion proves presence only; no PRF output is needed for the key.
  delete options.extensions
  const credential = await navigator.credentials.get({ publicKey: options, signal })
  throwIfAborted(signal)
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey verification was cancelled')
  const results = credential.getClientExtensionResults() as JsonObject
  const { prf: _prf, ...safeResults } = results
  await post('login/verify', { response: serializeCredential(credential, safeResults), managementAction: action }, userId, signal)
}

export async function addPasskey(userId: string, signal?: AbortSignal, email?: string | null, onPhase?: (phase: PasskeyPhase) => void): Promise<void> {
  requireWebAuthn()
  await verifyManagementAction(userId, 'add', signal)
  const existingKey = getVaultKey(userId)
  if (!existingKey) throw new Error('Unlock the passkey vault before adding another passkey')
  let prfOutput: Uint8Array | null = null
  try {
    const envelope = await post<OptionsEnvelope>('add/options', undefined, userId, signal)
    if (email) envelope.options.user = { ...(envelope.options.user as JsonObject), name: email, displayName: email }
    throwIfAborted(signal)
    const created = await createCredential(envelope, signal, onPhase)
    prfOutput = created.prfOutput
    throwIfAborted(signal)
    if (!envelope.prfSalt) throw new Error('Passkey registration did not include a wrapping salt')
    const wrappedMasterKey = serializeWrappedMasterKey(await wrapExistingMasterKey(prfOutput, userId, encodeBase64Url(created.credential.rawId), existingKey, decodeBase64Url(envelope.prfSalt)))
    await post('add/verify', { response: created.serialized, assertion: created.assertion, ...wrappedMasterKey }, userId, signal)
  } finally {
    existingKey.fill(0)
    prfOutput?.fill(0)
  }
}

export async function listPasskeys(userId: string, signal?: AbortSignal): Promise<PasskeyCredentialList> {
  return post<PasskeyCredentialList>('credentials/list', {}, userId, signal)
}

export async function renamePasskey(userId: string, credentialId: string, name: string, signal?: AbortSignal): Promise<void> {
  await post('credentials/rename', { credentialId, name }, userId, signal)
}

export async function deletePasskey(userId: string, credentialId: string, signal?: AbortSignal): Promise<void> {
  await verifyManagementAction(userId, 'delete', signal)
  await post<{ ok: true }>('credentials/delete', { credentialId }, userId, signal)
}
