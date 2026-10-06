import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildCdnDownloadUrl, buildCdnUploadUrl, parseAesKey,
  downloadAndDecryptBuffer, downloadPlainCdnBuffer, downloadRemoteUrlToTemp,
  uploadBufferToCdn, uploadBuffer, uploadVoice, uploadFileAttachment,
  saveBufferToFile, WEIXIN_MEDIA_MAX_BYTES,
} from '../src/media.mjs';
import { encryptAesEcb, decryptAesEcb } from '../src/crypto.mjs';
import { UploadMediaType } from '../src/constants.mjs';

const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const media = { encrypt_query_param: 'legacy+secret/a', aes_key: key.toString('base64') };
const cdn = 'https://cdn.example.test/c2c';
async function fakeFetch(fn, action) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await action(); } finally { globalThis.fetch = original; }
}
async function tempDir(action) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ilink-media-test-'));
  try { return await action(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function uploadResponse(param = 'verified-download-parameter') {
  return new Response(null, { status: 200, headers: { 'x-encrypted-param': param } });
}
const uploadArgs = { buf: Buffer.from('payload'), aeskey: key, filekey: 'file-key', uploadParam: 'upload+secret', cdnBaseUrl: cdn };

test('AES key parsing accepts both official encodings and rejects malformed values without revealing keys', () => {
  assert.deepEqual(parseAesKey(key.toString('base64')), key);
  assert.deepEqual(parseAesKey(Buffer.from(key.toString('hex')).toString('base64')), key);
  assert.deepEqual(parseAesKey(key.toString('base64').replace(/=+$/, '')), key);
  for (const value of ['', 'not@base64', 'AQ==', key.toString('base64') + '!']) {
    assert.throws(() => parseAesKey(value), /aes_key/);
  }
});

test('URL builders encode legacy signatures and prefer signed upload URLs unchanged', () => {
  assert.equal(buildCdnDownloadUrl('a/b+c=', cdn + '/'), cdn + '/download?encrypted_query_param=a%2Fb%2Bc%3D');
  assert.equal(buildCdnUploadUrl({ ...uploadArgs }), cdn + '/upload?encrypted_query_param=upload%2Bsecret&filekey=file-key');
  const full = 'https://cdn.example.test/raw/path?x=a%2Fb+c&signature=secret';
  assert.equal(buildCdnUploadUrl({ ...uploadArgs, uploadFullUrl: full }), full);
});

test('encrypted full_url takes priority and accepts hex-string base64 keys', async () => {
  const full = 'https://cdn.example.test/raw/object?signature=keep%2Fexact';
  const plaintext = Buffer.from('A picture, a video, or a file');
  await fakeFetch(async (url, options) => {
    assert.equal(url, full);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(encryptAesEcb(plaintext, key));
  }, async () => {
    assert.deepEqual(await downloadAndDecryptBuffer({ ...media, full_url: full,
      aes_key: Buffer.from(key.toString('hex')).toString('base64') }), plaintext);
  });
});

test('legacy encrypted query and plaintext media download forms remain compatible', async () => {
  await fakeFetch(async (url) => {
    assert.equal(url, buildCdnDownloadUrl(media.encrypt_query_param, cdn));
    return new Response(encryptAesEcb(Buffer.from('legacy'), key));
  }, async () => assert.equal((await downloadAndDecryptBuffer(media.encrypt_query_param, media.aes_key, cdn)).toString(), 'legacy'));
  await fakeFetch(async (url) => {
    assert.equal(url, 'https://cdn.example.test/raw-file');
    return new Response('plain');
  }, async () => assert.equal((await downloadPlainCdnBuffer({ full_url: 'https://cdn.example.test/raw-file' })).toString(), 'plain'));
  await fakeFetch(async (url) => {
    assert.equal(url, buildCdnDownloadUrl('signed', cdn));
    return new Response('legacy-plain');
  }, async () => assert.equal((await downloadPlainCdnBuffer('signed', cdn)).toString(), 'legacy-plain'));
});

test('non-HTTP media URLs fail before fetching', async () => {
  let calls = 0;
  await fakeFetch(async () => { calls++; throw new Error('unexpected'); }, async () => {
    for (const full of ['file:///etc/passwd', 'data:text/plain,secret', 'ftp://example.test/x', 'https://user:secret@example.test/x']) {
      await assert.rejects(downloadPlainCdnBuffer({ full_url: full }), /HTTP or HTTPS/);
      await assert.rejects(uploadBufferToCdn({ ...uploadArgs, uploadFullUrl: full }), /HTTP or HTTPS/);
    }
  });
  assert.equal(calls, 0);
});

test('streaming bounds cancel excess download bytes without reading the remaining stream', async () => {
  let cancelled = false;
  let pulls = 0;
  await fakeFetch(async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(9)); },
    cancel() { cancelled = true; },
  })), async () => await assert.rejects(downloadPlainCdnBuffer({ full_url: cdn }, { maxBytes: 8 }), /exceeds 8 byte limit/));
  assert.ok(cancelled);
  assert.ok(pulls <= 3);
});

test('content-length oversized media is rejected before body reads', async () => {
  let cancelled = false;
  await fakeFetch(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-length': '1000' } }), async () =>
    await assert.rejects(downloadPlainCdnBuffer({ full_url: cdn }, { maxBytes: 8 }), /exceeds 8 byte limit/));
  assert.ok(cancelled);
});

test('encrypted limits allow PKCS7 overhead but still enforce decrypted size', async () => {
  await fakeFetch(async () => new Response(encryptAesEcb(Buffer.alloc(16), key)), async () =>
    assert.equal((await downloadAndDecryptBuffer({ ...media, full_url: cdn }, { maxBytes: 16 })).length, 16));
  await fakeFetch(async () => new Response(encryptAesEcb(Buffer.alloc(17), key)), async () =>
    await assert.rejects(downloadAndDecryptBuffer({ ...media, full_url: cdn }, { maxBytes: 16 }), /exceeds 16 byte limit/));
  await fakeFetch(async () => new Response(Buffer.alloc(48)), async () =>
    await assert.rejects(downloadAndDecryptBuffer({ ...media, full_url: cdn }, { maxBytes: 16 }), /exceeds 32 byte limit/));
});

test('download timeout remains active while consuming the response body', async () => {
  let requestSignal;
  let cancelled = false;
  await fakeFetch(async (_url, options) => {
    requestSignal = options.signal;
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }));
  }, async () => await assert.rejects(downloadPlainCdnBuffer({ full_url: cdn }, { timeoutMs: 15 }), /timeout after 15ms/));
  assert.ok(requestSignal.aborted);
  assert.ok(cancelled);
});

test('caller cancellation aborts an outstanding download without exposing signal reasons', async () => {
  const controller = new AbortController();
  let requestSignal;
  await fakeFetch((_url, options) => { requestSignal = options.signal; return new Promise(() => {}); }, async () => {
    const download = downloadPlainCdnBuffer({ full_url: cdn }, { signal: controller.signal });
    controller.abort('secret-signature');
    await assert.rejects(download, /^Error: cdn-download-plain: request cancelled$/);
  });
  assert.ok(requestSignal.aborted);
});

test('uploads post exact full URLs, encrypt data, and require actual download header', async () => {
  const full = 'https://cdn.example.test/custom-upload?signature=raw+%2F';
  await fakeFetch(async (url, options) => {
    assert.equal(url, full);
    assert.equal(options.method, 'POST');
    assert.deepEqual(decryptAesEcb(Buffer.from(options.body), key), uploadArgs.buf);
    return uploadResponse();
  }, async () => assert.equal(await uploadBufferToCdn({ ...uploadArgs, uploadFullUrl: full }), 'verified-download-parameter'));
  let calls = 0;
  await fakeFetch(async () => { calls++; return new Response('fake-download-param'); }, async () =>
    await assert.rejects(uploadBufferToCdn(uploadArgs), /invalid response/));
  assert.equal(calls, 3);
});

test('upload 4xx never retries and hides response headers/body; server failures retry', async () => {
  let calls = 0;
  await fakeFetch(async () => { calls++; return new Response('token-secret-and-url', { status: 403, headers: { 'x-error-message': 'key-secret' } }); }, async () =>
    await assert.rejects(uploadBufferToCdn(uploadArgs), /^Error: cdn-upload: CDN upload client error 403$/));
  assert.equal(calls, 1);
  calls = 0;
  await fakeFetch(async () => { calls++; return calls === 1 ? new Response('secret', { status: 503 }) : uploadResponse('after-retry'); }, async () =>
    assert.equal(await uploadBufferToCdn(uploadArgs), 'after-retry'));
  assert.equal(calls, 2);
});

test('upload timeout cancels fetch and is not retried', async () => {
  let calls = 0;
  let requestSignal;
  await fakeFetch((_url, options) => { calls++; requestSignal = options.signal; return new Promise(() => {}); }, async () =>
    await assert.rejects(uploadBufferToCdn({ ...uploadArgs, timeoutMs: 15 }), /timeout after 15ms/));
  assert.equal(calls, 1);
  assert.ok(requestSignal.aborted);
});

test('network and HTTP download errors never echo signed URLs, keys, or response bodies', async () => {
  await fakeFetch(async () => { throw new Error('token-secret https://example.test/?aes=key-secret'); }, async () =>
    await assert.rejects(downloadPlainCdnBuffer({ full_url: cdn + '?secret=sign' }), /^Error: cdn-download-plain: media download failed \(network or response error\)$/));
  await fakeFetch(async () => new Response('token-secret', { status: 403 }), async () =>
    await assert.rejects(downloadPlainCdnBuffer({ full_url: cdn }), /^Error: cdn-download-plain: CDN download HTTP 403$/));
});

test('local file bounds are checked from stat before upload; directories are rejected', async () => {
  await tempDir(async (dir) => {
    const file = path.join(dir, 'oversized.bin');
    const handle = await fs.open(file, 'w');
    await handle.truncate(WEIXIN_MEDIA_MAX_BYTES + 1);
    await handle.close();
    let calls = 0;
    await fakeFetch(async () => { calls++; throw new Error('unexpected fetch'); }, async () => {
      await assert.rejects(uploadFileAttachment({ filePath: file, toUserId: 'user', opts: {} }), /exceeds/);
      await assert.rejects(uploadFileAttachment({ filePath: dir, toUserId: 'user', opts: {} }), /regular file/);
    });
    assert.equal(calls, 0);
  });
});

test('uploadBuffer and voice pipeline honor getUploadUrl full URL and SILK type', async () => {
  const opts = { baseUrl: 'https://api.example.test', token: 'test-token' };
  let calls = 0;
  const silk = Buffer.from('\x02#!SILK_V3audio');
  await fakeFetch(async (url, options) => {
    calls++;
    if (String(url).includes('/getuploadurl')) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.media_type, UploadMediaType.VOICE);
      assert.equal(payload.rawsize, silk.length);
      assert.equal(payload.filesize, 16);
      return Response.json({ ret: 0, upload_full_url: 'https://cdn.example.test/exact?key=signature' });
    }
    assert.equal(url, 'https://cdn.example.test/exact?key=signature');
    return uploadResponse();
  }, async () => {
    const uploaded = await uploadBuffer({ buf: silk, opts, toUserId: 'user', mediaType: UploadMediaType.VOICE });
    assert.equal(uploaded.fileSize, silk.length);
    assert.equal(uploaded.fileSizeCiphertext, 16);
    assert.match(uploaded.aeskey, /^[0-9a-f]{32}$/);
  });
  assert.equal(calls, 2);
  await tempDir(async (dir) => {
    const file = path.join(dir, 'not-silk.silk');
    await fs.writeFile(file, 'not actually silk');
    await assert.rejects(uploadVoice({ filePath: file, opts, toUserId: 'user' }), /SILK V3/);
  });
});

test('saveBufferToFile strips Unix and Windows paths and all prefix/extension traversal', async () => {
  await tempDir(async (dir) => {
    for (const originalFilename of ['../../outside.txt', '..\\..\\outside.txt', '/absolute/path.txt', '..', '\0evil:name.txt']) {
      const output = await saveBufferToFile(Buffer.from('safe'), dir,
        { originalFilename, prefix: '../../evil', ext: '/../../other' });
      assert.equal(path.dirname(output), dir);
      assert.equal((await fs.readFile(output)).toString(), 'safe');
      assert.doesNotMatch(path.basename(output), /[\\:\x00]/);
    }
    assert.equal((await fs.readdir(dir)).length, 5);
  });
});

test('remote download timeout or oversize leaves no temporary file', async () => {
  await tempDir(async (dir) => {
    await fakeFetch(async () => new Response('way too big'), async () =>
      await assert.rejects(downloadRemoteUrlToTemp(cdn, dir, { maxBytes: 3 }), /exceeds 3 byte limit/));
    assert.deepEqual(await fs.readdir(dir), []);
    await fakeFetch(async () => new Response('picture', { headers: { 'content-type': 'image/png' } }), async () => {
      const output = await downloadRemoteUrlToTemp(cdn, dir);
      assert.equal(path.extname(output), '.png');
      assert.equal((await fs.readFile(output)).toString(), 'picture');
    });
  });
});


test('buffer size rejection occurs before any API request, including encrypted upload bounds', async () => {
  let calls = 0;
  await fakeFetch(async () => { calls++; throw new Error('unexpected API request'); }, async () => {
    await assert.rejects(uploadBuffer({ buf: Buffer.alloc(9), maxBytes: 8, mediaType: UploadMediaType.FILE }), /exceeds 8 byte limit/);
    await assert.rejects(uploadBufferToCdn({ ...uploadArgs, buf: Buffer.alloc(9), maxBytes: 8 }), /exceeds 8 byte limit/);
  });
  assert.equal(calls, 0);
});
