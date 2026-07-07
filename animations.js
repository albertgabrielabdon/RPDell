
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyguZM3gI6vnqALOaiO2eG7vcaLBdQkLkmilZdm1wnx2bpnxV7I0m8GVifHL5FBvXxCdw/exec";
let CURRENT_USER = null;
let CACHED_QUESTS = [];

const RequestQueue = {
  locks: new Set(),
  async execute(lockKey, action, payload, elementToDisable = null) {
    if (this.locks.has(lockKey)) return null;
    this.locks.add(lockKey);
    if (elementToDisable) elementToDisable.disabled = true;

    try {
      const response = await fetch(`${APPS_SCRIPT_URL}?action=${action}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      return data;
    } catch (error) {
      console.error(`Transaction Failure [${action}]:`, error);
      showToast("Network disruption. Check your connection.", "danger");
      throw error;
    } finally {
      this.locks.delete(lockKey);
      if (elementToDisable) elementToDisable.disabled = false;
    }
  }
};

const ChatSystem = {
  lastChatHash: "",
  isSending: false,
  pendingMessage: "",
  pollingIntervalId: null,

  async fetchMessages() {
    if (this.isSending) return;
    try {
      const response = await fetch(`${APPS_SCRIPT_URL}?action=getFeed&_t=${Date.now()}`, { method: "POST" });
      const res = await response.json();

      if (res.ok && res.feed) {
        const messages = res.feed;
        if (this.pendingMessage) {
          if (messages.some(m => m.Text === this.pendingMessage)) this.pendingMessage = ""; else return; 
        }
        const currentHash = JSON.stringify(messages);
        if (currentHash !== this.lastChatHash) {
          this.renderMessages(messages);
          this.lastChatHash = currentHash;
        }
      }
    } catch (e) { console.error("Chat sync dropout:", e); }
  },

  renderMessages(messages) {
    const area = document.getElementById('chat-messages-area');
    if (!area) return;

    const currentUser = CURRENT_USER ? CURRENT_USER.Username : "";
    const sorted = [...messages].slice(-100).reverse();

    if(sorted.length === 0) {
      area.innerHTML = `<div class="empty-state"><div class="empty-state-title">Comms Interface Empty</div><div>No transaction data logs discovered within this channel window.</div></div>`;
      return;
    }

    area.innerHTML = sorted.map(m => {
      const isMe = m.Username === currentUser;
      return `
        <div class="chat-bubble ${isMe ? 'me' : 'other'}">
          <span class="bubble-user">${isMe ? 'You' : m.Username}</span>
          <span class="bubble-text">${this.escapeHTML(m.Text)}</span>
        </div>
      `;
    }).join('');
    area.scrollTop = area.scrollHeight;
  },

  async sendMessage(text) {
    if (!text.trim() || this.isSending) return;
    this.isSending = true;
    this.pendingMessage = text;

    const input = document.getElementById('chat-input-full');
    const sendBtn = document.getElementById('btn-chat-send');
    if (input) input.value = "";
    if (sendBtn) sendBtn.disabled = true;

    const area = document.getElementById('chat-messages-area');
    const tempDiv = document.createElement('div');
    tempDiv.className = "chat-bubble me optimistic";
    tempDiv.innerHTML = `
      <span class="bubble-user">You</span>
      <span class="bubble-text">${this.escapeHTML(text)}</span>
    `;
    area.appendChild(tempDiv);
    area.scrollTop = area.scrollHeight;

    try {
      const res = await RequestQueue.execute('chat_send', 'addFeedEntry', { Username: CURRENT_USER.Username, Text: text });
      if (res && res.ok) {
        tempDiv.classList.remove('optimistic');
        setTimeout(() => { this.isSending = false; this.fetchMessages(); }, 400);
      } else {
        throw new Error();
      }
    } catch (e) {
      this.isSending = false;
      tempDiv.className = "chat-bubble me failed";
      tempDiv.querySelector('.bubble-text').innerHTML += `<small style="display:block;opacity:0.8;font-size:10px;margin-top:4px;">Send Failed</small>`;
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  },

  escapeHTML(str) {
    const p = document.createElement('p');
    p.textContent = str;
    return p.innerHTML;
  },

  startPolling() {
    this.stopPolling();
    const area = document.getElementById('chat-messages-area');
    if(area) area.innerHTML = `<div class="skeleton-row" style="height:100%"></div>`;
    this.fetchMessages();
    this.pollingIntervalId = setInterval(() => this.fetchMessages(), 4000);
  },

  stopPolling() {
    if (this.pollingIntervalId) { clearInterval(this.pollingIntervalId); this.pollingIntervalId = null; }
  }
};

window.handleChatSend = () => {
  const input = document.getElementById('chat-input-full');
  if (input) ChatSystem.sendMessage(input.value);
};

function handleChatKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    window.handleChatSend();
  }
}

function switchTab(mode) {
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  document.getElementById('form-login').classList.toggle('hidden', mode !== 'login');
  document.getElementById('form-register').classList.toggle('hidden', mode !== 'register');
}

function switchView(view) {
  ['quests', 'leaderboard', 'feed'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== view);
    document.getElementById(`btn-view-${v}`).classList.toggle('active', v === view);
  });
  if (view === 'feed') ChatSystem.startPolling(); else ChatSystem.stopPolling();
  if (view === 'quests') loadLiveQuests();
  if (view === 'leaderboard') loadLeaderboard();
}

async function handleAuthSubmit(e, action) {
  e.preventDefault();
  const btn = document.getElementById(`btn-${action}-submit`);
  const originalText = btn.textContent;
  btn.textContent = action === 'login' ? "Connecting..." : "What have you done today?";
  
  const payload = action === 'login' ? {
    email: document.getElementById('login-email').value,
    pass: document.getElementById('login-pass').value
  } : {
    username: document.getElementById('reg-username').value,
    email: document.getElementById('reg-email').value,
    pass: document.getElementById('reg-pass').value
  };

  try {
    const res = await RequestQueue.execute('auth', action, payload, btn);
    if (res && res.ok) enterApp(res.user); else showToast(res.error || "Authentication validation failed.", "danger");
  } catch(err) {
    showToast("Forgetful, are you?", "danger");
  } finally {
    btn.textContent = originalText;
  }
}

function enterApp(user) {
  CURRENT_USER = user;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  updateProfileUI(false);
  switchView('quests');
  showToast(`Welcome back, ${user.Username}`, "success");
}

function logout() {
  ChatSystem.stopPolling();
  CURRENT_USER = null;
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
}

function xpBoundsForLevel(lvl) { return lvl <= 20 ? 100 : lvl <= 40 ? 250 : 500; }

function animateCounter(elementId, targetValue, suffix = '') {
  const el = document.getElementById(elementId);
  if (!el) return;
  let current = parseInt(el.textContent, 10) || 0;
  const target = parseInt(targetValue, 10) || 0;
  if (current === target) { el.textContent = target + suffix; return; }
  const steps = 20;
  const stepValue = (target - current) / steps;
  let count = 0;
  
  const t = setInterval(() => {
    count++;
    current += stepValue;
    el.textContent = Math.round(current) + suffix;
    if (count >= steps) { clearInterval(t); el.textContent = target + suffix; }
  }, 16);
}

function updateProfileUI(animate = true) {
  if (!CURRENT_USER) return;
  
  const nameContainer = document.getElementById('user-display-name');
  nameContainer.textContent = CURRENT_USER.Username;
  document.getElementById('user-display-rank').textContent = CURRENT_USER.Rank || 'Peashooter';
  
  if (animate) {
    animateCounter('stat-level', CURRENT_USER.Level || 1);
    animateCounter('stat-streak', CURRENT_USER['Current Streak'] || 0, 'd');
    animateCounter('stat-tokens', CURRENT_USER['Reward Tokens'] || 0);
    animateCounter('stat-total-xp', CURRENT_USER['Total XP'] || 0);
  } else {
    document.getElementById('stat-level').textContent = CURRENT_USER.Level || 1;
    document.getElementById('stat-streak').textContent = `${CURRENT_USER['Current Streak'] || 0}d`;
    document.getElementById('stat-tokens').textContent = CURRENT_USER['Reward Tokens'] || 0;
    document.getElementById('stat-total-xp').textContent = CURRENT_USER['Total XP'] || 0;
  }

  const levelCeiling = xpBoundsForLevel(Number(CURRENT_USER.Level || 1));
  const currentXp = Number(CURRENT_USER.XP || 0);
  const pct = Math.min(100, Math.round((currentXp / levelCeiling) * 100));
  document.getElementById('xp-fraction').textContent = `${currentXp} / ${levelCeiling} XP`;
  document.getElementById('xp-fill').style.width = `${pct}%`;
}

async function loadLiveQuests() {
  const container = document.getElementById('quest-list-container');
  container.innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>`;
  
  try {
    const res = await RequestQueue.execute('get_quests', 'getQuests', { 
      userId: CURRENT_USER.Username, Username: CURRENT_USER.Username, username: CURRENT_USER.Username 
    });
    if (res && res.ok && res.quests) {
      CACHED_QUESTS = res.quests;
      filterQuests();
    } else {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-title">DB error.</div><div>Could not match DB logs.</div></div>`;
    }
  } catch(e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Interruption detected</div><div>Item missing.</div></div>`;
  }
}
function filterQuests() {
    const targetCat = document.getElementById('filter-category').value;
    const container = document.getElementById('quest-list-container');
    container.innerHTML = "";
  
    let filtered = CACHED_QUESTS.filter(q => targetCat === "ALL" || q.Category === targetCat);
    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-title">No Quests Discovered</div><div>No active quests.</div></div>`;
      return;
    }
  
    filtered.sort((a, b) => {
      const aDone = !!(a.isDone || a.done);
      const bDone = !!(b.isDone || b.done);
      return aDone === bDone ? 0 : aDone ? 1 : -1;
    });
  
    filtered.forEach(q => {
      const item = document.createElement('div');
      const isCompleted = !!(q.isDone || q.done); 
      item.id = `quest-row-${q.QuestId}`;
      item.className = `quest-item ${isCompleted ? 'completed' : ''}`;
      
      item.innerHTML = `
        <div class="checkbox-wrapper">
          <div class="checkbox" onclick="${isCompleted ? 'return false;' : `toggleQuestState('${q.QuestId}', ${isCompleted})`}"></div>
        </div>
        <div class="quest-details">
          <div class="quest-name">${q.Name}</div>
          <div class="quest-cat">
            <span class="quest-badge">${q.Category}</span>
            <span class="quest-badge">${q.Frequency || 'Daily'}</span>
          </div>
        </div>
        <div class="quest-xp">+${q.XP} XP</div>
      `;
      container.appendChild(item);
    });
  }
  
  async function toggleQuestState(questId, wasDone) {
    if (wasDone) return; 
  
    const rowElement = document.getElementById(`quest-row-${questId}`);
    if (rowElement) {
      if (rowElement.classList.contains('completed')) return;
      rowElement.classList.add('completed');
      const checkbox = rowElement.querySelector('.checkbox');
      if (checkbox) checkbox.setAttribute('onclick', 'return false;');
    }
    
    try {
      const res = await RequestQueue.execute(`complete_${questId}`, 'completeQuest', { 
        userId: CURRENT_USER.Username, Username: CURRENT_USER.Username, questId: questId, QuestId: questId 
      });
  
      if (res && res.ok) {
        CURRENT_USER.Level = res.level;
        CURRENT_USER.Rank = res.rank;
        CURRENT_USER.XP = res.xpIntoLevel;
        CURRENT_USER['Total XP'] = Number(CURRENT_USER['Total XP'] || 0) + Number(res.xpGained || 0);
        
        if (res.leveledUp) {
          CURRENT_USER['Reward Tokens'] = Number(CURRENT_USER['Reward Tokens'] || 0) + 1;
          showToast(`<strong>Crazy Dave sees you got some upgrades!</strong> Promoted to Level ${res.level} [${res.rank}]!`, "warning");
        } else {
          showToast(`Quest logged successfully. Added +${res.xpGained} XP.`, "success");
        }
        
        updateProfileUI(true);
        
        const targetQuest = CACHED_QUESTS.find(q => String(q.QuestId) === String(questId));
        if (targetQuest) {
          targetQuest.isDone = true;
          targetQuest.done = true;
        }
  
        await loadLiveQuests();
      } else {
        if (rowElement) rowElement.classList.remove('completed');
        showToast(`Transaction error rollback executed: ${res ? res.error : 'Unknown'}`, "danger");
      }
    } catch (error) {
      if (rowElement) rowElement.classList.remove('completed');
      showToast("Rollback.", "danger");
    }
  }

async function loadLeaderboard() {
  const container = document.getElementById('leaderboard-container');
  container.innerHTML = `<div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>`;
  
  try {
    const res = await RequestQueue.execute('leaderboard', 'getLeaderboard');
    if (res && res.ok && res.leaderboard) {
      container.innerHTML = "";
      const metric = document.getElementById('leaderboard-metric').value;
      let players = [...res.leaderboard];
      
      if (metric === 'weekly') {
        players.sort((a, b) => Number(b['Weekly XP'] || 0) - Number(a['Weekly XP'] || 0));
      } else {
        players.sort((a, b) => Number(b['Total XP'] || 0) - Number(a['Total XP'] || 0));
      }

      players.forEach((p, index) => {
        const score = metric === 'weekly' ? `${p['Weekly XP'] || 0} W_XP` : `${p['Total XP'] || 0} Total XP`;
        const isMe = p.Username === (CURRENT_USER ? CURRENT_USER.Username : "");
        const row = document.createElement('div');
        row.className = `leader-row ${isMe ? 'current-user' : ''}`;
        row.innerHTML = `
          <div class="leader-rank ${index < 3 ? 'top-3' : ''}">#${index + 1}</div>
          <div class="leader-name">${p.Username}</div>
          <div class="leader-xp">${score}</div>
        `;
        container.appendChild(row);
      });
    }
  } catch(e) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Failed to Load Metrics</div><div> DB connection failed.</div></div>`;
  }
}

function showToast(message, type = "info") {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const card = document.createElement('div');
  card.className = `toast-card ${type}`;
  card.innerHTML = `
    <div class="toast-content">${message}</div>
    <button class="toast-close" onclick="dismissToast(this.parentElement)">×</button>
  `;
  container.appendChild(card);
  setTimeout(() => dismissToast(card), 5000);
}

function dismissToast(element) {
  if (!element || !element.parentNode) return;
  element.style.animation = 'toastOut 0.2s ease-in forwards';
  setTimeout(() => element.remove(), 200);
}
