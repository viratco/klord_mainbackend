/*
  Warnings:

  - The values [waare,tata,satvik,rayzon,navitas,pahal,vikram] on the enum `PanelProvider` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PanelProvider_new" AS ENUM ('purvanchal_vv', 'torrent_power', 'paschimanchal', 'mvvnl', 'dvvnl', 'npcl');
ALTER TABLE "Lead" ALTER COLUMN "provider" TYPE "PanelProvider_new" USING ("provider"::text::"PanelProvider_new");
ALTER TYPE "PanelProvider" RENAME TO "PanelProvider_old";
ALTER TYPE "PanelProvider_new" RENAME TO "PanelProvider";
DROP TYPE "PanelProvider_old";
COMMIT;
