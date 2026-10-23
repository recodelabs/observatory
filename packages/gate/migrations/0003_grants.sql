-- Sites an admin has opened to a user on the admin page (invites and later changes), on top of
-- the config's own `access`: a closed site also lets in the users granted it. One row per user
-- and site name (the `name` in the config's `sites`).
CREATE TABLE "siteGrant" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "site" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "createdBy" TEXT,
  PRIMARY KEY ("userId", "site")
);
