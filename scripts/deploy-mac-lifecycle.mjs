// Deployment lifecycle logic has no filesystem/process side effects of its own.
const activeStatuses = new Set(['downloading', 'starting', 'merging'])
export const isActiveTask = task => activeStatuses.has(task.status)
export function createPauseSession({ rpc, now = Date.now }) {
  const pausedIDs = new Set()
  // Survives lost ACK/post-pause list failures; only IDs observed active
  // immediately before issuing this deployment's pause enter this set.
  const attemptedIDs = new Set()
  async function tasks() {
    const reply = await rpc('list')
    if (reply.ok !== true || !Array.isArray(reply.tasks)) throw Error('Cannot verify download state')
    return reply.tasks
  }
  return {
    pausedIDs, attemptedIDs,
    async pauseActive() {
      const deadline = now() + 90000
      while (true) {
        const active = (await tasks()).find(isActiveTask)
        if (!active) return
        if (now() >= deadline) throw Error('Downloads kept starting during update; installed app unchanged')
        const id = active.id
        if (!Number.isSafeInteger(id)) throw Error('Invalid active task ID')
        // Refresh immediately before issuing the command: a task may have
        // completed or the user may have paused it since the previous snapshot.
        const current = (await tasks()).find(task => task.id === id)
        if (!current || !isActiveTask(current)) continue
        attemptedIDs.add(id)
        let pauseError
        try {
          const reply = await rpc('pause', { taskID: id }, 30000)
          if (reply.ok !== true) throw Error(`Pause rejected for task ${id}`)
        } catch (error) { pauseError = error }
        // Host pause ACK waits for the writer to drain. A timeout is not an ACK:
        // even if list becomes paused, abort deployment and recover that ID.
        const after = (await tasks()).find(task => task.id === id)
        if (after?.status === 'paused') pausedIDs.add(id)
        if (pauseError) throw Error(`Could not confirm drained task ${id}; no force quit. ${pauseError.message}`)
        if (after && isActiveTask(after)) throw Error(`Task ${id} is still active after pause; no force quit`)
        if (after && !['paused', 'complete', 'error', 'incomplete'].includes(after.status)) {
          throw Error(`Task ${id} has unverified state after pause: ${after.status}`)
        }
      }
    },
    async assertDrained() {
      if ((await tasks()).some(isActiveTask)) throw Error('A task started before app exit; update stopped')
    },
    async restore() {
      const failures = []
      // Reconcile uncertain attempts first; never blindly resume them.
      for (const id of attemptedIDs) {
        try {
          const task = (await tasks()).find(task => task.id === id)
          if (!task || task.status === 'complete' || isActiveTask(task) || task.status === 'waiting') continue
          if (task.status !== 'paused') throw Error(`Task ${id} is ${task.status}, not resuming automatically`)
          pausedIDs.add(id)
          const reply = await rpc('resume', { taskID: id }, 15000)
          if (reply.ok !== true) throw Error(`Resume rejected for task ${id}`)
          const after = (await tasks()).find(task => task.id === id)
          if (!after || !['downloading', 'starting', 'merging', 'waiting', 'complete'].includes(after.status)) {
            throw Error(`Task ${id} did not enter a resumed state`)
          }
        } catch (error) { failures.push(`task ${id}: ${error.message}`) }
      }
      if (failures.length) throw Error(`Update task recovery incomplete: ${failures.join('; ')}`)
    }
  }
}

// All bundle operations remain supplied by deploy-mac. No force kill is ever
// attempted; rollback waits for a normal exit before moving a running bundle.
export async function installWithRecovery({ session, running, quit, swap, launch, healthy, rollback, cleanupBackup }) {
  let swapStarted = false, deploymentReady = false
  try {
    if (running()) {
      await session.pauseActive()
      await session.assertDrained()
      await quit()
    }
    swapStarted = true
    await swap()
    await launch()
    if (!await healthy()) throw Error('New app did not become ready')
    deploymentReady = true
    await session.restore()
    await cleanupBackup()
  } catch (original) {
    const errors = [original]
    // If only resuming failed, preserve the healthy new app and the backup.
    // Replacing it again would interrupt tasks which already resumed.
    if (!deploymentReady && swapStarted) {
      try {
        if (running()) {
          await session.pauseActive()
          await session.assertDrained()
          await quit()
        }
        await rollback()
        await launch()
        if (!await healthy()) throw Error('Restored app did not become ready')
      } catch (error) {
        errors.push(error)
        throw new AggregateError(errors, 'Deployment failed; rollback could not be completed. Backup retained; no force quit.')
      }
    } else if (!deploymentReady && !running() && (session.attemptedIDs?.size || session.pausedIDs.size)) {
      // quit may have returned an error after the old process already exited.
      try { await launch(); if (!await healthy()) throw Error('Original app did not become ready') }
      catch (error) { errors.push(error) }
    }
    if (!deploymentReady && running()) {
      try { await session.restore() } catch (error) { errors.push(error) }
    }
    throw new AggregateError(errors, `Deployment failed: ${errors.map(error => error.message).join('; ')}`)
  }
}
