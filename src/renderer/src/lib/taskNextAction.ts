import type { Task } from './types'

export interface TaskNextAction {
  kind: 'toggle' | 'restart' | 'inspect' | 'open'
  label: string
  ariaLabel: string
  busyLabel: string
  disabled: boolean
}

type ActionTask = Pick<Task, 'awaitingDestination' | 'status' | 'isLiveRecording' | 'phase' | 'diagnostic'>

/** The row's next step follows the task state; recovery guidance must not turn
 * into a blind retry merely because the source page is unavailable. */
export function taskNextAction(task: ActionTask): TaskNextAction {
  if (task.awaitingDestination) {
    return { kind: 'toggle', label: '选目录', ariaLabel: '选择保存目录', busyLabel: '正在选择目录', disabled: false }
  }

  if (task.status === 'complete') {
    return { kind: 'open', label: '打开', ariaLabel: '打开文件', busyLabel: '正在打开', disabled: false }
  }

  if (task.status === 'error') {
    if (task.diagnostic?.primaryAction === 'openPage' || task.diagnostic?.primaryAction === 'renew') {
      return { kind: 'inspect', label: task.diagnostic.primaryAction === 'renew' ? '更新链接…' : '来源页面…', ariaLabel: '查看下载问题与处理方式', busyLabel: '正在打开详情', disabled: false }
    }
    return { kind: 'restart', label: '重试', ariaLabel: '重试下载', busyLabel: '正在重试', disabled: false }
  }

  if (task.status === 'downloading' && task.isLiveRecording) {
    if (task.phase === 'merging') {
      return { kind: 'toggle', label: '正在保存', ariaLabel: '正在保存录制', busyLabel: '正在保存', disabled: true }
    }
    return { kind: 'toggle', label: '停止并保存', ariaLabel: '停止并保存录制', busyLabel: '正在保存', disabled: false }
  }

  if (task.status === 'downloading' || task.status === 'waiting') {
    return { kind: 'toggle', label: '暂停', ariaLabel: '暂停下载', busyLabel: '正在暂停', disabled: false }
  }

  return { kind: 'toggle', label: '继续', ariaLabel: '继续下载', busyLabel: '正在继续', disabled: false }
}
