// 老師頁：登入、題庫、分班投票、投影即時結果、兩輪對照、正確答案、座號明細、匯出。
import { configured, auth, db, el } from "./firebase-init.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  collection, query, where, limit, getDocs, getDoc, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["v-loading", "v-missing", "v-login", "v-home", "v-live"];
function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
}

// 房間代碼不使用容易看錯的 0/O、1/I/L（構想參考自原作品）
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const CLASS_KEY = "civics-vote-class";
const NO_CLASS = "未指定班級";
const NO_UNIT = "未分類";

let user = null;
let bank = [];          // 題庫
let records = [];       // 投票紀錄（每一筆是某一班對某一題的一場投票）
let pollId = null;
let poll = null;
let votes = [];
let showResults = false;
let showSeats = false;
let unsubscribePoll = null;
let unsubscribeVotes = null;

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 無痕模式等情況下略過 */ }
}
function recall(key) {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function byNewest(a, b) {
  return (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);
}
function shortDate(timestamp) {
  const date = timestamp?.toDate?.();
  return date ? date.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" }) : "";
}

/* ---------- 出題表單 ---------- */

function addOptionRow(value = "", correct = false) {
  const box = $("opts");
  if (box.children.length >= MAX_OPTIONS) return;
  const radio = el("input", { type: "radio", name: "correct", title: "設為正確答案", "aria-label": "設為正確答案" });
  radio.checked = correct;
  const input = el("input", { type: "text", maxlength: "60", placeholder: `選項 ${box.children.length + 1}` });
  input.value = value;
  const row = el("div", { class: "opt-row" }, radio, input,
    el("button", {
      class: "small", type: "button", text: "移除",
      onclick: () => { if (box.children.length > MIN_OPTIONS) row.remove(); },
    }));
  box.append(row);
}

function setOptions(values, correct = null) {
  $("opts").replaceChildren();
  values.forEach((value, index) => addOptionRow(value, index === correct));
}

function resetForm() {
  $("q").value = "";
  $("identify").checked = false;
  setOptions(["", ""]);
}

// 讀取表單；有問題時顯示訊息並回傳 null
function readForm() {
  $("form-error").textContent = "";
  const question = $("q").value.trim();
  const filled = [...$("opts").children]
    .map((row) => ({
      text: row.querySelector('input[type="text"]').value.trim(),
      correct: row.querySelector('input[type="radio"]').checked,
    }))
    .filter((item) => item.text);
  const options = filled.map((item) => item.text);
  const correctIndex = filled.findIndex((item) => item.correct);

  if (!question) { $("form-error").textContent = "請輸入題目"; return null; }
  if (options.length < MIN_OPTIONS) { $("form-error").textContent = "至少要有 2 個選項"; return null; }
  if (new Set(options).size !== options.length) { $("form-error").textContent = "選項不能重複"; return null; }
  return {
    unit: $("unit").value.trim(),
    question,
    options,
    correct: correctIndex >= 0 ? correctIndex : null,
    identify: $("identify").checked,
  };
}

/* ---------- 題庫 ---------- */

async function saveToBank() {
  const data = readForm();
  if (!data) return;
  $("btn-save-bank").disabled = true;
  try {
    await addDoc(collection(db, "questions"), { ownerUid: user.uid, ...data, createdAt: serverTimestamp() });
    resetForm();
    await loadHome();
  } catch (error) {
    console.error(error);
    $("form-error").textContent = "儲存失敗：" + (error.code || error.message);
  }
  $("btn-save-bank").disabled = false;
}

async function deleteBankQuestion(item) {
  if (!confirm(`確定要從題庫刪除這一題嗎？\n\n${item.question}\n\n已經做過的投票紀錄不受影響。刪除後無法復原。`)) return;
  await deleteDoc(doc(db, "questions", item.id));
  await loadHome();
}

function renderBank() {
  const box = $("bank");
  box.replaceChildren();
  $("bank-empty").hidden = bank.length > 0;

  const units = new Map();
  for (const item of bank) {
    const unit = item.unit || NO_UNIT;
    if (!units.has(unit)) units.set(unit, []);
    units.get(unit).push(item);
  }
  for (const [unit, items] of units) {
    const list = el("ul", { class: "poll-list" });
    for (const item of items) {
      list.append(el("li", {},
        el("span", { class: "q", text: item.question }),
        item.correct != null ? el("span", { class: "tag", text: "有答案" }) : null,
        item.identify ? el("span", { class: "tag", text: "記座號" }) : null,
        el("button", { class: "small primary", type: "button", text: "開始投票", onclick: () => startPoll(item) }),
        el("button", { class: "small", type: "button", text: "刪除", onclick: () => deleteBankQuestion(item).catch(reportHomeError) }),
      ));
    }
    box.append(el("h3", { class: "unit", text: unit }), list);
  }

  $("unit-list").replaceChildren(...[...units.keys()].filter((u) => u !== NO_UNIT).map((u) => el("option", { value: u })));
}

/* ---------- 開始一場投票 ---------- */

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

async function startPoll(data) {
  $("form-error").textContent = "";
  const classLabel = $("class-label").value.trim();
  if (!classLabel && !confirm("還沒有填「目前班級」。要以「未指定班級」開始投票嗎？")) return false;
  try {
    const created = await addDoc(collection(db, "polls"), {
      ownerUid: user.uid,
      code: await unusedCode(),
      question: data.question,
      options: data.options,
      round: 1,
      open: true,
      createdAt: serverTimestamp(),
      classLabel,
      unit: data.unit || "",
      identify: Boolean(data.identify),
      hasAnswer: data.correct != null,
      answer: null,
    });
    // 正確答案另外存在只有老師讀得到的地方，公布之前學生端拿不到
    if (data.correct != null) {
      await setDoc(doc(db, "polls", created.id, "secret", "answer"), { correct: data.correct });
    }
    openPoll(created.id);
    return true;
  } catch (error) {
    console.error(error);
    $("form-error").textContent = "建立失敗：" + (error.code || error.message);
    return false;
  }
}

async function startFromForm() {
  const data = readForm();
  if (!data) return;
  $("btn-start-now").disabled = true;
  if (await startPoll(data)) resetForm();
  $("btn-start-now").disabled = false;
}

/* ---------- 首頁：題庫與紀錄 ---------- */

function reportHomeError(error) {
  console.error(error);
  $("form-error").textContent = "操作失敗：" + (error.code || error.message);
}

async function loadHome() {
  const mine = (name) => getDocs(query(collection(db, name), where("ownerUid", "==", user.uid)));
  const [questionSnap, pollSnap] = await Promise.all([mine("questions"), mine("polls")]);
  bank = questionSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNewest).reverse();
  records = pollSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNewest);

  const classes = [...new Set(records.map((r) => r.classLabel).filter(Boolean))].sort();
  $("class-list").replaceChildren(...classes.map((c) => el("option", { value: c })));

  const filter = $("filter-class");
  const previous = filter.value;
  filter.replaceChildren(el("option", { value: "", text: "全部班級" }), ...classes.map((c) => el("option", { value: c, text: c })));
  if (records.some((r) => !r.classLabel)) filter.append(el("option", { value: NO_CLASS, text: NO_CLASS }));
  filter.value = [...filter.options].some((o) => o.value === previous) ? previous : "";

  renderBank();
  renderRecords();
}

function renderRecords() {
  const list = $("records");
  list.replaceChildren();
  const filter = $("filter-class").value;
  const shown = records.filter((r) => !filter || (r.classLabel || NO_CLASS) === filter);
  $("records-empty").hidden = shown.length > 0;
  for (const item of shown) {
    list.append(el("li", {},
      el("span", { class: "tag", text: item.classLabel || NO_CLASS }),
      el("span", { class: "q", text: item.question }),
      el("span", { class: "muted", text: shortDate(item.createdAt) }),
      el("span", { class: item.open ? "badge" : "badge closed", text: item.open ? `投票中・${item.code}` : "已暫停" }),
      el("button", { class: "small", type: "button", text: "開啟", onclick: () => openPoll(item.id) }),
      el("button", { class: "small", type: "button", text: "匯出", onclick: () => exportPoll(item.id, item).catch(reportHomeError) }),
      el("button", { class: "small", type: "button", text: "刪除", onclick: () => deletePoll(item).catch(reportHomeError) }),
    ));
  }
}

async function deletePoll(item) {
  const label = item.classLabel || NO_CLASS;
  if (!confirm(`確定要刪除這場投票和它的所有票嗎？\n\n${label}：${item.question}\n\n刪除後無法復原，建議先匯出。`)) return;
  const voteSnap = await getDocs(collection(db, "polls", item.id, "votes"));
  await Promise.all(voteSnap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, "polls", item.id, "secret", "answer"));
  await deleteDoc(doc(db, "polls", item.id));
  await loadHome();
}

/* ---------- 統計 ---------- */

function tally(pollData, voteList, round) {
  const counts = pollData.options.map(() => 0);
  let total = 0;
  for (const vote of voteList) {
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

// 同一台裝置兩輪都有投的人當中，有幾個人換了選項
function changedCount(voteList) {
  const first = new Map();
  const second = new Map();
  for (const vote of voteList) (vote.round === 2 ? second : first).set(vote.uid, vote.option);
  let both = 0;
  let changed = 0;
  for (const [uid, option] of second) {
    if (!first.has(uid)) continue;
    both++;
    if (first.get(uid) !== option) changed++;
  }
  return { both, changed };
}

// 依座號整理兩輪的選擇；同一個座號被不同裝置使用時標記為重複
function seatRows(pollData, voteList) {
  const seats = new Map();
  for (const vote of voteList) {
    if (!vote.seat) continue;
    const key = String(Number(vote.seat));
    if (!seats.has(key)) seats.set(key, { seat: key, r1: [], r2: [], devices: new Set() });
    const row = seats.get(key);
    (vote.round === 2 ? row.r2 : row.r1).push(pollData.options[vote.option] ?? "");
    row.devices.add(vote.uid);
  }
  return [...seats.values()]
    .sort((a, b) => Number(a.seat) - Number(b.seat))
    .map((row) => ({
      seat: row.seat,
      first: row.r1.join("／"),
      second: row.r2.join("／"),
      duplicate: row.devices.size > 1,
    }));
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
  showSeats = false;
  $("live-error").textContent = "";
  const fail = (error) => {
    console.error(error);
    $("live-error").textContent = "連線發生問題：" + (error.code || error.message);
  };
  unsubscribePoll = onSnapshot(doc(db, "polls", id), (snap) => {
    if (!snap.exists()) { backHome(); return; }
    poll = snap.data();
    show("v-live");
    renderLive();
  }, fail);
  unsubscribeVotes = onSnapshot(collection(db, "polls", id, "votes"), (snap) => {
    votes = snap.docs.map((d) => d.data());
    renderLive();
  }, fail);
}

function backHome() {
  closePoll();
  show("v-home");
  loadHome().catch(reportHomeError);
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

function renderLive() {
  if (!poll) return;
  const joinUrl = new URL("vote.html?c=" + poll.code, location.href).href;
  const revealed = poll.answer != null;

  $("live-badge").textContent = `${poll.round === 2 ? "第二輪（討論後）" : "第一輪"}・${poll.open ? "投票中" : "已暫停"}`;
  $("live-badge").className = poll.open ? "badge" : "badge closed";
  $("live-class").textContent = poll.classLabel || NO_CLASS;
  $("live-q").textContent = poll.question;
  $("live-code").textContent = poll.code;
  $("live-url").textContent = new URL("index.html", location.href).href;

  if ($("qr").dataset.url !== joinUrl) {
    const qr = qrcode(0, "M");
    qr.addData(joinUrl);
    qr.make();
    $("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $("qr").dataset.url = joinUrl;
  }

  const first = tally(poll, votes, 1);
  const second = tally(poll, votes, 2);
  const current = poll.round === 2 ? second : first;
  $("live-count").textContent = `本輪已有 ${current.total} 人投票${poll.identify ? "（記座號）" : "（匿名）"}`;

  $("btn-open").textContent = poll.open ? "暫停投票" : "重新開放投票";
  $("btn-round2").hidden = poll.round !== 1;
  $("btn-results").textContent = showResults ? "隱藏結果" : "顯示結果";
  $("btn-answer").hidden = !poll.hasAnswer;
  $("btn-answer").textContent = revealed ? "收回正確答案" : "公布正確答案";
  $("btn-seats").hidden = !poll.identify;
  $("btn-seats").textContent = showSeats ? "收起座號明細" : "座號明細";

  const results = $("results");
  results.replaceChildren();
  if (!showResults) {
    results.append(el("p", { class: "muted", text: "結果目前隱藏中，避免影響還沒投票的同學。按下方「顯示結果」公布。" }));
  } else {
    poll.options.forEach((text, index) => {
      const isAnswer = revealed && poll.answer === index;
      const block = el("div", { class: isAnswer ? "result correct" : "result" },
        el("div", { class: "result-label", text: isAnswer ? `${text}　✓ 正確答案` : text }));
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
      const { both, changed } = changedCount(votes);
      results.append(el("div", { class: "summary", text: `兩輪都有投票的 ${both} 人當中，有 ${changed} 人改變了選擇。` }));
    }
  }

  $("seat-card").hidden = !(poll.identify && showSeats);
  if (poll.identify && showSeats) {
    const rows = seatRows(poll, votes);
    const table = el("table", { class: "seats" },
      el("thead", {}, el("tr", {}, el("th", { text: "座號" }), el("th", { text: "第一輪" }), el("th", { text: "第二輪" }))),
      el("tbody", {}, ...rows.map((row) => el("tr", {},
        el("td", { text: row.duplicate ? `${row.seat}（多台裝置使用）` : row.seat }),
        el("td", { text: row.first }),
        el("td", { text: row.second })))));
    $("seat-table").replaceChildren(rows.length ? table : el("p", { class: "muted", text: "還沒有人投票。" }));
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

async function readCorrect(id) {
  const secret = await getDoc(doc(db, "polls", id, "secret", "answer"));
  return secret.exists() ? secret.data().correct : null;
}

async function toggleAnswer() {
  if (poll.answer != null) { await updatePoll({ answer: null }); return; }
  try {
    const correct = await readCorrect(pollId);
    if (correct == null) { $("live-error").textContent = "找不到這一題的正確答案"; return; }
    showResults = true;
    await updatePoll({ answer: correct });
  } catch (error) {
    console.error(error);
    $("live-error").textContent = "公布失敗：" + (error.code || error.message);
  }
}

/* ---------- 匯出 ---------- */

function csvLine(cells) {
  return cells.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",");
}

async function exportPoll(id, pollData) {
  const voteSnap = await getDocs(collection(db, "polls", id, "votes"));
  const voteList = voteSnap.docs.map((d) => d.data());
  const correct = pollData.hasAnswer ? await readCorrect(id) : null;
  const first = tally(pollData, voteList, 1);
  const second = tally(pollData, voteList, 2);
  const { both, changed } = changedCount(voteList);

  const lines = [
    csvLine(["班級", pollData.classLabel || NO_CLASS]),
    csvLine(["單元", pollData.unit || ""]),
    csvLine(["題目", pollData.question]),
    csvLine(["日期", shortDate(pollData.createdAt)]),
    csvLine(["作答方式", pollData.identify ? "記座號" : "匿名"]),
    "",
    csvLine(["選項", "第一輪票數", "第一輪比例", "第二輪票數", "第二輪比例", "正確答案"]),
    ...pollData.options.map((text, index) => csvLine([
      text,
      first.counts[index], percent(first.counts[index], first.total) + "%",
      second.counts[index], percent(second.counts[index], second.total) + "%",
      correct === index ? "✓" : "",
    ])),
    csvLine(["合計", first.total, "", second.total, "", ""]),
    "",
    csvLine(["兩輪都有投票的人數", both]),
    csvLine(["其中改變選擇的人數", changed]),
  ];
  if (pollData.identify) {
    lines.push("", csvLine(["座號", "第一輪", "第二輪", "備註"]));
    for (const row of seatRows(pollData, voteList)) {
      lines.push(csvLine([row.seat, row.first, row.second, row.duplicate ? "多台裝置使用同一座號" : ""]));
    }
  }

  // 開頭加上 BOM，Excel 才會正確顯示中文
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = el("a", { href: URL.createObjectURL(blob), download: `${pollData.classLabel || NO_CLASS}_${pollData.question.slice(0, 20)}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

/* ---------- 啟動 ---------- */

if (!configured) {
  show("v-missing");
} else {
  setOptions(["", ""]);
  $("class-label").value = recall(CLASS_KEY);
  $("class-label").addEventListener("input", () => remember(CLASS_KEY, $("class-label").value.trim()));
  $("question-form").addEventListener("submit", (event) => event.preventDefault());
  $("btn-start-now").addEventListener("click", startFromForm);
  $("btn-save-bank").addEventListener("click", saveToBank);
  $("btn-add-opt").addEventListener("click", () => addOptionRow());
  $("btn-clear-correct").addEventListener("click", () =>
    $("opts").querySelectorAll('input[type="radio"]').forEach((radio) => { radio.checked = false; }));
  document.querySelectorAll("[data-preset]").forEach((button) =>
    button.addEventListener("click", () => setOptions(button.dataset.preset.split("|"))));
  $("filter-class").addEventListener("change", renderRecords);

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
    if (confirm("開始第二輪後，學生會看到同一題並重新投票；已公布的正確答案會先收回。確定開始嗎？")) {
      showResults = false;
      updatePoll({ round: 2, open: true, answer: null });
    }
  });
  $("btn-results").addEventListener("click", () => { showResults = !showResults; renderLive(); });
  $("btn-answer").addEventListener("click", toggleAnswer);
  $("btn-seats").addEventListener("click", () => { showSeats = !showSeats; renderLive(); });
  $("btn-export").addEventListener("click", () => exportPoll(pollId, poll).catch((error) => {
    console.error(error);
    $("live-error").textContent = "匯出失敗：" + (error.code || error.message);
  }));
  $("btn-back").addEventListener("click", backHome);

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
    show("v-home");
    loadHome().catch(reportHomeError);
  });
}
