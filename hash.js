// Codex / 2026-10-25. Pinned @noble/hashes 2.4.0, MIT; local modules only.
import { sha256 as digest } from './vendor/noble/sha2.js?v=usage1';
export const createHasher = () => digest.create();
export const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
export const sha256 = bytes => hex(digest(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
