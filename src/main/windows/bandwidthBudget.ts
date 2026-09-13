export type BandwidthEngine = 'primary' | 'auxiliary'
export type BandwidthDemand = Record<BandwidthEngine, boolean>
export type BandwidthAllocation = Record<BandwidthEngine, number>
const engines: BandwidthEngine[] = ['primary', 'auxiliary']

/** Zero means unlimited in both RPCs; never use it as a zero-byte allocation. */
export function allocateWindowsBandwidth(total: number, demand: BandwidthDemand): BandwidthAllocation {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('限速必须是非负整数字节数。')
  if (total === 0) return { primary: 0, auxiliary: 0 }
  if (demand.primary && demand.auxiliary) {
    if (total < 2) throw new Error('两类下载同时运行时，总限速至少需要 2 B/s。请提高限速后继续原任务。')
    return { primary: Math.ceil(total / 2), auxiliary: Math.floor(total / 2) }
  }
  // Inactive processes get a bounded value as well. Admission must call
  // reconcile with prospective demand before adding/unpausing any transfer.
  return { primary: total, auxiliary: total }
}

export class WindowsBandwidthBudget {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly dependencies: {
    /** null only when that process is not running; never start it for a query. */
    readCap: (engine: BandwidthEngine) => Promise<number | null>
    writeCap: (engine: BandwidthEngine, value: number) => Promise<void>
  }) {}

  /** Serialize transitions and lower every affected cap before raising any.
   * Read actual RPC state each time: a timed-out write may have reached the
   * child. Callers persist their setting only after this operation succeeds.
   * A not-yet-running child must start with the returned allocation in argv,
   * then reconcile once more before admitting its first payload transfer. */
  reconcile(total: number, demand: BandwidthDemand): Promise<BandwidthAllocation> {
    const plan = allocateWindowsBandwidth(total, { ...demand })
    const operation = this.tail.then(async () => {
      const current = {} as Record<BandwidthEngine, number | null>
      for (const engine of engines) {
        const cap = await this.dependencies.readCap(engine)
        if (cap !== null && (!Number.isSafeInteger(cap) || cap < 0)) throw new Error('未能读取下载引擎的实际限速。')
        current[engine] = cap
      }
      const value = (cap: number) => cap === 0 ? Infinity : cap
      const changed = engines.filter(engine => current[engine] !== null && current[engine] !== plan[engine])
      const decreases = changed.filter(engine => value(plan[engine]) < value(current[engine]!))
      const increases = changed.filter(engine => !decreases.includes(engine))
      for (const engine of [...decreases, ...increases]) {
        await this.dependencies.writeCap(engine, plan[engine])
        if (await this.dependencies.readCap(engine) !== plan[engine]) throw new Error('下载引擎尚未确认总限速，请重试。')
      }
      return plan
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
}
