/*
  Warnings:

  - The values [open] on the enum `ComplaintStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ComplaintStatus_new" AS ENUM ('pending', 'in_progress', 'resolved');
ALTER TABLE "Complaint" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Complaint" ALTER COLUMN "status" TYPE "ComplaintStatus_new" USING ("status"::text::"ComplaintStatus_new");
ALTER TYPE "ComplaintStatus" RENAME TO "ComplaintStatus_old";
ALTER TYPE "ComplaintStatus_new" RENAME TO "ComplaintStatus";
DROP TYPE "ComplaintStatus_old";
ALTER TABLE "Complaint" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

-- AlterTable
ALTER TABLE "Complaint" ALTER COLUMN "status" SET DEFAULT 'pending';
