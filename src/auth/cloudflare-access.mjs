import { createRemoteJWKSet, jwtVerify } from "jose";

export function createAccessVerifier({ teamDomain, audience, allowedEmail }) {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain ?? "")) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN must be a Cloudflare Access HTTPS team domain.");
  }
  if (typeof audience !== "string" || !/^[a-f0-9]{64}$/i.test(audience)) {
    throw new Error("CF_ACCESS_AUD must be the Access application audience tag.");
  }
  if (typeof allowedEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(allowedEmail)) {
    throw new Error("CF_ACCESS_ALLOWED_EMAIL must be the authorized Cloudflare Access email.");
  }
  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  return async function verify(request) {
    const header = request.headers["cf-access-jwt-assertion"];
    if (typeof header !== "string" || !header) return false;
    try {
      const { payload } = await jwtVerify(header, jwks, {
        issuer: teamDomain,
        audience,
        algorithms: ["RS256"],
      });
      return payload.email?.toLowerCase() === allowedEmail.toLowerCase();
    } catch {
      return false;
    }
  };
}
