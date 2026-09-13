import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CompletionAction } from '../shared/completionAction'

const execute = promisify(execFile)

/** Invoked only after the user arms a one-shot action and the final task check passes. */
export async function performCompletionAction(action: CompletionAction): Promise<void> {
  if (action === 'quit') { app.quit(); return }
  if (process.platform === 'darwin') {
    if (action === 'sleep') await execute('/usr/bin/pmset', ['sleepnow'], { timeout: 15_000 })
    else await execute('/usr/bin/osascript', ['-e', 'tell application "System Events" to shut down'], { timeout: 30_000 })
    return
  }
  if (process.platform === 'win32') {
    if (action === 'shutdown') await execute('shutdown.exe', ['/s', '/t', '0'], { timeout: 15_000, windowsHide: true })
    else await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -Namespace NDM -Name Power -MemberDefinition \'[System.Runtime.InteropServices.DllImport("powrprof.dll", SetLastError=true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);\'; if (-not [NDM.Power]::SetSuspendState($false,$false,$false)) { exit 1 }'
    ], { timeout: 15_000, windowsHide: true })
    return
  }
  throw new Error('当前平台不支持此完成后动作。')
}
