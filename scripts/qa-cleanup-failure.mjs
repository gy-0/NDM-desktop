// Exercise the history dialog after its isolated Swift host disconnects.
process.argv.push('--disconnect')
await import('./qa-cleanup-library.mjs')
