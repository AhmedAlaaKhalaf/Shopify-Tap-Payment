-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" DATETIME
);

-- CreateTable
CREATE TABLE "PaymentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gid" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "buyerSessionId" TEXT,
    "kind" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL,
    "amount" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "proposedAt" DATETIME NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "customer" TEXT,
    "state" TEXT NOT NULL DEFAULT 'INITIATED',
    "outcome" TEXT,
    "rejectCode" TEXT,
    "rejectMessage" TEXT,
    "finalizedAt" DATETIME,
    "cardLast4" TEXT,
    "cardBrand" TEXT,
    "processorStatus" TEXT,
    "processorRef" TEXT,
    "networkTransactionId" TEXT,
    "threeDSRequired" BOOLEAN NOT NULL DEFAULT false,
    "threeDSResult" TEXT,
    "redirectSentAt" DATETIME,
    "confirmationResult" BOOLEAN,
    "buyerReturnUrl" TEXT,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RefundSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gid" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL,
    "proposedAt" DATETIME NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'INITIATED',
    "outcome" TEXT,
    "rejectCode" TEXT,
    "rejectMessage" TEXT,
    "finalizedAt" DATETIME,
    "reservedMinor" INTEGER NOT NULL DEFAULT 0,
    "processorRef" TEXT,
    "lastError" TEXT,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ThreeDSChallenge" (
    "token" TEXT NOT NULL PRIMARY KEY,
    "paymentSessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThreeDSChallenge_paymentSessionId_fkey" FOREIGN KEY ("paymentSessionId") REFERENCES "PaymentSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UnsupportedSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gid" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "rejectedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "data" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSession_gid_key" ON "PaymentSession"("gid");

-- CreateIndex
CREATE INDEX "PaymentSession_shop_idx" ON "PaymentSession"("shop");

-- CreateIndex
CREATE INDEX "PaymentSession_state_idx" ON "PaymentSession"("state");

-- CreateIndex
CREATE UNIQUE INDEX "RefundSession_gid_key" ON "RefundSession"("gid");

-- CreateIndex
CREATE INDEX "RefundSession_paymentId_idx" ON "RefundSession"("paymentId");

-- CreateIndex
CREATE INDEX "RefundSession_state_idx" ON "RefundSession"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ThreeDSChallenge_paymentSessionId_key" ON "ThreeDSChallenge"("paymentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "UnsupportedSession_gid_key" ON "UnsupportedSession"("gid");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");
