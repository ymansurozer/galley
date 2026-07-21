// crypto.randomUUID() is secure-context-gated: on a plain-HTTP non-localhost origin
// (GALLEY_HOST/tailnet desks, e.g. http://devbox:41443/) it's undefined and comment creation
// would throw. crypto.getRandomValues() has no such gate, so build an RFC-4122 v4 UUID from it
// when the native call isn't available — same shape as native, no Math.random fallback.
export function uuidFallback(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuid(): string {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : uuidFallback();
}
