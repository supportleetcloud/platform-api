-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "feedback" TEXT,
ADD COLUMN     "feedbackStatus" TEXT NOT NULL DEFAULT 'not_applicable';

-- CreateTable
CREATE TABLE "LlmSettings" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmSettings_pkey" PRIMARY KEY ("id")
);
