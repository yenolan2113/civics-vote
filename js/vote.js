// 學生投票頁：不用登入，系統自動給這台裝置一個匿名身分，用來防止同一輪重複投票。
import { configured, auth, db, el } from "./firebase-init.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  collection, query, where, limit, getDocs, doc, getDoc, setDoc, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const stage = document.getElementById("stage");
const code = (new URLSearchParams(location.search).get("c") || "").trim().toUpperCase();

let uid = null;
let pollId = null;
let poll = null;
let selected = null;      // 目前點選、尚未送出的選項
let sending = false;
let seat = "";            // 記座號的題目才會用到
let editingSeat = false;
const myVotes = {};       // { 1: 選項編號, 2: 選項編號 }；undefined 代表還沒查過

function seatKey() { return "civics-vote-seat-" + pollId; }
function recallSeat() {
  try { return localStorage.getItem(seatKey()) || ""; } catch { return ""; }
}
function rememberSeat(value) {
  try { localStorage.setItem(seatKey(), value); } catch { /* 無痕模式等情況下略過 */ }
}

function message(text, extra) {
  stage.replaceChildren(el("p", { class: "big-status", text }), extra ?? "");
}

function roundName(round) {
  return round === 2 ? "第二輪（討論後）" : "第一輪";
}

function centered(text) {
  return el("p", { class: "muted", style: "text-align:center", text });
}

// 老師公布正確答案後才會出現
function answerNote(myOption) {
  if (poll.answer == null) return null;
  const lines = [el("p", { class: "big-status", text: `正確答案：${poll.options[poll.answer]}` })];
  if (myOption != null) {
    lines.push(centered(myOption === poll.answer ? "你答對了。" : "你這一輪選的不是這個答案。"));
  }
  return el("div", { class: "answer-note" }, ...lines);
}

function seatForm() {
  const input = el("input", { type: "text", inputmode: "numeric", maxlength: "2", class: "code-input", placeholder: "座號" });
  input.value = seat;
  const error = el("p", { class: "error", style: "text-align:center" });
  const form = el("form", {
    onsubmit: (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!/^[0-9]{1,2}$/.test(value) || Number(value) < 1) {
        error.textContent = "請輸入 1 到 99 的座號";
        return;
      }
      seat = String(Number(value));
      rememberSeat(seat);
      editingSeat = false;
      render();
    },
  },
    el("p", { text: "這一題需要座號。請輸入你的座號（不用寫名字）。" }),
    input,
    el("p"),
    el("button", { class: "primary", type: "submit", style: "width:100%", text: "確定" }),
    error);
  return form;
}

function render() {
  if (!poll) return;
  const round = poll.round;
  const header = [
    el("span", { class: poll.open ? "badge" : "badge closed", text: `${roundName(round)}・${poll.open ? "投票中" : "已暫停"}` }),
    el("h1", { text: poll.question }),
  ];

  if (myVotes[round] === undefined) {
    stage.replaceChildren(...header, centered("確認中…"));
    return;
  }

  if (myVotes[round] !== null) {
    stage.replaceChildren(
      ...header,
      el("p", { class: "big-status", text: "已收到你的選擇" }),
      centered(`你選的是：${poll.options[myVotes[round]]}`),
      answerNote(myVotes[round]) ?? centered("請看老師的投影畫面。如果老師開始下一輪，這個頁面會自動更新。"),
    );
    return;
  }

  if (!poll.open) {
    stage.replaceChildren(...header,
      el("p", { class: "big-status", text: "投票目前沒有開放，請等老師" }),
      answerNote(null) ?? "");
    return;
  }

  if (poll.identify && (!seat || editingSeat)) {
    stage.replaceChildren(...header, seatForm());
    return;
  }

  const choices = poll.options.map((text, index) =>
    el("button", {
      class: index === selected ? "choice selected" : "choice",
      type: "button",
      text,
      onclick: () => { selected = index; render(); },
    }));
  const submit = el("button", {
    class: "primary",
    type: "button",
    style: "width:100%",
    text: sending ? "送出中…" : "送出",
    onclick: submitVote,
  });
  submit.disabled = selected === null || sending;

  const seatLine = poll.identify
    ? el("p", { class: "muted" }, `座號 ${seat}　`,
        el("button", { class: "small", type: "button", text: "更改", onclick: () => { editingSeat = true; render(); } }))
    : null;

  stage.replaceChildren(
    ...header,
    seatLine ?? "",
    ...choices,
    submit,
    el("p", { class: "muted", style: "text-align:center;margin-top:10px", text: poll.identify ? "老師會看到你的座號和選擇。送出後不能更改。" : "匿名投票，送出後不能更改。" }),
  );
}

async function submitVote() {
  if (selected === null || sending) return;
  const round = poll.round;
  const option = selected;
  sending = true;
  render();
  try {
    const vote = { uid, round, option, at: serverTimestamp() };
    if (poll.identify) vote.seat = seat;
    await setDoc(doc(db, "polls", pollId, "votes", `${uid}_r${round}`), vote);
    myVotes[round] = option;
  } catch (error) {
    console.error(error);
    await loadMyVote(round);
    if (myVotes[round] === null) alert("送出失敗，可能是投票剛好結束或網路不穩，請再試一次。");
  }
  sending = false;
  selected = null;
  render();
}

async function loadMyVote(round) {
  try {
    const snap = await getDoc(doc(db, "polls", pollId, "votes", `${uid}_r${round}`));
    myVotes[round] = snap.exists() ? snap.data().option : null;
  } catch (error) {
    console.error(error);
    myVotes[round] = null;
  }
}

async function start() {
  const found = await getDocs(query(collection(db, "polls"), where("code", "==", code), limit(1)));
  if (found.empty) {
    message(`找不到代碼「${code}」`, centered("請對照投影畫面再輸入一次。"));
    return;
  }
  pollId = found.docs[0].id;
  seat = recallSeat();
  onSnapshot(doc(db, "polls", pollId), async (snap) => {
    if (!snap.exists()) { message("這一題已經被老師刪除"); return; }
    const previousRound = poll?.round;
    poll = snap.data();
    if (poll.round !== previousRound) selected = null;
    render();
    if (myVotes[poll.round] === undefined) {
      await loadMyVote(poll.round);
      render();
    }
  }, (error) => {
    console.error(error);
    message("連線中斷，請重新整理頁面");
  });
}

if (!configured) {
  message("系統尚未完成設定", centered("請老師先完成 Firebase 設定。"));
} else if (!code) {
  location.replace("index.html");
} else {
  let started = false;
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      signInAnonymously(auth).catch((error) => {
        console.error(error);
        message("無法連線，請檢查網路後重新整理");
      });
      return;
    }
    uid = user.uid;
    if (!started) {
      started = true;
      start().catch((error) => {
        console.error(error);
        message("載入失敗，請重新整理頁面");
      });
    }
  });
}
