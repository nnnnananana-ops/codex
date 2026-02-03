/**
 * SHN Lite Canvas - 경량화 캔버스 모듈 (Pure JavaScript)
 * 
 * 기능:
 * 1. AI 출력 파싱 → 로그/HUD/선택지 렌더링 + Firebase 저장
 * 2. 세션 관리 (목록 조회, 로드)
 * 3. 데이터 추출 (micro/meso/turn 단위 청킹 + LLM API 호출)
 * 4. renderAppShell 함수 export (HTML 캔버스 엔진 호환)
 * 
 * 사용법: <script src="shn-lite-canvas.js"></script>
 */

(function(global) {
'use strict';

// ============================================
// 내부 상태
// ============================================
let firebaseConfig = null;
let currentSessionId = null;
let sessionsCache = [];

// ============================================
// 설정 관리 (localStorage)
// ============================================
const CONFIG_KEY = 'shn-lite-config';

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
  } catch {
    return {};
  }
}

function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function getFirebaseConfig() {
  const config = loadConfig();
  return config.firebase || null;
}

function getLLMConfig() {
  const config = loadConfig();
  return config.llm || { apiKey: '', model: 'gemini-2.0-flash' };
}

// ============================================
// Firebase 초기화 (REST API 사용)
// ============================================
function initFirebase() {
  firebaseConfig = getFirebaseConfig();
  if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.warn('Firebase 설정이 필요합니다. (apiKey, projectId 필수)');
    return false;
  }
  
  console.log('✅ Firebase REST API 준비 완료!');
  return true;
}

/**
 * Firestore REST API 기본 URL 생성
 */
function getFirestoreUrl(collectionPath, docId) {
  const projectId = firebaseConfig?.projectId;
  if (!projectId) return null;
  
  let url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionPath}`;
  if (docId) {
    url += `/${docId}`;
  }
  return url;
}

/**
 * Firestore 문서 저장 (PATCH - upsert)
 */
async function firestoreSet(collectionPath, docId, data) {
  const url = getFirestoreUrl(collectionPath, docId);
  if (!url) throw new Error('Firebase 설정 필요');
  
  // Firestore REST API 형식으로 변환
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = convertToFirestoreValue(value);
  }
  
  const response = await fetch(`${url}?key=${firebaseConfig.apiKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Firestore 저장 실패: ${error.error?.message || response.statusText}`);
  }
  
  return await response.json();
}

/**
 * Firestore 문서 조회
 */
async function firestoreGet(collectionPath, docId) {
  const url = getFirestoreUrl(collectionPath, docId);
  if (!url) throw new Error('Firebase 설정 필요');
  
  const response = await fetch(`${url}?key=${firebaseConfig.apiKey}`);
  
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Firestore 조회 실패: ${error.error?.message || response.statusText}`);
  }
  
  const doc = await response.json();
  return convertFromFirestoreDoc(doc);
}

/**
 * Firestore 컬렉션 조회
 */
async function firestoreList(collectionPath, orderByField, limitCount) {
  let url = getFirestoreUrl(collectionPath);
  if (!url) throw new Error('Firebase 설정 필요');
  
  url += `?key=${firebaseConfig.apiKey}`;
  if (orderByField) {
    url += `&orderBy=${orderByField}`;
  }
  if (limitCount) {
    url += `&pageSize=${limitCount}`;
  }
  
  const response = await fetch(url);
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`Firestore 목록 조회 실패: ${error.error?.message || response.statusText}`);
  }
  
  const result = await response.json();
  return (result.documents || []).map(convertFromFirestoreDoc);
}

/**
 * JS 값 → Firestore 값 변환
 */
function convertToFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(convertToFirestoreValue) } };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (typeof value === 'object') {
    // serverTimestamp 특수 처리
    if (value._serverTimestamp) {
      return { timestampValue: new Date().toISOString() };
    }
    const fields = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = convertToFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/**
 * Firestore 문서 → JS 객체 변환
 */
function convertFromFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  
  const result = {};
  for (const [key, value] of Object.entries(doc.fields)) {
    result[key] = convertFromFirestoreValue(value);
  }
  
  // 문서 ID 추가
  if (doc.name) {
    result._id = doc.name.split('/').pop();
  }
  
  return result;
}

/**
 * Firestore 값 → JS 값 변환
 */
function convertFromFirestoreValue(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return parseInt(value.integerValue, 10);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(convertFromFirestoreValue);
  }
  if ('mapValue' in value) {
    const result = {};
    for (const [k, v] of Object.entries(value.mapValue.fields || {})) {
      result[k] = convertFromFirestoreValue(v);
    }
    return result;
  }
  return null;
}

/**
 * serverTimestamp 헬퍼
 */
function serverTimestamp() {
  return { _serverTimestamp: true };
}

// ============================================
// renderAppShell - HTML 캔버스 엔진 호환 함수
// ============================================
function renderAppShell(rawHtmlContent, title, canvasId) {
  console.log('🎨 renderAppShell 호출됨:', { title, canvasId });
  
  // 로더 제거
  const loader = document.getElementById('initial-loader');
  if (loader) loader.remove();
  
  // 앱 셸 생성
  const appShell = document.createElement('div');
  appShell.id = 'app-shell';
  appShell.className = 'shn-lite-canvas';
  
  // 스타일 주입
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --bg-primary: #0a0a12;
      --bg-secondary: #12121e;
      --bg-card: #1a1a2e;
      --accent: #ffd700;
      --accent-dim: #b8860b;
      --text: #e8e8e8;
      --text-dim: #888;
      --success: #4ecca3;
      --error: #ff6b6b;
      --info: #7b68ee;
      --border: #2a2a4a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: 'Noto Serif KR', 'Gowun Batang', serif; 
      background: var(--bg-primary); 
      color: var(--text); 
      min-height: 100vh;
      line-height: 1.8;
    }
    .canvas-content {
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    .shn-lite-canvas {
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    .canvas-content {
      max-width: 900px;
      margin: 0 auto;
    }
    .header { text-align: center; margin-bottom: 30px; }
    .header .main-title { font-size: 1.8rem; color: var(--accent); margin-bottom: 10px; }
    .header .subtitle { color: var(--text-dim); font-size: 0.9rem; }
    .content-section { margin-bottom: 20px; }
    .content-section.type-paragraph p { text-indent: 1em; margin-bottom: 1em; }
    .content-section.type-blockquote blockquote {
      border-left: 3px solid var(--accent);
      padding-left: 15px;
      color: var(--text-dim);
      font-style: italic;
    }
    .content-section.type-heading-h2 h2 {
      color: var(--accent);
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    .content-section.type-ordered-list ol {
      list-style: none;
      padding: 0;
    }
    .content-section.type-ordered-list li {
      padding: 12px 15px;
      background: var(--bg-card);
      border-radius: 8px;
      margin-bottom: 8px;
      cursor: pointer;
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .content-section.type-ordered-list li:hover {
      border-color: var(--accent);
      background: #252540;
    }
    .type-status-dashboard {
      background: var(--bg-secondary);
      border-radius: 8px;
      padding: 20px;
      border: 1px solid var(--border);
    }
    .dashboard-section {
      margin-bottom: 15px;
    }
    .dashboard-section-title {
      font-size: 0.85rem;
      color: var(--accent);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dashboard-items {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .dashboard-item {
      background: var(--bg-card);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 0.85rem;
    }
    .dashboard-item .key { color: var(--text-dim); }
    .dashboard-item .value { color: var(--text); margin-left: 5px; }
    [data-component="image-placeholder"] {
      background: var(--bg-card);
      border: 2px dashed var(--border);
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      color: var(--text-dim);
    }
    [data-component="image-placeholder"]::before {
      content: "🖼️ " attr(data-prompt);
    }
    [data-component="visualization-placeholder"] {
      background: var(--bg-card);
      border: 2px dashed var(--info);
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      color: var(--text-dim);
    }
    [data-component="visualization-placeholder"]::before {
      content: "📊 " attr(data-prompt);
    }
    [data-component="interactive-map"] {
      background: var(--bg-card);
      border-radius: 8px;
      padding: 20px;
      text-align: center;
    }
    [data-component="interactive-map"]::before {
      content: "🗺️ " attr(data-location);
      color: var(--accent);
    }
    strong { color: var(--accent); }
    a { color: var(--info); }
  `;
  document.head.appendChild(style);
  
  // HTML 콘텐츠 주입
  appShell.innerHTML = rawHtmlContent;
  document.body.appendChild(appShell);
  
  // Dashboard JSON 파싱 및 렌더링
  renderDashboard();
  
  // Firebase 저장 (설정 있으면)
  if (initFirebase()) {
    saveCanvasToFirebase(rawHtmlContent, title, canvasId);
  }
}

// Dashboard JSON → HTML 렌더링
function renderDashboard() {
  const jsonBlock = document.getElementById('dashboard-json-data');
  const renderTarget = document.getElementById('dashboard-render-target');
  
  if (!jsonBlock || !renderTarget) return;
  
  try {
    const data = JSON.parse(jsonBlock.textContent);
    let html = '';
    
    // Core sections
    if (data.core) {
      data.core.forEach(section => {
        html += `<div class="dashboard-section">`;
        html += `<div class="dashboard-section-title">${section.i} ${section.t}</div>`;
        html += `<div class="dashboard-items">`;
        section.d.forEach(item => {
          html += `<div class="dashboard-item"><span class="key">${item.k}:</span><span class="value">${item.v}</span></div>`;
        });
        html += `</div></div>`;
      });
    }
    
    // Event progress
    if (data.event) {
      html += `<div class="dashboard-section">`;
      html += `<div class="dashboard-section-title">${data.event.i} ${data.event.t}</div>`;
      html += `<div class="progress-bar" style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">`;
      html += `<div style="height:100%;width:${data.event.p}%;background:var(--accent);"></div>`;
      html += `</div></div>`;
    }
    
    renderTarget.innerHTML = html;
  } catch (e) {
    console.error('Dashboard 렌더링 실패:', e);
  }
}

// Firebase 저장 (REST API)
async function saveCanvasToFirebase(content, title, canvasId) {
  if (!firebaseConfig) return;
  
  try {
    await firestoreSet('canvas', canvasId, {
      content: content,
      title: title,
      canvasId: canvasId,
      savedAt: serverTimestamp()
    });
    console.log('✅ Canvas 저장됨:', canvasId);
  } catch (e) {
    console.error('Canvas 저장 실패:', e);
  }
}

// ============================================
// 데이터 추출 유틸리티
// ============================================
function chunkByMarker(text, markerType, chunkSize = 1) {
  let regex;
  switch (markerType) {
    case 'day':
      regex = /(?=\[📅\s*(?:Day|날짜)[:\s]*\d+\])/gi;
      break;
    case 'episode':
      regex = /(?=\[📖\s*(?:Episode|에피소드)[:\s]*\d+\])/gi;
      break;
    case 'turn':
    default:
      regex = /(?=##\s*\[턴\s*\d+\])/gi;
      break;
  }
  
  const rawChunks = text.split(regex).filter(c => c.trim());
  const grouped = [];
  for (let i = 0; i < rawChunks.length; i += chunkSize) {
    grouped.push(rawChunks.slice(i, i + chunkSize).join('\n\n'));
  }
  return grouped;
}

// ============================================
// LLM 기반 데이터 추출
// ============================================

/**
 * LLM API 호출 (Gemini API)
 * @param {string} prompt - 시스템 프롬프트
 * @param {string} content - 추출할 콘텐츠
 * @returns {Promise<object>} - 파싱된 JSON 응답
 */
async function callLLM(prompt, content) {
  const config = getLLMConfig();
  
  if (!config.apiKey) {
    throw new Error('LLM 설정이 필요합니다. saveConfig({ llm: { apiKey, model } })');
  }
  
  const model = config.model || 'gemini-2.0-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: `${prompt}\n\n---\n\n${content}` }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Gemini API 오류: ${response.status} ${errorData.error?.message || response.statusText}`);
  }
  
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(text);
}

/**
 * 마이크로 단위 추출 (턴 단위 상태 변화)
 * @param {string} turnContent - 단일 턴 콘텐츠
 * @returns {Promise<object>} - 추출된 마이크로 데이터
 */
async function extractMicro(turnContent) {
  const prompt = `You are a data extraction assistant. Extract micro-level state changes from this game turn.
Return JSON with this structure:
{
  "turn": number,
  "timestamp": "in-game time if mentioned",
  "pc_changes": {
    "stats": { "stat_name": delta_number },
    "condition": { "fatigue": delta, "mental": delta, "health": delta },
    "skills_used": ["skill1", "skill2"]
  },
  "npc_interactions": [
    { "npc_id": "name", "action": "description", "intimacy_change": delta }
  ],
  "events": ["event1", "event2"],
  "choices_made": ["choice description"],
  "outcomes": { "success": boolean, "z_grade": number_if_mentioned }
}
Only include fields with actual data. Use null for unknown values.`;

  return await callLLM(prompt, turnContent);
}

/**
 * 메소 단위 추출 (Day/Episode 요약)
 * @param {string} chunkContent - Day 또는 Episode 콘텐츠
 * @param {string} chunkType - 'day' 또는 'episode'
 * @returns {Promise<object>} - 추출된 메소 데이터
 */
async function extractMeso(chunkContent, chunkType = 'day') {
  const prompt = `You are a narrative analyst. Summarize this ${chunkType} of gameplay.
Return JSON with this structure:
{
  "${chunkType}_number": number,
  "summary": "2-3 sentence narrative summary in Korean",
  "key_events": ["major event 1", "major event 2"],
  "relationship_changes": [
    { "npc": "name", "from_level": number, "to_level": number, "reason": "brief" }
  ],
  "stat_progression": {
    "notable_changes": ["stat improved", "condition worsened"]
  },
  "narrative_beats": ["setup", "conflict", "resolution"],
  "cliffhangers": ["unresolved tension"],
  "themes": ["theme1", "theme2"]
}
Write summary in Korean. Other fields can be English or Korean.`;

  return await callLLM(prompt, chunkContent);
}

/**
 * 매크로 단위 추출 (전체 세션/Phase 요약)
 * @param {string} fullContent - 전체 세션 콘텐츠
 * @returns {Promise<object>} - 추출된 매크로 데이터
 */
async function extractMacro(fullContent) {
  const prompt = `You are a story analyst. Analyze the overall narrative arc of this game session.
Return JSON with this structure:
{
  "session_summary": "Overall narrative summary in Korean (3-5 sentences)",
  "protagonist_arc": {
    "starting_state": "description",
    "ending_state": "description", 
    "growth": ["growth point 1", "growth point 2"],
    "setbacks": ["setback 1"]
  },
  "key_relationships": [
    { "npc": "name", "relationship_type": "rival/ally/mentor/etc", "arc": "brief description" }
  ],
  "major_turning_points": ["turning point 1", "turning point 2"],
  "unresolved_threads": ["thread 1", "thread 2"],
  "emotional_journey": ["emotion1 → emotion2 → emotion3"],
  "phase_progress": { "current": number, "of": number }
}
Write summaries in Korean.`;

  return await callLLM(prompt, fullContent);
}

/**
 * 배치 추출 - 청크 단위로 순차 처리
 * @param {string} fullText - 전체 텍스트
 * @param {string} markerType - 'turn', 'day', 'episode'
 * @param {string} extractionLevel - 'micro', 'meso', 'macro'
 * @param {function} onProgress - 진행 콜백 (current, total)
 * @returns {Promise<array>} - 추출 결과 배열
 */
async function batchExtract(fullText, markerType = 'turn', extractionLevel = 'micro', onProgress = null) {
  const chunks = chunkByMarker(fullText, markerType);
  const results = [];
  
  for (let i = 0; i < chunks.length; i++) {
    try {
      let result;
      switch (extractionLevel) {
        case 'meso':
          result = await extractMeso(chunks[i], markerType);
          break;
        case 'macro':
          result = await extractMacro(chunks[i]);
          break;
        case 'micro':
        default:
          result = await extractMicro(chunks[i]);
      }
      results.push({ index: i, success: true, data: result });
    } catch (e) {
      results.push({ index: i, success: false, error: e.message });
    }
    
    if (onProgress) {
      onProgress(i + 1, chunks.length);
    }
    
    // Rate limiting - 500ms 딜레이
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  return results;
}

/**
 * 추출 결과를 Firebase에 저장
 * @param {string} sessionId - 세션 ID
 * @param {array} extractedData - 추출 결과
 * @param {string} extractionType - 추출 타입
 */
async function saveExtractedData(sessionId, extractedData, extractionType) {
  if (extractionType === undefined) extractionType = 'micro';
  
  if (!firebaseConfig) {
    if (!initFirebase()) {
      throw new Error('Firebase 연결 필요');
    }
  }
  
  await firestoreSet('extractions', sessionId + '_' + extractionType, {
    sessionId: sessionId,
    extractionType: extractionType,
    data: extractedData,
    extractedAt: serverTimestamp()
  });
  
  console.log('✅ 추출 데이터 저장됨: ' + sessionId + '_' + extractionType);
}

// ============================================
// 설정 UI
// ============================================

function createSettingsButton() {
  // 이미 있으면 생성 안 함
  if (document.getElementById('shn-settings-btn')) return;
  
  const btn = document.createElement('button');
  btn.id = 'shn-settings-btn';
  btn.innerHTML = '⚙️';
  btn.title = '설정';
  btn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 50px;
    height: 50px;
    border-radius: 50%;
    border: none;
    background: var(--bg-card, #1a1a2e);
    color: var(--accent, #ffd700);
    font-size: 24px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 9999;
    transition: transform 0.2s, background 0.2s;
  `;
  btn.onmouseenter = () => btn.style.transform = 'scale(1.1)';
  btn.onmouseleave = () => btn.style.transform = 'scale(1)';
  btn.onclick = openSettingsModal;
  
  document.body.appendChild(btn);
}

function openSettingsModal() {
  // 이미 열려있으면 닫기
  const existing = document.getElementById('shn-settings-modal');
  if (existing) {
    existing.remove();
    return;
  }
  
  const config = loadConfig();
  const llm = config.llm || {};
  const firebase = config.firebase || {};
  
  const modal = document.createElement('div');
  modal.id = 'shn-settings-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;
  
  modal.innerHTML = `
    <div style="
      background: var(--bg-secondary, #12121e);
      border-radius: 12px;
      padding: 30px;
      max-width: 500px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      border: 1px solid var(--border, #2a2a4a);
    ">
      <h2 style="color: var(--accent, #ffd700); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
        ⚙️ 설정
        <button id="shn-settings-close" style="background: none; border: none; color: var(--text-dim, #888); font-size: 24px; cursor: pointer;">✕</button>
      </h2>
      
      <div style="margin-bottom: 25px;">
        <h3 style="color: var(--text, #e8e8e8); margin-bottom: 12px; font-size: 0.95rem;">🤖 Gemini API</h3>
        <div style="margin-bottom: 10px;">
          <label style="display: block; color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 4px;">API Key</label>
          <input type="password" id="shn-llm-apikey" value="${llm.apiKey || ''}" placeholder="AIza..." style="
            width: 100%;
            padding: 10px 12px;
            background: var(--bg-card, #1a1a2e);
            border: 1px solid var(--border, #2a2a4a);
            border-radius: 6px;
            color: var(--text, #e8e8e8);
            font-size: 0.9rem;
          ">
        </div>
        <div>
          <label style="display: block; color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 4px;">Model</label>
          <select id="shn-llm-model" style="
            width: 100%;
            padding: 10px 12px;
            background: var(--bg-card, #1a1a2e);
            border: 1px solid var(--border, #2a2a4a);
            border-radius: 6px;
            color: var(--text, #e8e8e8);
            font-size: 0.9rem;
          ">
            <option value="gemini-3.0-pro" ${llm.model === 'gemini-3.0-pro' ? 'selected' : ''}>Gemini 3.0 Pro</option>
            <option value="gemini-2.0-flash" ${llm.model === 'gemini-2.0-flash' ? 'selected' : ''}>Gemini 2.0 Flash</option>
            <option value="gemini-2.0-flash-lite" ${llm.model === 'gemini-2.0-flash-lite' ? 'selected' : ''}>Gemini 2.0 Flash Lite</option>
            <option value="gemini-1.5-pro" ${llm.model === 'gemini-1.5-pro' ? 'selected' : ''}>Gemini 1.5 Pro</option>
            <option value="gemini-1.5-flash" ${llm.model === 'gemini-1.5-flash' ? 'selected' : ''}>Gemini 1.5 Flash</option>
          </select>
        </div>
      </div>
      
      <div style="margin-bottom: 25px;">
        <h3 style="color: var(--text, #e8e8e8); margin-bottom: 12px; font-size: 0.95rem;">🔥 Firebase (선택)</h3>
        <div style="margin-bottom: 10px;">
          <label style="display: block; color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 4px;">API Key</label>
          <input type="password" id="shn-fb-apikey" value="${firebase.apiKey || ''}" placeholder="Firebase API Key" style="
            width: 100%;
            padding: 10px 12px;
            background: var(--bg-card, #1a1a2e);
            border: 1px solid var(--border, #2a2a4a);
            border-radius: 6px;
            color: var(--text, #e8e8e8);
            font-size: 0.9rem;
          ">
        </div>
        <div style="margin-bottom: 10px;">
          <label style="display: block; color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 4px;">Project ID</label>
          <input type="text" id="shn-fb-projectid" value="${firebase.projectId || ''}" placeholder="my-project-id" style="
            width: 100%;
            padding: 10px 12px;
            background: var(--bg-card, #1a1a2e);
            border: 1px solid var(--border, #2a2a4a);
            border-radius: 6px;
            color: var(--text, #e8e8e8);
            font-size: 0.9rem;
          ">
        </div>
        <div>
          <label style="display: block; color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 4px;">Auth Domain</label>
          <input type="text" id="shn-fb-authdomain" value="${firebase.authDomain || ''}" placeholder="my-project.firebaseapp.com" style="
            width: 100%;
            padding: 10px 12px;
            background: var(--bg-card, #1a1a2e);
            border: 1px solid var(--border, #2a2a4a);
            border-radius: 6px;
            color: var(--text, #e8e8e8);
            font-size: 0.9rem;
          ">
        </div>
      </div>
      
      <div style="display: flex; gap: 10px;">
        <button id="shn-settings-save" style="
          flex: 1;
          padding: 12px;
          background: var(--accent, #ffd700);
          color: #000;
          border: none;
          border-radius: 6px;
          font-weight: bold;
          cursor: pointer;
          transition: opacity 0.2s;
        ">💾 저장</button>
        <button id="shn-settings-clear" style="
          padding: 12px 20px;
          background: transparent;
          color: var(--error, #ff6b6b);
          border: 1px solid var(--error, #ff6b6b);
          border-radius: 6px;
          cursor: pointer;
        ">🗑️ 초기화</button>
      </div>
      
      <p style="margin-top: 15px; font-size: 0.75rem; color: var(--text-dim, #888); text-align: center;">
        🔒 설정은 브라우저 localStorage에만 저장됩니다.
      </p>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // 이벤트 바인딩
  document.getElementById('shn-settings-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  document.getElementById('shn-settings-save').onclick = () => {
    const newConfig = {
      llm: {
        apiKey: document.getElementById('shn-llm-apikey').value.trim(),
        model: document.getElementById('shn-llm-model').value
      },
      firebase: {
        apiKey: document.getElementById('shn-fb-apikey').value.trim(),
        projectId: document.getElementById('shn-fb-projectid').value.trim(),
        authDomain: document.getElementById('shn-fb-authdomain').value.trim()
      }
    };
    
    // 빈 값 제거
    if (!newConfig.firebase.apiKey) delete newConfig.firebase;
    
    saveConfig(newConfig);
    
    // 성공 피드백
    const btn = document.getElementById('shn-settings-save');
    btn.textContent = '✅ 저장됨!';
    btn.style.background = 'var(--success, #4ecca3)';
    setTimeout(() => modal.remove(), 800);
  };
  
  document.getElementById('shn-settings-clear').onclick = () => {
    if (confirm('모든 설정을 초기화할까요?')) {
      localStorage.removeItem(CONFIG_KEY);
      modal.remove();
      openSettingsModal(); // 다시 열기
    }
  };
}

// ============================================
// 전역 노출
// ============================================
global.renderAppShell = renderAppShell;
global.SHNLiteCanvas = {
  renderAppShell: renderAppShell,
  chunkByMarker: chunkByMarker,
  initFirebase: initFirebase,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  getLLMConfig: getLLMConfig,
  // Firebase REST API
  firestoreSet: firestoreSet,
  firestoreGet: firestoreGet,
  firestoreList: firestoreList,
  // LLM 추출 함수들
  callLLM: callLLM,
  extractMicro: extractMicro,
  extractMeso: extractMeso,
  extractMacro: extractMacro,
  batchExtract: batchExtract,
  saveExtractedData: saveExtractedData,
  // 설정 UI
  openSettingsModal: openSettingsModal,
  createSettingsButton: createSettingsButton
};

// 자동 초기화
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      console.log('📜 SHN Lite Canvas 로드됨 (Pure JS)');
      createSettingsButton();
    });
  } else {
    console.log('📜 SHN Lite Canvas 로드됨 (Pure JS)');
    createSettingsButton();
  }
}

})(typeof window !== 'undefined' ? window : this);
