import { marked } from 'https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js';
Chart.register(ChartDataLabels);

// --- ESTADO GLOBAL ---
let API_KEY = import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem('GEMINI_PRO_KEY');
let ttsEnabled = false;
let globalHistory = JSON.parse(localStorage.getItem('gemini_history')) || [];
let currentChatId = Date.now().toString();

// REGLA 3: Pool de Modelos Fallback (Orden de prioridad)
const MODEL_POOL = [
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash"
];

// --- ELEMENTOS DOM ---
const chatBox = document.getElementById('chat-box');
const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const fileUpload = document.getElementById('file-upload');
const ttsBtn = document.getElementById('tts-btn');
const micBtn = document.getElementById('mic-btn');
const currentModelDisplay = document.getElementById('current-model-display');
const proModal = document.getElementById('pro-modal');

// --- INICIALIZACIÓN ---
function init() {
  renderSidebarHistory();
  loadChat(currentChatId);
  setupEvents();
}

// --- EVENTOS ---
function setupEvents() {
  sendBtn.addEventListener('click', handleSend);
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  
  newChatBtn.addEventListener('click', () => {
    currentChatId = Date.now().toString();
    chatBox.innerHTML = '';
  });

  // TTS Toggle
  ttsBtn.addEventListener('click', () => {
    ttsEnabled = !ttsEnabled;
    ttsBtn.innerHTML = ttsEnabled ? '<i class="fa-solid fa-volume-high"></i>' : '<i class="fa-solid fa-volume-xmark"></i>';
    ttsBtn.classList.toggle('active', ttsEnabled);
    if (!ttsEnabled) window.speechSynthesis.cancel();
  });

  // Modal Pro
  document.getElementById('save-key-btn').addEventListener('click', () => {
    const key = document.getElementById('new-api-key').value;
    if (key) {
      API_KEY = key;
      localStorage.setItem('GEMINI_PRO_KEY', key);
      proModal.classList.add('hidden');
      alert("Key Pro Inyectada. Reintentando...");
    }
  });
  document.getElementById('close-modal-btn').addEventListener('click', () => proModal.classList.add('hidden'));

  // Micrófono (STT)
  micBtn.addEventListener('click', startDictation);

  // Sidebar
  document.getElementById('menu-btn').addEventListener('click', () => document.getElementById('sidebar').classList.remove('hidden'));
  document.getElementById('close-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.add('hidden'));
}

// --- LÓGICA DE PROCESAMIENTO ---
async function handleSend() {
  const text = promptInput.value.trim();
  const files = fileUpload.files;
  if (!text && files.length === 0) return;

  promptInput.value = '';
  appendMessage('user', text);
  saveToHistory(currentChatId, 'user', text);

  let inlineDataArray = [];
  let fileTextContent = "";

  // Procesar Archivos (Híbrido)
  for (let file of files) {
    if (file.type.startsWith('image/') || file.type === 'application/pdf') {
      const base64 = await fileToBase64(file);
      inlineDataArray.push({
        inlineData: { data: base64.split(',')[1], mimeType: file.type }
      });
    } else {
      // Leer como texto (SQL, JS, CSV, TXT)
      const textData = await fileToText(file);
      fileTextContent += `\n\n--- Archivo Adjunto: ${file.name} ---\n${textData}\n--- Fin Archivo ---\n`;
    }
  }

  const finalPrompt = fileTextContent ? `${text}\n${fileTextContent}` : text;
  fetchGeminiConFallback(finalPrompt, inlineDataArray);
}

// --- FALLBACK MULTI-MODELO (REGLA 3) ---
async function fetchGeminiConFallback(promptText, inlineDataArray) {
  const typingId = appendTyping();
  let success = false;

  for (let model of MODEL_POOL) {
    currentModelDisplay.innerText = model;
    try {
      const payload = {
        contents: [{
          parts: [{ text: promptText }, ...inlineDataArray]
        }]
      };

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status === 403 || res.status === 429) {
        console.warn(`[${model}] Falló por cuota (429) o permisos (403). Saltando...`);
        continue; // Fallback al siguiente modelo
      }

      if (res.status === 404) { continue; } // Ignorar si el modelo aún no está desplegado públicamente

      if (!res.ok) throw new Error("Error HTTP " + res.status);

      const data = await res.json();
      const aiResponse = data.candidates[0].content.parts[0].text;
      
      document.getElementById(typingId).remove();
      renderAIResponse(aiResponse);
      success = true;
      break; 
    } catch (e) {
      console.error(e);
    }
  }

  if (!success) {
    document.getElementById(typingId).remove();
    proModal.classList.remove('hidden'); // Disparar Modal Login Pro
  }
}

// --- RENDERIZADO Y UI ---
function renderAIResponse(rawText) {
  // Guardar historial puro
  saveToHistory(currentChatId, 'ai', rawText);

  // Verificar si hay JSON oculto para gráficos
  let textToRender = rawText;
  let chartData = null;
  const chartMatch = rawText.match(/```json\n([\s\S]*?)\n```/);
  if (chartMatch && chartMatch[1].includes("labels") && chartMatch[1].includes("datasets")) {
    try {
      chartData = JSON.parse(chartMatch[1]);
      textToRender = rawText.replace(chartMatch[0], ''); // Remover el JSON del texto visible
    } catch(e) {}
  }

  const msgDiv = document.createElement('div');
  msgDiv.className = 'message ai-msg';
  msgDiv.innerHTML = marked.parse(textToRender);

  // Inyectar Botones en Bloques de Código
  msgDiv.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code').innerText;
    const lang = pre.querySelector('code').className.replace('language-', '') || 'txt';
    
    const header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML = `
      <span>${lang.toUpperCase()}</span>
      <div>
        <button onclick="navigator.clipboard.writeText(\`${code.replace(/`/g, '\\`')}\`)">COPIAR</button>
        <button onclick="downloadScript(\`${code.replace(/`/g, '\\`')}\`, '${lang}')">BAJAR SCRIPT</button>
      </div>
    `;
    pre.insertBefore(header, pre.firstChild);
  });

  // Renderizar Gráfico si existe
  if (chartData) {
    const card = document.createElement('div');
    card.className = 'cyber-card';
    const canvas = document.createElement('canvas');
    card.appendChild(canvas);
    
    const btn = document.createElement('button');
    btn.className = 'cyber-btn neon-green';
    btn.style.marginTop = '10px';
    btn.innerText = 'DESCARGAR PNG';
    btn.onclick = () => {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = 'cyber-chart.png';
      link.click();
    };
    card.appendChild(btn);
    msgDiv.appendChild(card);

    // Datalabels en NEGRO (Regla 4)
    setTimeout(() => {
      new Chart(canvas, {
        type: chartData.type || 'bar',
        data: chartData,
        options: {
          plugins: {
            datalabels: { color: '#000', font: { weight: 'bold' } },
            legend: { labels: { color: '#e0e0e0' } }
          },
          scales: {
            x: { ticks: { color: '#00ffcc' }, grid: { color: '#333' } },
            y: { ticks: { color: '#00ffcc' }, grid: { color: '#333' } }
          }
        }
      });
    }, 100);
  }

  // Botones de Sesión
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = `
    <button class="cyber-btn" onclick="navigator.clipboard.writeText(\`${rawText.replace(/`/g, '\\`')}\`)"><i class="fa-solid fa-copy"></i> COPIAR</button>
    <button class="cyber-btn" onclick="downloadScript(\`${rawText.replace(/`/g, '\\`')}\`, 'md')"><i class="fa-solid fa-download"></i> DESCARGAR SESIÓN</button>
  `;
  msgDiv.appendChild(actions);

  chatBox.appendChild(msgDiv);
  Prism.highlightAllUnder(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;

  // REGLA 1: Síntesis de voz con Chunking
  if (ttsEnabled) {
    window.speechSynthesis.cancel(); // Limpiar colas
    const chunks = textToRender.split(/(?<=[.;?!])\s+/);
    chunks.forEach(chunk => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = 'es-ES';
      utterance.rate = 1.1;
      window.speechSynthesis.speak(utterance);
    });
    window.speechSynthesis.resume();
  }
}

// --- UTILIDADES ---
function appendMessage(role, text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}-msg`;
  msgDiv.innerText = text;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendTyping() {
  const id = 'typing-' + Date.now();
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ai-msg`;
  msgDiv.id = id;
  msgDiv.innerHTML = `<span style="color:var(--neon-green)">Procesando... <i class="fa-solid fa-circle-notch fa-spin"></i></span>`;
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
  return id;
}

const fileToBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = () => resolve(reader.result);
  reader.onerror = error => reject(error);
});

const fileToText = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsText(file);
  reader.onload = () => resolve(reader.result);
  reader.onerror = error => reject(error);
});

window.downloadScript = (content, ext) => {
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `omega_export_${Date.now()}.${ext}`;
  a.click();
};

function startDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return alert("STT no soportado en este navegador.");
  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  micBtn.style.color = 'var(--neon-red)';
  recognition.start();
  recognition.onresult = (e) => {
    promptInput.value += e.results[0][0].transcript;
    micBtn.style.color = '';
  };
  recognition.onerror = () => micBtn.style.color = '';
}

// --- HISTORIAL (REGLA 2) ---
function saveToHistory(chatId, role, text) {
  let session = globalHistory.find(s => s.id === chatId);
  if (!session) {
    session = { id: chatId, title: text.substring(0, 20) + '...', messages: [] };
    globalHistory.unshift(session);
  }
  session.messages.push({ role, text });
  localStorage.setItem('gemini_history', JSON.stringify(globalHistory));
  renderSidebarHistory();
}

function renderSidebarHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  globalHistory.forEach(session => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerText = session.title;
    div.onclick = () => { currentChatId = session.id; loadChat(session.id); };
    list.appendChild(div);
  });
}

function loadChat(chatId) {
  chatBox.innerHTML = '';
  const session = globalHistory.find(s => s.id === chatId);
  if (session) {
    session.messages.forEach(m => {
      if (m.role === 'user') appendMessage('user', m.text);
      else renderAIResponse(m.text); // Re-dibuja y re-renderiza todo
    });
  }
}

init();