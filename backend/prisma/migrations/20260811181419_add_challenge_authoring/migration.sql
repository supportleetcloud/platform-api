/*
  Warnings:

  - Added the required column `updatedAt` to the `Challenge` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Challenge" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "objective" TEXT,
ADD COLUMN     "technicalDetails" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "yamlPath" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ChallengeCheck" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHeaders" JSONB,
    "requestBody" JSONB,
    "expectStatus" INTEGER NOT NULL,
    "expectJson" JSONB,
    "expectHeaders" JSONB,
    "points" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "ChallengeCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChallengeCheck_challengeId_idx" ON "ChallengeCheck"("challengeId");

-- AddForeignKey
ALTER TABLE "ChallengeCheck" ADD CONSTRAINT "ChallengeCheck_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop DEFAULT from updatedAt (backfill already happened; should be Prisma-managed, not DB-managed)
ALTER TABLE "Challenge" ALTER COLUMN "updatedAt" DROP DEFAULT;
