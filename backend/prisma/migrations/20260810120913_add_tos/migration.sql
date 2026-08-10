-- CreateTable
CREATE TABLE "TosVersion" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TosVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TosAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tosVersionId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TosAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TosAcceptance_userId_tosVersionId_key" ON "TosAcceptance"("userId", "tosVersionId");

-- AddForeignKey
ALTER TABLE "TosAcceptance" ADD CONSTRAINT "TosAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TosAcceptance" ADD CONSTRAINT "TosAcceptance_tosVersionId_fkey" FOREIGN KEY ("tosVersionId") REFERENCES "TosVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
