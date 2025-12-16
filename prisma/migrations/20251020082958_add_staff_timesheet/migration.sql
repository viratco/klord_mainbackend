-- CreateTable
CREATE TABLE "StaffTimesheet" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL,
    "source" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffTimesheet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffTimesheet_staffId_date_idx" ON "StaffTimesheet"("staffId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StaffTimesheet_staffId_date_key" ON "StaffTimesheet"("staffId", "date");

-- AddForeignKey
ALTER TABLE "StaffTimesheet" ADD CONSTRAINT "StaffTimesheet_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
