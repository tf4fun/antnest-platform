package server

// Fixed independent test vector: HMAC-SHA256(testCSRFKey, "token-1").
// Session IDs come from the Identity double, never from request headers.
const testCSRFKey = "0123456789abcdef0123456789abcdef"
const testCSRFToken = "9mcP8ic4-686eM_qh1iVGgPDZV79Wrxeq-v9X8LA8hs"
