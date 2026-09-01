import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ClipboardSnapshot = {
  text: string
  changeCount: number
  selfWritten: boolean
}

let selfWrittenChangeCount: number | null = null
let syntheticCount = 0
let lastSyntheticText = ''

async function darwinPasteboardChangeCount(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount'],
      { timeout: 800, windowsHide: true, encoding: 'utf8' }
    )
    const value = Number.parseInt(String(stdout).trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function syntheticChangeCount(text: string): number {
  if (text !== lastSyntheticText) {
    syntheticCount += 1
    lastSyntheticText = text
  }
  return syntheticCount
}

export async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  const text = clipboard.readText()
  const changeCount =
    process.platform === 'darwin'
      ? ((await darwinPasteboardChangeCount()) ?? syntheticChangeCount(text))
      : syntheticChangeCount(text)
  return {
    text,
    changeCount,
    selfWritten: selfWrittenChangeCount === changeCount
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  clipboard.writeText(text)
  const snapshot = await readClipboardSnapshot()
  selfWrittenChangeCount = snapshot.changeCount
}

export function readClipboardText(): string {
  return clipboard.readText()
}
