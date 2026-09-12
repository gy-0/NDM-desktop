// Same isolated host/browser event harness, focused on deferred frame downloads.
process.env.NDM_QA_SUITE = 'download-coverage'
process.env.NDM_QA_OUTPUT_DIR ||= 'outputs/relay-download-coverage/after'
await import('./qa-relay-file-clicks.mjs')
