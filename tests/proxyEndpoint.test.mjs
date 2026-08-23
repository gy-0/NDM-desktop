import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatProxyEndpoint, formatProxyURL, parseProxyEndpoint } from '../src/shared/proxyEndpoint.ts'

test('parses hostnames, IPv4 and bracketed IPv6 proxy endpoints', () => {
  assert.deepEqual(parseProxyEndpoint('127.0.0.1:7890', 8080), {
    ok: true,
    endpoint: { host: '127.0.0.1', port: 7890 }
  })
  assert.deepEqual(parseProxyEndpoint('proxy.example.com', 8080), {
    ok: true,
    endpoint: { host: 'proxy.example.com', port: 8080 }
  })
  assert.deepEqual(parseProxyEndpoint('[::1]:7890', 8080), {
    ok: true,
    endpoint: { host: '::1', port: 7890 }
  })
  assert.deepEqual(parseProxyEndpoint('[2001:db8::1]', 1080), {
    ok: true,
    endpoint: { host: '2001:db8::1', port: 1080 }
  })
  assert.deepEqual(parseProxyEndpoint('   ', 8080), { ok: true, endpoint: null })
})

test('rejects ambiguous IPv6, invalid ports and URL-like proxy input', () => {
  assert.deepEqual(parseProxyEndpoint('::1:7890', 8080), { ok: false, error: 'ipv6Brackets' })
  for (const value of ['proxy:0', 'proxy:65536', 'proxy:abc', 'proxy:']) {
    assert.deepEqual(parseProxyEndpoint(value, 8080), { ok: false, error: 'port' })
  }
  for (const value of ['http://proxy:7890', 'user@proxy:7890', 'proxy/path']) {
    assert.deepEqual(parseProxyEndpoint(value, 8080), { ok: false, error: 'format' })
  }
})

test('formats proxy endpoints and URLs with bracketed IPv6 hosts', () => {
  assert.equal(formatProxyEndpoint('proxy.example.com', 7890), 'proxy.example.com:7890')
  assert.equal(formatProxyEndpoint('::1', 7890), '[::1]:7890')
  assert.equal(formatProxyURL('http', '::1', 7890), 'http://[::1]:7890')
  assert.equal(formatProxyURL('socks5', 'proxy.example.com', 1080), 'socks5://proxy.example.com:1080')
})
