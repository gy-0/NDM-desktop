import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { dirname, join } from 'node:path'
import { WindowsAuxiliaryRPCClient, type WindowsAuxiliaryRPC } from './auxiliaryRpc'
import type { AuxiliaryCapabilities } from '../../shared/auxiliaryTransfer'

export const AUXILIARY_BINARY_PINS: Record<string, string> = {
  'macos-arm64': 'c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343',
  'macos-x86_64': 'c94d4bed9f1d8270320e17d3af1fa72d5fd4040efd5ee8a87c6d75d47aa6c5b4',
  'windows-x86_64': '7c1f49bf9f22f15f684ce1dcc76768f04b5dc3795281aef750d1e5ad78ff1459',
  'windows-arm64': '96036770333de330462158f592cf9474ccf6fe28c39d22a013971c1f12ad7526'
}
export const auxiliaryDelay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
export interface WindowsAuxiliaryDaemonOptions { binaryPath: string; manifestPath: string; stateDirectory: string; loopbackOnly?: boolean; peerDiscovery?: boolean }
export interface WindowsAuxiliaryDaemonProvider { start(): Promise<AuxiliaryCapabilities>; rpc(): Promise<WindowsAuxiliaryRPC>; stop(): Promise<void> }

async function portReservation(udp = false, alsoUDP = false): Promise<{ port: number; release(): Promise<void> }> {
  const server = udp ? createSocket('udp4') : createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); if (udp) (server as ReturnType<typeof createSocket>).bind(0, '127.0.0.1', resolve); else (server as ReturnType<typeof createServer>).listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  let extra: ReturnType<typeof createSocket> | undefined
  try {
    if (alsoUDP) { extra = createSocket('udp4'); await new Promise<void>((resolve, reject) => { extra!.once('error', reject); extra!.bind(port, '127.0.0.1', resolve) }) }
  } catch (error) { server.close(); extra?.close(); throw error }
  return { port, release: async () => { await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), ...(extra ? [new Promise<void>(resolve => extra!.close(() => resolve()))] : [])]) } }
}

/** A separate shared process; the standard HTTP aria2 child is untouched. */
export class WindowsAuxiliaryDaemon implements WindowsAuxiliaryDaemonProvider {
  private child: ChildProcess | null = null
  private client: WindowsAuxiliaryRPCClient | null = null
  private capabilities: AuxiliaryCapabilities | null = null
  private starting: Promise<AuxiliaryCapabilities> | null = null
  private stopped = false
  constructor(private readonly options: WindowsAuxiliaryDaemonOptions) {}
  async start(): Promise<AuxiliaryCapabilities> {
    if (this.stopped) throw new Error('辅助引擎已停止。')
    if (this.capabilities && this.child?.exitCode === null && this.child.signalCode === null) return this.capabilities
    this.starting ??= this.launch().finally(() => { this.starting = null })
    return this.starting
  }
  async rpc(): Promise<WindowsAuxiliaryRPC> { await this.start(); return this.client! }
  async stop(): Promise<void> {
    this.stopped = true
    await this.starting?.catch(() => undefined)
    const child = this.child
    await this.client?.call('aria2.forceShutdown').catch(() => undefined)
    if (child) await this.terminate(child)
    this.child = null; this.client = null; this.capabilities = null
  }
  private async terminate(child: ChildProcess): Promise<void> {
    const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null
    for (let i = 0; i < 20 && running(); i++) await auxiliaryDelay(50)
    if (running()) child.kill()
    for (let i = 0; i < 20 && running(); i++) await auxiliaryDelay(50)
    if (running()) child.kill('SIGKILL')
    for (let i = 0; i < 20 && running(); i++) await auxiliaryDelay(50)
    if (running()) throw new Error('辅助引擎进程尚未退出。')
  }
  private async launch(): Promise<AuxiliaryCapabilities> {
    const target = `${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`
    const pin = AUXILIARY_BINARY_PINS[target]
    const manifest = JSON.parse(await readFile(this.options.manifestPath, 'utf8'))
    if (!pin || manifest.target !== target || manifest.version !== '2.7.5' || manifest.sourceCommit !== 'a9784ea8e36ae83f360ff5157b60c72eb8d96375' || manifest.binarySHA256 !== pin) throw new Error('辅助引擎版本或清单校验失败。')
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(this.options.binaryPath)) digest.update(chunk)
    if (digest.digest('hex') !== pin) throw new Error('辅助引擎文件校验失败。')
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 })
    const reservations: Awaited<ReturnType<typeof portReservation>>[] = []
    try {
      reservations.push(await portReservation(), await portReservation(false, true), await portReservation())
      let udp = await portReservation(true)
      while (reservations.some(item => item.port === udp.port)) { await udp.release(); udp = await portReservation(true) }
      reservations.push(udp)
      const [rpc, bt, edTCP, edUDP] = reservations.map(item => item.port)
      const secret = randomBytes(32).toString('hex')
      const client = new WindowsAuxiliaryRPCClient(`http://127.0.0.1:${rpc}/jsonrpc`, secret, 5000)
      const args = ['--no-conf=true', '--no-netrc=true', '--enable-rpc=true', '--rpc-listen-all=false', `--rpc-listen-port=${rpc}`, `--rpc-secret=${secret}`,
        `--state-dir=${this.options.stateDirectory}`, `--dir=${join(this.options.stateDirectory, 'unassigned')}`, `--stop-with-process=${process.pid}`,
        `--listen-port=${bt}`, `--ed2k-listen-port=${edTCP}`, `--ed2k-udp-listen-port=${edUDP}`, `--enable-dht=${this.options.peerDiscovery !== false}`, `--bt-enable-lpd=${this.options.peerDiscovery !== false}`,
        '--bt-port-mapping=false', '--disable-ipv6=true', '--auto-file-renaming=false', '--allow-overwrite=false', '--console-log-level=error']
      if (this.options.loopbackOnly) args.push('--interface=127.0.0.1', '--bt-interface=127.0.0.1')
      await Promise.all(reservations.map(item => item.release())); reservations.length = 0
      if (this.stopped) throw new Error('辅助引擎已停止。')
      const child = spawn(this.options.binaryPath, args, { cwd: dirname(this.options.binaryPath), windowsHide: true, stdio: 'ignore' })
      let failed = false
      child.once('error', () => { failed = true })
      this.child = child; this.client = client
      const deadline = Date.now() + 15000
      for (let i = 0; i < 60 && Date.now() < deadline; i++) {
        if (this.stopped || failed || child.exitCode !== null || child.signalCode !== null) throw new Error('辅助引擎未能启动。')
        try {
          const version = await client.call<{ version: string; enabledFeatures: string[] }>('aria2.getVersion')
          const methods = await client.call<string[]>('system.listMethods')
          if (version.version !== '2.7.5' || !Array.isArray(version.enabledFeatures) || !Array.isArray(methods)) throw new Error('辅助引擎协议不兼容。')
          const required = ['aria2.addUri', 'aria2.tellStatus', 'aria2.forcePause', 'aria2.unpause', 'aria2.forceRemove', 'aria2.changeOption']
          if (!required.every(method => methods.includes(method))) throw new Error('辅助引擎缺少必需功能。')
          const bittorrent = version.enabledFeatures.includes('BitTorrent') && methods.includes('aria2.addTorrent')
          if (this.stopped) throw new Error('辅助引擎已停止。')
          const ed2k = version.enabledFeatures.includes('ED2K')
          this.capabilities = { bittorrent, ed2k, sftp: version.enabledFeatures.includes('SFTP'), fileSelection: bittorrent, stopSeeding: bittorrent || ed2k }
          return this.capabilities
        } catch { await auxiliaryDelay(100) }
      }
      throw new Error('辅助引擎启动超时。')
    } catch {
      if (this.child) { this.child.kill(); await this.terminate(this.child) }
      this.child = null; this.client = null; this.capabilities = null
      throw new Error('辅助引擎尚不可用，请检查已打包的固定版本工具。')
    } finally { await Promise.all(reservations.map(item => item.release().catch(() => undefined))) }
  }
}
