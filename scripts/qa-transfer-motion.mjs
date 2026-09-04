import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { _electron as electron } from 'playwright'
import { completeOnboarding, qaLaunchOptions } from './qa-env.mjs'

const issues = []
const app = await electron.launch(qaLaunchOptions('transfer-motion'))
const win = await app.firstWindow()
win.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') issues.push(`${message.type()}: ${message.text()}`)
})

try {
  await win.waitForLoadState('domcontentloaded')
  if (process.env.NDM_QA_THEME) {
    const themedUrl = new URL(win.url())
    themedUrl.searchParams.set('theme', process.env.NDM_QA_THEME)
    await win.goto(themedUrl.toString())
    await win.waitForLoadState('domcontentloaded')
  }
  await completeOnboarding(win)
  await win.waitForFunction(
    async () => await window.ndm?.status().catch(() => 'down') === 'live',
    undefined,
    { timeout: 20_000 }
  )

  const task = {
    id: 9_001_800,
    title: 'NDM Slosh Integration QA',
    filename: 'NDM-Slosh-Integration-QA.dmg',
    folderPath: '/tmp',
    url: 'https://cdn.example.com/NDM-Slosh-Integration-QA.dmg',
    source: 'cdn.example.com',
    category: 'application',
    connections: 8,
    segments: Array.from({ length: 8 }, (_, index) => ({ id: index, fraction: 0.63 })),
    fileSize: 1_000_000_000,
    completedBytes: 630_000_000,
    bytesPerSecond: 24_000_000,
    status: 'downloading',
    phase: 'transferring'
  }
  const secondaryTask = {
    ...task,
    id: 9_001_799,
    title: 'NDM Parallel ETA QA',
    filename: 'NDM-Parallel-ETA-QA.zip',
    url: 'https://cdn.example.com/NDM-Parallel-ETA-QA.zip',
    category: 'compressed',
    connections: 4,
    segments: [],
    fileSize: 100_000_000,
    completedBytes: 50_000_000,
    bytesPerSecond: 10_000_000
  }

  const pushSnapshot = async () => {
    await app.evaluate(({ BrowserWindow }, nextTasks) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('engine:event', { op: 'snapshot', tasks: nextTasks })
    }, [task, secondaryTask])
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await pushSnapshot()
    if (await win.getByText(task.filename, { exact: true }).count()) break
    await win.waitForTimeout(160)
  }
  await win.getByText(task.filename, { exact: true }).first().waitFor({ state: 'visible', timeout: 5_000 })

  const hero = win.locator('section').filter({ hasText: task.filename }).first()
  const canvas = hero.locator('canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 5_000 })
  await win.waitForTimeout(700)

  const surface = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      backingWidth: node.width,
      backingHeight: node.height,
      opacity: getComputedStyle(node).opacity,
      frames: node.__ndmFxFrames ?? 0
    }
  })

  const progressBar = hero.getByRole('progressbar').first()
  const motionSamples = win.evaluate(async () => {
    const fill = document.querySelector('[role="progressbar"] [data-progress-fill]')
    if (!(fill instanceof HTMLElement)) return []

    const samples = []
    const startedAt = performance.now()
    return await new Promise((resolve) => {
      const sample = (now) => {
        const match = fill.style.transform.match(/scaleX\(([^)]+)\)/)
        samples.push({ at: now - startedAt, value: Number(match?.[1] ?? 0) })
        if (now - startedAt < 720) requestAnimationFrame(sample)
        else resolve(samples)
      }
      requestAnimationFrame(sample)
    })
  })
  const snapshotMotion = (async () => {
    for (const fraction of [0.69, 0.75]) {
      await win.waitForTimeout(250)
      task.completedBytes = task.fileSize * fraction
      task.segments = task.segments.map((segment) => ({ ...segment, fraction }))
      await pushSnapshot()
    }
  })()
  const [samples] = await Promise.all([motionSamples, snapshotMotion])
  const values = samples.map((sample) => sample.value)
  const frameDeltas = values.slice(1).map((value, index) => value - values[index])
  const positiveFrames = frameDeltas.filter((delta) => delta > 0.00001).length
  const maxForwardDelta = Math.max(0, ...frameDeltas)
  const minDelta = Math.min(0, ...frameDeltas)
  const renderedProgress = await progressBar.getAttribute('aria-valuenow')

  const secondaryRow = win.locator('[data-task-state="downloading"]').filter({ hasText: secondaryTask.filename })
  await secondaryRow.waitFor({ state: 'visible', timeout: 3_000 })
  const heroSwitcher = hero.locator('[data-hero-cycle]')
  await heroSwitcher.waitFor({ state: 'visible', timeout: 3_000 })
  const initialHeroPosition = (await heroSwitcher.textContent())?.trim()
  const parallelEta = await secondaryRow.locator('[data-task-time]').textContent()

  const rowProgressBar = secondaryRow.getByRole('progressbar')
  const rowMotionSamplesPromise = win.evaluate(async () => {
    const fill = document.querySelector('[data-row-progress-fill]')
    if (!(fill instanceof HTMLElement)) return []
    const samples = []
    const startedAt = performance.now()
    return await new Promise((resolve) => {
      const sample = (now) => {
        const match = fill.style.transform.match(/scaleX\(([^)]+)\)/)
        samples.push({ at: now - startedAt, value: Number(match?.[1] ?? 0) })
        if (now - startedAt < 720) requestAnimationFrame(sample)
        else resolve(samples)
      }
      requestAnimationFrame(sample)
    })
  })
  const rowSnapshotMotion = (async () => {
    for (const fraction of [0.56, 0.62]) {
      await win.waitForTimeout(250)
      secondaryTask.completedBytes = secondaryTask.fileSize * fraction
      await pushSnapshot()
    }
  })()
  const [rowMotionSamples] = await Promise.all([rowMotionSamplesPromise, rowSnapshotMotion])
  const rowValues = rowMotionSamples.map((sample) => sample.value)
  const rowFrameDeltas = rowValues.slice(1).map((value, index) => value - rowValues[index])
  const rowRenderedProgress = await rowProgressBar.getAttribute('aria-valuenow')

  await secondaryRow.click()
  const chartPath = win.locator('[data-speed-path]')
  await chartPath.waitFor({ state: 'attached', timeout: 3_000 })
  await win.waitForTimeout(560)
  const chartSampling = win.evaluate(async () => {
    const path = document.querySelector('[data-speed-path]')
    if (!(path instanceof SVGPathElement)) return []
    const samples = []
    const startedAt = performance.now()
    return await new Promise((resolve) => {
      const sample = (now) => {
        samples.push(path.getAttribute('d') ?? '')
        if (now - startedAt < 420) requestAnimationFrame(sample)
        else resolve(samples)
      }
      requestAnimationFrame(sample)
    })
  })
  await win.waitForTimeout(40)
  secondaryTask.bytesPerSecond = 5_000_000
  await pushSnapshot()
  const chartPaths = await chartSampling
  const finalChartPath = await chartPath.getAttribute('d') ?? ''
  const chartStyle = await chartPath.evaluate((path) => path.getAttribute('style') ?? '')

  const startedAt = performance.now()
  const frameHashes = []
  for (let sample = 0; sample < 4; sample += 1) {
    const frame = await canvas.screenshot()
    frameHashes.push(createHash('sha256').update(frame).digest('hex'))
    await win.waitForTimeout(160)
  }
  await win.waitForTimeout(1_000)
  const frameEnd = await canvas.evaluate((node) => node.__ndmFxFrames ?? 0)
  const elapsedSeconds = (performance.now() - startedAt) / 1_000

  task.status = 'paused'
  task.bytesPerSecond = 0
  await pushSnapshot()
  const pausedHero = win.locator('[data-hero-state="paused"]').filter({ hasText: task.filename })
  await pausedHero.waitFor({ state: 'visible', timeout: 3_000 })
  await pausedHero.getByText(task.filename, { exact: true }).click()
  const pausedInspector = win.locator('aside').filter({ hasText: task.filename })
  await pausedInspector.waitFor({ state: 'visible', timeout: 3_000 })
  await win.waitForTimeout(140)
  const pausedFramesStart = await canvas.evaluate((node) => node.__ndmFxFrames ?? 0)
  await win.waitForTimeout(360)
  const pausedFramesEnd = await canvas.evaluate((node) => node.__ndmFxFrames ?? 0)
  const pauseContinuity = {
    retained: await pausedHero.isVisible(),
    status: await pausedHero.getByText('已暂停', { exact: true }).first().isVisible(),
    statusCount: await pausedHero.getByText('已暂停', { exact: true }).count(),
    retainedProgress: (await pausedHero.locator('[data-hero-rest-progress]').textContent())?.replace(/\s+/g, ' ').trim(),
    resumeAction: await pausedHero.getByRole('button', { name: '继续下载' }).isVisible(),
    inspectorPhaseHidden: !await pausedInspector.getByText('正在下载音视频', { exact: true }).count(),
    frameDelta: pausedFramesEnd - pausedFramesStart,
    canvasOpacity: await canvas.evaluate((node) => getComputedStyle(node).opacity)
  }
  const spotlight = {
    initialPosition: initialHeroPosition,
    retainedWhilePeerDownloads: await pausedHero.isVisible(),
    switcherPosition: (await pausedHero.locator('[data-hero-cycle]').textContent())?.trim()
  }
  writeFileSync('/tmp/ndm-pause-continuity.png', await win.screenshot())

  task.status = 'downloading'
  task.bytesPerSecond = 24_000_000
  await pushSnapshot()
  await win.locator('[data-hero-state="downloading"]').filter({ hasText: task.filename }).waitFor({ state: 'visible', timeout: 3_000 })
  await win.waitForTimeout(360)
  const resumedFrames = await canvas.evaluate((node) => node.__ndmFxFrames ?? 0)
  const resumedHero = win.locator('[data-hero-state="downloading"]').filter({ hasText: task.filename })
  const outgoingHeroContent = resumedHero.locator(`[data-hero-content="${task.id}"]`)
  await resumedHero.locator('[data-hero-cycle]').click()
  const incomingHeroContent = win.locator(`[data-hero-content="${secondaryTask.id}"]`)
  await incomingHeroContent.waitFor({ state: 'visible', timeout: 3_000 })
  spotlight.transitionLayers = await win.locator('[data-hero-content]').count()
  await outgoingHeroContent.waitFor({ state: 'detached', timeout: 1_000 })
  spotlight.settledLayers = await win.locator('[data-hero-content]').count()
  spotlight.switchedToPeer = await incomingHeroContent.getByText(secondaryTask.filename, { exact: true }).isVisible()
  spotlight.switchedPosition = (await incomingHeroContent.locator('[data-hero-cycle]').textContent())?.trim()
  const switchedInspector = win.locator('aside').filter({ hasText: secondaryTask.filename })
  await switchedInspector.waitFor({ state: 'visible', timeout: 1_000 })
  spotlight.inspectorFollowed = await switchedInspector.isVisible()
  const switchedHero = win.locator('[data-hero-state="downloading"]').filter({ hasText: secondaryTask.filename })
  const speedMetric = switchedHero.locator('[data-hero-speed]')
  const speedTypography = await speedMetric.locator('span').first().evaluate((node) => {
    const style = getComputedStyle(node)
    return { fontFamily: style.fontFamily, fontVariantNumeric: style.fontVariantNumeric }
  })
  const heroText = (await switchedHero.textContent())?.replace(/\s+/g, ' ').trim() ?? ''
  const inspectorSummaryText = (await switchedInspector.locator('[data-inspector-summary]').textContent())?.replace(/\s+/g, ' ').trim() ?? ''
  const minimalism = {
    heroText,
    speedTypography,
    inspectorSummaryText,
    heroHasTuning: await switchedHero.getByText(/连接|不限速/).count() > 0,
    heroHasRedundantMetrics: /正在下载音视频|剩余|\d+%|个分段/.test(heroText),
    inspectorHasRedundantSummary: /正在下载音视频|压缩包|\d+%|秒|连接/.test(inspectorSummaryText)
  }
  writeFileSync('/tmp/ndm-focus-switch.png', await win.screenshot())

  secondaryTask.status = 'complete'
  secondaryTask.completedBytes = secondaryTask.fileSize
  secondaryTask.bytesPerSecond = 0
  await pushSnapshot()
  const handedOffContent = win.locator(`[data-hero-content="${task.id}"]`)
  await handedOffContent.waitFor({ state: 'visible', timeout: 3_000 })
  await incomingHeroContent.waitFor({ state: 'detached', timeout: 1_000 })
  spotlight.automaticHandoff = await handedOffContent.getByText(task.filename, { exact: true }).isVisible()
  spotlight.singleAfterHandoff = await handedOffContent.locator('[data-hero-cycle]').count() === 0
  const result = {
    surface,
    fps: Number(((frameEnd - surface.frames) / elapsedSeconds).toFixed(1)),
    distinctFrames: new Set(frameHashes).size,
    progress: {
      samples: samples.length,
      positiveFrames,
      maxForwardDelta: Number(maxForwardDelta.toFixed(5)),
      minDelta: Number(minDelta.toFixed(5)),
      authoritativePercent: Number(renderedProgress)
    },
    parallelEta,
    rowProgress: {
      samples: rowMotionSamples.length,
      positiveFrames: rowFrameDeltas.filter((delta) => delta > 0.00001).length,
      maxForwardDelta: Number(Math.max(0, ...rowFrameDeltas).toFixed(5)),
      minDelta: Number(Math.min(0, ...rowFrameDeltas).toFixed(5)),
      authoritativePercent: Number(rowRenderedProgress)
    },
    speedChart: {
      samples: chartPaths.length,
      distinctPaths: new Set(chartPaths).size,
      cubicSegments: (finalChartPath.match(/C/g) ?? []).length,
      inlineStyle: chartStyle
    },
    pauseContinuity: {
      ...pauseContinuity,
      resumedFrameDelta: resumedFrames - pausedFramesEnd
    },
    spotlight,
    minimalism,
    issues
  }

  writeFileSync('/tmp/ndm-transfer-motion.png', await win.screenshot())
  console.log(JSON.stringify(result))
  if (
    surface.backingWidth / surface.cssWidth < 1.9 ||
    surface.backingHeight / surface.cssHeight < 1.9 ||
    result.fps < 50 ||
    result.distinctFrames < 3 ||
    result.progress.samples < 30 ||
    result.progress.positiveFrames < 12 ||
    result.progress.maxForwardDelta > 0.012 ||
    result.progress.minDelta < -0.00001 ||
    result.progress.authoritativePercent !== 75 ||
    result.parallelEta?.trim() !== '剩余 5秒' ||
    result.rowProgress.samples < 30 ||
    result.rowProgress.positiveFrames < 12 ||
    result.rowProgress.maxForwardDelta > 0.012 ||
    result.rowProgress.minDelta < -0.00001 ||
    result.rowProgress.authoritativePercent !== 62 ||
    result.speedChart.samples < 20 ||
    result.speedChart.distinctPaths < 4 ||
    result.speedChart.cubicSegments !== 39 ||
    /transition(?:-property)?:\s*all/i.test(result.speedChart.inlineStyle) ||
    !result.pauseContinuity.retained ||
    !result.pauseContinuity.status ||
    result.pauseContinuity.statusCount !== 1 ||
    result.pauseContinuity.retainedProgress !== '715 MB已安全保留' ||
    !result.pauseContinuity.resumeAction ||
    !result.pauseContinuity.inspectorPhaseHidden ||
    result.pauseContinuity.frameDelta !== 0 ||
    result.pauseContinuity.canvasOpacity !== '0.16' ||
    result.pauseContinuity.resumedFrameDelta < 8 ||
    result.spotlight.initialPosition !== '1/2' ||
    !result.spotlight.retainedWhilePeerDownloads ||
    result.spotlight.switcherPosition !== '1/2' ||
    result.spotlight.transitionLayers < 2 ||
    result.spotlight.settledLayers !== 1 ||
    !result.spotlight.switchedToPeer ||
    result.spotlight.switchedPosition !== '2/2' ||
    !result.spotlight.inspectorFollowed ||
    !result.spotlight.automaticHandoff ||
    !result.spotlight.singleAfterHandoff ||
    result.minimalism.heroHasTuning ||
    result.minimalism.heroHasRedundantMetrics ||
    result.minimalism.inspectorHasRedundantSummary ||
    /IBM Plex Mono/i.test(result.minimalism.speedTypography.fontFamily) ||
    !result.minimalism.speedTypography.fontVariantNumeric.includes('tabular-nums') ||
    issues.length > 0
  ) process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
