-- Sign-in with Keycloak (OpenID Connect).
-- Each session records how it was signed in: "email", or an OIDC provider id from the config,
-- and for an OIDC session the provider account (the token's subject) it belongs to.
ALTER TABLE "session" ADD COLUMN "provider" TEXT;
ALTER TABLE "session" ADD COLUMN "subject" TEXT;
-- The groups and realm roles from a provider's tokens, per provider account (provider + the
-- token's subject). Written only from that provider's tokens, at sign-in and at each refresh.
CREATE TABLE "oidcClaims" (
  "providerId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "groups" TEXT NOT NULL DEFAULT '[]',
  "roles" TEXT NOT NULL DEFAULT '[]',
  "refreshedAt" INTEGER NOT NULL,
  -- While one request refreshes the claims, others wait until this time (ms) rather than refresh
  -- too. refreshLock names that refresh: only the refresh holding it may write its result.
  "refreshingUntil" INTEGER NOT NULL DEFAULT 0,
  "refreshLock" TEXT,
  PRIMARY KEY ("providerId", "subject")
);
CREATE INDEX "oidcClaims_user" ON "oidcClaims"("userId", "providerId");
