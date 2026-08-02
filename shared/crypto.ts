const PBKDF2_ITERATIONS = 100_000;
const SALT_LEN = 16;
const IV_LEN = 12; // AES-GCM
const KEY_LEN = 256; // bits

export async function encryptPayload(plaintext: Uint8Array, code: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(code, salt);

  const enc = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext as BufferSource
  );
  // enc contains ciphertext + 16-byte auth tag (appended)
  const ciphertext = new Uint8Array(enc);

  // concat: salt (16) | iv (12) | ciphertext
  const out = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.length);
  out.set(salt, 0);
  out.set(iv, SALT_LEN);
  out.set(ciphertext, SALT_LEN + IV_LEN);
  return out;
}

export async function decryptPayload(data: Uint8Array, code: string): Promise<Uint8Array> {
  if (data.length < SALT_LEN + IV_LEN + 16) throw new Error("Payload too short");
  const salt = data.subarray(0, SALT_LEN);
  const iv = data.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = data.subarray(SALT_LEN + IV_LEN);

  const key = await deriveKey(code, salt);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error("Decryption failed — wrong code or corrupted data.");
  }
}

async function deriveKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(code),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: KEY_LEN },
    false,
    ["encrypt", "decrypt"]
  );
}