const SESSION_KEY = "paybuddy_customer_session";
let currentCustomer = null;      // full customer doc (live)
let historyUnsub = null;
let rechargesUnsub = null;
let balanceUnsub = null;
let myTransactions = [];         // cached list, newest first
let myRecharges = [];            // cached recharges, newest first
let myLoans = [];                // cached loan applications, newest first
let loansUnsub = null;
let myDeposits = [];             // cached Fixed Deposits, newest first
let depositsUnsub = null;
let selectedLoanType = null;     // the loan definition currently being applied for
let statementEntryPoint = "list"; // "list" or "dashboard" - governs the back button in statement detail
let currentDetailTxn = null;     // the transaction currently shown in the detail view

/* ---------------- Launch animation ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  const launch = document.getElementById("launchScreen");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const delay = reduce ? 150 : 1900;

  setTimeout(() => {
    launch.classList.add("hide");
    boot();
  }, delay);
});

function boot() {
  const dobInput = document.getElementById("suDob");
  if (dobInput) dobInput.max = new Date().toISOString().split("T")[0];

  const savedAcct = localStorage.getItem(SESSION_KEY);
  if (savedAcct) {
    loadSession(savedAcct);
  } else {
    document.getElementById("authShell").style.display = "flex";
  }
}

/* ---------------- Helpers ---------------- */

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomDigits(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

function generateTransactionId() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  return dd + mm + yy + randomDigits(4);
}

function generateAccountNumber() {
  // 11 digits, doesn't start with 0
  return String(Math.floor(Math.random() * 9) + 1) + randomDigits(10);
}

function generateIFSC() {
  return "PYBY0" + randomDigits(3); // PYBY = PayBuddy bank code, 5th char reserved as 0
}

function formatMoney(n) {
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "2000-09-23" -> "23/09/2000"
function formatDobSlash(dobStr) {
  if (!dobStr) return "•••";
  const [y, m, d] = dobStr.split("-");
  if (!y || !m || !d) return dobStr;
  return `${d}/${m}/${y}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// -> "23 September, 2026 4:35 PM"
function formatFriendlyDateTime(dateObj) {
  const day = dateObj.getDate();
  const month = MONTH_NAMES[dateObj.getMonth()];
  const year = dateObj.getFullYear();
  let hours = dateObj.getHours();
  const minutes = String(dateObj.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${day} ${month}, ${year} ${hours}:${minutes} ${ampm}`;
}

function showToast(msg, ms = 2200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), ms);
}

function setFieldError(fieldId, isInvalid) {
  document.getElementById(fieldId).classList.toggle("invalid", isInvalid);
}

function showAlert(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.classList.add("show");
}
function hideAlert(elId) {
  document.getElementById(elId).classList.remove("show");
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------------- Tab switching ---------------- */

function switchTab(which) {
  document.getElementById("tabLogin").classList.toggle("active", which === "login");
  document.getElementById("tabSignup").classList.toggle("active", which === "signup");
  document.getElementById("paneLogin").classList.toggle("active", which === "login");
  document.getElementById("paneSignup").classList.toggle("active", which === "signup");
  document.getElementById("paneCreated").classList.remove("active");
  hideAlert("loginAlert");
  hideAlert("signupAlert");
}

/* ---------------- Signup ---------------- */

async function handleSignup() {
  hideAlert("signupAlert");
  const name = document.getElementById("suName").value.trim();
  const dob = document.getElementById("suDob").value;
  const mobile = document.getElementById("suMobile").value.trim();
  const mpin = document.getElementById("suMpin").value.trim();
  const mpin2 = document.getElementById("suMpin2").value.trim();

  let valid = true;
  setFieldError("fName", !name); if (!name) valid = false;
  const dobOk = dob && new Date(dob) <= new Date();
  setFieldError("fDob", !dobOk); if (!dobOk) valid = false;
  const mobileOk = /^[6-9]\d{9}$/.test(mobile);
  setFieldError("fMobile", !mobileOk); if (!mobileOk) valid = false;
  const mpinOk = /^\d{4}$/.test(mpin);
  setFieldError("fMpin", !mpinOk); if (!mpinOk) valid = false;
  setFieldError("fMpin2", mpin !== mpin2 || !mpin2); if (mpin !== mpin2 || !mpin2) valid = false;

  if (!valid) return;

  const btn = document.getElementById("signupBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating account…';

  try {
    // Ensure mobile number is not already registered
    const existing = await db.collection("customers").where("mobile", "==", mobile).limit(1).get();
    if (!existing.empty) {
      showAlert("signupAlert", "This mobile number is already registered. Please log in instead.");
      btn.disabled = false;
      btn.textContent = "Create account";
      return;
    }

    // Generate unique account number
    let accountNumber, clash = true;
    while (clash) {
      accountNumber = generateAccountNumber();
      const doc = await db.collection("customers").doc(accountNumber).get();
      clash = doc.exists;
    }
    const ifsc = generateIFSC();
    const mpinHash = await sha256(mpin);

    await db.collection("customers").doc(accountNumber).set({
      name,
      dob,
      mobile,
      mpinHash,
      accountNumber,
      ifsc,
      balance: 0,
      status: "active",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    document.getElementById("createdName").textContent = name;
    document.getElementById("createdAcct").textContent = accountNumber;
    document.getElementById("createdIfsc").textContent = ifsc;

    document.getElementById("paneLogin").classList.remove("active");
    document.getElementById("paneSignup").classList.remove("active");
    document.getElementById("paneCreated").classList.add("active");

    // Pre-fill login form for convenience
    document.getElementById("loginMobile").value = mobile;

    // clear signup form
    document.getElementById("signupForm").reset();
  } catch (err) {
    console.error(err);
    showAlert("signupAlert", "Something went wrong. Please check your Firebase setup and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create account";
  }
}

function goToLoginAfterSignup() {
  document.getElementById("paneCreated").classList.remove("active");
  switchTab("login");
}

/* ---------------- Login ---------------- */

async function handleLogin() {
  hideAlert("loginAlert");
  const mobile = document.getElementById("loginMobile").value.trim();
  const mpin = document.getElementById("loginMpin").value.trim();

  let valid = true;
  const mobileOk = /^[6-9]\d{9}$/.test(mobile);
  setFieldError("fLoginMobile", !mobileOk); if (!mobileOk) valid = false;
  const mpinOk = /^\d{4}$/.test(mpin);
  setFieldError("fLoginMpin", !mpinOk); if (!mpinOk) valid = false;
  if (!valid) return;

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Logging in…';

  try {
    const snap = await db.collection("customers").where("mobile", "==", mobile).limit(1).get();
    if (snap.empty) {
      showAlert("loginAlert", "No account found for this mobile number.");
      return;
    }
    const doc = snap.docs[0];
    const data = doc.data();

    if (data.status === "blocked") {
      showAlert("loginAlert", "This account has been blocked. Please contact support.");
      return;
    }

    const mpinHash = await sha256(mpin);
    if (mpinHash !== data.mpinHash) {
      showAlert("loginAlert", "Incorrect mPIN.");
      return;
    }

    localStorage.setItem(SESSION_KEY, doc.id);
    document.getElementById("loginForm").reset();
    document.getElementById("authShell").style.display = "none";
    loadSession(doc.id);
  } catch (err) {
    console.error(err);
    showAlert("loginAlert", "Something went wrong. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Log in";
  }
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  if (historyUnsub) historyUnsub();
  if (rechargesUnsub) rechargesUnsub();
  if (loansUnsub) loansUnsub();
  if (depositsUnsub) depositsUnsub();
  if (balanceUnsub) balanceUnsub();
  currentCustomer = null;
  myDeposits = [];
  currentFdId = null;
  myTransactions = [];
  myRecharges = [];
  myLoans = [];
  document.getElementById("appShell").style.display = "none";
  document.getElementById("authShell").style.display = "flex";
  switchTab("login");
}

/* ---------------- Session / dashboard ---------------- */

function loadSession(accountNumber) {
  balanceUnsub = db.collection("customers").doc(accountNumber).onSnapshot(doc => {
    if (!doc.exists) { logout(); return; }
    currentCustomer = doc.data();

    if (currentCustomer.status === "blocked") {
      showToast("Your account has been blocked by the bank.");
      logout();
      return;
    }

    document.getElementById("authShell").style.display = "none";
    document.getElementById("appShell").style.display = "flex";
    document.getElementById("topName").textContent = currentCustomer.name.split(" ")[0];
    document.getElementById("balanceAmt").textContent = formatMoney(currentCustomer.balance);
    document.getElementById("miniAcct").textContent = currentCustomer.accountNumber;
    document.getElementById("miniIfsc").textContent = currentCustomer.ifsc;

    if (document.getElementById("cardsPage").classList.contains("show")) {
      renderCardTypeVisibility();
      if (currentCardType && document.getElementById("cardsDetailView").style.display !== "none") {
        renderCardDetail();
      }
    }

    if (document.getElementById("loansPage").classList.contains("show") &&
        document.getElementById("loansListView").style.display !== "none") {
      renderLoanOptions();
    }
  }, err => console.error(err));

  if (historyUnsub) historyUnsub();
  historyUnsub = db.collection("transactions")
    .where("participants", "array-contains", accountNumber)
    .orderBy("timestamp", "desc")
    .limit(100)
    .onSnapshot(snap => {
      myTransactions = snap.docs.map(d => ({ id: d.id, type: "payment", ...d.data() }));
      renderRecentActivity();
      renderStatementsList();
    }, err => console.error(err));

  if (rechargesUnsub) rechargesUnsub();
  // No orderBy here on purpose: filtering on accountNumber AND sorting by timestamp would
  // need a composite index. getMergedActivity() sorts everything newest first instead.
  rechargesUnsub = db.collection("recharges")
    .where("accountNumber", "==", accountNumber)
    .onSnapshot(snap => {
      myRecharges = snap.docs.map(d => ({ id: d.id, type: "recharge", ...d.data() }));
      renderRecentActivity();
      renderStatementsList();
    }, err => console.error(err));

  if (loansUnsub) loansUnsub();
  // No orderBy here either, for the same reason as recharges above.
  loansUnsub = db.collection("loans")
    .where("accountNumber", "==", accountNumber)
    .onSnapshot(snap => {
      myLoans = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => tsMillisCustomer(b) - tsMillisCustomer(a));
      if (document.getElementById("loansPage").classList.contains("show")) {
        renderMyLoans();
      }
    }, err => console.error(err));

  if (depositsUnsub) depositsUnsub();
  // No orderBy (avoids a composite index); sorted in the browser instead.
  depositsUnsub = db.collection("deposits")
    .where("accountNumber", "==", accountNumber)
    .onSnapshot(snap => {
      myDeposits = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => fdMillis(b.startDate) - fdMillis(a.startDate));
      processDueDeposits();
      if (document.getElementById("depositsPage").classList.contains("show")) {
        renderDepositsPage();
      }
    }, err => console.error(err));
}

function tsMillisCustomer(x) { return x.appliedAt && x.appliedAt.toMillis ? x.appliedAt.toMillis() : 0; }

// Payments and recharges live in separate Firestore collections, but the customer
// sees them as one combined activity feed, newest first.
function getMergedActivity() {
  const millis = (t) => (t.timestamp && t.timestamp.toMillis) ? t.timestamp.toMillis() : 0;
  return [...myTransactions, ...myRecharges].sort((a, b) => millis(b) - millis(a));
}

/* ---------------- History rendering (dashboard + statements share this) ---------------- */

function buildTransactionRow(t, extraClass) {
  const row = document.createElement("div");
  row.className = "history-row" + (extraClass ? " " + extraClass : "");
  const when = t.timestamp && t.timestamp.toDate ? t.timestamp.toDate().toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "•••";

  if (t.type === "recharge") {
    row.innerHTML = `
      <div class="who">
        <span class="name">${escapeHtml(t.operator)} recharge · ${escapeHtml(t.mobile)}</span>
        <span class="txn-id">Txn ID: ${escapeHtml(t.rechargeId || "•••")}</span>
        <span class="meta">${when}</span>
      </div>
      <div class="amt debit">-₹${formatMoney(t.amount)}</div>
    `;
    return row;
  }

  const isCredit = t.toAccount === currentCustomer.accountNumber;
  const otherName = isCredit ? t.fromName : t.toName;
  const isBank = t.entryType === "bank_credit" || t.entryType === "bank_debit" || t.entryType === "loan_disbursement";
  const rowTitle = isBank
    ? (t.note || (isCredit ? "Money added by bank" : "Money deducted by bank"))
    : (isCredit ? "From " : "To ") + (otherName || "•••");
  row.innerHTML = `
    <div class="who">
      <span class="name">${escapeHtml(rowTitle)}</span>
      <span class="txn-id">Txn ID: ${escapeHtml(t.transactionId || "•••")}</span>
      <span class="meta">${when}</span>
    </div>
    <div class="amt ${isCredit ? "credit" : "debit"}">${isCredit ? "+" : "-"}₹${formatMoney(t.amount)}</div>
  `;
  return row;
}

function renderRecentActivity() {
  const list = document.getElementById("historyList");
  const activity = getMergedActivity();
  if (!activity.length) {
    list.innerHTML = '<div class="empty-state">No transactions yet. Once you pay, recharge, or receive money, it will show up here.</div>';
    return;
  }
  list.innerHTML = "";
  activity.slice(0, 3).forEach(t => {
    const row = buildTransactionRow(t);
    row.onclick = () => openTransactionDetail(t.id, t.type, "dashboard");
    list.appendChild(row);
  });
}

// Statements filter: "all" or "monthly" (monthly auto credit entries only)
let statementsFilter = "all";

function isMonthlyCredit(t) {
  return t.type !== "recharge" &&
    t.entryType === "bank_credit" &&
    t.toAccount === currentCustomer.accountNumber &&
    /monthly auto credit/i.test(t.note || "");
}

function setStatementsFilter(f) {
  statementsFilter = f;
  renderStatementsList();
}

function renderStatementsList() {
  const list = document.getElementById("statementsList");
  if (!list) return;

  // keep the filter chips in sync
  document.querySelectorAll("#statementsFilter .filter-chip").forEach(b => {
    b.classList.toggle("active", b.dataset.filter === statementsFilter);
  });

  let activity = getMergedActivity();
  if (statementsFilter === "monthly") activity = activity.filter(isMonthlyCredit);

  if (!activity.length) {
    list.innerHTML = statementsFilter === "monthly"
      ? '<div class="empty-state">No monthly credit transactions yet.</div>'
      : '<div class="empty-state">No transactions yet. Once you pay, recharge, or receive money, it will show up here.</div>';
    return;
  }
  list.innerHTML = "";
  activity.forEach(t => {
    const row = buildTransactionRow(t);
    row.onclick = () => openTransactionDetail(t.id, t.type, "list");
    list.appendChild(row);
  });
}

/* ---------------- My Account page ---------------- */

function openAccountPage() {
  document.getElementById("profileAvatar").textContent = (currentCustomer.name || "?").trim().charAt(0).toUpperCase();
  document.getElementById("profileName").textContent = currentCustomer.name;
  document.getElementById("profileStatus").textContent = currentCustomer.status === "blocked" ? "Account blocked" : "Active PayBuddy account";
  document.getElementById("accAcctNo").textContent = currentCustomer.accountNumber;
  document.getElementById("accIfsc").textContent = currentCustomer.ifsc;
  document.getElementById("accMobile").textContent = currentCustomer.mobile;
  document.getElementById("accDob").textContent = formatDobSlash(currentCustomer.dob);
  document.getElementById("accStatus").textContent = currentCustomer.status === "blocked" ? "Blocked" : "Active";
  document.getElementById("accountPage").classList.add("show");
}

function closeAccountPage() {
  document.getElementById("accountPage").classList.remove("show");
}

/* ---------------- Statements: list then detail ---------------- */

function openStatementsPage() {
  statementEntryPoint = "list";
  document.getElementById("statementsTitle").textContent = "Statements";
  document.getElementById("statementsListView").style.display = "block";
  document.getElementById("statementsDetailView").style.display = "none";
  renderStatementsList();
  document.getElementById("statementsPage").classList.add("show");
}

function closeStatementsPage() {
  document.getElementById("statementsPage").classList.remove("show");
}

function showStatementsList() {
  document.getElementById("statementsTitle").textContent = "Statements";
  document.getElementById("statementsDetailView").style.display = "none";
  document.getElementById("statementsListView").style.display = "block";
}

// Header back button on the Statements page: drill up one level at a time
function statementsBack() {
  const detailVisible = document.getElementById("statementsDetailView").style.display !== "none";
  if (detailVisible) {
    if (statementEntryPoint === "list") {
      showStatementsList();
    } else {
      closeStatementsPage();
    }
  } else {
    closeStatementsPage();
  }
}

function openTransactionDetail(txnDocId, type, entryPoint) {
  const isRecharge = type === "recharge";
  const t = (isRecharge ? myRecharges : myTransactions).find(x => x.id === txnDocId);
  if (!t) return;
  statementEntryPoint = entryPoint || "list";
  currentDetailTxn = isRecharge ? null : t;

  const when = t.timestamp && t.timestamp.toDate ? formatFriendlyDateTime(t.timestamp.toDate()) : "•••";
  const repayBtn = document.getElementById("repayBtn");
  const mobileRow = document.getElementById("detailMobile").parentElement;
  const fromAcctRow = document.getElementById("detailFromAcct").parentElement;
  const toAcctRow = document.getElementById("detailToAcct").parentElement;
  mobileRow.style.display = "";
  fromAcctRow.style.display = "";
  toAcctRow.style.display = "";

  if (isRecharge) {
    document.getElementById("detailDirection").textContent = "Mobile recharge";
    document.getElementById("detailAmount").textContent = "-₹" + formatMoney(t.amount);
    document.getElementById("detailParty").textContent = t.operator + " recharge for " + t.mobile;
    document.getElementById("detailTxnId").textContent = t.rechargeId || "•••";
    document.getElementById("detailDate").textContent = when;
    document.getElementById("detailMobileLabel").textContent = "Recharged mobile number";
    document.getElementById("detailMobile").textContent = t.mobile;
    document.getElementById("detailFromAcct").textContent = t.accountNumber;
    document.getElementById("detailToAcct").textContent = t.operator + " (operator)";
    document.getElementById("detailAmount2").textContent = "₹" + formatMoney(t.amount);
    repayBtn.style.display = "none";
  } else {
    const isCredit = t.toAccount === currentCustomer.accountNumber;
    const otherName = isCredit ? t.fromName : t.toName;
    const otherMobile = isCredit ? t.fromMobile : t.toMobile;
    document.getElementById("detailDirection").textContent = isCredit ? "Money received" : "Money sent";
    document.getElementById("detailAmount").textContent = (isCredit ? "+₹" : "-₹") + formatMoney(t.amount);
    document.getElementById("detailParty").textContent = (isCredit ? "From " : "To ") + otherName;
    document.getElementById("detailTxnId").textContent = t.transactionId || "•••";
    document.getElementById("detailDate").textContent = when;
    document.getElementById("detailMobileLabel").textContent = isCredit ? "Sender's mobile number" : "Recipient's mobile number";
    document.getElementById("detailMobile").textContent = otherMobile || "Not available";
    // "BANK" is a placeholder id, not a real account, so never show it as one.
    document.getElementById("detailFromAcct").textContent = t.fromAccount === "BANK" ? "PayBuddy Bank" : t.fromAccount;
    document.getElementById("detailToAcct").textContent = t.toAccount === "BANK" ? "PayBuddy Bank" : t.toAccount;
    document.getElementById("detailAmount2").textContent = "₹" + formatMoney(t.amount);
    if (t.entryType === "bank_credit" || t.entryType === "bank_debit" || t.entryType === "loan_disbursement") {
      document.getElementById("detailDirection").textContent = isCredit ? "Added by bank" : "Deducted by bank";
      document.getElementById("detailParty").textContent = t.note || (isCredit ? "Money added by bank" : "Money deducted by bank");
      // The sender is always "PayBuddy Bank" (or the viewer's own account) for these entries,
      // which adds no information, so the from/to account rows are hidden rather than shown.
      mobileRow.style.display = "none";
      fromAcctRow.style.display = "none";
      toAcctRow.style.display = "none";
      repayBtn.style.display = "none";
    } else {
      repayBtn.style.display = "block";
    }
  }

  document.getElementById("statementsTitle").textContent = "Transaction detail";
  document.getElementById("statementsListView").style.display = "none";
  document.getElementById("statementsDetailView").style.display = "block";
  document.getElementById("statementsPage").classList.add("show");
}

// "Pay again" from a transaction's detail view: reuse the counterparty's mobile
// number so the customer doesn't have to type it in again.
async function repayFromDetail() {
  if (!currentDetailTxn) return;
  const t = currentDetailTxn;
  const isCredit = t.toAccount === currentCustomer.accountNumber;
  const counterpartyMobile = isCredit ? t.fromMobile : t.toMobile;
  const counterpartyAccount = isCredit ? t.fromAccount : t.toAccount;

  closeStatementsPage();
  openPayPanel();

  if (counterpartyMobile) {
    document.getElementById("payMobile").value = counterpartyMobile;
    await onPayMobileInput();
    return;
  }

  // Older transactions made before mobile numbers were stored: look it up once by account number.
  try {
    const doc = await db.collection("customers").doc(counterpartyAccount).get();
    if (doc.exists) {
      document.getElementById("payMobile").value = doc.data().mobile;
      await onPayMobileInput();
    } else {
      showToast("Could not find this account anymore.");
    }
  } catch (err) {
    console.error(err);
    showToast("Could not look up this account. Please try again.");
  }
}

/* ---------------- Pay flow ---------------- */

let payeeData = null;
let pendingAmount = null;

function openPayPanel() {
  document.getElementById("payPage").classList.add("show");
  document.getElementById("payAvailBal").textContent = formatMoney(currentCustomer.balance);
  document.getElementById("payMobile").focus();
}

function closePayPanel() {
  document.getElementById("payPage").classList.remove("show");
  resetPayForm();
}

function resetPayForm() {
  document.getElementById("payMobile").value = "";
  document.getElementById("payAmount").value = "";
  document.getElementById("payeeCard").style.display = "none";
  document.getElementById("payAmountBlock").style.display = "none";
  document.getElementById("payActions").style.display = "none";
  document.getElementById("payMobileHint").textContent = "We will look up their account automatically.";
  document.getElementById("confirmMpin").value = "";
  document.getElementById("payStepDetails").style.display = "block";
  document.getElementById("payStepMpin").style.display = "none";
  hideAlert("payAlert");
  hideAlert("mpinAlert");
  payeeData = null;
  pendingAmount = null;
}

async function onPayMobileInput() {
  const input = document.getElementById("payMobile");
  input.value = input.value.replace(/\D/g, "").slice(0, 10);
  hideAlert("payAlert");

  if (input.value.length < 10) {
    document.getElementById("payeeCard").style.display = "none";
    document.getElementById("payAmountBlock").style.display = "none";
    document.getElementById("payActions").style.display = "none";
    payeeData = null;
    return;
  }

  const mobile = input.value;
  if (mobile === currentCustomer.mobile) {
    showAlert("payAlert", "You can't pay yourself.");
    return;
  }

  document.getElementById("payMobileHint").innerHTML = '<span class="spinner dark"></span> Looking up account…';

  try {
    const snap = await db.collection("customers").where("mobile", "==", mobile).limit(1).get();
    if (snap.empty) {
      document.getElementById("payMobileHint").textContent = "We will look up their account automatically.";
      showAlert("payAlert", "No PayBuddy account found for this number.");
      return;
    }
    const data = snap.docs[0].data();
    if (data.status === "blocked") {
      showAlert("payAlert", "This account cannot receive payments right now.");
      return;
    }
    payeeData = data;
    document.getElementById("payeeName").textContent = data.name;
    document.getElementById("payeeAcct").textContent = data.accountNumber;
    document.getElementById("payeeIfsc").textContent = data.ifsc;
    document.getElementById("payeeMobile").textContent = data.mobile;
    document.getElementById("payeeCard").style.display = "block";
    document.getElementById("payAmountBlock").style.display = "block";
    document.getElementById("payActions").style.display = "block";
    document.getElementById("payMobileHint").textContent = "Account found.";
    document.getElementById("payAmount").focus();
  } catch (err) {
    console.error(err);
    document.getElementById("payMobileHint").textContent = "We will look up their account automatically.";
    showAlert("payAlert", "Couldn't look up this number. Please try again.");
  }
}

/* Step 1 -> Step 2: validate amount, then ask for mPIN */
function goToMpinStep() {
  hideAlert("payAlert");
  if (!payeeData) { showAlert("payAlert", "Enter a valid recipient first."); return; }

  const amount = parseFloat(document.getElementById("payAmount").value);
  if (!amount || amount <= 0) { showAlert("payAlert", "Enter a valid amount."); return; }
  if (amount > currentCustomer.balance) { showAlert("payAlert", "Insufficient balance."); return; }

  pendingAmount = amount;
  document.getElementById("mpinPayeeName").textContent = payeeData.name;
  document.getElementById("mpinAmountLabel").textContent = formatMoney(amount);
  document.getElementById("payStepDetails").style.display = "none";
  document.getElementById("payStepMpin").style.display = "block";
  hideAlert("mpinAlert");
  document.getElementById("confirmMpin").value = "";
  document.getElementById("confirmMpin").focus();
}

function backToPayDetails() {
  document.getElementById("payStepMpin").style.display = "none";
  document.getElementById("payStepDetails").style.display = "block";
  hideAlert("mpinAlert");
}

/* Step 2: verify mPIN, then run the actual transfer */
async function submitMpinAndPay() {
  hideAlert("mpinAlert");
  const mpin = document.getElementById("confirmMpin").value.trim();

  if (!/^\d{4}$/.test(mpin)) {
    document.getElementById("mpinAlert").textContent = "Enter your 4 digit mPIN.";
    document.getElementById("mpinAlert").classList.add("show");
    return;
  }
  if (!payeeData || !pendingAmount) { backToPayDetails(); return; }

  const btn = document.getElementById("submitMpinBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying…';

  try {
    const mpinHash = await sha256(mpin);
    if (mpinHash !== currentCustomer.mpinHash) {
      document.getElementById("mpinAlert").textContent = "Incorrect mPIN.";
      document.getElementById("mpinAlert").classList.add("show");
      return;
    }

    const transactionId = await runTransfer(payeeData, pendingAmount);
    const paidAt = new Date();

    const paidToName = payeeData.name;
    const paidAmount = pendingAmount;
    closePayPanel();
    document.getElementById("tickTitle").textContent = "Payment successful";
    document.getElementById("tickAmt").textContent = "₹" + formatMoney(paidAmount);
    document.getElementById("tickTo").textContent = "Paid to " + paidToName;
    document.getElementById("tickTxnId").textContent = "Transaction ID: " + transactionId;
    document.getElementById("tickDate").textContent = formatFriendlyDateTime(paidAt);
    document.getElementById("paySuccessPage").classList.add("show");
  } catch (err) {
    console.error(err);
    document.getElementById("mpinAlert").textContent = err.message || "Payment failed. Please try again.";
    document.getElementById("mpinAlert").classList.add("show");
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirm and pay";
  }
}

async function runTransfer(payee, amount) {
  const fromRef = db.collection("customers").doc(currentCustomer.accountNumber);
  const toRef = db.collection("customers").doc(payee.accountNumber);
  const txnRef = db.collection("transactions").doc();
  const transactionId = generateTransactionId();

  await db.runTransaction(async (tx) => {
    const fromSnap = await tx.get(fromRef);
    const toSnap = await tx.get(toRef);
    if (!fromSnap.exists || !toSnap.exists) throw new Error("Account not found.");

    const fromBal = fromSnap.data().balance;
    const toBal = toSnap.data().balance;
    if (fromBal < amount) throw new Error("Insufficient balance.");

    tx.update(fromRef, { balance: Number((fromBal - amount).toFixed(2)) });
    tx.update(toRef, { balance: Number((toBal + amount).toFixed(2)) });

    tx.set(txnRef, {
      transactionId,
      fromAccount: currentCustomer.accountNumber,
      fromName: currentCustomer.name,
      fromMobile: currentCustomer.mobile,
      toAccount: payee.accountNumber,
      toName: payee.name,
      toMobile: payee.mobile,
      amount: Number(amount.toFixed(2)),
      participants: [currentCustomer.accountNumber, payee.accountNumber],
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
  });

  return transactionId;
}

function closeTick() {
  document.getElementById("paySuccessPage").classList.remove("show");
}


/* ===========================================================
   Fixed Deposits
   =========================================================== */

// Annual interest rate (%) by tenure in months. Senior citizens (60+) get an extra 0.50%.
const FD_RATES = [
  { months: 3,  label: "3 months", rate: 5.00 },
  { months: 6,  label: "6 months", rate: 5.75 },
  { months: 12, label: "1 year",   rate: 6.50 },
  { months: 24, label: "2 years",  rate: 6.75 },
  { months: 36, label: "3 years",  rate: 7.00 },
  { months: 60, label: "5 years",  rate: 6.75 }
];
const FD_SENIOR_BONUS = 0.5;
const FD_MIN_AMOUNT = 1000;
const FD_MIN_DAYS_FOR_INTEREST = 7;
const FD_PREMATURE_PENALTY = 1; // percentage points
const DAY_MS = 24 * 60 * 60 * 1000;

let currentFdId = null;       // deposit shown in the detail view
let fdMpinMode = null;        // "open" or "close"
let fdPendingOpen = null;     // validated details of the FD waiting for mPIN
const fdSettling = new Set(); // deposit ids currently being settled (avoid double runs)

function round2(n) { return Math.round(n * 100) / 100; }

function fdMillis(ts) { return ts && ts.toMillis ? ts.toMillis() : 0; }

function fdDate(ts) { return ts && ts.toDate ? ts.toDate() : null; }

function fdFormatDate(d) {
  if (!d) return "•••";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// Adds whole months, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb).
function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function countElapsedMonths(start, now, max) {
  let k = 0;
  while (k < max && addMonths(start, k + 1) <= now) k++;
  return k;
}

function isSeniorCitizen(dobStr) {
  if (!dobStr) return false;
  const [y, m, d] = dobStr.split("-").map(Number);
  if (!y) return false;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age >= 60;
}

function fdRateFor(months) {
  const slab = FD_RATES.find(r => r.months === months);
  if (!slab) return 0;
  return round2(slab.rate + (isSeniorCitizen(currentCustomer && currentCustomer.dob) ? FD_SENIOR_BONUS : 0));
}

function fdTenureLabel(months) {
  const slab = FD_RATES.find(r => r.months === months);
  return slab ? slab.label : months + " months";
}

function generateFdId() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  return "FD" + dd + mm + yy + randomDigits(4);
}

// Works out interest and maturity amount for a new deposit.
//  cumulative: quarterly compounding, everything paid at maturity
//  monthly:    simple interest credited every month, principal paid at maturity
function calcDeposit(principal, months, ratePercent, payoutType) {
  if (payoutType === "monthly") {
    const monthlyInterest = round2(principal * ratePercent / 1200);
    const totalInterest = round2(monthlyInterest * months);
    return { monthlyInterest, totalInterest, maturityAmount: round2(principal) };
  }
  const years = months / 12;
  const amount = principal * Math.pow(1 + ratePercent / 400, 4 * years);
  const totalInterest = round2(amount - principal);
  return { monthlyInterest: 0, totalInterest, maturityAmount: round2(principal + totalInterest) };
}

// Payout if the customer breaks the deposit today: contracted rate minus 1%, only for the time it ran.
function calcPrematureClosure(d, now) {
  const start = fdDate(d.startDate);
  const elapsedDays = Math.max(0, Math.floor((now - start) / DAY_MS));
  const paidAlready = d.interestPaid || 0;
  if (elapsedDays < FD_MIN_DAYS_FOR_INTEREST) {
    return { elapsedDays, penaltyRate: 0, earned: 0, payout: Math.max(0, round2(d.principal - paidAlready)) };
  }
  const penaltyRate = Math.max(0, d.rate - FD_PREMATURE_PENALTY);
  const years = elapsedDays / 365;
  const earned = d.payoutType === "monthly"
    ? d.principal * penaltyRate / 100 * years
    : d.principal * (Math.pow(1 + penaltyRate / 400, 4 * years) - 1);
  const payout = Math.max(0, round2(d.principal + earned - paidAlready));
  return { elapsedDays, penaltyRate, earned: round2(earned), payout };
}

// Same shape as the admin portal's bank entries, so they appear in Recent activity and Statements.
function buildBankTxnForMe(direction, amount, note) {
  const c = currentCustomer;
  const credit = direction === "credit";
  return {
    transactionId: generateTransactionId(),
    entryType: credit ? "bank_credit" : "bank_debit",
    note,
    fromAccount: credit ? "BANK" : c.accountNumber,
    fromName: credit ? "PayBuddy Bank" : c.name,
    fromMobile: credit ? "" : (c.mobile || ""),
    toAccount: credit ? c.accountNumber : "BANK",
    toName: credit ? c.name : "PayBuddy Bank",
    toMobile: credit ? (c.mobile || "") : "",
    amount: Number(amount.toFixed(2)),
    participants: [c.accountNumber],
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  };
}

/* ---------------- Automatic monthly interest + maturity ---------------- */

// Runs whenever the deposits list loads. Banks do this on their own schedule; this demo has no
// server, so it is settled the next time the customer opens the app after the date has passed.
function fdNeedsSettlement(d, now) {
  if (d.status !== "active") return false;
  const mat = fdDate(d.maturityDate);
  if (mat && now >= mat) return true;
  if (d.payoutType === "monthly") {
    const due = countElapsedMonths(fdDate(d.startDate), now, d.tenureMonths);
    return due > (d.interestPaidMonths || 0);
  }
  return false;
}

function processDueDeposits() {
  const now = new Date();
  myDeposits.forEach(d => {
    if (!fdNeedsSettlement(d, now) || fdSettling.has(d.id)) return;
    fdSettling.add(d.id);
    settleDeposit(d.id)
      .catch(err => console.error("FD settlement failed", err))
      .finally(() => fdSettling.delete(d.id));
  });
}

async function settleDeposit(depId) {
  const depRef = db.collection("deposits").doc(depId);
  const custRef = db.collection("customers").doc(currentCustomer.accountNumber);
  const txnCol = db.collection("transactions");
  const depCol = db.collection("deposits");

  await db.runTransaction(async (tx) => {
    const dSnap = await tx.get(depRef);
    const cSnap = await tx.get(custRef);
    if (!dSnap.exists || !cSnap.exists) return;
    const d = dSnap.data();
    if (d.status !== "active") return; // already handled elsewhere

    const now = new Date();
    const start = fdDate(d.startDate);
    const mat = fdDate(d.maturityDate);
    const matured = now >= mat;

    let credit = 0;
    const txns = [];
    const update = {};

    if (d.payoutType === "monthly") {
      const dueMonths = matured ? d.tenureMonths : countElapsedMonths(start, now, d.tenureMonths);
      const owed = dueMonths - (d.interestPaidMonths || 0);
      if (owed > 0) {
        const amt = round2(owed * d.monthlyInterest);
        credit += amt;
        txns.push({ amount: amt, note: `Fixed Deposit interest · ${d.fdId}` });
        update.interestPaidMonths = dueMonths;
        update.interestPaid = round2((d.interestPaid || 0) + amt);
      }
    }

    let renewDoc = null;
    if (matured) {
      const maturityValue = d.maturityAmount;
      update.status = "matured";
      update.maturedAt = firebase.firestore.Timestamp.fromDate(now);
      if (d.maturityAction === "renew") {
        const rate = fdRateFor(d.tenureMonths);
        const calc = calcDeposit(maturityValue, d.tenureMonths, rate, d.payoutType);
        const newRef = depCol.doc();
        const newId = generateFdId();
        renewDoc = {
          ref: newRef,
          data: {
            fdId: newId,
            accountNumber: d.accountNumber,
            customerName: d.customerName,
            principal: round2(maturityValue),
            rate,
            tenureMonths: d.tenureMonths,
            payoutType: d.payoutType,
            maturityAction: d.maturityAction,
            monthlyInterest: calc.monthlyInterest,
            totalInterest: calc.totalInterest,
            maturityAmount: calc.maturityAmount,
            interestPaid: 0,
            interestPaidMonths: 0,
            status: "active",
            renewedFrom: d.fdId,
            startDate: firebase.firestore.Timestamp.fromDate(mat),
            maturityDate: firebase.firestore.Timestamp.fromDate(addMonths(mat, d.tenureMonths)),
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          }
        };
        update.renewedTo = newId;
      } else {
        credit += maturityValue;
        txns.push({ amount: maturityValue, note: `Fixed Deposit matured · ${d.fdId}` });
      }
    }

    if (!txns.length && !renewDoc && !Object.keys(update).length) return;

    if (credit > 0) {
      const bal = cSnap.data().balance || 0;
      tx.update(custRef, { balance: Number((bal + credit).toFixed(2)) });
    }
    txns.forEach(t => tx.set(txnCol.doc(), buildBankTxnForMe("credit", t.amount, t.note)));
    if (renewDoc) tx.set(renewDoc.ref, renewDoc.data);
    tx.update(depRef, update);
  });
}

/* ---------------- Page navigation ---------------- */

function openDepositsPage() {
  showFdList();
  document.getElementById("depositsPage").classList.add("show");
}

function closeDepositsPage() {
  document.getElementById("depositsPage").classList.remove("show");
  currentFdId = null;
  fdPendingOpen = null;
}

function fdShowView(which) {
  ["fdListView", "fdNewView", "fdDetailView", "fdMpinView"].forEach(id => {
    document.getElementById(id).style.display = id === which ? "block" : "none";
  });
  const titles = { fdListView: "Fixed Deposit", fdNewView: "New Fixed Deposit", fdDetailView: "Deposit details", fdMpinView: "Confirm with mPIN" };
  document.getElementById("depositsTitle").textContent = titles[which];
}

function depositsBack() {
  if (document.getElementById("fdMpinView").style.display !== "none") { fdMpinCancel(); return; }
  if (document.getElementById("fdListView").style.display === "none") { showFdList(); return; }
  closeDepositsPage();
}

function showFdList() {
  currentFdId = null;
  fdShowView("fdListView");
  renderDepositsPage();
}

/* ---------------- List + detail rendering ---------------- */

function fdStatusInfo(d) {
  if (d.status === "active") return { cls: "active", label: "Active" };
  if (d.status === "matured") return { cls: "closed", label: "Matured" };
  return { cls: "closed", label: "Closed early" };
}

function renderDepositsPage() {
  // keep whichever sub-view is open fresh
  if (document.getElementById("fdDetailView").style.display !== "none" && currentFdId) {
    renderFdDetail();
  }
  if (document.getElementById("fdListView").style.display === "none") return;

  const active = myDeposits.filter(d => d.status === "active");
  const total = active.reduce((s, d) => s + (d.principal || 0), 0);
  document.getElementById("fdTotalInvested").textContent = formatMoney(total);
  document.getElementById("fdActiveCount").textContent = active.length;

  const senior = isSeniorCitizen(currentCustomer && currentCustomer.dob);
  document.getElementById("fdRateTable").innerHTML = FD_RATES.map(r =>
    `<div class="row"><span>${escapeHtml(r.label)}</span><span>${fdRateFor(r.months).toFixed(2)}%</span></div>`
  ).join("");
  document.getElementById("fdRateNote").textContent = senior
    ? "Rates include the extra 0.50% for senior citizens."
    : "Senior citizens (60+) earn an extra 0.50%.";

  const list = document.getElementById("myDepositsList");
  if (!myDeposits.length) {
    list.innerHTML = '<div class="empty-state" style="padding:16px 0;">You have no Fixed Deposits yet.</div>';
    return;
  }
  list.innerHTML = myDeposits.map(d => {
    const st = fdStatusInfo(d);
    return `
      <button type="button" class="fd-row" onclick="openFdDetail('${d.id}')">
        <div>
          <div class="name">₹${formatMoney(d.principal)}</div>
          <div class="meta">${escapeHtml(d.fdId)} · ${escapeHtml(fdTenureLabel(d.tenureMonths))} · ${Number(d.rate).toFixed(2)}%</div>
          <div class="meta">Matures ${fdFormatDate(fdDate(d.maturityDate))}</div>
        </div>
        <div class="right"><span class="pill ${st.cls}">${st.label}</span></div>
      </button>`;
  }).join("");
}

function openFdDetail(id) {
  currentFdId = id;
  fdShowView("fdDetailView");
  renderFdDetail();
}

function renderFdDetail() {
  const d = myDeposits.find(x => x.id === currentFdId);
  if (!d) { showFdList(); return; }
  const now = new Date();
  const st = fdStatusInfo(d);
  const pill = document.getElementById("fdDetStatus");
  pill.className = "pill " + st.cls;
  pill.textContent = st.label;

  document.getElementById("fdDetId").textContent = d.fdId;
  document.getElementById("fdDetPrincipal").textContent = formatMoney(d.principal);
  document.getElementById("fdDetSub").textContent =
    `${fdTenureLabel(d.tenureMonths)} at ${Number(d.rate).toFixed(2)}% per year`;

  const rows = [];
  const row = (k, v) => rows.push(`<div class="row"><span>${k}</span><span>${v}</span></div>`);
  row("Deposit date", fdFormatDate(fdDate(d.startDate)));
  row("Maturity date", fdFormatDate(fdDate(d.maturityDate)));
  row("Interest option", d.payoutType === "monthly" ? "Monthly payout" : "Cumulative (quarterly compounding)");
  row("On maturity", d.maturityAction === "renew" ? "Auto-renew" : "Credit to account");
  if (d.payoutType === "monthly") {
    row("Monthly interest", "₹" + formatMoney(d.monthlyInterest));
    row("Interest received so far", "₹" + formatMoney(d.interestPaid || 0));
  } else if (d.status === "active") {
    const start = fdDate(d.startDate);
    const years = Math.max(0, (now - start) / DAY_MS) / 365;
    const accrued = d.principal * (Math.pow(1 + d.rate / 400, 4 * years) - 1);
    row("Interest accrued till today", "₹" + formatMoney(Math.min(accrued, d.totalInterest)));
  }
  row("Total interest at maturity", "₹" + formatMoney(d.totalInterest));
  row("Maturity amount", "₹" + formatMoney(d.maturityAmount));
  if (d.status === "closed") {
    row("Closed on", fdFormatDate(fdDate(d.closedAt)));
    row("Amount paid to you", "₹" + formatMoney(d.closedPayout || 0));
  }
  if (d.status === "matured") {
    row("Matured on", fdFormatDate(fdDate(d.maturedAt)));
    if (d.renewedTo) row("Renewed as", escapeHtml(d.renewedTo));
  }
  if (d.renewedFrom) row("Renewed from", escapeHtml(d.renewedFrom));
  document.getElementById("fdDetRows").innerHTML = rows.join("");

  const actions = document.getElementById("fdDetActions");
  const note = document.getElementById("fdDetClosureNote");
  if (d.status === "active") {
    actions.style.display = "block";
    const c = calcPrematureClosure(d, now);
    note.textContent = c.elapsedDays < FD_MIN_DAYS_FOR_INTEREST
      ? `If you close today you get ₹${formatMoney(c.payout)} back, with no interest because the deposit is under ${FD_MIN_DAYS_FOR_INTEREST} days old.`
      : `If you close today you get ₹${formatMoney(c.payout)} back, with interest at ${c.penaltyRate.toFixed(2)}% (1% below the contracted rate).`;
  } else {
    actions.style.display = "none";
    note.textContent = "";
  }
}


/* ---------------- mPIN step (open + close) ---------------- */

function goToFdMpinStep(mode) {
  hideAlert("fdAlert");
  hideAlert("fdMpinAlert");
  document.getElementById("fdMpin").value = "";
  fdMpinMode = mode;

  if (mode === "open") {
    const principal = parseFloat(document.getElementById("fdAmount").value);
    const months = parseInt(document.getElementById("fdTenure").value, 10);
    if (!principal || principal < FD_MIN_AMOUNT) {
      showAlert("fdAlert", `Minimum deposit is ₹${formatMoney(FD_MIN_AMOUNT)}.`);
      return;
    }
    if (!Number.isInteger(principal)) {
      showAlert("fdAlert", "Enter a whole rupee amount.");
      return;
    }
    if (principal > currentCustomer.balance) {
      showAlert("fdAlert", "Insufficient balance.");
      return;
    }
    fdPendingOpen = {
      principal,
      months,
      payoutType: document.getElementById("fdPayout").value,
      maturityAction: document.getElementById("fdMaturityAction").value
    };
    document.getElementById("fdMpinText").innerHTML =
      `Enter your mPIN to open a <strong style="color:var(--text);">${escapeHtml(fdTenureLabel(months))}</strong> Fixed Deposit of ₹<strong style="color:var(--text);">${formatMoney(principal)}</strong>. The amount is deducted from your balance now.`;
    document.getElementById("fdMpinBtn").textContent = "Confirm and open deposit";
  } else {
    const d = myDeposits.find(x => x.id === currentFdId);
    if (!d) return;
    const c = calcPrematureClosure(d, new Date());
    document.getElementById("fdMpinText").innerHTML =
      `Enter your mPIN to close <strong style="color:var(--text);">${escapeHtml(d.fdId)}</strong> before maturity. You will receive ₹<strong style="color:var(--text);">${formatMoney(c.payout)}</strong> in your account. This cannot be undone.`;
    document.getElementById("fdMpinBtn").textContent = "Confirm and close deposit";
  }
  fdShowView("fdMpinView");
}

function fdMpinCancel() {
  hideAlert("fdMpinAlert");
  if (fdMpinMode === "close" && currentFdId) { openFdDetail(currentFdId); return; }
  fdShowView("fdNewView");
}

async function submitFdMpin() {
  hideAlert("fdMpinAlert");
  const mpin = document.getElementById("fdMpin").value.trim();
  if (!/^\d{4}$/.test(mpin)) {
    showAlert("fdMpinAlert", "Enter your 4 digit mPIN.");
    return;
  }

  const btn = document.getElementById("fdMpinBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying…';

  try {
    const mpinHash = await sha256(mpin);
    if (mpinHash !== currentCustomer.mpinHash) {
      showAlert("fdMpinAlert", "Incorrect mPIN.");
      return;
    }

    if (fdMpinMode === "open") {
      const result = await runOpenDeposit(fdPendingOpen);
      fdPendingOpen = null;
      showFdList();
      showFdSuccess("Fixed Deposit opened", result.principal, "Matures on " + fdFormatDate(result.maturity), result.fdId);
    } else {
      const result = await runCloseDeposit(currentFdId);
      showFdList();
      showFdSuccess("Deposit closed", result.payout, "Credited to your account", result.fdId);
    }
  } catch (err) {
    console.error(err);
    showAlert("fdMpinAlert", err.message || "Something went wrong. Please try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function showFdSuccess(title, amount, line, fdId) {
  document.getElementById("tickTitle").textContent = title;
  document.getElementById("tickAmt").textContent = "₹" + formatMoney(amount);
  document.getElementById("tickTo").textContent = line;
  document.getElementById("tickTxnId").textContent = "Deposit number: " + fdId;
  document.getElementById("tickDate").textContent = formatFriendlyDateTime(new Date());
  document.getElementById("paySuccessPage").classList.add("show");
}

async function runOpenDeposit(p) {
  const custRef = db.collection("customers").doc(currentCustomer.accountNumber);
  const depRef = db.collection("deposits").doc();
  const txnRef = db.collection("transactions").doc();
  const fdId = generateFdId();
  const start = new Date();
  const maturity = addMonths(start, p.months);
  const rate = fdRateFor(p.months);
  const calc = calcDeposit(p.principal, p.months, rate, p.payoutType);

  await db.runTransaction(async (tx) => {
    const cSnap = await tx.get(custRef);
    if (!cSnap.exists) throw new Error("Account not found.");
    const bal = cSnap.data().balance || 0;
    if (bal < p.principal) throw new Error("Insufficient balance.");

    tx.update(custRef, { balance: Number((bal - p.principal).toFixed(2)) });
    tx.set(txnRef, buildBankTxnForMe("debit", p.principal, `Fixed Deposit opened · ${fdId}`));
    tx.set(depRef, {
      fdId,
      accountNumber: currentCustomer.accountNumber,
      customerName: currentCustomer.name,
      principal: round2(p.principal),
      rate,
      tenureMonths: p.months,
      payoutType: p.payoutType,
      maturityAction: p.maturityAction,
      monthlyInterest: calc.monthlyInterest,
      totalInterest: calc.totalInterest,
      maturityAmount: calc.maturityAmount,
      interestPaid: 0,
      interestPaidMonths: 0,
      status: "active",
      startDate: firebase.firestore.Timestamp.fromDate(start),
      maturityDate: firebase.firestore.Timestamp.fromDate(maturity),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });

  return { fdId, principal: p.principal, maturity };
}

async function runCloseDeposit(depId) {
  const custRef = db.collection("customers").doc(currentCustomer.accountNumber);
  const depRef = db.collection("deposits").doc(depId);
  const txnRef = db.collection("transactions").doc();
  let result = null;

  await db.runTransaction(async (tx) => {
    const dSnap = await tx.get(depRef);
    const cSnap = await tx.get(custRef);
    if (!dSnap.exists || !cSnap.exists) throw new Error("Deposit not found.");
    const d = dSnap.data();
    if (d.status !== "active") throw new Error("This deposit is no longer active.");

    const now = new Date();
    if (now >= fdDate(d.maturityDate)) {
      throw new Error("This deposit has matured. It will be settled automatically.");
    }
    const c = calcPrematureClosure(d, now);
    const bal = cSnap.data().balance || 0;

    tx.update(custRef, { balance: Number((bal + c.payout).toFixed(2)) });
    if (c.payout > 0) {
      tx.set(txnRef, buildBankTxnForMe("credit", c.payout, `Fixed Deposit closed early · ${d.fdId}`));
    }
    tx.update(depRef, {
      status: "closed",
      closedAt: firebase.firestore.Timestamp.fromDate(now),
      closedPayout: c.payout
    });
    result = { fdId: d.fdId, payout: c.payout };
  });

  return result;
}
