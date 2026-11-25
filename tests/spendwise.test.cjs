"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const finance = require("../js/spendwise.js");

test("amounts are converted to integer cents without accepting excess precision", () => {
  assert.equal(finance.parseAmountToCents("1234.5"), 123450);
  assert.equal(finance.parseAmountToCents("0.01"), 1);
  assert.equal(finance.parseAmountToCents("0", true), 0);
  assert.throws(() => finance.parseAmountToCents("1.234"), /two decimal places/);
  assert.throws(() => finance.parseAmountToCents("0"), /greater than zero/);
  assert.throws(() => finance.parseAmountToCents("1,000.00"), /two decimal places/);
});

test("calendar dates are validated, including leap days", () => {
  assert.equal(finance.isValidISODate("2024-02-29"), true);
  assert.equal(finance.isValidISODate("2025-02-29"), false);
  assert.equal(finance.isValidISODate("2025-13-01"), false);
  assert.equal(finance.isValidISODate("2025-2-01"), false);
});

test("period totals include only transactions in the selected calendar period", () => {
  const now = new Date(2026, 2, 15, 12);
  const transactions = [
    { date: "2026-03-01", type: "income", amountCents: 325000 },
    { date: "2026-03-15", type: "expense", amountCents: 47550 },
    { date: "2026-02-28", type: "expense", amountCents: 10000 },
    { date: "2025-03-15", type: "income", amountCents: 99900 }
  ];

  assert.deepEqual(finance.calculateTotals(transactions, "month", now), {
    incomeCents: 325000,
    expenseCents: 47550,
    netCents: 277450
  });
  assert.deepEqual(finance.calculateTotals(transactions, "last-month", now), {
    incomeCents: 0,
    expenseCents: 10000,
    netCents: -10000
  });
  assert.equal(finance.calculateTotals(transactions, "all", now).incomeCents, 424900);
});

test("category totals and budgets use exact integer-cent arithmetic", () => {
  const now = new Date(2026, 2, 15, 12);
  const transactions = [
    { date: "2026-03-02", type: "expense", category: "Food", amountCents: 6400 },
    { date: "2026-03-12", type: "expense", category: "Food", amountCents: 3600 },
    { date: "2026-03-12", type: "expense", category: "Rent", amountCents: 80000 },
    { date: "2026-02-28", type: "expense", category: "Food", amountCents: 5000 },
    { date: "2026-03-12", type: "income", category: "Salary", amountCents: 100000 }
  ];
  assert.deepEqual(finance.calculateCategoryTotals(transactions, "month", now), [
    { category: "Rent", amountCents: 80000 },
    { category: "Food", amountCents: 10000 }
  ]);
  assert.deepEqual(finance.calculateBudgetUsage({ category: "Food", limitCents: 8000 }, transactions, now), {
    spentCents: 10000,
    percentage: 125,
    remainingCents: -2000
  });
});

test("login cookie helpers persist and clear the remembered login", () => {
  const cookieDocument = {
    location: { protocol: "http:" },
    cookie: ""
  };

  finance.setLoginCookie("alex@example.com", cookieDocument);
  assert.equal(cookieDocument.cookie.includes("spendwise_login=alex%40example.com"), true);
  assert.equal(finance.getLoginCookie(cookieDocument), "alex@example.com");

  finance.clearLoginCookie(cookieDocument);
  assert.equal(cookieDocument.cookie.includes("max-age=0"), true);
  assert.equal(finance.getLoginCookie(cookieDocument), null);
});

test("active workspace view is restored only from a supported section", () => {
  const storage = {
    value: "budgets",
    getItem() {
      return this.value;
    }
  };

  assert.equal(finance.getActiveView(storage), "budgets");
  storage.value = "unknown";
  assert.equal(finance.getActiveView(storage), "dashboard");
});
