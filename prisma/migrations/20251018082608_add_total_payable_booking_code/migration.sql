/*
  Warnings:

  - A unique constraint covering the columns `[bookingCode]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "bookingCode" TEXT,
ADD COLUMN     "totalPayable" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Lead_bookingCode_key" ON "Lead"("bookingCode");
