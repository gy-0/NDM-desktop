const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../session-cookies.js');
const url = 'https://www.youtube.com/watch?v=fixture';
const cookie = (overrides = {}) => ({ domain: '.youtube.com', hostOnly: false, path: '/', secure: true,
    httpOnly: true, session: true, name: 'SESSION', value: 'fixture-only', ...overrides });

test('media jar preserves HttpOnly, domain, path, secure and expiry while excluding unrelated credentials', () => {
    const rows = [cookie(), cookie({ domain: '.google.com' }), cookie({ path: '/account' }),
        cookie({ domain: 'youtube.com', hostOnly: true }), cookie({ name: 'expired', session: false, expirationDate: 1 }),
        cookie({ name: 'injected', value: 'value\n13:evil' })];
    const jar = session.netscape(rows, url);
    assert.equal(jar, '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSESSION\tfixture-only\n');
    assert.equal(Buffer.from(session.encode(jar), 'base64').toString('utf8'), jar);
    assert.equal(session.header(rows, url), 'SESSION=fixture-only');
    assert.equal(session.header(rows, 'http://www.youtube.com/watch'), '');
    assert.equal(session.header(rows, 'https://www.youtube.com.evil.test/watch'), '');
});

test('cookie paths require a boundary and host-only scope is retained', () => {
    const c = cookie({ domain: 'files.example.com', hostOnly: true, path: '/export', secure: false });
    assert.equal(session.matches(c, 'https://files.example.com/export/a.zip'), true);
    assert.equal(session.matches(c, 'https://files.example.com/exports/a.zip'), false);
    assert.equal(session.matches(c, 'https://sub.files.example.com/export/a.zip'), false);
    assert.match(session.netscape([c], 'https://files.example.com/export'), /#HttpOnly_files.example.com\tFALSE\t\/export\tFALSE/);
});

test('reads initiating tab store and frame partition, never a different signed-in profile', async () => {
    const calls = [];
    const partitionKey = { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true };
    const chrome = { runtime: {}, cookies: {
        getAllCookieStores(callback) { callback([{ id: 'ordinary', tabIds: [1] }, { id: 'private', tabIds: [42] }]); },
        getPartitionKey(details, callback) { calls.push(details); callback({ partitionKey }); },
        getAll(details, callback) {
            calls.push(details);
            callback(details.partitionKey ? [cookie({ storeId: 'private', partitionKey, value: 'frame-session' }),
                cookie({ name: 'wrong-partition', storeId: 'private', partitionKey: { topLevelSite: 'https://wrong.test' } })]
                : [cookie({ storeId: 'private' }), cookie({ name: 'wrong-profile', storeId: 'ordinary' })]);
        }
    } };
    const cookies = await session.read(chrome, { url, tabId: 42, frameId: 7 });
    assert.deepEqual(calls[0], { tabId: 42, frameId: 7 });
    assert.ok(calls.slice(1).every(details => details.storeId === 'private' && details.url === url));
    assert.equal(session.header(cookies, url), 'SESSION=frame-session');
    assert.deepEqual(await session.read(chrome, { url, tabId: 999 }), []);
});

test('browser cookie denial does not invent a login requirement; older APIs still work', async () => {
    assert.deepEqual(await session.read({ runtime: {}, cookies: { getAll(_details, cb) { cb([]); } } }, { url }), []);
    assert.deepEqual(await session.read({ runtime: {}, cookies: { getAll() { return Promise.reject(Error('denied')); } } }, { url }), []);
    const cookies = await session.read({ runtime: {}, cookies: { getAll() { return Promise.resolve([cookie()]); } } }, { url });
    assert.equal(cookies.length, 1);
});

test('browser identity distinguishes the actual extension runtime', () => {
    assert.equal(session.browserName({ userAgent: 'Mozilla Edg/123' }), 'edge');
    assert.equal(session.browserName({ userAgent: 'Mozilla Firefox/123' }), 'firefox');
    assert.equal(session.browserName({ userAgent: 'Chrome/123' }), 'chrome');
    assert.equal(session.browserName({ userAgent: 'Chrome/123 OPR/99' }), 'chromium');
});

test('routing survives worker restart without persisting Cookie values or changing the original profile', async () => {
    const saved = {};
    const chrome = { runtime: {}, storage: { session: {
        get(key, callback) { callback(saved); },
        set(value, callback) { Object.assign(saved, structuredClone(value)); callback(); }
    } } };
    const context = { url, storeId: 'original-private-profile', tabId: 42, frameId: 5,
        partitionKey: { topLevelSite:'https://example.com',hasCrossSiteAncestor:true }, cookie: 'must-never-persist', cookies:[cookie()] };
    const first = session.createRegistry(chrome);
    await first.remember('opaque-token', context);
    assert.doesNotMatch(JSON.stringify(saved), /must-never-persist|fixture-only|SESSION/);
    const restarted = session.createRegistry(chrome);
    assert.equal((await restarted.find('opaque-token', url)).storeId, 'original-private-profile');
    assert.equal(await restarted.find('opaque-token','https://www.youtube.com/watch?v=different'), null);
    assert.equal(await restarted.find('unknown',url), null);
    const requested = [];
    chrome.cookies = { getAllCookieStores() { throw Error('Must not rediscover from a now unrelated tab'); },
        getPartitionKey() { throw Error('Must retain original partition after navigation'); },
        getAll(details, callback) { requested.push(details); callback([]); } };
    await session.capture(chrome, await restarted.find('opaque-token', url));
    assert.ok(requested.every(details => details.storeId === 'original-private-profile'));
    assert.equal(requested[1].partitionKey.topLevelSite, 'https://example.com');
});
