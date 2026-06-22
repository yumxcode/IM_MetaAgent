/**
 * AES-128-ECB 加解密工具（PKCS7 padding）。
 *
 * 微信 CDN 上所有媒体文件都用 AES-128-ECB 加密：
 *  - 上传前：encryptAesEcb(plaintext, key)
 *  - 下载后：decryptAesEcb(ciphertext, key)
 *  - 密文大小需对齐到 16 字节边界（PKCS7）
 *
 * 与官方插件的 aes-ecb 实现行为完全一致。
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

/** 用 AES-128-ECB 加密 buffer（PKCS7 padding 为默认）。 */
export function encryptAesEcb(plaintext, key) {
  if (key.length !== 16) {
    throw new Error(`AES-128-ECB requires a 16-byte key, got ${key.length} bytes`);
  }
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 用 AES-128-ECB 解密 buffer（PKCS7 padding）。 */
export function decryptAesEcb(ciphertext, key) {
  if (key.length !== 16) {
    throw new Error(`AES-128-ECB requires a 16-byte key, got ${key.length} bytes`);
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 计算 AES-128-ECB 密文大小（PKCS7 padding 到 16 字节边界）。 */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
