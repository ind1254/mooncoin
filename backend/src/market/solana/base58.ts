/**
 * Base58 encoding for Solana public keys.
 *
 * A Solana address is 32 raw bytes; base58 is only how humans read it. When we
 * decode an account we get those bytes back, and to use one in another RPC
 * call it has to be re-encoded.
 *
 * Base58 is base64 minus the characters that misread when copied by hand:
 * 0/O and I/l are excluded. That is the entire design rationale, and it is why
 * the alphabet below is not sorted the way you would expect.
 *
 * The algorithm is plain positional base conversion: treat the bytes as one
 * big-endian integer and repeatedly divide by 58. Leading zero BYTES carry no
 * numeric weight, so they would vanish in the arithmetic — they are re-added
 * afterwards as leading '1' characters, one per zero byte. That special case
 * is why the all-zero pubkey encodes to thirty-two '1's, which is the System
 * Program's address.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = 58n;

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = value % BASE;
    value /= BASE;
    encoded = ALPHABET[Number(remainder)] + encoded;
  }

  // One '1' per leading zero byte, restoring the length the arithmetic drops.
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }

  return encoded;
}

/** Read a 32-byte pubkey at `offset` and return it as a base58 address. */
export function readPubkey(data: Uint8Array, offset: number): string {
  return base58Encode(data.subarray(offset, offset + 32));
}
