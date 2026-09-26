-- Session invalidation on password change. requireAuth rejects any JWT whose
-- iat predates this stamp, so changing (or an administrator resetting) a
-- password retires every session issued before it. Null for all existing
-- accounts: their pre-migration sessions stay valid until a password change.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
