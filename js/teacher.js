// 老師頁：登入、出題、投影即時結果、開第二輪並比較前後差異。
import { configured, auth, db, el } from "./firebase-init.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  collection, query, where, limit, getDocs, doc, addDoc, updateDoc, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["v-loading", "v-missing", "v-login", "v-create", "v-live"];
function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
}

// 房間代碼不使用容易看錯的 0/O、1/I/L（構想參考自原作品）
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

let user = null;
let pollId = null;
let poll = null;
let votes = [];
let showResults = false;
let unsubscribePoll = null;
let unsubscribeVotes = null;

/* ---------- 出題表單 ---------- */

function addOptionRow(value = "") {
  const box = $("opts");
  if (box.children.length >= MAX_OPTIONS) return;
  const input = el("input", { type: "text", maxlength: "60", placeholder: `選項 ${box.children.length + 1}` });
  input.value = value;
  const row = el("div", { class: "opt-row" }, input,
    el("button", {
      class: "small", type: "button", text: "移除", "aria-label": "移除這個選項",
      onclick: () => { if (box.children.length > MIN_OPTIONS) row.remove(); },
    }));
  box.append(row);
}

function setOptions(values) {
  $("opts").replaceChildren();
  values.forEach((value) => addOptionRow(value));
}

function randomCode(length) {
  let code = "";
  for (let i = 0; i < length; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

async function unusedCode() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode(4);
    const taken = await getDocs(query(collection(db, "polls"), where("code", "==", code), limit(1)));
    if (taken.empty) return code;
  }
  return randomCode(5);
}

async function createPoll(event) {
  event.preventDefault();
  $("create-error").textContent = "";
  const question = $("q").value.trim();
  const options = [...$("opts").querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
  if (!question) { $("create-error").textContent = "請輸入題目"; return; }
  if (options.length < MIN_OPTIONS) { $("create-error").textContent = "至少要有 2 個選項"; return; }
  if (new Set(options).size !== options.length) { $("create-error").textContent = "選項不能重複"; return; }

  $("btn-create").disabled = true;
  try {
    const created = await addDoc(collection(db, "polls"), {
      ownerUid: user.uid,
      code: await unusedCode(),
      question,
      options,
      round: 1,
      open: true,
      createdAt: serverTimestamp(),
    });
    $("q").value = "";
    setOptions(["", ""]);
    openPoll(created.id);
  } catch (error) {
    console.error(error);
    $("create-error").textContent = "建立失敗：" + (error.code || error.message);
  }
  $("btn-create").disabled = false;
}

async function loadMyPolls() {
  const list = $("my-polls");
  list.replaceChildren();
  const snap = await getDocs(query(collection(db, "polls"), where("ownerUid", "==", user.uid)));
  const mine = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
  $("my-polls-empty").hidden = mine.length > 0;
  for (const item of mine) {
    list.append(el("li", {},
      el("span", { class: "q", text: item.question }),
      el("span", { class: item.open ? "badge" : "badge closed", text: item.open ? `投票中・${item.code}` : "已結束" }),
      el("button", { class: "small", type: "button", text: "開啟", onclick: () => openPoll(item.id) }),
    ));
  }
}

/* ---------- 投影畫面 ---------- */

function closePoll() {
  unsubscribePoll?.();
  unsubscribeVotes?.();
  unsubscribePoll = unsubscribeVotes = null;
  pollId = null;
  poll = null;
  votes = [];
}

function openPoll(id) {
  closePoll();
  pollId = id;
  showResults = false;
  $("live-error").textContent = "";
  const fail = (error) => {
    console.error(error);
    $("live-error").textContent = "連線發生問題：" + (error.code || error.message);
  };
  unsubscribePoll = onSnapshot(doc(db, "polls", id), (snap) => {
    if (!snap.exists()) { backToList(); return; }
    poll = snap.data();
    show("v-live");
    renderLive();
  }, fail);
  unsubscribeVotes = onSnapshot(collection(db, "polls", id, "votes"), (snap) => {
    votes = snap.docs.map((d) => d.data());
    renderLive();
  }, fail);
}

function backToList() {
  closePoll();
  show("v-create");
  loadMyPolls().catch(console.error);
}

function tally(round) {
  const counts = poll.options.map(() => 0);
  let total = 0;
  for (const vote of votes) {
    if (vote.round === round && vote.option >= 0 && vote.option < counts.length) {
      counts[vote.option]++;
      total++;
    }
  }
  return { counts, total };
}

function percent(count, total) {
  return total ? Math.round((count / total) * 100) : 0;
}

function barLine(label, count, total, cssClass) {
  const fill = el("div", { class: `bar-fill ${cssClass}` });
  fill.style.width = percent(count, total) + "%";
  return el("div", { class: "bar-line" },
    el("span", { class: "muted", text: label }),
    el("div", { class: "bar-track" }, fill),
    el("span", { class: "bar-num", text: `${count} 票（${percent(count, total)}%）` }),
  );
}

// 同一台裝置兩輪都有投的人當中，有幾個人換了選項
function changedCount() {
  const first = new Map();
  const second = new Map();
  for (const vote of votes) (vote.round === 2 ? second : first).set(vote.uid, vote.option);
  let both = 0;
  let changed = 0;
  for (const [uid, option] of second) {
    if (!first.has(uid)) continue;
    both++;
    if (first.get(uid) !== option) changed++;
  }
  return { both, changed };
}

function renderLive() {
  if (!poll) return;
  const joinUrl = new URL("vote.html?c=" + poll.code, location.href).href;
  const homeUrl = new URL("index.html", location.href).href;

  $("live-badge").textContent = `${poll.round === 2 ? "第二輪（討論後）" : "第一輪"}・${poll.open ? "投票中" : "已暫停"}`;
  $("live-badge").className = poll.open ? "badge" : "badge closed";
  $("live-q").textContent = poll.question;
  $("live-code").textContent = poll.code;
  $("live-url").textContent = homeUrl;

  if ($("qr").dataset.url !== joinUrl) {
    const qr = qrcode(0, "M");
    qr.addData(joinUrl);
    qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $("qr").dataset.url = joinUrl;
  }

  const first = tally(1);
  const second = tally(2);
  const current = poll.round === 2 ? second : first;
  $("live-count").textContent = `本輪已有 ${current.total} 人投票`;

  $("btn-open").textContent = poll.open ? "暫停投票" : "重新開放投票";
  $("btn-round2").hidden = poll.round !== 1;
  $("btn-results").textContent = showResults ? "隱藏結果" : "顯示結果";

  const results = $("results");
  results.replaceChildren();
  if (!showResults) {
    results.append(el("p", { class: "muted", text: "結果目前隱藏中，避免影響還沒投票的同學。按下方「顯示結果」公布。" }));
    return;
  }

  poll.options.forEach((text, index) => {
    const block = el("div", { class: "result" }, el("div", { class: "result-label", text }));
    if (poll.round === 2) {
      block.append(barLine("討論前", first.counts[index], first.total, "before"));
      block.append(barLine("討論後", second.counts[index], second.total, ""));
      const diff = percent(second.counts[index], second.total) - percent(first.counts[index], first.total);
      if (second.total > 0) {
        block.append(el("div", {
          class: "delta " + (diff > 0 ? "up" : diff < 0 ? "down" : ""),
          text: diff === 0 ? "比例不變" : `${diff > 0 ? "增加" : "減少"} ${Math.abs(diff)} 個百分點`,
        }));
      }
    } else {
      block.append(barLine("票數", first.counts[index], first.total, ""));
    }
    results.append(block);
  });

  if (poll.round === 2) {
    const { both, changed } = changedCount();
    results.append(el("div", { class: "summary", text: `兩輪都有投票的 ${both} 人當中，有 ${changed} 人改變了選擇。` }));
  }
}

async function updatePoll(changes) {
  $("live-error").textContent = "";
  try {
    await updateDoc(doc(db, "polls", pollId), changes);
  } catch (error) {
    console.error(error);
    $("live-error").textContent = "更新失敗：" + (error.code || error.message);
  }
}

/* ---------- 啟動 ---------- */

if (!configured) {
  show("v-missing");
} else {
  setOptions(["", ""]);
  $("create-form").addEventListener("submit", createPoll);
  $("btn-add-opt").addEventListener("click", () => addOptionRow());
  document.querySelectorAll("[data-preset]").forEach((button) =>
    button.addEventListener("click", () => setOptions(button.dataset.preset.split("|"))));

  $("btn-login").addEventListener("click", async () => {
    $("login-error").textContent = "";
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      console.error(error);
      $("login-error").textContent = "登入失敗：" + (error.code || error.message);
    }
  });
  $("btn-logout").addEventListener("click", () => signOut(auth));

  $("btn-open").addEventListener("click", () => updatePoll({ open: !poll.open }));
  $("btn-round2").addEventListener("click", () => {
    if (confirm("開始第二輪後，學生會看到同一題並重新投票。確定開始嗎？")) {
      showResults = false;
      updatePoll({ round: 2, open: true });
    }
  });
  $("btn-results").addEventListener("click", () => { showResults = !showResults; renderLive(); });
  $("btn-back").addEventListener("click", backToList);

  onAuthStateChanged(auth, (current) => {
    closePoll();
    // 匿名身分是學生用的；老師必須是 Google 帳號
    if (!current || current.isAnonymous) {
      user = null;
      show("v-login");
      return;
    }
    user = current;
    $("who").textContent = current.email || "";
    show("v-create");
    loadMyPolls().catch(console.error);
  });
}
