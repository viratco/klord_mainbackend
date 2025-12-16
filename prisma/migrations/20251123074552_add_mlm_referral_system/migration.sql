/*
  Warnings:

  - A unique constraint covering the columns `[referralCode]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referralCode" TEXT,
ADD COLUMN     "referredBy" TEXT;

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "fromCustomerId" TEXT NOT NULL,
    "levelFromDownline" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MlSettings" (
    "id" TEXT NOT NULL,
    "maxPayoutPercent" DOUBLE PRECISION NOT NULL DEFAULT 4.0,
    "level1Percent" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "level2Percent" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "level3Percent" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_customerId_key" ON "Wallet"("customerId");

-- CreateIndex
CREATE INDEX "Commission_customerId_idx" ON "Commission"("customerId");

-- CreateIndex
CREATE INDEX "Commission_fromCustomerId_idx" ON "Commission"("fromCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_referralCode_key" ON "Customer"("referralCode");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_referredBy_fkey" FOREIGN KEY ("referredBy") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_fromCustomerId_fkey" FOREIGN KEY ("fromCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
