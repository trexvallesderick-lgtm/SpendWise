"use strict";

(() => {
  // ---------------------------------------------------------------------------
  // Application configuration
  // ---------------------------------------------------------------------------
  // Storage keys keep vault data, login state, and workspace navigation separate.
  const STORAGE_KEY = "spendwise.local-vault.v1";
  const SESSION_KEY = "spendwise.login-session.v1";
  const ACTIVE_VIEW_KEY = "spendwise.active-view.v1";
  const SESSION_COOKIE = "spendwise_login";
  const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
  const PBKDF2_ITERATIONS = 310000;
  const MAX_AMOUNT_CENTS = 1000000000000;

  // Default categories are cloned for every newly-created vault.
  const DEFAULT_CATEGORIES = {
    expense: ["Housing", "Food", "Transportation", "Bills", "Shopping", "Health", "Entertainment", "Education", "Other"],
    income: ["Salary", "Freelance", "Business", "Allowance", "Investments", "Other"]
  };
  const CHART_COLORS = ["#344f91", "#58a27d", "#d69b48", "#6e91cd", "#d57479", "#8d7fc2", "#58a9ae", "#a58b6a", "#929cac"];

  // ---------------------------------------------------------------------------
  // Login cookie and active workspace helpers
  // ---------------------------------------------------------------------------
  // Cookies identify a remembered browser session; encrypted vault data is kept
  // separately in browser storage and is never reconstructed from cookie text.
  function setLoginCookie(email, cookieDocument = document) {
    const secure = cookieDocument.location?.protocol === "https:" ? "; Secure" : "";
    cookieDocument.cookie = `${SESSION_COOKIE}=${encodeURIComponent(email)}; path=/; max-age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  }

  function getLoginCookie(cookieDocument = document) {
    const prefix = `${SESSION_COOKIE}=`;
    const match = cookieDocument.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
    if (!match) return null;
    const value = match.slice(prefix.length);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  function clearLoginCookie(cookieDocument = document) {
    const secure = cookieDocument.location?.protocol === "https:" ? "; Secure" : "";
    cookieDocument.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax${secure}`;
  }

  function getActiveView(storage = sessionStorage) {
    try {
      const view = storage.getItem(ACTIVE_VIEW_KEY);
      return ["dashboard", "transactions", "budgets", "goals", "reports", "settings"].includes(view) ? view : "dashboard";
    } catch {
      return "dashboard";
    }
  }

  // ---------------------------------------------------------------------------
  // Exact finance utilities
  // ---------------------------------------------------------------------------
  // Money values are represented as integer cents to avoid floating-point drift.
  function parseAmountToCents(value, allowZero = false) {
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Enter an amount with up to two decimal places.");
    const [whole, fraction = ""] = text.split(".");
    const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
    if (!Number.isSafeInteger(cents) || cents < 0 || (!allowZero && cents === 0) || cents > MAX_AMOUNT_CENTS) {
      throw new Error("Enter an amount greater than zero and no more than 10 billion.");
    }
    return cents;
  }

  function toISODate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function isValidISODate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
    const date = new Date(`${value}T00:00:00`);
    return !Number.isNaN(date.getTime()) && toISODate(date) === value;
  }

  function periodBounds(period, now = new Date()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === "month") return [toISODate(new Date(now.getFullYear(), now.getMonth(), 1)), toISODate(today)];
    if (period === "last-month") {
      return [
        toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        toISODate(new Date(now.getFullYear(), now.getMonth(), 0))
      ];
    }
    if (period === "year") return [toISODate(new Date(now.getFullYear(), 0, 1)), toISODate(today)];
    return ["0000-01-01", "9999-12-31"];
  }

  function isInPeriod(date, period, now = new Date()) {
    if (!isValidISODate(date)) return false;
    const [start, end] = periodBounds(period, now);
    return date >= start && date <= end;
  }

  function calculateTotals(transactions, period = "all", now = new Date()) {
    let incomeCents = 0;
    let expenseCents = 0;
    for (const transaction of transactions) {
      if (!isInPeriod(transaction.date, period, now)) continue;
      if (!Number.isSafeInteger(transaction.amountCents) || transaction.amountCents < 0) continue;
      if (transaction.type === "income") incomeCents += transaction.amountCents;
      if (transaction.type === "expense") expenseCents += transaction.amountCents;
    }
    if (!Number.isSafeInteger(incomeCents) || !Number.isSafeInteger(expenseCents)) {
      throw new RangeError("The transaction total is too large to calculate safely.");
    }
    return {
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents
    };
  }

  function calculateCategoryTotals(transactions, period = "month", now = new Date()) {
    const totals = new Map();
    for (const transaction of transactions) {
      if (transaction.type !== "expense" || !isInPeriod(transaction.date, period, now)) continue;
      totals.set(transaction.category, (totals.get(transaction.category) || 0) + transaction.amountCents);
    }
    return [...totals.entries()]
      .map(([category, amountCents]) => ({
        category,
        amountCents
      }))
      .sort((a, b) => b.amountCents - a.amountCents);
  }

  function calculateBudgetUsage(budget, transactions, now = new Date()) {
    const spentCents = transactions.reduce((sum, transaction) => {
      if (transaction.type === "expense" && transaction.category === budget.category && isInPeriod(transaction.date, "month", now)) {
        return sum + transaction.amountCents;
      }
      return sum;
    }, 0);
    const percentage = budget.limitCents > 0 ? spentCents / budget.limitCents * 100 : 0;
    return {
      spentCents,
      percentage,
      remainingCents: budget.limitCents - spentCents
    };
  }

  function formatMoney(cents, currency = "USD") {
    const amount = cents / 100;
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  const finance = {
    parseAmountToCents,
    isValidISODate,
    periodBounds,
    isInPeriod,
    calculateTotals,
    calculateCategoryTotals,
    calculateBudgetUsage,
    formatMoney,
    setLoginCookie,
    getLoginCookie,
    clearLoginCookie,
    getActiveView
  };
  if (typeof module !== "undefined" && module.exports) module.exports = finance;
  if (typeof window !== "undefined") window.SpendWiseFinance = finance;

  if (typeof document === "undefined") return;

  document.addEventListener("DOMContentLoaded", async () => {
    // Cache the elements used throughout this feature so repeated DOM lookups stay small.
    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const authScreen = $("#auth-screen");
    const appShell = $("#app-shell");
    const authForm = $("#auth-form");
    const authError = $("#auth-error");
    const modalLayer = $("#modal-layer");
    const modalCard = $("#modal-card");
    const toastRegion = $("#toast-region");
    const notificationPopover = $("#notification-popover");
    let vault = null;
    let userData = null;
    let saveQueue = Promise.resolve();
    let authMode = "login";
    let lastFocusedElement = null;
    let idleTimer;

    // -------------------------------------------------------------------------
    // Encrypted vault data model
    // -------------------------------------------------------------------------
    // A fresh vault starts with an empty dataset and the default spending categories.
    function createEmptyData(name, email) {
      return {
        version: 1,
        profile: {
          name,
          email
        },
        settings: {
          currency: "USD",
          theme: "light",
          warningThreshold: 80
        },
        categories: structuredClone(DEFAULT_CATEGORIES),
        transactions: [],
        budgets: [],
        goals: [],
        recurring: []
      };
    }

    function normalizeData(value, email) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The vault data is not valid.");
      const base = createEmptyData("My workspace", email);
      const result = {
        ...base,
        ...value,
        profile: {
          ...base.profile,
          ...(value.profile || {}),
          email
        },
        settings: {
          ...base.settings,
          ...(value.settings || {})
        },
        categories: {
          expense: Array.isArray(value.categories?.expense) ? value.categories.expense.filter((item) => typeof item === "string") : base.categories.expense,
          income: Array.isArray(value.categories?.income) ? value.categories.income.filter((item) => typeof item === "string") : base.categories.income
        },
        transactions: Array.isArray(value.transactions) ? value.transactions : [],
        budgets: Array.isArray(value.budgets) ? value.budgets : [],
        goals: Array.isArray(value.goals) ? value.goals : [],
        recurring: Array.isArray(value.recurring) ? value.recurring : []
      };
      if (typeof result.profile.name !== "string" || !result.profile.name.trim()) result.profile.name = "My workspace";
      if (!["USD", "EUR", "GBP", "PHP", "CAD", "AUD"].includes(result.settings.currency)) result.settings.currency = "USD";
      if (!Number.isInteger(result.settings.warningThreshold) || result.settings.warningThreshold < 50 || result.settings.warningThreshold > 99) result.settings.warningThreshold = 80;
      return result;
    }

    function encodeBase64(bytes) {
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      return btoa(binary);
    }

    function decodeBase64(value) {
      const binary = atob(value);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }

    async function deriveEncryptionKey(password, salt) {
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({
          name: "PBKDF2",
          salt,
          iterations: PBKDF2_ITERATIONS,
          hash: "SHA-256"
        },
        material, {
          name: "AES-GCM",
          length: 256
        },
        true,
        ["encrypt", "decrypt"]
      );
    }

    async function encryptVault(data, password, email, existingSalt, cachedKey) {
      const salt = existingSalt || crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = cachedKey || (existingSalt && activeEncryptionKey) || await deriveEncryptionKey(password, salt);
      if (!existingSalt && !cachedKey) activeEncryptionKey = key;
      const encoded = new TextEncoder().encode(JSON.stringify(data));
      const encrypted = await crypto.subtle.encrypt({
        name: "AES-GCM",
        iv
      }, key, encoded);
      return {
        version: 1,
        email,
        iterations: PBKDF2_ITERATIONS,
        salt: encodeBase64(salt),
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(encrypted))
      };
    }

    async function decryptVault(encryptedVault, password, cachedKey = null) {
      if (encryptedVault?.version !== 1 || typeof encryptedVault.salt !== "string" ||
        typeof encryptedVault.iv !== "string" || typeof encryptedVault.ciphertext !== "string") {
        throw new Error("This vault file is not a supported SpendWise backup.");
      }
      const salt = decodeBase64(encryptedVault.salt);
      const iv = decodeBase64(encryptedVault.iv);
      const key = cachedKey || await deriveEncryptionKey(password, salt);
      activeEncryptionKey = key;
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv
      }, key, decodeBase64(encryptedVault.ciphertext));
      return normalizeData(JSON.parse(new TextDecoder().decode(plaintext)), encryptedVault.email);
    }

    function getStoredVault() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error("SpendWise could not read this browser's saved vault. Check the browser storage settings.");
      }
    }

    async function rememberLogin(email, data) {
      let key = null;
      if (activeEncryptionKey) {
        const rawKey = await crypto.subtle.exportKey("raw", activeEncryptionKey);
        key = encodeBase64(new Uint8Array(rawKey));
      }
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        email,
        data,
        key,
        expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000
      }));
      setLoginCookie(email);
    }

    function getRememberedLogin() {
      const cookieEmail = getLoginCookie();
      if (!cookieEmail) return null;
      try {
        const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
        if (!session || session.email !== cookieEmail || !session.data ||
          !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
          clearRememberedLogin();
          return null;
        }
        return session;
      } catch {
        clearRememberedLogin();
        return null;
      }
    }

    function clearRememberedLogin() {
      sessionStorage.removeItem(SESSION_KEY);
      clearLoginCookie();
    }

    async function importRememberedKey(encodedKey) {
      if (!encodedKey) return null;
      return crypto.subtle.importKey(
        "raw",
        decodeBase64(encodedKey), {
          name: "AES-GCM"
        },
        true,
        ["encrypt", "decrypt"]
      );
    }

    function saveData() {
      const snapshot = JSON.stringify(userData);
      const key = activeEncryptionKey;
      const salt = decodeBase64(vault.salt);
      const next = saveQueue.catch(() => {}).then(async () => {
        const encrypted = await encryptVault(JSON.parse(snapshot), null, vault.email, salt, key);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
        const remembered = getRememberedLogin();
        if (remembered) {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            email: vault.email,
            data: JSON.parse(snapshot),
            key: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key))),
            expiresAt: remembered.expiresAt
          }));
        }
        vault = encrypted;
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !modalLayer.hidden) closeModal();
      });
      saveQueue = next;
      return next;
    }

    let activeEncryptionKey = null;

    function showToast(message, type = "success") {
      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      toast.textContent = message;
      toastRegion.append(toast);
      window.setTimeout(() => toast.remove(), 3500);
    }

    function escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]);
    }

    function newId() {
      if (crypto.randomUUID) return crypto.randomUUID();
      return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
    }

    function dateToday() {
      return toISODate(new Date());
    }

    function showAuthError(message) {
      authError.textContent = message;
      authError.hidden = !message;
    }

    function setAuthMode(mode) {
      authMode = mode;
      const registering = mode === "register";
      $("#login-tab").classList.toggle("active", !registering);
      $("#register-tab").classList.toggle("active", registering);
      $("#login-tab").setAttribute("aria-selected", String(!registering));
      $("#register-tab").setAttribute("aria-selected", String(registering));
      $("#auth-name-group").hidden = !registering;
      $("#auth-confirm-group").hidden = !registering;
      $("#auth-name").required = registering;
      $("#auth-confirm").required = registering;
      $("#auth-password").autocomplete = registering ? "new-password" : "current-password";
      $("#auth-form-title").textContent = registering ? "Create your private vault" : "Welcome back";
      $("#auth-form-description").textContent = registering ?
        "Choose a strong password. It encrypts your data and cannot be recovered if you forget it." :
        "Enter your email and password to unlock your private workspace.";
      $("#auth-submit").textContent = registering ? "Create my vault" : "Unlock my vault";
      $("#auth-footnote").innerHTML = registering ?
        'Already have a vault? <button type="button" id="switch-to-login">Unlock it</button>' :
        'New to SpendWise? <button type="button" id="switch-to-register">Create your local vault</button>';
      showAuthError("");
      authForm.reset();
    }

    function showApp() {
      authScreen.hidden = true;
      appShell.hidden = false;
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(lockVault, 15 * 60 * 1000);
      document.body.classList.toggle("dark", userData.settings.theme === "dark");
      updateProfile();
      populateSettings();
      renderAll();
      setView(getActiveView());
    }

    function lockVault() {
      window.clearTimeout(idleTimer);
      userData = null;
      activeEncryptionKey = null;
      clearRememberedLogin();
      appShell.hidden = true;
      authScreen.hidden = false;
      notificationPopover.hidden = true;
      setAuthMode("login");
      $("#auth-email").value = vault?.email || "";
      $("#auth-password").focus();
    }

    function updateProfile() {
      const name = userData.profile.name.trim() || "My workspace";
      const initial = [...name][0]?.toUpperCase() || "S";
      $("#profile-name").textContent = name;
      $("#profile-avatar").textContent = initial;
      $("#top-avatar").textContent = initial;
      $("#greeting-name").textContent = name.split(/\s+/)[0];
    }

    function setView(view) {
      const titles = {
        dashboard: "Overview",
        transactions: "Transactions",
        budgets: "Budgets",
        goals: "Savings goals",
        reports: "Reports",
        settings: "Settings"
      };
      if (!titles[view]) return;
      try {
        sessionStorage.setItem(ACTIVE_VIEW_KEY, view);
      } catch {}
      $$(".app-view").forEach((section) => {
        const active = section.id === `view-${view}`;
        section.classList.toggle("active", active);
        section.hidden = !active;
      });
      $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
      $("#page-title").textContent = titles[view];
      $("#sidebar").classList.remove("open");
      $("#mobile-menu").setAttribute("aria-expanded", "false");
      notificationPopover.hidden = true;
      if (view === "reports") renderReports();
      if (view === "settings") populateSettings();
    }

    function updateProfileSettings() {
      $("#settings-name").value = userData.profile.name;
      $("#settings-currency").value = userData.settings.currency;
      $("#warning-threshold").value = String(userData.settings.warningThreshold);
    }

    function populateSettings() {
      updateProfileSettings();
      renderCategories();
      renderRecurring();
    }

    function currency() {
      return userData.settings.currency;
    }

    function money(cents) {
      return formatMoney(cents, currency());
    }

    function dateLabel(isoDate, options = {
      month: "short",
      day: "numeric",
      year: "numeric"
    }) {
      if (!isValidISODate(isoDate)) return "—";
      return new Intl.DateTimeFormat(undefined, options).format(new Date(`${isoDate}T00:00:00`));
    }

    function selectedPeriod() {
      return $("#dashboard-period").value;
    }

    function periodName(period) {
      return ({
        month: "This month",
        "last-month": "Last month",
        year: "This year",
        all: "All time"
      })[period] || "This month";
    }

    function transactionsInPeriod(period) {
      return userData.transactions.filter((transaction) => isInPeriod(transaction.date, period));
    }

    function budgetStatus(budget) {
      return calculateBudgetUsage(budget, userData.transactions);
    }

    function budgetTone(usage, threshold = userData.settings.warningThreshold) {
      if (usage.percentage >= 100) return "over";
      if (usage.percentage >= threshold) return "warning";
      return "";
    }

    function renderTrendChart() {
      const today = new Date();
      const months = [];
      for (let offset = 5; offset >= 0; offset -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth() - offset, 1);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        const transactions = userData.transactions.filter((item) => item.date.startsWith(key));
        const totals = calculateTotals(transactions);
        months.push({
          label: new Intl.DateTimeFormat(undefined, {
            month: "short"
          }).format(date),
          income: totals.incomeCents,
          expense: totals.expenseCents
        });
      }
      const max = Math.max(100, ...months.flatMap((month) => [month.income, month.expense]));
      const width = 620;
      const height = 190;
      const left = 43;
      const right = 10;
      const top = 10;
      const bottom = 28;
      const plotWidth = width - left - right;
      const plotHeight = height - top - bottom;
      const x = (index) => left + index * plotWidth / (months.length - 1);
      const y = (value) => top + plotHeight - value / max * plotHeight;
      const pointsFor = (key) => months.map((month, index) => `${x(index)},${y(month[key])}`).join(" ");
      const grid = [0, .5, 1].map((fraction) => {
        const lineY = top + plotHeight * fraction;
        const amount = max * (1 - fraction);
        return `<line x1="${left}" y1="${lineY}" x2="${width - right}" y2="${lineY}" class="chart-grid-line"/><text x="${left - 7}" y="${lineY + 3}" text-anchor="end" class="chart-axis-text">${escapeHTML(shortMoney(amount))}</text>`;
      }).join("");
      const labels = months.map((month, index) => `<text x="${x(index)}" y="${height - 5}" text-anchor="middle" class="chart-axis-text">${escapeHTML(month.label)}</text>`).join("");
      const dots = months.map((month, index) => `<circle cx="${x(index)}" cy="${y(month.income)}" r="3" class="chart-dot-income"/><circle cx="${x(index)}" cy="${y(month.expense)}" r="3" class="chart-dot-expense"/>`).join("");
      $("#trend-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Income and expenses for the last six months">${grid}<polyline points="${pointsFor("income")}" class="chart-line-income"/><polyline points="${pointsFor("expense")}" class="chart-line-expense"/>${dots}${labels}</svg>`;
    }

    function shortMoney(cents) {
      const amount = cents / 100;
      if (amount >= 1000000) return `${(amount / 1000000).toFixed(1)}m`;
      if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
      return amount.toFixed(0);
    }

    function renderCategoryChart() {
      const totals = calculateCategoryTotals(userData.transactions, "month");
      const total = totals.reduce((sum, item) => sum + item.amountCents, 0);
      const chart = $("#category-chart");
      const legend = $("#category-legend");
      if (!total) {
        chart.style.background = "conic-gradient(#e9edf3 0deg 360deg)";
        chart.setAttribute("aria-label", "No expenses this month");
        chart.innerHTML = `<div class="donut-center"><strong>${money(0)}</strong><span>spent</span></div>`;
        legend.innerHTML = `<div class="chart-legend-row"><i style="background:#e9edf3"></i><span>No spending yet</span><strong>—</strong></div>`;
        return;
      }
      let offset = 0;
      const stops = totals.map((item, index) => {
        const start = offset;
        offset += item.amountCents / total * 360;
        return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}deg ${offset}deg`;
      });
      chart.style.background = `conic-gradient(${stops.join(",")})`;
      chart.setAttribute("aria-label", `Monthly expenses total ${money(total)}`);
      chart.innerHTML = `<div class="donut-center"><strong>${money(total)}</strong><span>spent this month</span></div>`;
      legend.innerHTML = totals.slice(0, 5).map((item, index) => `<div class="chart-legend-row"><i style="background:${CHART_COLORS[index % CHART_COLORS.length]}"></i><span>${escapeHTML(item.category)}</span><strong>${Math.round(item.amountCents / total * 100)}%</strong></div>`).join("");
    }

    function renderRecentTransactions() {
      const rows = [...userData.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5);
      $("#recent-transactions").innerHTML = rows.map((transaction) => transactionRow(transaction, true)).join("");
      $("#recent-empty").hidden = rows.length > 0;
      $("#transaction-count").textContent = String(userData.transactions.length);
    }

    function transactionRow(transaction, compact = false) {
      const isIncome = transaction.type === "income";
      const amount = `${isIncome ? "+" : "−"}${money(transaction.amountCents)}`;
      const description = escapeHTML(transaction.description || transaction.category);
      const date = dateLabel(transaction.date, compact ? {
        month: "short",
        day: "numeric"
      } : {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
      if (compact) {
        return `<tr><td><div class="transaction-name"><span class="transaction-avatar">${isIncome ? "↙" : "↗"}</span><strong>${description}</strong></div></td><td>${escapeHTML(transaction.category)}</td><td>${date}</td><td class="align-right ${isIncome ? "amount-income" : "amount-expense"}">${amount}</td></tr>`;
      }
      return `<tr><td><div class="transaction-name"><span class="transaction-avatar">${isIncome ? "↙" : "↗"}</span><div><strong>${description}</strong><small>${escapeHTML(transaction.notes || "—")}</small></div></div></td><td>${escapeHTML(transaction.category)}</td><td>${escapeHTML(transaction.paymentMethod || "—")}</td><td>${date}</td><td class="align-right ${isIncome ? "amount-income" : "amount-expense"}">${amount}</td><td><div class="row-actions"><button class="row-action" type="button" data-action="edit-transaction" data-id="${escapeHTML(transaction.id)}" aria-label="Edit ${description}" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15v5Z"/></svg></button><button class="row-action delete" type="button" data-action="delete-transaction" data-id="${escapeHTML(transaction.id)}" aria-label="Delete ${description}" title="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></div></td></tr>`;
    }

    function getVisibleTransactions() {
      const search = ($("#transaction-search").value || "").trim().toLowerCase();
      const type = $("#transaction-type-filter").value;
      const category = $("#transaction-category-filter").value;
      const period = $("#transaction-date-filter").value;
      return [...userData.transactions]
        .filter((transaction) => type === "all" || transaction.type === type)
        .filter((transaction) => category === "all" || transaction.category === category)
        .filter((transaction) => period === "all" || isInPeriod(transaction.date, period))
        .filter((transaction) => !search || `${transaction.description} ${transaction.category} ${transaction.notes} ${transaction.paymentMethod}`.toLowerCase().includes(search))
        .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    }

    function populateTransactionCategoryFilter() {
      const select = $("#transaction-category-filter");
      const previous = select.value;
      const categories = [...new Set([...userData.categories.expense, ...userData.categories.income])].sort((a, b) => a.localeCompare(b));
      select.innerHTML = `<option value="all">All categories</option>${categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("")}`;
      if (categories.includes(previous)) select.value = previous;
    }

    function renderTransactions() {
      populateTransactionCategoryFilter();
      const rows = getVisibleTransactions();
      $("#transaction-rows").innerHTML = rows.map((transaction) => transactionRow(transaction)).join("");
      $("#transaction-empty").hidden = rows.length > 0;
      $("#transaction-result-count").textContent = `${rows.length} ${rows.length === 1 ? "transaction" : "transactions"}`;
    }

    function renderBudgetSummary() {
      const budgets = userData.budgets.slice(0, 4);
      $("#budget-summary").innerHTML = budgets.map((budget) => {
        const usage = budgetStatus(budget);
        const tone = budgetTone(usage, budget.warningThreshold || userData.settings.warningThreshold);
        const percent = Math.min(100, Math.max(0, usage.percentage));
        return `<div class="budget-summary-item"><div class="budget-summary-top"><strong>${escapeHTML(budget.category)}</strong><span>${money(usage.spentCents)} / ${money(budget.limitCents)}</span></div><div class="progress-track"><div class="progress-fill ${tone}" style="width:${percent}%"></div></div></div>`;
      }).join("");
      $("#budget-summary-empty").hidden = budgets.length > 0;
    }

    function renderDashboard() {
      const allTotals = calculateTotals(userData.transactions, "all");
      const period = selectedPeriod();
      const totals = calculateTotals(userData.transactions, period);
      $("#stat-balance").textContent = money(allTotals.netCents);
      $("#stat-income").textContent = money(totals.incomeCents);
      $("#stat-expenses").textContent = money(totals.expenseCents);
      $("#stat-savings").textContent = money(totals.netCents);
      $("#income-period-label").textContent = periodName(period);
      $("#expense-period-label").textContent = periodName(period);
      $("#savings-rate").textContent = totals.incomeCents ? `${Math.round(totals.netCents / totals.incomeCents * 100)}% net savings rate` : "Income minus expenses";
      renderTrendChart();
      renderCategoryChart();
      renderRecentTransactions();
      renderBudgetSummary();
      renderNotificationDot();
    }

    function renderBudgets() {
      const budgets = userData.budgets;
      const totalLimit = budgets.reduce((sum, budget) => sum + budget.limitCents, 0);
      const totalSpent = budgets.reduce((sum, budget) => sum + budgetStatus(budget).spentCents, 0);
      const remaining = totalLimit - totalSpent;
      $("#budget-totals").innerHTML = [
        ["Total monthly limits", money(totalLimit)],
        ["Spent this month", money(totalSpent)],
        ["Remaining", money(remaining)]
      ].map(([label, amount]) => `<article class="budget-total-card"><span>${label}</span><strong>${amount}</strong></article>`).join("");
      $("#budget-cards").innerHTML = budgets.map((budget) => {
        const usage = budgetStatus(budget);
        const tone = budgetTone(usage, budget.warningThreshold || userData.settings.warningThreshold);
        const percentage = Math.max(0, usage.percentage);
        const statusText = tone === "over" ? `Over budget by ${money(Math.abs(usage.remainingCents))}` : tone === "warning" ? `You're getting close to this budget` : `${money(Math.max(0, usage.remainingCents))} left this month`;
        return `<article class="budget-card"><div class="budget-card-head"><div class="budget-category"><span class="category-dot">${escapeHTML([...budget.category][0]?.toUpperCase() || "•")}</span><span><strong>${escapeHTML(budget.category)}</strong><small>Monthly limit</small></span></div><div class="budget-actions"><button class="row-action" type="button" data-action="edit-budget" data-id="${escapeHTML(budget.id)}" aria-label="Edit ${escapeHTML(budget.category)} budget"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15v5Z"/></svg></button><button class="row-action delete" type="button" data-action="delete-budget" data-id="${escapeHTML(budget.id)}" aria-label="Delete ${escapeHTML(budget.category)} budget"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></div></div><div class="budget-progress-label"><span>${money(usage.spentCents)} spent</span><span>${Math.round(percentage)}%</span></div><div class="progress-track"><div class="progress-fill ${tone}" style="width:${Math.min(100, percentage)}%"></div></div><div class="budget-card-amounts"><strong>${money(budget.limitCents)}</strong><span>monthly limit</span></div><div class="budget-alert ${tone}">${statusText}</div></article>`;
      }).join("");
      $("#budget-empty").hidden = budgets.length > 0;
    }

    function renderGoals() {
      const goals = userData.goals;
      const saved = goals.reduce((sum, goal) => sum + goal.currentCents, 0);
      const target = goals.reduce((sum, goal) => sum + goal.targetCents, 0);
      const overview = $("#goal-overview");
      overview.innerHTML = `<div><span class="goal-overview-label">Total saved toward your goals</span><strong>${money(saved)}</strong></div><div class="goal-overview-right"><span>${money(target)} total target</span><strong>${target ? Math.round(saved / target * 100) : 0}% complete</strong></div>`;
      $("#goal-cards").innerHTML = goals.map((goal) => {
        const percent = Math.min(100, goal.currentCents / goal.targetCents * 100);
        const remaining = Math.max(0, goal.targetCents - goal.currentCents);
        return `<article class="goal-card"><div class="goal-card-top"><span class="goal-symbol">${escapeHTML(goal.icon || "◎")}</span><div class="budget-actions"><button class="row-action" type="button" data-action="edit-goal" data-id="${escapeHTML(goal.id)}" aria-label="Edit ${escapeHTML(goal.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15v5Z"/></svg></button><button class="row-action delete" type="button" data-action="delete-goal" data-id="${escapeHTML(goal.id)}" aria-label="Delete ${escapeHTML(goal.name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button></div></div><h3>${escapeHTML(goal.name)}</h3><span class="goal-deadline">${goal.targetDate ? `Target date ${dateLabel(goal.targetDate)}` : "No target date"}</span><div class="goal-amounts"><strong>${money(goal.currentCents)}</strong><span>of ${money(goal.targetCents)}</span></div><div class="goal-progress-line"><span>${Math.round(percent)}% saved</span><span>${money(remaining)} to go</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, percent)}%"></div></div><div class="goal-card-footer"><span>${remaining ? "Keep building your momentum" : "Goal reached — well done!"}</span>${remaining ? `<button class="text-button" type="button" data-action="contribute-goal" data-id="${escapeHTML(goal.id)}">Add money +</button>` : ""}</div></article>`;
      }).join("");
      $("#goals-empty").hidden = goals.length > 0;
    }

    function renderReports() {
      const period = $("#report-period").value;
      const transactions = transactionsInPeriod(period).sort((a, b) => b.date.localeCompare(a.date));
      const totals = calculateTotals(transactions);
      const savingsRate = totals.incomeCents ? Math.round(totals.netCents / totals.incomeCents * 100) : 0;
      $("#report-stats").innerHTML = [
        ["Income", money(totals.incomeCents), "income"],
        ["Expenses", money(totals.expenseCents), "expense"],
        ["Net savings", money(totals.netCents), "savings"],
        ["Savings rate", `${savingsRate}%`, "rate"]
      ].map(([label, value, type]) => `<article class="stat-card"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-icon ${type === "income" ? "green" : type === "expense" ? "red" : "blue"}">${type === "income" ? "↗" : type === "expense" ? "↘" : "◇"}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${periodName(period)}</div></article>`).join("");
      const categoryTotals = calculateCategoryTotals(transactions);
      const largest = categoryTotals[0]?.amountCents || 0;
      $("#report-categories").innerHTML = categoryTotals.length ?
        categoryTotals.map((item, index) => `<div class="report-category-row"><span>${escapeHTML(item.category)}</span><div class="report-category-bar"><span style="width:${largest ? item.amountCents / largest * 100 : 0}%;background:${CHART_COLORS[index % CHART_COLORS.length]}"></span></div><strong>${money(item.amountCents)}</strong></div>`).join("") :
        `<div class="notification-empty">No expenses in this period yet.</div>`;
      $("#report-budgets").innerHTML = userData.budgets.length ?
        userData.budgets.map((budget) => {
          const usage = budgetStatus(budget);
          const tone = budgetTone(usage, budget.warningThreshold || userData.settings.warningThreshold);
          return `<div class="report-budget-item"><strong>${escapeHTML(budget.category)}</strong><div class="progress-track"><div class="progress-fill ${tone}" style="width:${Math.min(100, Math.max(0, usage.percentage))}%"></div></div><span>${money(usage.spentCents)} / ${money(budget.limitCents)}</span></div>`;
        }).join("") :
        `<div class="notification-empty">Create a monthly budget to track how you’re doing.</div>`;
      $("#report-rows").innerHTML = transactions.map((transaction) => `<tr><td>${dateLabel(transaction.date)}</td><td>${escapeHTML(transaction.description || transaction.category)}</td><td><span class="type-pill ${transaction.type}">${transaction.type}</span></td><td>${escapeHTML(transaction.category)}</td><td class="align-right ${transaction.type === "income" ? "amount-income" : "amount-expense"}">${transaction.type === "income" ? "+" : "−"}${money(transaction.amountCents)}</td></tr>`).join("");
      $("#report-empty").hidden = transactions.length > 0;
      $("#report-period-caption").textContent = `${periodName(period)} · ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}`;
    }

    function renderCategories() {
      for (const type of ["expense", "income"]) {
        const container = $(`#${type}-category-list`);
        container.innerHTML = userData.categories[type].map((category) => `<span class="category-tag">${escapeHTML(category)}<button type="button" data-action="remove-category" data-type="${type}" data-category="${escapeHTML(category)}" aria-label="Remove ${escapeHTML(category)} category">×</button></span>`).join("");
      }
    }

    function renderRecurring() {
      $("#recurring-list").innerHTML = userData.recurring.length ?
        userData.recurring.map((rule) => `<div class="recurring-item"><div><strong>${escapeHTML(rule.description || rule.category)}</strong><small>${escapeHTML(rule.frequency)} · next ${dateLabel(rule.nextDate)}</small></div><span>${money(rule.amountCents)}</span><button class="row-action delete" type="button" data-action="delete-recurring" data-id="${escapeHTML(rule.id)}" aria-label="Stop recurring ${escapeHTML(rule.description || rule.category)}">×</button></div>`).join("") :
        `<div class="notification-empty">No recurring entries set up.</div>`;
    }

    function budgetAlerts() {
      return userData.budgets.map((budget) => {
        const usage = budgetStatus(budget);
        const tone = budgetTone(usage, budget.warningThreshold || userData.settings.warningThreshold);
        if (!tone) return null;
        return {
          tone,
          category: budget.category,
          message: tone === "over" ?
            `You've spent ${money(Math.abs(usage.remainingCents))} over your ${budget.category} limit.` : `${budget.category} is at ${Math.floor(usage.percentage)}% of its monthly limit.`
        };
      }).filter(Boolean);
    }

    function renderNotificationDot() {
      const hasAlerts = budgetAlerts().length > 0;
      $("#notification-dot").hidden = !hasAlerts;
    }

    function renderNotifications() {
      const alerts = budgetAlerts();
      notificationPopover.innerHTML = `<h3>Budget check-in</h3>${alerts.length ? alerts.map((alert) => `<div class="notification-item"><strong>${alert.tone === "over" ? "Budget exceeded" : "Getting close"} · ${escapeHTML(alert.category)}</strong>${escapeHTML(alert.message)}</div>`).join("") : `<div class="notification-empty">You're in the clear. No budget alerts right now.</div>`}`;
      notificationPopover.hidden = false;
    }

    function renderAll() {
      renderDashboard();
      renderTransactions();
      renderBudgets();
      renderGoals();
      renderReports();
    }

    function setCategoryOptions(select, type, selected) {
      const categories = userData.categories[type];
      select.innerHTML = categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
      if (categories.includes(selected)) select.value = selected;
    }

    function openModal(title, description, body, submitText, onSubmit) {
      lastFocusedElement = document.activeElement;
      modalCard.innerHTML = `<div class="modal-header"><div><h2 id="modal-title">${escapeHTML(title)}</h2><p>${escapeHTML(description)}</p></div><button class="modal-close" type="button" aria-label="Close dialog">×</button></div><div class="modal-body">${body}</div>`;
      modalLayer.hidden = false;
      document.body.style.overflow = "hidden";
      modalCard.querySelector(".modal-close").addEventListener("click", closeModal);
      modalLayer.addEventListener("click", closeModalOnBackdrop);
      const form = modalCard.querySelector("form");
      if (form && onSubmit) {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const button = form.querySelector("[type=submit]");
          if (button) {
            button.disabled = true;
            button.textContent = "Saving…";
          }
          try {
            await onSubmit(new FormData(form));
          } catch (error) {
            showToast(error.message || "That change could not be saved.", "error");
            if (button) {
              button.disabled = false;
              button.textContent = submitText;
            }
            return;
          }
          closeModal();
        });
      }
      if (submitText && !form) {
        const footer = document.createElement("div");
        footer.className = "modal-footer";
        footer.innerHTML = `<button type="button" class="secondary-button modal-cancel">Cancel</button><button type="button" class="primary-button modal-confirm">${escapeHTML(submitText)}</button>`;
        modalCard.append(footer);
        footer.querySelector(".modal-cancel").addEventListener("click", closeModal);
        footer.querySelector(".modal-confirm").addEventListener("click", async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await onSubmit();
            closeModal();
          } catch (error) {
            showToast(error.message || "That change could not be saved.", "error");
            button.disabled = false;
          }
        });
      }
      const firstField = modalCard.querySelector(".modal-body input, .modal-body select, .modal-body textarea") || modalCard.querySelector(".modal-close");
      if (firstField) firstField.focus();
    }

    function closeModal() {
      if (modalLayer.hidden) return;
      modalLayer.hidden = true;
      modalCard.innerHTML = "";
      document.body.style.overflow = "";
      modalLayer.removeEventListener("click", closeModalOnBackdrop);
      if (lastFocusedElement?.isConnected) lastFocusedElement.focus();
    }

    function closeModalOnBackdrop(event) {
      if (event.target === modalLayer) closeModal();
    }

    function transactionModal(existing = null) {
      const type = existing?.type || "expense";
      const categories = userData.categories[type];
      const categoryOptions = categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
      const recurrence = existing ? "" : `<div class="field-group"><label for="transaction-frequency">Repeat</label><select id="transaction-frequency" name="frequency"><option value="none">Does not repeat</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div>`;
      const body = `<form id="transaction-form"><div class="modal-form-grid"><div class="field-group"><label for="transaction-type">Type</label><select id="transaction-type" name="type"><option value="expense">Expense</option><option value="income">Income</option></select></div><div class="field-group"><label for="transaction-amount">Amount</label><input id="transaction-amount" name="amount" inputmode="decimal" type="number" min="0.01" max="10000000000" step="0.01" required placeholder="0.00" value="${existing ? escapeHTML((existing.amountCents / 100).toFixed(2)) : ""}"></div><div class="field-group"><label for="transaction-category">Category</label><select id="transaction-category" name="category">${categoryOptions}</select></div><div class="field-group"><label for="transaction-date">Date</label><input id="transaction-date" name="date" type="date" required value="${escapeHTML(existing?.date || dateToday())}"></div><div class="field-group full-width"><label for="transaction-description">Description</label><input id="transaction-description" name="description" maxlength="80" placeholder="e.g. Weekly groceries" value="${escapeHTML(existing?.description || "")}"></div><div class="field-group"><label for="transaction-payment">Payment method</label><select id="transaction-payment" name="paymentMethod"><option>Card</option><option>Cash</option><option>Bank transfer</option><option>Credit card</option><option>Other</option></select></div>${recurrence}<div class="field-group full-width"><label for="transaction-notes">Notes <span class="optional-label">(optional)</span></label><textarea class="form-control" id="transaction-notes" name="notes" maxlength="400" placeholder="Anything else you'd like to remember?">${escapeHTML(existing?.notes || "")}</textarea></div></div><div class="modal-footer"><button type="button" class="secondary-button modal-cancel">Cancel</button><button class="primary-button" type="submit">${existing ? "Save changes" : "Add transaction"}</button></div></form>`;
      openModal(existing ? "Edit transaction" : "Add a transaction", "Record money coming in or going out. Amounts use your selected display currency.", body, existing ? "Save changes" : "Add transaction", async (formData) => {
        const transactionType = String(formData.get("type"));
        const amountCents = parseAmountToCents(formData.get("amount"));
        const transactionDate = String(formData.get("date"));
        if (!isValidISODate(transactionDate)) throw new Error("Choose a valid transaction date.");
        const category = String(formData.get("category") || "");
        if (!userData.categories[transactionType]?.includes(category)) throw new Error("Choose a category from your list.");
        const entry = {
          id: existing?.id || newId(),
          type: transactionType,
          amountCents,
          category,
          description: String(formData.get("description") || "").trim().slice(0, 80),
          date: transactionDate,
          paymentMethod: String(formData.get("paymentMethod") || "Other"),
          notes: String(formData.get("notes") || "").trim().slice(0, 400),
          createdAt: existing?.createdAt || Date.now()
        };
        if (existing) {
          Object.assign(existing, entry);
        } else {
          userData.transactions.push(entry);
          const frequency = String(formData.get("frequency") || "none");
          if (frequency !== "none") {
            userData.recurring.push({
              id: newId(),
              type: entry.type,
              amountCents: entry.amountCents,
              category: entry.category,
              description: entry.description,
              paymentMethod: entry.paymentMethod,
              notes: entry.notes,
              frequency,
              nextDate: nextOccurrence(entry.date, frequency)
            });
          }
        }
        await saveData();
        renderAll();
        showToast(existing ? "Transaction updated." : "Transaction added.");
      });
      const form = $("#transaction-form", modalCard);
      if (existing) {
        form.querySelector("#transaction-type").value = existing.type;
        form.querySelector("#transaction-payment").value = existing.paymentMethod || "Card";
        setCategoryOptions(form.querySelector("#transaction-category"), existing.type, existing.category);
      }
      form.querySelector("#transaction-type").addEventListener("change", (event) => {
        setCategoryOptions(form.querySelector("#transaction-category"), event.target.value);
      });
      form.querySelector(".modal-cancel").addEventListener("click", closeModal);
    }

    function budgetModal(existing = null) {
      const usedCategories = new Set(userData.budgets.filter((item) => item.id !== existing?.id).map((item) => item.category));
      const available = userData.categories.expense.filter((category) => !usedCategories.has(category));
      if (!available.length && !existing) {
        showToast("All of your expense categories already have a budget. Add a new category in Settings first.", "error");
        return;
      }
      const categories = existing ? [...new Set([...available, existing.category])] : available;
      const options = categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join("");
      const body = `<form id="budget-form"><div class="field-group"><label for="budget-category">Expense category</label><select id="budget-category" name="category">${options}</select></div><div class="field-group"><label for="budget-limit">Monthly limit</label><input id="budget-limit" name="limit" type="number" inputmode="decimal" min="0.01" max="10000000000" step="0.01" required placeholder="0.00" value="${existing ? escapeHTML((existing.limitCents / 100).toFixed(2)) : ""}"></div><div class="field-group"><label for="budget-threshold">Warning threshold</label><div class="input-suffix"><input id="budget-threshold" name="threshold" type="number" min="50" max="99" step="1" value="${existing?.warningThreshold || userData.settings.warningThreshold}" required><span>%</span></div><span class="field-hint">You'll also get an alert when spending reaches 100%.</span></div><div class="modal-footer"><button class="secondary-button modal-cancel" type="button">Cancel</button><button class="primary-button" type="submit">${existing ? "Save budget" : "Create budget"}</button></div></form>`;
      openModal(existing ? "Edit monthly budget" : "Create a monthly budget", "Set a limit for one expense category. Spending is counted from this calendar month.", body, "Save budget", async (formData) => {
        const category = String(formData.get("category"));
        const limitCents = parseAmountToCents(formData.get("limit"));
        const warningThreshold = Number(formData.get("threshold"));
        if (!userData.categories.expense.includes(category)) throw new Error("Choose an expense category from your list.");
        if (!Number.isInteger(warningThreshold) || warningThreshold < 50 || warningThreshold > 99) throw new Error("Choose a warning threshold between 50 and 99 percent.");
        if (userData.budgets.some((budget) => budget.category === category && budget.id !== existing?.id)) throw new Error("There is already a budget for that category.");
        if (existing) Object.assign(existing, {
          category,
          limitCents,
          warningThreshold
        });
        else userData.budgets.push({
          id: newId(),
          category,
          limitCents,
          warningThreshold
        });
        await saveData();
        renderAll();
        showToast(existing ? "Budget updated." : "Budget created.");
      });
      if (existing) $("#budget-category", modalCard).value = existing.category;
      $(".modal-cancel", modalCard).addEventListener("click", closeModal);
    }

    function goalModal(existing = null) {
      const body = `<form id="goal-form"><div class="field-group"><label for="goal-name">What are you saving for?</label><input id="goal-name" name="name" maxlength="60" required placeholder="e.g. A weekend away" value="${escapeHTML(existing?.name || "")}"></div><div class="modal-form-grid"><div class="field-group"><label for="goal-target">Target amount</label><input id="goal-target" name="target" type="number" inputmode="decimal" min="0.01" max="10000000000" step="0.01" required placeholder="0.00" value="${existing ? escapeHTML((existing.targetCents / 100).toFixed(2)) : ""}"></div><div class="field-group"><label for="goal-current">Already saved</label><input id="goal-current" name="current" type="number" inputmode="decimal" min="0" max="10000000000" step="0.01" value="${existing ? escapeHTML((existing.currentCents / 100).toFixed(2)) : "0.00"}"></div><div class="field-group"><label for="goal-date">Target date <span class="optional-label">(optional)</span></label><input id="goal-date" name="targetDate" type="date" value="${escapeHTML(existing?.targetDate || "")}"></div><div class="field-group"><label for="goal-icon">Small symbol</label><select id="goal-icon" name="icon"><option value="◎">Target</option><option value="⌂">Home</option><option value="✈">Travel</option><option value="☆">Something special</option><option value="♧">Rainy day</option></select></div></div><div class="modal-footer"><button class="secondary-button modal-cancel" type="button">Cancel</button><button class="primary-button" type="submit">${existing ? "Save goal" : "Create goal"}</button></div></form>`;
      openModal(existing ? "Edit savings goal" : "Create a savings goal", "Choose a target that feels meaningful to you.", body, "Save goal", async (formData) => {
        const name = String(formData.get("name") || "").trim();
        const targetCents = parseAmountToCents(formData.get("target"));
        const currentText = String(formData.get("current") || "0");
        const currentCents = currentText === "" ? 0 : parseAmountToCents(currentText, true);
        const targetDate = String(formData.get("targetDate") || "");
        if (!name) throw new Error("Add a name for your goal.");
        if (targetDate && !isValidISODate(targetDate)) throw new Error("Choose a valid target date.");
        const goal = {
          name: name.slice(0, 60),
          targetCents,
          currentCents,
          targetDate,
          icon: String(formData.get("icon") || "◎")
        };
        if (existing) Object.assign(existing, goal);
        else userData.goals.push({
          id: newId(),
          ...goal
        });
        await saveData();
        renderAll();
        showToast(existing ? "Savings goal updated." : "Savings goal created.");
      });
      if (existing) $("#goal-icon", modalCard).value = existing.icon || "◎";
      $(".modal-cancel", modalCard).addEventListener("click", closeModal);
    }

    function contributionModal(goal) {
      const remaining = Math.max(0, goal.targetCents - goal.currentCents);
      const body = `<form id="contribution-form"><div class="privacy-note"><strong>${escapeHTML(goal.name)}</strong><p>${money(goal.currentCents)} saved · ${money(remaining)} to target</p></div><div class="field-group"><label for="contribution-amount">Contribution amount</label><input id="contribution-amount" name="amount" type="number" inputmode="decimal" min="0.01" max="10000000000" step="0.01" required placeholder="0.00"></div><div class="modal-footer"><button class="secondary-button modal-cancel" type="button">Cancel</button><button class="primary-button" type="submit">Add contribution</button></div></form>`;
      openModal("Add to your savings", "Record the progress you have made toward this goal.", body, "Add contribution", async (formData) => {
        const amount = parseAmountToCents(formData.get("amount"));
        const updatedCents = goal.currentCents + amount;
        if (!Number.isSafeInteger(updatedCents)) throw new Error("This contribution makes the total too large.");
        goal.currentCents = updatedCents;
        await saveData();
        renderAll();
        showToast("Contribution added to your goal.");
      });
      $(".modal-cancel", modalCard).addEventListener("click", closeModal);
    }

    function confirmDelete(title, message, onConfirm) {
      openModal(title, "", `<p class="delete-confirm">${escapeHTML(message)}</p>`, "Delete", async () => {
        await onConfirm();
        renderAll();
        showToast("Deleted.");
      });
    }

    function nextOccurrence(dateString, frequency) {
      const date = new Date(`${dateString}T00:00:00`);
      if (frequency === "weekly") {
        date.setDate(date.getDate() + 7);
        return toISODate(date);
      }
      const day = date.getDate();
      const targetMonth = date.getMonth() + 1;
      const firstOfTarget = new Date(date.getFullYear(), targetMonth, 1);
      const lastDay = new Date(firstOfTarget.getFullYear(), firstOfTarget.getMonth() + 1, 0).getDate();
      firstOfTarget.setDate(Math.min(day, lastDay));
      return toISODate(firstOfTarget);
    }

    async function processRecurring() {
      let changed = false;
      const today = dateToday();
      for (const rule of userData.recurring) {
        let generated = 0;
        while (rule.nextDate <= today && generated < 500) {
          userData.transactions.push({
            id: newId(),
            type: rule.type,
            amountCents: rule.amountCents,
            category: rule.category,
            description: rule.description,
            date: rule.nextDate,
            paymentMethod: rule.paymentMethod,
            notes: rule.notes,
            createdAt: Date.now(),
            recurringId: rule.id
          });
          rule.nextDate = nextOccurrence(rule.nextDate, rule.frequency);
          generated += 1;
          changed = true;
        }
        if (generated === 500 && rule.nextDate <= today) {
          showToast(`Recurring entries for “${rule.description || rule.category}” are overdue by more than 500 periods. Adjust or stop the schedule in Settings.`, "error");
        }
      }
      if (changed) await saveData();
    }

    function addCategory(type, value) {
      const category = value.trim().replace(/\s+/g, " ").slice(0, 24);
      if (!category) throw new Error("Enter a category name.");
      if (userData.categories[type].some((item) => item.toLowerCase() === category.toLowerCase())) throw new Error("That category already exists.");
      userData.categories[type].push(category);
      return saveData().then(() => {
        renderAll();
        populateSettings();
        showToast("Category added.");
      });
    }

    function csvCell(value) {
      let text = String(value ?? "");
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    }

    function exportCSV() {
      const period = $("#view-reports").classList.contains("active") ? $("#report-period").value : "all";
      const rows = userData.transactions.filter((transaction) => isInPeriod(transaction.date, period))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((transaction) => [
          transaction.date,
          transaction.type,
          transaction.description || transaction.category,
          transaction.category,
          (transaction.amountCents / 100).toFixed(2),
          transaction.paymentMethod,
          transaction.notes
        ]);
      const content = [
          ["Date", "Type", "Description", "Category", "Amount", "Payment method", "Notes"], ...rows
        ]
        .map((row) => row.map(csvCell).join(",")).join("\r\n");
      downloadBlob(`\ufeff${content}`, `spendwise-transactions-${dateToday()}.csv`, "text/csv;charset=utf-8");
      showToast("Your CSV report is ready.");
    }

    function downloadBlob(content, filename, type) {
      const blob = new Blob([content], {
        type
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function downloadBackup() {
      if (!vault) throw new Error("There is no unlocked vault to back up.");
      downloadBlob(JSON.stringify(vault, null, 2), `spendwise-encrypted-backup-${dateToday()}.json`, "application/json");
      showToast("Encrypted backup downloaded. Keep it somewhere safe.");
    }

    async function readBackupFile(file) {
      if (!file) return null;
      let parsed;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("That file isn't valid JSON.");
      }
      if (parsed?.version !== 1 || typeof parsed.email !== "string" || !parsed.salt || !parsed.iv || !parsed.ciphertext) {
        throw new Error("That file isn't a valid SpendWise encrypted backup.");
      }
      return parsed;
    }

    async function restoreBackup(file, fromAuth = false) {
      const parsed = await readBackupFile(file);
      if (!parsed) return;
      const accepted = window.confirm("Restoring a backup replaces the vault saved in this browser. Continue?");
      if (!accepted) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      vault = parsed;
      if (fromAuth) {
        setAuthMode("login");
        $("#auth-email").value = vault.email;
      } else {
        lockVault();
      }
      showAuthError("Backup restored. Unlock it with the password used when that backup was created.");
    }

    function applyTheme() {
      document.body.classList.toggle("dark", userData.settings.theme === "dark");
    }

    function addCategoryForm(type, form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = form.querySelector("input");
        try {
          await addCategory(type, input.value);
          input.value = "";
        } catch (error) {
          showToast(error.message, "error");
        }
      });
    }

    function bindAppEvents() {
      $$(".nav-item[data-view], [data-view]:not(.nav-item)").forEach((button) => {
        button.addEventListener("click", () => setView(button.dataset.view));
      });
      $("#top-avatar").addEventListener("click", () => setView("settings"));
      $("#dashboard-period").addEventListener("change", renderDashboard);
      $("#report-period").addEventListener("change", renderReports);
      $("#transaction-search").addEventListener("input", renderTransactions);
      $("#transaction-type-filter").addEventListener("change", renderTransactions);
      $("#transaction-category-filter").addEventListener("change", renderTransactions);
      $("#transaction-date-filter").addEventListener("change", renderTransactions);
      $("#clear-transaction-filters").addEventListener("click", () => {
        $("#transaction-search").value = "";
        $("#transaction-type-filter").value = "all";
        $("#transaction-category-filter").value = "all";
        $("#transaction-date-filter").value = "all";
        renderTransactions();
      });
      $("#notification-button").addEventListener("click", (event) => {
        event.stopPropagation();
        if (notificationPopover.hidden) renderNotifications();
        else notificationPopover.hidden = true;
      });
      document.addEventListener("click", (event) => {
        if (!notificationPopover.hidden && !notificationPopover.contains(event.target) && !$("#notification-button").contains(event.target)) {
          notificationPopover.hidden = true;
        }
      });
      $("#theme-toggle").addEventListener("click", async () => {
        userData.settings.theme = userData.settings.theme === "dark" ? "light" : "dark";
        applyTheme();
        try {
          await saveData();
          showToast("Appearance preference saved.");
        } catch (error) {
          showToast(error.message || "Could not save your preference.", "error");
        }
      });
      $("#mobile-menu").addEventListener("click", () => {
        const sidebar = $("#sidebar");
        const open = sidebar.classList.toggle("open");
        $("#mobile-menu").setAttribute("aria-expanded", String(open));
      });
      document.addEventListener("click", (event) => {
        if (window.innerWidth <= 760 && $("#sidebar").classList.contains("open") &&
          !$("#sidebar").contains(event.target) && !$("#mobile-menu").contains(event.target)) {
          $("#sidebar").classList.remove("open");
          $("#mobile-menu").setAttribute("aria-expanded", "false");
        }
      });
      $("#lock-button").addEventListener("click", lockVault);
      $("#lock-from-settings").addEventListener("click", lockVault);
      const resetIdleTimer = () => {
        window.clearTimeout(idleTimer);
        if (userData) idleTimer = window.setTimeout(lockVault, 15 * 60 * 1000);
      };
      ["pointerdown", "keydown"].forEach((eventName) => document.addEventListener(eventName, resetIdleTimer, {
        passive: true
      }));
      resetIdleTimer();
      $("#settings-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = $("#settings-name").value.trim();
        const threshold = Number($("#warning-threshold").value);
        if (!name || name.length > 60) {
          showToast("Enter a display name of 1–60 characters.", "error");
          return;
        }
        if (!Number.isInteger(threshold) || threshold < 50 || threshold > 99) {
          showToast("Choose a warning threshold between 50 and 99 percent.", "error");
          return;
        }
        userData.profile.name = name;
        userData.settings.currency = $("#settings-currency").value;
        userData.settings.warningThreshold = threshold;
        try {
          await saveData();
          updateProfile();
          renderAll();
          showToast("Your preferences have been saved.");
        } catch (error) {
          showToast(error.message || "Preferences could not be saved.", "error");
        }
      });
      addCategoryForm("expense", $("#add-expense-category"));
      addCategoryForm("income", $("#add-income-category"));
      $("#restore-file").addEventListener("change", async (event) => {
        try {
          await restoreBackup(event.target.files[0]);
        } catch (error) {
          showToast(error.message || "The backup could not be restored.", "error");
        } finally {
          event.target.value = "";
        }
      });
      document.addEventListener("click", async (event) => {
        const action = event.target.closest("[data-action]");
        if (!action) return;
        const {
          action: name,
          id,
          type,
          category
        } = action.dataset;
        try {
          if (name === "add-transaction") transactionModal();
          else if (name === "edit-transaction") {
            const transaction = userData.transactions.find((item) => item.id === id);
            if (transaction) transactionModal(transaction);
          } else if (name === "delete-transaction") {
            const transaction = userData.transactions.find((item) => item.id === id);
            if (transaction) confirmDelete("Delete transaction?", `Delete “${transaction.description || transaction.category}” for ${money(transaction.amountCents)}? This cannot be undone.`, async () => {
              userData.transactions = userData.transactions.filter((item) => item.id !== id);
              await saveData();
            });
          } else if (name === "add-budget") budgetModal();
          else if (name === "edit-budget") {
            const budget = userData.budgets.find((item) => item.id === id);
            if (budget) budgetModal(budget);
          } else if (name === "delete-budget") {
            const budget = userData.budgets.find((item) => item.id === id);
            if (budget) confirmDelete("Delete this budget?", `Remove the monthly ${budget.category} budget? Your transactions will not be affected.`, async () => {
              userData.budgets = userData.budgets.filter((item) => item.id !== id);
              await saveData();
            });
          } else if (name === "add-goal") goalModal();
          else if (name === "edit-goal") {
            const goal = userData.goals.find((item) => item.id === id);
            if (goal) goalModal(goal);
          } else if (name === "contribute-goal") {
            const goal = userData.goals.find((item) => item.id === id);
            if (goal) contributionModal(goal);
          } else if (name === "delete-goal") {
            const goal = userData.goals.find((item) => item.id === id);
            if (goal) confirmDelete("Delete savings goal?", `Remove “${goal.name}” and its progress from this vault?`, async () => {
              userData.goals = userData.goals.filter((item) => item.id !== id);
              await saveData();
            });
          } else if (name === "remove-category") {
            const inUse = userData.transactions.some((item) => item.category === category && item.type === type) ||
              (type === "expense" && userData.budgets.some((item) => item.category === category));
            if (inUse) {
              showToast("This category is used by a transaction or budget, so it can't be removed yet.", "error");
              return;
            }
            userData.categories[type] = userData.categories[type].filter((item) => item !== category);
            await saveData();
            renderAll();
            populateSettings();
            showToast("Category removed.");
          } else if (name === "delete-recurring") {
            const rule = userData.recurring.find((item) => item.id === id);
            if (rule) confirmDelete("Stop recurring entries?", `Stop future “${rule.description || rule.category}” entries? Existing transactions will remain.`, async () => {
              userData.recurring = userData.recurring.filter((item) => item.id !== id);
              await saveData();
            });
          } else if (name === "export-csv") exportCSV();
          else if (name === "print-report") window.print();
          else if (name === "backup-vault") downloadBackup();
        } catch (error) {
          showToast(error.message || "That action could not be completed.", "error");
        }
      });
    }

    async function handleAuthSubmit(event) {
      event.preventDefault();
      showAuthError("");
      const email = $("#auth-email").value.trim().toLowerCase();
      const password = $("#auth-password").value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showAuthError("Enter a valid email address.");
        return;
      }
      if (!password) {
        showAuthError("Enter your password.");
        return;
      }
      if (!window.crypto?.subtle) {
        showAuthError("This browser does not support secure encryption. Open SpendWise in a current browser over localhost or HTTPS.");
        return;
      }
      const submit = $("#auth-submit");
      submit.disabled = true;
      submit.textContent = authMode === "register" ? "Creating encrypted vault…" : "Unlocking vault…";
      try {
        const existingVault = getStoredVault();
        if (authMode === "register") {
          if (existingVault) throw new Error("A vault already exists in this browser. Unlock it or restore a backup instead.");
          const name = $("#auth-name").value.trim();
          if (!name || name.length > 60) throw new Error("Enter a name between 1 and 60 characters.");
          if (password.length < 12) throw new Error("Use a password with at least 12 characters.");
          if ($("#auth-confirm").value !== password) throw new Error("The passwords don't match.");
          userData = createEmptyData(name, email);
          vault = await encryptVault(userData, password, email);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
          } catch {
            throw new Error("The browser couldn't save your vault. Check available storage and try again.");
          }
        } else {
          if (!existingVault) throw new Error("No vault was found in this browser. Create a vault or restore an encrypted backup.");
          if (existingVault.email !== email) throw new Error("No vault matches that email address.");
          try {
            userData = await decryptVault(existingVault, password);
          } catch {
            throw new Error("The password is incorrect, or this vault's data is damaged.");
          }
          vault = existingVault;
        }
        userData = normalizeData(userData, email);
        await processRecurring();
        await rememberLogin(email, userData);
        showApp();
      } catch (error) {
        userData = null;
        activeEncryptionKey = null;
        showAuthError(error.message || "The vault could not be opened.");
      } finally {
        submit.disabled = false;
        submit.textContent = authMode === "register" ? "Create my vault" : "Unlock my vault";
      }
    }

    $("#login-tab").addEventListener("click", () => setAuthMode("login"));
    $("#register-tab").addEventListener("click", () => setAuthMode("register"));
    $("#auth-footnote").addEventListener("click", (event) => {
      if (event.target.id === "switch-to-register") setAuthMode("register");
      if (event.target.id === "switch-to-login") setAuthMode("login");
    });
    $("#auth-restore-file").addEventListener("change", async (event) => {
      try {
        await restoreBackup(event.target.files[0], true);
      } catch (error) {
        showAuthError(error.message || "The backup could not be restored.");
      } finally {
        event.target.value = "";
      }
    });
    authForm.addEventListener("submit", handleAuthSubmit);
    bindAppEvents();

    try {
      vault = getStoredVault();
      if (vault && (vault.version !== 1 || !vault.email || !vault.salt || !vault.iv || !vault.ciphertext)) {
        throw new Error("The saved vault is not valid. Restore a valid encrypted backup to continue.");
      }
      const remembered = getRememberedLogin();
      if (vault && remembered && remembered.email === vault.email) {
        activeEncryptionKey = await importRememberedKey(remembered.key);
        if (activeEncryptionKey) {
          userData = normalizeData(remembered.data, vault.email);
          await processRecurring();
          await saveData();
          showApp();
          return;
        }
      }
      setAuthMode(vault ? "login" : "register");
      if (vault) $("#auth-email").value = vault.email;
    } catch (error) {
      setAuthMode("register");
      showAuthError(error.message);
    }
  });
})();