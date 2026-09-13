import {
  BT_CONTROL_OPS, BT_ERROR_MESSAGES, btObject, btOnly, btFailure, btSafeFailure, btConfigEqual,
  canConfigureBT, isBTEncryption, isBTInteger, readBTControlsState, readBTGlobalState,
  validateBTPeers, validateBTTaskConfig, type BTErrorCode
} from '../shared/btTransferControls'

type Request = (op: string, extra?: Record<string, unknown>) => Promise<unknown>
/** Renderer whitelist only. Backends own serialized generation/revision checks,
 * durable same-GID configuration replay, RPC ACKs, and authoritative readback. */
export class BTTransferControlsService {
  constructor(private readonly dependencies: { request: Request }) {}
  supports(op: string): boolean { return (BT_CONTROL_OPS as readonly string[]).includes(op) }
  async request(op: string, extra: unknown = {}): Promise<Record<string, unknown>> {
    let mutation = false
    try {
      if (!this.supports(op)) return btFailure('unsupported')
      const input = btObject(extra)
      if (op === 'auxiliaryBTGlobalStatus' || op === 'auxiliaryBTGlobalConfigure') {
        btOnly(input, op.endsWith('Status') ? [] : ['expectedRevision', 'encryption'])
        if (op.endsWith('Configure') && (!isBTInteger(input.expectedRevision) || !isBTEncryption(input.encryption))) return btFailure('invalidConfig')
        const reply = await this.dependencies.request('auxiliaryBTGlobalStatus', {})
        const state = readBTGlobalState(reply)
        if (!state) return btSafeFailure(reply)
        if (op.endsWith('Status')) return { ok: true, state }
        if (state.revision !== input.expectedRevision) return btFailure('conflict')
        if (!state.canConfigure) return btFailure('allTasksMustPause')
        mutation = true
        const result = await this.dependencies.request(op, { expectedRevision: input.expectedRevision, encryption: input.encryption })
        const updated = readBTGlobalState(result)
        const minimumRevision = state.revision + (state.encryption === input.encryption ? 0 : 1)
        return updated && updated.revision >= minimumRevision && updated.encryption === input.encryption ? { ok: true, state: updated } : btSafeFailure(result, 'unconfirmed')
      }
      btOnly(input, op === 'auxiliaryBTStatus' ? ['taskID', 'generation'] : op === 'auxiliaryBTConfigure'
        ? ['taskID', 'generation', 'expectedRevision', 'config'] : ['taskID', 'generation', 'peers'])
      if (!isBTInteger(input.taskID, 1) || !isBTInteger(input.generation)) return btFailure('invalidRequest')
      const binding = { taskID: input.taskID, generation: input.generation }
      const config = op === 'auxiliaryBTConfigure' ? validateBTTaskConfig(input.config) : undefined
      if (config && !isBTInteger(input.expectedRevision)) return btFailure('invalidRequest')
      const peers = op === 'auxiliaryBTAddPeers' ? validateBTPeers(input.peers) : undefined
      const reply = await this.dependencies.request('auxiliaryBTStatus', binding)
      const state = readBTControlsState(reply, binding.taskID, binding.generation)
      if (!state) return btSafeFailure(reply)
      if (op === 'auxiliaryBTStatus') return { ok: true, state }
      if (!canConfigureBT(state.phase)) return btFailure('notPaused')
      if (config && state.revision !== input.expectedRevision) return btFailure('conflict')
      mutation = true
      const result = await this.dependencies.request(op, { ...binding, ...(config ? { config, expectedRevision: input.expectedRevision } : { peers }) })
      if (config) {
        const updated = readBTControlsState(result, binding.taskID, binding.generation)
        const minimumRevision = state.revision + (btConfigEqual(state.config, config) ? 0 : 1)
        return updated && updated.revision >= minimumRevision && btConfigEqual(updated.config, config) ? { ok: true, state: updated } : btSafeFailure(result, 'unconfirmed')
      }
      const added = btObject(result)
      return added.ok === true && isBTInteger(added.added) && isBTInteger(added.failed) && added.added + added.failed === peers!.length
        ? { ok: true, added: added.added, failed: added.failed } : btSafeFailure(result, 'unconfirmed')
    } catch (error) {
      // Never expose raw engine errors: they may contain passkeys or signed URLs.
      const code = error instanceof Error && Object.hasOwn(BT_ERROR_MESSAGES, error.message) ? error.message as BTErrorCode : mutation ? 'unconfirmed' : 'unavailable'
      return btFailure(code)
    }
  }
  handle(op: string, extra: unknown = {}): Promise<Record<string, unknown>> { return this.request(op, extra) }
}
