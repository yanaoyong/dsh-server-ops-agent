// Questions and model prose may contain pasted authentication material.
export function redact(text) {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[私钥已隐藏]'
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [已隐藏]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|cookie|set-cookie)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[已隐藏]'
    )
    .replace(/([?&](?:code|token|key)=)[^\s&#]+/gi, '$1[已隐藏]')
}
