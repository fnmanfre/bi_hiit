const STORAGE_KEY = "bi-hiit-config-v2";
const DEFAULT_COMPLETION_MESSAGE = "Treino concluído";
const DEFAULT_CONFIG = {
  theme: "dark",
  settings: { countdown: true, wakeLock: false, notifications: false },
  completionMessage: DEFAULT_COMPLETION_MESSAGE,
  workout: {
    name: "HIIT básico",
    rounds: 3,
    warmup: { name: "Aquecimento", minutes: 1, seconds: 0, color: "#5c8d89" },
    stages: [
      { name: "Exercício intenso", minutes: 0, seconds: 30, color: "#c46b5b" },
      { name: "Descanso", minutes: 0, seconds: 20, color: "#71839b" }
    ]
  }
};

const $ = (selector) => document.querySelector(selector);
const clone = (value) => JSON.parse(JSON.stringify(value));

let config = loadConfig();
let timer = { running: false, completed: false, stageIndex: -1, round: 1, remaining: 0, total: 0, interval: null };
let wakeLock = null;
let audioContext = null;
let serviceWorkerRegistration = null;
let mediaAudio = null;

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem("bi-hiit-config-v1"));
    if (!saved) return clone(DEFAULT_CONFIG);
    const workout = { ...DEFAULT_CONFIG.workout, ...saved.workout };
    if (!saved.workout.warmup && workout.stages[0]?.name?.toLowerCase() === "aquecimento") {
      workout.warmup = workout.stages.shift();
    }
    return {
      ...clone(DEFAULT_CONFIG),
      ...saved,
      completionMessage: saved.completionMessage || DEFAULT_COMPLETION_MESSAGE,
      settings: { ...DEFAULT_CONFIG.settings, ...saved.settings },
      workout
    };
  } catch {
    return clone(DEFAULT_CONFIG);
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function formatTime(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function totalStageSeconds(stage) {
  return Math.max(1, Number(stage.minutes || 0) * 60 + Number(stage.seconds || 0));
}

function renderEditor() {
  $("#workout-name").value = config.workout.name;
  $("#rounds-input").value = config.workout.rounds;
  $("#countdown-toggle").checked = config.settings.countdown;
  $("#wake-lock-toggle").checked = config.settings.wakeLock;
  $("#notifications-toggle").checked = config.settings.notifications;
  $("#completion-message-input").value = config.completionMessage;
  $("#warmup-editor").innerHTML = renderStageEditor(config.workout.warmup, "warmup");
  $("#stage-list").innerHTML = config.workout.stages.map((stage, index) => renderStageEditor(stage, index)).join("");
}

function renderStageEditor(stage, index) {
  const dataIndex = index === "warmup" ? "warmup" : index;
  return `
    <article class="stage-card" style="--stage-color:${stage.color}">
      <div class="stage-fields">
        <input class="text-input stage-name" data-index="${dataIndex}" maxlength="40" value="${escapeAttribute(stage.name)}" aria-label="Nome da etapa" />
        <input class="text-input stage-duration" data-index="${dataIndex}" type="number" min="1" max="3600" value="${totalStageSeconds(stage)}" aria-label="Duração da etapa em segundos" />
      </div>
      <div class="stage-tools">
        <input class="color-input stage-color" data-index="${dataIndex}" type="color" value="${stage.color}" aria-label="Cor da etapa" />
        ${index === "warmup" ? "" : `<button class="small-button remove" data-remove="${index}" type="button" aria-label="Remover etapa">×</button>`}
      </div>
    </article>
  `;
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderTimer() {
  const stages = config.workout.stages;
  const stage = timer.stageIndex === -1 ? config.workout.warmup : stages[timer.stageIndex];
  const hasWorkout = stages.length > 0;
  $("#timer-title").textContent = config.workout.name || "Treino HIIT";
  $("#time-display").textContent = formatTime(timer.remaining);
  $("#stage-name").textContent = stage?.name || "Configure um treino para começar";
  $("#stage-counter").textContent = timer.stageIndex === -1 ? "Aquecimento" : (hasWorkout ? `Etapa ${timer.stageIndex + 1} de ${stages.length}` : "Etapa 0 de 0");
  $("#round-counter").textContent = hasWorkout ? `Ciclo ${timer.round} de ${config.workout.rounds}` : "Ciclo 0 de 0";
  $("#timer-status").textContent = timer.completed ? "Concluído" : (timer.running ? "Em andamento" : "Parado");
  const startButton = $("#start-button");
  startButton.innerHTML = `<span aria-hidden="true">${timer.running ? "⏸" : "▶"}</span>`;
  startButton.setAttribute("aria-label", timer.running ? "Pausar" : (timer.remaining > 0 ? "Continuar" : "Começar"));
  startButton.title = timer.running ? "Pausar" : (timer.remaining > 0 ? "Continuar" : "Começar");
  $("#timer-card").style.setProperty("--stage-color", stage?.color || "var(--accent)");
  const progress = timer.total > 0 ? ((timer.total - timer.remaining) / timer.total) * 100 : 0;
  $("#progress-bar").style.width = `${Math.min(100, Math.max(0, progress))}%`;
  const next = timer.stageIndex === -1 ? stages[0] : (stages[timer.stageIndex + 1] || (timer.round < config.workout.rounds ? stages[0] : null));
  $("#next-stage").textContent = next ? `Próxima etapa: ${next.name}` : (hasWorkout ? "Treino concluído. Bom trabalho!" : "");
  $("#completion-message").hidden = !timer.completed;
  $("#completion-message-title").textContent = config.completionMessage;
  updateMediaSession();
}

function resetTimer() {
  clearInterval(timer.interval);
  pauseMediaAudio(true);
  timer = { running: false, completed: false, stageIndex: -1, round: 1, remaining: 0, total: 0, interval: null };
  renderTimer();
  releaseWakeLock();
  updateMediaSession();
}

function beginStage(index, round) {
  const stage = index === -1 ? config.workout.warmup : config.workout.stages[index];
  timer.stageIndex = index;
  timer.round = round;
  timer.total = totalStageSeconds(stage);
  timer.remaining = timer.total;
  announce(stage.name);
  notifyWorkout(config.workout.name || "BI HIIT", `Etapa: ${stage.name} · Ciclo ${round} de ${config.workout.rounds}`);
  renderTimer();
}

function tick() {
  if (config.settings.countdown && timer.remaining <= 3) beep(660, 0.09);
  if (timer.remaining <= 1) {
    const nextIndex = timer.stageIndex === -1 ? 0 : timer.stageIndex + 1;
    if (nextIndex < config.workout.stages.length) beginStage(nextIndex, timer.round);
    else if (timer.round < config.workout.rounds) beginStage(0, timer.round + 1);
    else {
      timer.running = false;
      timer.completed = true;
      clearInterval(timer.interval);
      announce(config.completionMessage);
      pauseMediaAudio(true);
      notifyWorkout(config.completionMessage, config.workout.name || "Treino concluído");
      renderTimer();
      releaseWakeLock();
      return;
    }
  } else {
    timer.remaining -= 1;
    renderTimer();
  }
}

function toggleTimer() {
  if (!config.workout.stages.length) return;
  if (timer.running) {
    timer.running = false;
    clearInterval(timer.interval);
    pauseMediaAudio();
    releaseWakeLock();
  } else {
    unlockAudio();
    if (timer.completed) resetTimer();
    if (!timer.remaining) beginStage(config.workout.warmup ? -1 : 0, 1);
    timer.running = true;
    playMediaAudio();
    timer.interval = setInterval(tick, 1000);
    requestWakeLock();
  }
  renderTimer();
}

function advanceStage() {
  if (!config.workout.stages.length) return;
  unlockAudio();
  if (timer.completed) resetTimer();
  else if (timer.stageIndex === -1) beginStage(0, 1);
  else if (timer.stageIndex + 1 < config.workout.stages.length) beginStage(timer.stageIndex + 1, timer.round);
  else if (timer.round < config.workout.rounds) beginStage(0, timer.round + 1);
  else {
    timer.running = false;
    timer.completed = true;
    clearInterval(timer.interval);
    announce(config.completionMessage);
    pauseMediaAudio(true);
    notifyWorkout(config.completionMessage, config.workout.name || "Treino concluído");
    releaseWakeLock();
    renderTimer();
  }
  if (!timer.completed && !timer.running) {
    timer.running = true;
    playMediaAudio();
    timer.interval = setInterval(tick, 1000);
  }
  renderTimer();
}

function previousStage() {
  if (!config.workout.stages.length) return;
  unlockAudio();
  if (timer.completed) {
    beginStage(config.workout.stages.length - 1, config.workout.rounds);
  } else if (timer.stageIndex === -1) {
    resetTimer();
    return;
  } else if (timer.remaining < timer.total - 3) {
    beginStage(timer.stageIndex, timer.round);
  } else if (timer.stageIndex > 0) {
    beginStage(timer.stageIndex - 1, timer.round);
  } else if (timer.round > 1) {
    beginStage(config.workout.stages.length - 1, timer.round - 1);
  } else if (config.workout.warmup) {
    beginStage(-1, 1);
  } else {
    resetTimer();
    return;
  }
  timer.running = true;
  clearInterval(timer.interval);
  timer.interval = setInterval(tick, 1000);
  requestWakeLock();
  renderTimer();
}

function unlockAudio() {
  audioContext ||= new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume();
}

function beep(frequency = 880, duration = 0.16) {
  unlockAudio();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, audioContext.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration);
}

function createMediaAudio() {
  const sampleRate = 8000;
  const samples = sampleRate;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeText(36, "data");
  view.setUint32(40, samples, true);
  for (let index = 44; index < buffer.byteLength; index += 1) view.setUint8(index, 128);
  mediaAudio = new Audio(URL.createObjectURL(new Blob([buffer], { type: "audio/wav" })));
  mediaAudio.loop = true;
  mediaAudio.volume = 0.001;
}

function playMediaAudio() {
  if (!mediaAudio) createMediaAudio();
  mediaAudio.play().catch(() => {
    $("#support-note").textContent = "O navegador não permitiu ativar os controles de mídia.";
  });
}

function pauseMediaAudio(reset = false) {
  if (!mediaAudio) return;
  mediaAudio.pause();
  if (reset) mediaAudio.currentTime = 0;
}

function announce(text) {
  beep(880, 0.22);
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    const announcement = new SpeechSynthesisUtterance(text);
    announcement.lang = "pt-BR";
    speechSynthesis.speak(announcement);
  }
}

function notifyWorkout(title, body) {
  if (!config.settings.notifications || !("Notification" in window) || Notification.permission !== "granted") return;
  const options = {
    body,
    tag: `bi-hiit-${Date.now()}`,
    renotify: true,
    silent: false,
    vibrate: [200, 100, 200],
    icon: "./icons/icon.svg",
    badge: "./icons/icon.svg"
  };
  if (serviceWorkerRegistration) serviceWorkerRegistration.showNotification(title, options);
  else new Notification(title, options);
}

async function setNotificationsEnabled(enabled) {
  if (!enabled) {
    config.settings.notifications = false;
    saveConfig();
    return;
  }
  if (!("Notification" in window)) {
    $("#support-note").textContent = "Este navegador não oferece notificações.";
    $("#notifications-toggle").checked = false;
    config.settings.notifications = false;
    saveConfig();
    return;
  }
  const permission = Notification.permission === "default"
    ? await Notification.requestPermission()
    : Notification.permission;
  config.settings.notifications = permission === "granted";
  $("#notifications-toggle").checked = config.settings.notifications;
  if (permission !== "granted") $("#support-note").textContent = "Permissão para notificações não concedida.";
  saveConfig();
}

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const stage = timer.stageIndex === -1 ? config.workout.warmup : config.workout.stages[timer.stageIndex];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: stage?.name || config.workout.name || "BI HIIT",
      artist: config.workout.name || "BI HIIT",
      album: `Ciclo ${timer.round} de ${config.workout.rounds}`
    });
    navigator.mediaSession.playbackState = timer.running ? "playing" : "paused";
    if ("setPositionState" in navigator.mediaSession && timer.total > 0) {
      navigator.mediaSession.setPositionState({
        duration: timer.total,
        playbackRate: 1,
        position: Math.min(timer.total, Math.max(0, timer.total - timer.remaining))
      });
    }
  } catch {
    $("#support-note").textContent = "O navegador não permitiu atualizar os controles de mídia.";
  }
}

function bindMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const handlers = {
    play: () => { if (!timer.running) toggleTimer(); },
    pause: () => { if (timer.running) toggleTimer(); },
    nexttrack: advanceStage,
    previoustrack: previousStage
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
  });
}

async function requestWakeLock() {
  if (!config.settings.wakeLock || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { $("#support-note").textContent = "O navegador não permitiu manter a tela ativa."; }
}

function releaseWakeLock() {
  wakeLock?.release();
  wakeLock = null;
}

function applyTheme() {
  document.body.classList.toggle("light", config.theme === "light");
}

function bindEvents() {
  $("#theme-toggle").addEventListener("click", () => { config.theme = config.theme === "dark" ? "light" : "dark"; applyTheme(); saveConfig(); });
  $("#start-button").addEventListener("click", toggleTimer);
  $("#reset-button").addEventListener("click", resetTimer);
  $("#advance-button").addEventListener("click", advanceStage);
  $("#previous-button").addEventListener("click", previousStage);
  $("#add-stage").addEventListener("click", () => {
    config.workout.stages.push({ name: "Nova etapa", minutes: 0, seconds: 30, color: "#8b789d" });
    saveConfig(); renderEditor(); resetTimer();
  });
  $("#restore-defaults").addEventListener("click", () => { config.workout = clone(DEFAULT_CONFIG.workout); saveConfig(); renderEditor(); resetTimer(); });
  $("#workout-name").addEventListener("input", (event) => { config.workout.name = event.target.value; saveConfig(); renderTimer(); });
  $("#rounds-input").addEventListener("input", (event) => { config.workout.rounds = Math.min(99, Math.max(1, Number(event.target.value) || 1)); saveConfig(); renderTimer(); });
  $("#countdown-toggle").addEventListener("change", (event) => { config.settings.countdown = event.target.checked; saveConfig(); });
  $("#wake-lock-toggle").addEventListener("change", (event) => { config.settings.wakeLock = event.target.checked; saveConfig(); if (timer.running) requestWakeLock(); });
  $("#notifications-toggle").addEventListener("change", (event) => { setNotificationsEnabled(event.target.checked); });
  $("#completion-message-input").addEventListener("input", (event) => {
    config.completionMessage = event.target.value.trim() || DEFAULT_COMPLETION_MESSAGE;
    saveConfig();
  });
  $("#stage-list").addEventListener("input", (event) => {
    const index = event.target.dataset.index;
    const stage = index === "warmup" ? config.workout.warmup : config.workout.stages[Number(index)];
    if (!stage) return;
    if (event.target.classList.contains("stage-name")) stage.name = event.target.value;
    if (event.target.classList.contains("stage-duration")) { const seconds = Math.max(1, Number(event.target.value) || 1); stage.minutes = Math.floor(seconds / 60); stage.seconds = seconds % 60; }
    if (event.target.classList.contains("stage-color")) stage.color = event.target.value;
    saveConfig(); renderTimer();
  });
  $("#warmup-editor").addEventListener("input", (event) => {
    const stage = config.workout.warmup;
    if (event.target.classList.contains("stage-name")) stage.name = event.target.value;
    if (event.target.classList.contains("stage-duration")) { const seconds = Math.max(1, Number(event.target.value) || 1); stage.minutes = Math.floor(seconds / 60); stage.seconds = seconds % 60; }
    if (event.target.classList.contains("stage-color")) stage.color = event.target.value;
    saveConfig(); renderTimer();
  });
  $("#stage-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button || config.workout.stages.length <= 1) return;
    config.workout.stages.splice(Number(button.dataset.remove), 1);
    saveConfig(); renderEditor(); resetTimer();
  });
  document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".view, .nav-button").forEach((element) => element.classList.remove("active"));
    $(`#${button.dataset.view}`).classList.add("active");
    button.classList.add("active");
  }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && timer.running) requestWakeLock(); });
}

applyTheme();
renderEditor();
renderTimer();
bindEvents();
bindMediaSession();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .then((registration) => { serviceWorkerRegistration = registration; })
    .catch(() => { $("#support-note").textContent = "Não foi possível ativar o suporte a notificações."; });
}
