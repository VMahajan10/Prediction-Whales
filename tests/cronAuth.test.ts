import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { authorizeCronRequest, getBearerToken } from "../lib/cronAuth";

function requestWithAuth(header: string | null): NextRequest {
  const headers = new Headers();
  if (header) headers.set("authorization", header);
  return new NextRequest("http://localhost/api/cron/ev-pipeline", { headers });
}

describe("cronAuth", () => {
  it("extracts bearer tokens case-insensitively", () => {
    expect(getBearerToken(requestWithAuth("Bearer secret-token"))).toBe(
      "secret-token"
    );
    expect(getBearerToken(requestWithAuth("bearer abc"))).toBe("abc");
    expect(getBearerToken(requestWithAuth(null))).toBeNull();
    expect(getBearerToken(requestWithAuth("Basic abc"))).toBeNull();
  });

  it("authorizes cron requests with bearer secret only", () => {
    expect(authorizeCronRequest(requestWithAuth("Bearer good"), "good")).toBe(
      true
    );
    expect(authorizeCronRequest(requestWithAuth("Bearer bad"), "good")).toBe(
      false
    );
    expect(authorizeCronRequest(requestWithAuth(null), "good")).toBe(false);
    expect(authorizeCronRequest(requestWithAuth(null), null)).toBe(true);
    expect(
      authorizeCronRequest(
        new NextRequest("http://localhost/api/cron/ev-pipeline?secret=leaked"),
        "leaked"
      )
    ).toBe(false);
  });
});
