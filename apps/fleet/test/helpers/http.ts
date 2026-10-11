// Shared fixture builder for tests that exercise the Access-auth boundary:
// the JWT header value is the literal fixture "test-jwt", matching what the
// studio test suites' mocked verifyAccess expects — never a real credential.
export function authorizedReq(path: string, init: RequestInit = {}) {
  return new Request(`https://x${path}`, {
    ...init,
    headers: { "Cf-Access-Jwt-Assertion": "test-jwt", ...(init.headers ?? {}) },
  });
}
