-- Sign-in with Keycloak (OpenID Connect).
-- Each session records how it was signed in: "email", or an OIDC provider id from the config.
ALTER TABLE "session" ADD COLUMN "provider" TEXT;
-- The groups and realm roles from a provider's tokens, per provider account (provider + the
-- token's subject). Written only from that provider's tokens, at sign-in and at each refresh.
CREATE TABLE "oidcClaims" (
  "providerId" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "groups" TEXT NOT NULL DEFAULT '[]',
  "roles" TEXT NOT NULL DEFAULT '[]',
  "refreshedAt" INTEGER NOT NULL,
  PRIMARY KEY ("providerId", "subject")
);
CREATE INDEX "oidcClaims_user" ON "oidcClaims"("userId", "providerId");
