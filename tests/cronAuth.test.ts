import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { authorizeCronRequest, getBearerToken } from "../lib/cronAuth";

function requestWithAuth(header: string | null): NextRequest {
  const headers = new Headers();
  if (header) headers.set("authorization", header);
  return new NextRequest("http://localhost/api/cron/ev-pipeline", { headers });
}

{
  assert.equal(getBearerToken(requestWithAuth("Bearer secret-token")), "secret-token");
  assert.equal(getBearerToken(requestWithAuth("bearer abc")), "abc");
  assert.equal(getBearerToken(requestWithAuth(null)), null);
  assert.equal(getBearerToken(requestWithAuth("Basic abc")), null);

  assert.equal(authorizeCronRequest(requestWithAuth("Bearer good"), "good"), true);
  assert.equal(authorizeCronRequest(requestWithAuth("Bearer bad"), "good"), false);
  assert.equal(authorizeCronRequest(requestWithAuth(null), "good"), false);
  assert.equal(authorizeCronRequest(requestWithAuth(null), null), true);
  assert.equal(
    authorizeCronRequest(
      new NextRequest("http://localhost/api/cron/ev-pipeline?secret=leaked"),
      "leaked"
    ),
    false
  );

  console.log("✓ cronAuth.test.ts");
}
