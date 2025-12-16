-- CreateTable
CREATE TABLE "StepMedia" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepMedia_stepId_idx" ON "StepMedia"("stepId");

-- AddForeignKey
ALTER TABLE "StepMedia" ADD CONSTRAINT "StepMedia_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "LeadStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
