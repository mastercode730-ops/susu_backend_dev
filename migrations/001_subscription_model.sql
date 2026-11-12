-- ═══════════════════════════════════════════════════════════════════════════
-- 001_subscription_model.sql
-- Super Manager role + subscription model.
-- Target DB: SUSU9DB_DEV (run with scripts/migrate.js or paste into SSMS).
-- Idempotent: safe to run more than once. Does NOT modify any existing table.
-- ═══════════════════════════════════════════════════════════════════════════

-- Super Managers: top-level platform operators. Kept separate from Users so a
-- manager never shows up in game/customer queries that scan Users.
IF OBJECT_ID('dbo.SuperManagers', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.SuperManagers (
    SMID          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SuperManagers PRIMARY KEY,
    Name          NVARCHAR(100) NOT NULL,
    Mobile        NVARCHAR(20)  NOT NULL CONSTRAINT UQ_SuperManagers_Mobile UNIQUE,
    PasswordHash  NVARCHAR(200) NOT NULL,           -- bcrypt
    IsActive      BIT NOT NULL CONSTRAINT DF_SuperManagers_IsActive DEFAULT (1),
    fCreatedBy    INT NULL,                         -- SMID of creator (NULL = bootstrap script)
    CreatedOn     DATETIME NOT NULL CONSTRAINT DF_SuperManagers_CreatedOn DEFAULT (GETDATE()),
    LastLoginOn   DATETIME NULL
  );
END
GO

-- Plans the Super Manager sells. NULL limit = unlimited.
IF OBJECT_ID('dbo.SubscriptionPlans', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.SubscriptionPlans (
    PlanID        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SubscriptionPlans PRIMARY KEY,
    PlanName      NVARCHAR(100) NOT NULL,
    DurationDays  INT NOT NULL,
    Price         DECIMAL(18,2) NOT NULL CONSTRAINT DF_SubscriptionPlans_Price DEFAULT (0),
    MaxSubUsers   INT NULL,
    MaxCustomers  INT NULL,
    Description   NVARCHAR(500) NULL,
    IsActive      BIT NOT NULL CONSTRAINT DF_SubscriptionPlans_IsActive DEFAULT (1),
    SortOrder     INT NOT NULL CONSTRAINT DF_SubscriptionPlans_SortOrder DEFAULT (0),
    CreatedOn     DATETIME NOT NULL CONSTRAINT DF_SubscriptionPlans_CreatedOn DEFAULT (GETDATE()),
    UpdatedOn     DATETIME NULL
  );
END
GO

-- Single-row table (SettingID = 1): QR code + bank details shown on the
-- public subscribe page. QrImage is a data: URL (image/png|jpeg|webp).
IF OBJECT_ID('dbo.PaymentSettings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PaymentSettings (
    SettingID      INT NOT NULL CONSTRAINT PK_PaymentSettings PRIMARY KEY,
    QrImage        NVARCHAR(MAX) NULL,
    UpiID          NVARCHAR(100) NULL,
    PayeeName      NVARCHAR(150) NULL,
    BankName       NVARCHAR(150) NULL,
    AccountHolder  NVARCHAR(150) NULL,
    AccountNumber  NVARCHAR(50)  NULL,
    IFSC           NVARCHAR(20)  NULL,
    BranchName     NVARCHAR(150) NULL,
    Instructions   NVARCHAR(1000) NULL,
    SupportMobile  NVARCHAR(20)  NULL,
    UpdatedOn      DATETIME NULL,
    fUpdatedBy     INT NULL
  );
  INSERT INTO dbo.PaymentSettings (SettingID, Instructions)
  VALUES (1, N'Scan the QR code or transfer to the bank account below, then upload the payment screenshot.');
END
GO

-- Payment submissions from the public subscribe page.
IF OBJECT_ID('dbo.SubscriptionRequests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.SubscriptionRequests (
    RequestID       INT IDENTITY(1000,1) NOT NULL CONSTRAINT PK_SubscriptionRequests PRIMARY KEY,
    RequestType     NVARCHAR(10)  NOT NULL CONSTRAINT DF_SubscriptionRequests_Type DEFAULT ('NEW'), -- NEW | RENEW
    FullName        NVARCHAR(150) NOT NULL,
    Mobile          NVARCHAR(20)  NOT NULL,
    Email           NVARCHAR(150) NULL,
    fPlanID         INT NOT NULL,
    PlanName        NVARCHAR(100) NULL,        -- snapshot at time of request
    DurationDays    INT NULL,                  -- snapshot
    Amount          DECIMAL(18,2) NULL,        -- snapshot of plan price
    TransactionRef  NVARCHAR(100) NULL,        -- UTR / UPI ref entered by the payer
    Notes           NVARCHAR(500) NULL,
    Screenshot      NVARCHAR(MAX) NOT NULL,    -- data: URL
    Status          NVARCHAR(20)  NOT NULL CONSTRAINT DF_SubscriptionRequests_Status DEFAULT ('Pending'), -- Pending | Processing | Approved | Rejected
    Remarks         NVARCHAR(500) NULL,        -- Super Manager's note to the payer
    fReviewedBy     INT NULL,
    ReviewedOn      DATETIME NULL,
    fCreatedUID     INT NULL,                  -- Users.UID created / extended on approval
    ClientIP        NVARCHAR(64) NULL,
    CreatedOn       DATETIME NOT NULL CONSTRAINT DF_SubscriptionRequests_CreatedOn DEFAULT (GETDATE())
  );
  CREATE INDEX IX_SubscriptionRequests_Status ON dbo.SubscriptionRequests (Status, CreatedOn DESC);
  CREATE INDEX IX_SubscriptionRequests_Mobile ON dbo.SubscriptionRequests (Mobile);
END
GO

-- Current subscription state of every subscribed Admin (Users.UID).
-- Users without a row here are "legacy" accounts and are not restricted.
IF OBJECT_ID('dbo.AdminAccounts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.AdminAccounts (
    fUID          INT NOT NULL CONSTRAINT PK_AdminAccounts PRIMARY KEY,
    FullName      NVARCHAR(150) NULL,
    fPlanID       INT NULL,
    StartDate     DATE NOT NULL,
    EndDate       DATE NOT NULL,              -- last valid day (inclusive)
    IsBlocked     BIT NOT NULL CONSTRAINT DF_AdminAccounts_IsBlocked DEFAULT (0),
    MaxSubUsers   INT NULL,                   -- snapshot of plan limits
    MaxCustomers  INT NULL,
    fCreatedBy    INT NULL,                   -- SMID
    CreatedOn     DATETIME NOT NULL CONSTRAINT DF_AdminAccounts_CreatedOn DEFAULT (GETDATE()),
    UpdatedOn     DATETIME NULL
  );
  CREATE INDEX IX_AdminAccounts_EndDate ON dbo.AdminAccounts (EndDate);
END
GO

-- Audit trail: every grant / renewal / manual extension.
IF OBJECT_ID('dbo.SubscriptionHistory', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.SubscriptionHistory (
    HistoryID     INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_SubscriptionHistory PRIMARY KEY,
    fUID          INT NOT NULL,
    fPlanID       INT NULL,
    PlanName      NVARCHAR(100) NULL,
    Amount        DECIMAL(18,2) NULL,
    DurationDays  INT NULL,
    StartDate     DATE NULL,
    EndDate       DATE NULL,
    Action        NVARCHAR(20) NOT NULL,      -- CREATE | RENEW | EXTEND | BLOCK | UNBLOCK
    fRequestID    INT NULL,
    fCreatedBy    INT NULL,                   -- SMID
    Remarks       NVARCHAR(500) NULL,
    CreatedOn     DATETIME NOT NULL CONSTRAINT DF_SubscriptionHistory_CreatedOn DEFAULT (GETDATE())
  );
  CREATE INDEX IX_SubscriptionHistory_fUID ON dbo.SubscriptionHistory (fUID, CreatedOn DESC);
END
GO

-- Starter plans (edit prices/limits from the Super Manager portal).
IF NOT EXISTS (SELECT 1 FROM dbo.SubscriptionPlans)
BEGIN
  INSERT INTO dbo.SubscriptionPlans (PlanName, DurationDays, Price, MaxSubUsers, MaxCustomers, Description, SortOrder) VALUES
    (N'Monthly',   30,  1000.00,  3,  NULL, N'Full portal access for 30 days',  1),
    (N'Quarterly', 90,  2700.00,  5,  NULL, N'Full portal access for 90 days',  2),
    (N'Yearly',    365, 10000.00, NULL, NULL, N'Full portal access for 1 year, unlimited sub users', 3);
END
GO
