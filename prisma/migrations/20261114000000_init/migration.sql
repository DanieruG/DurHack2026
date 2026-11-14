-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "pageUrl" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "inputHash" TEXT NOT NULL,
    "needs" JSONB NOT NULL,
    "listingFacts" JSONB,
    "identify" JSONB,
    "verdict" JSONB,
    "nextMoves" JSONB,
    "shareOptIn" BOOLEAN NOT NULL DEFAULT false,
    "history" JSONB,
    "answered" JSONB,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseInput" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT,
    "data" BYTEA,
    "text" TEXT,
    "sourceUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "check" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadRecord" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "lead" JSONB NOT NULL,

    CONSTRAINT "LeadRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogueModel" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" JSONB NOT NULL,
    "retailGBP" DOUBLE PRECISION,
    "referenceImg" TEXT,
    "sizeChartId" TEXT NOT NULL,

    CONSTRAINT "CatalogueModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeChart" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "rows" JSONB NOT NULL,

    CONSTRAINT "SizeChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceSample" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "priceGBP" DOUBLE PRECISION NOT NULL,
    "condition" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "collectedOn" TIMESTAMP(3) NOT NULL,
    "ruleId" TEXT NOT NULL,

    CONSTRAINT "PriceSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSnippet" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "topics" JSONB NOT NULL,

    CONSTRAINT "ReviewSnippet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CacheEntry" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CacheEntry_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Case_updatedAt_idx" ON "Case"("updatedAt");

-- CreateIndex
CREATE INDEX "CaseInput_caseId_revision_idx" ON "CaseInput"("caseId", "revision");

-- CreateIndex
CREATE INDEX "CheckRecord_caseId_revision_idx" ON "CheckRecord"("caseId", "revision");

-- CreateIndex
CREATE INDEX "LeadRecord_caseId_revision_idx" ON "LeadRecord"("caseId", "revision");

-- CreateIndex
CREATE INDEX "PriceSample_modelId_idx" ON "PriceSample"("modelId");

-- CreateIndex
CREATE INDEX "ReviewSnippet_modelId_idx" ON "ReviewSnippet"("modelId");

-- AddForeignKey
ALTER TABLE "CaseInput" ADD CONSTRAINT "CaseInput_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckRecord" ADD CONSTRAINT "CheckRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecord" ADD CONSTRAINT "LeadRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

