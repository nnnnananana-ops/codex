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
let db = null;  // Firestore 인스턴스
let currentUser = null;  // Firebase 사용자
let currentSessionId = null;
let currentSubject = null;  // 현재 주제 (세션 식별용)
let sessionsCache = [];
let userApiSettings = {};  // API 설정 (bundle.js 패턴)

// Firestore 컬렉션 참조들
let sessionsCollectionRef = null;
let userSettingsRef = null;

const appId = 'the-edge-canvas';  // 앱 식별자

// ============================================
// Firebase 초기화 (Google Gemini 플랫폼 패턴)
// ============================================
async function initFirebase() {
  try {
    // Google Gemini Canvas Mode에서 자동 주입된 config 사용
    const configStr = typeof __firebase_config !== 'undefined' ? __firebase_config : null;
    const authToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
    
    if (!configStr) {
      console.warn('⚠️ Google Gemini Canvas Mode에서만 작동합니다. __firebase_config가 없습니다.');
      return false;
    }
    
    const firebaseConfig = JSON.parse(configStr);
    
    // Firebase 초기화 (이미 초기화되었으면 스킵)
    if (!firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    
    const auth = firebase.auth();
    db = firebase.firestore();
    
    // 로컬 지속성 설정
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    
    // Long Polling 설정 (Google Gemini 환경 최적화)
    try {
      db.settings({ experimentalForceLongPolling: true });
    } catch (e) {
      // 이미 설정된 경우 무시
    }
    
    // 인증 처리
    if (!auth.currentUser) {
      if (authToken) {
        await auth.signInWithCustomToken(authToken).catch(async () => {
          await auth.signInAnonymously();
        });
      } else {
        await auth.signInAnonymously();
      }
    }
    
    currentUser = auth.currentUser;
    
    if (!currentUser) {
      console.error('Firebase 인증 실패');
      return false;
    }
    
    // Firestore 컬렉션 참조 설정 (bundle.js 패턴)
    const basePath = `artifacts/${appId}/users/${currentUser.uid}`;
    sessionsCollectionRef = db.collection(`${basePath}/sessions`);
    userSettingsRef = db.collection(`${basePath}/settings`).doc('userSettings');
    
    // 사용자 설정 로드
    await loadUserSettingsFromFirebase();
    
    console.log('✅ Firebase 연결 완료! (사용자:', currentUser.uid, ')');
    return true;
    
  } catch (error) {
    console.error('Firebase 초기화 실패:', error);
    return false;
  }
}

// ============================================
// API 설정 관리 (bundle.js 패턴)
// ============================================

/**
 * Firestore에서 사용자 설정 로드
 */
async function loadUserSettingsFromFirebase() {
  try {
    const doc = await userSettingsRef.get();
    if (doc.exists) {
      const data = doc.data();
      userApiSettings = data.userApiSettings || {};
      console.log('✅ API 설정 로드 완료');
    } else {
      // 기본 설정 생성
      userApiSettings = {
        apiPresets: [{
          name: 'Default',
          provider: 'gemini',
          apiKey: '',
          model: 'gemini-2.0-flash-exp',
          tokensUsed: 0
        }]
      };
      await saveUserSettingsToFirebase();
    }
  } catch (error) {
    console.error('설정 로드 실패:', error);
    userApiSettings = {
      apiPresets: [{
        name: 'Default',
        provider: 'gemini',
        apiKey: '',
        model: 'gemini-2.0-flash-exp',
        tokensUsed: 0
      }]
    };
  }
}

/**
 * Firestore에 사용자 설정 저장
 */
async function saveUserSettingsToFirebase() {
  try {
    await userSettingsRef.set({
      userApiSettings: userApiSettings,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    console.log('✅ API 설정 저장 완료');
  } catch (error) {
    console.error('설정 저장 실패:', error);
  }
}

/**
 * API 키 가져오기 (현재 선택된 preset에서)
 */
function getApiKey() {
  const presets = userApiSettings.apiPresets || [];
  const currentPreset = presets[0];  // 첫 번째 preset 사용
  return currentPreset?.apiKey || '';
}

/**
 * API 설정 가져오기
 */
function getApiConfig() {
  const presets = userApiSettings.apiPresets || [];
  const currentPreset = presets[0];  // 첫 번째 preset 사용
  return {
    apiKey: currentPreset?.apiKey || '',
    model: currentPreset?.model || 'gemini-2.0-flash-exp',
    provider: currentPreset?.provider || 'gemini'
  };
}

/**
 * API 키 설정 (UI에서 호출)
 */
async function setApiKey(apiKey, model = 'gemini-2.0-flash-exp') {
  if (!userApiSettings.apiPresets) {
    userApiSettings.apiPresets = [];
  }
  
  // 첫 번째 preset 업데이트 또는 생성
  if (userApiSettings.apiPresets.length === 0) {
    userApiSettings.apiPresets.push({
      name: 'Default',
      provider: 'gemini',
      apiKey: apiKey,
      model: model,
      tokensUsed: 0
    });
  } else {
    userApiSettings.apiPresets[0].apiKey = apiKey;
    userApiSettings.apiPresets[0].model = model;
  }
  
  await saveUserSettingsToFirebase();
}

// ============================================
// 세션 관리 (Firestore SDK 사용)
// ============================================

/**
 * 세션 목록 로드
 */
async function loadSessions() {
  if (!db) {
    console.warn('Firebase 미초기화');
    return [];
  }
  
  try {
    const snapshot = await sessionsCollectionRef
      .orderBy('updatedAt', 'desc')
      .limit(50)
      .get();
    
    sessionsCache = [];
    snapshot.forEach(doc => {
      sessionsCache.push({ id: doc.id, ...doc.data() });
    });
    
    return sessionsCache;
  } catch (error) {
    console.error('세션 목록 로드 실패:', error);
    return [];
  }
}

/**
 * 세션 생성
 */
async function createSession(subject, initialShn) {
  if (!db) {
    console.warn('Firebase 미초기화');
    return null;
  }
  
  const sessionData = {
    subject: subject,
    shn: initialShn,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  
  try {
    const docRef = await sessionsCollectionRef.add(sessionData);
    currentSessionId = docRef.id;
    currentSubject = subject;
    console.log('✅ 새 세션 생성:', docRef.id);
    return docRef.id;
  } catch (error) {
    console.error('세션 생성 실패:', error);
    return null;
  }
}

/**
 * 세션 저장 (업데이트)
 */
async function saveSession(shn) {
  if (!db || !currentSessionId) {
    console.warn('저장 실패: Firebase 미초기화 또는 세션 없음');
    return;
  }
  
  try {
    await sessionsCollectionRef.doc(currentSessionId).update({
      shn: shn,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ 세션 저장 완료:', currentSessionId);
  } catch (error) {
    console.error('세션 저장 실패:', error);
  }
}

/**
 * 세션 로드
 */
async function loadSession(sessionId) {
  if (!db) {
    console.warn('Firebase 미초기화');
    return null;
  }
  
  try {
    const doc = await sessionsCollectionRef.doc(sessionId).get();
    if (!doc.exists) {
      console.warn('세션을 찾을 수 없음:', sessionId);
      return null;
    }
    
    const data = doc.data();
    currentSessionId = sessionId;
    currentSubject = data.subject;
    console.log('✅ 세션 로드 완료:', sessionId);
    return data.shn;
  } catch (error) {
    console.error('세션 로드 실패:', error);
    return null;
  }
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

/**
 * HTML → Markdown 변환 (bundle.js의 _convertHtmlToNarrativeSnapshot 기반)
 * @param {string} htmlContent - HTML 콘텐츠
 * @param {number} turn - 턴 번호
 * @returns {string} - Markdown 형식
 */
function convertHtmlToMarkdown(htmlContent, turn) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  
  let markdown = `\n\n## [턴 ${turn}]\n\n`;
  
  // Header 정보 추출
  const header = doc.querySelector('.header');
  if (header) {
    const mainTitle = header.querySelector('h1');
    const subtitle = header.querySelector('.subtitle');
    
    if (mainTitle) {
      markdown += `### @mainTitle: ${mainTitle.textContent.trim()}\n`;
    }
    if (subtitle) {
      markdown += `### @mainSubtitle: ${subtitle.textContent.trim()}\n`;
    }
    markdown += '\n';
  }
  
  // Content sections 파싱
  const contentSections = doc.querySelectorAll('.content-section');
  
  contentSections.forEach(section => {
    // Paragraph
    if (section.classList.contains('type-paragraph')) {
      const paragraphs = section.querySelectorAll('p');
      paragraphs.forEach(p => {
        markdown += `${p.textContent.trim()}\n\n`;
      });
    }
    
    // Blockquote
    else if (section.classList.contains('type-blockquote')) {
      const blockquote = section.querySelector('blockquote');
      if (blockquote) {
        const lines = blockquote.textContent.trim().split('\n');
        markdown += lines.map(line => `> ${line.trim()}`).join('\n') + '\n\n';
      }
    }
    
    // Heading
    else if (section.classList.contains('type-heading-h2')) {
      const h2 = section.querySelector('h2');
      if (h2) {
        markdown += `## ${h2.textContent.trim()}\n\n`;
      }
    }
    
    // Status Dashboard
    else if (section.classList.contains('type-status-dashboard')) {
      markdown += '### 상태 정보\n\n';
      
      const dashboardSections = section.querySelectorAll('.dashboard-section');
      dashboardSections.forEach(ds => {
        const title = ds.querySelector('.dashboard-section-title');
        const items = ds.querySelectorAll('.dashboard-item');
        
        if (title && items.length > 0) {
          markdown += `**${title.textContent.trim()}**\n`;
          items.forEach(item => {
            const key = item.querySelector('.key');
            const value = item.querySelector('.value');
            if (key && value) {
              markdown += `- **${key.textContent.trim()}:** ${value.textContent.trim()}\n`;
            }
          });
          markdown += '\n';
        }
      });
      
      markdown += '---\n\n';
    }
    
    // Ordered List (선택지)
    else if (section.classList.contains('type-ordered-list')) {
      markdown += '### 제시된 선택지\n\n';
      const items = section.querySelectorAll('li');
      items.forEach((item, idx) => {
        markdown += `${idx + 1}. ${item.textContent.trim()}\n`;
      });
      markdown += '\n';
    }
  });
  
  return markdown;
}

// Firebase 저장 (세션 기반) - bundle.js 구조 적용
async function saveCanvasToFirebase(content, title, canvasId) {
  if (!firebaseConfig) return;
  
  try {
    // data-turn 추출
    const turnMatch = content.match(/data-turn=["'](\d+)["']/i);
    const turn = turnMatch ? parseInt(turnMatch[1], 10) : 1;
    
    // data-subject (주제) 추출
    const subjectMatch = content.match(/data-subject=["']([^"']+)["']/i);
    const subject = subjectMatch ? subjectMatch[1] : 'General';
    
    // HTML → Markdown 변환
    const markdown = convertHtmlToMarkdown(content, turn);
    
    // 세션 ID 결정: 주제가 바뀌면 새 세션 생성
    if (!currentSessionId || currentSubject !== subject) {
      // 기존 세션 검색 (같은 주제)
      const existingSessions = await firestoreList('shn-sessions');
      const matchingSession = existingSessions.find(s => s.subject === subject);
      
      if (matchingSession) {
        currentSessionId = matchingSession._id;
      } else {
        // 새 세션 생성
        const sessionData = {
          subject: subject,
          title: `[${subject}] 서사 기록`,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          turnCount: 0
        };
        
        // Firestore REST API로 문서 생성 (자동 ID)
        const response = await fetch(
          `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/shn-sessions?key=${firebaseConfig.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: convertToFirestoreFields(sessionData) })
          }
        );
        
        if (!response.ok) throw new Error('세션 생성 실패');
        
        const doc = await response.json();
        currentSessionId = doc.name.split('/').pop();
      }
      
      currentSubject = subject;
    }
    
    // 턴 데이터를 세션의 하위 컬렉션에 저장
    const turnData = {
      turnNumber: turn,
      content: markdown,
      rawHtml: content,
      title: title,
      timestamp: serverTimestamp()
    };
    
    await firestoreSet(`shn-sessions/${currentSessionId}/turns`, `turn_${turn}`, turnData);
    
    // 세션의 턴 카운트 업데이트
    await firestoreSet('shn-sessions', currentSessionId, {
      updatedAt: serverTimestamp(),
      turnCount: turn,
      lastTurnTitle: title
    });
    
    console.log('✅ 세션 저장됨:', currentSessionId, '| 주제:', subject, '| 턴:', turn);
  } catch (e) {
    console.error('Canvas 저장 실패:', e);
  }
}

/**
 * Firestore 필드 변환 헬퍼
 */
function convertToFirestoreFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    fields[key] = convertToFirestoreValue(value);
  }
  return fields;
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
  
  // 현재 설정 가져오기
  const apiConfig = getApiConfig();
  const currentKey = apiConfig.apiKey || '';
  const currentModel = apiConfig.model || 'gemini-2.0-flash-exp';
  
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
      max-width: 600px;
      width: 90%;
      max-height: 85vh;
      overflow-y: auto;
      border: 1px solid var(--border, #2a2a4a);
    ">
      <h2 style="color: var(--accent, #ffd700); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
        ⚙️ The Edge - API 설정
        <button id="shn-settings-close" style="background: none; border: none; color: var(--text-dim, #888); font-size: 24px; cursor: pointer;">✕</button>
      </h2>
      
      <div style="margin-bottom: 20px; padding: 15px; background: var(--bg-info, #1a2332); border-left: 3px solid var(--accent, #ffd700); border-radius: 6px;">
        <p style="color: var(--text, #e8e8e8); font-size: 0.9rem; margin: 0;">
          🔒 <strong>Google Gemini Canvas Mode</strong>에서 실행 중입니다.<br>
          API 키는 Google의 Firestore에 안전하게 저장됩니다.
        </p>
      </div>
      
      <!-- 탭 버튼 -->
      <div style="display: flex; gap: 5px; margin-bottom: 20px; border-bottom: 1px solid var(--border, #2a2a4a); padding-bottom: 10px;">
        <button class="shn-tab-btn" data-tab="settings" style="
          padding: 8px 16px;
          background: var(--accent, #ffd700);
          color: #000;
          border: none;
          border-radius: 6px 6px 0 0;
          cursor: pointer;
          font-weight: bold;
        ">⚙️ 설정</button>
        <button class="shn-tab-btn" data-tab="sessions" style="
          padding: 8px 16px;
          background: var(--bg-card, #1a1a2e);
          color: var(--text-dim, #888);
          border: none;
          border-radius: 6px 6px 0 0;
          cursor: pointer;
        ">📚 세션</button>
      </div>
      
      <!-- 설정 탭 -->
      <div id="shn-tab-settings" class="shn-tab-content">
        <div style="margin-bottom: 25px;">
          <h3 style="color: var(--text, #e8e8e8); margin-bottom: 12px; font-size: 0.95rem;">
            🤖 Gemini API
          </h3>
          <div style="margin-bottom: 10px;">
            <label style="display: block; color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 4px;">API Key</label>
            <input type="password" id="shn-llm-apikey" value="${currentKey}" placeholder="AIza..." style="
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
              <option value="gemini-2.0-flash-exp" ${currentModel === 'gemini-2.0-flash-exp' ? 'selected' : ''}>Gemini 2.0 Flash (Experimental)</option>
              <option value="gemini-2.0-flash" ${currentModel === 'gemini-2.0-flash' ? 'selected' : ''}>Gemini 2.0 Flash</option>
              <option value="gemini-1.5-pro" ${currentModel === 'gemini-1.5-pro' ? 'selected' : ''}>Gemini 1.5 Pro</option>
              <option value="gemini-1.5-flash" ${currentModel === 'gemini-1.5-flash' ? 'selected' : ''}>Gemini 1.5 Flash</option>
            </select>
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
          ">💾 Firestore에 저장</button>
        </div>
        
        <p style="margin-top: 15px; font-size: 0.75rem; color: var(--text-dim, #888); text-align: center;">
          🔒 설정은 사용자 전용 Firestore 경로에 암호화되어 저장됩니다.
        </p>
      </div>
      
      <!-- 세션 탭 -->
      <div id="shn-tab-sessions" class="shn-tab-content" style="display: none;">
        <div style="margin-bottom: 15px; display: flex; gap: 10px;">
          <button id="shn-refresh-sessions" style="
            padding: 10px 16px;
            background: var(--bg-card, #1a1a2e);
            color: var(--text, #e8e8e8);
            border: 1px solid var(--border, #2a2a4a);
            border-radius: 6px;
            cursor: pointer;
          ">🔄 새로고침</button>
          <span id="shn-session-status" style="color: var(--text-dim, #888); font-size: 0.85rem; align-self: center;"></span>
        </div>
        
        <div id="shn-sessions-list" style="
          max-height: 400px;
          overflow-y: auto;
          border: 1px solid var(--border, #2a2a4a);
          border-radius: 8px;
          background: var(--bg-card, #1a1a2e);
        ">
          <p style="padding: 20px; color: var(--text-dim, #888); text-align: center;">
            세션을 로드하려면 새로고침을 클릭하세요.
          </p>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // 탭 전환 이벤트
  modal.querySelectorAll('.shn-tab-btn').forEach(btn => {
    btn.onclick = () => {
      const tabId = btn.dataset.tab;
      
      // 버튼 스타일 토글
      modal.querySelectorAll('.shn-tab-btn').forEach(b => {
        b.style.background = 'var(--bg-card, #1a1a2e)';
        b.style.color = 'var(--text-dim, #888)';
        b.style.fontWeight = 'normal';
      });
      btn.style.background = 'var(--accent, #ffd700)';
      btn.style.color = '#000';
      btn.style.fontWeight = 'bold';
      
      // 탭 콘텐츠 토글
      modal.querySelectorAll('.shn-tab-content').forEach(c => c.style.display = 'none');
      document.getElementById('shn-tab-' + tabId).style.display = 'block';
    };
  });
  
  // 이벤트 바인딩
  document.getElementById('shn-settings-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  document.getElementById('shn-settings-save').onclick = async () => {
    const apiKey = document.getElementById('shn-llm-apikey').value.trim();
    const model = document.getElementById('shn-llm-model').value;
    
    if (!apiKey) {
      alert('API 키를 입력해주세요.');
      return;
    }
    
    if (!db) {
      alert('Firebase가 초기화되지 않았습니다. Google Gemini Canvas Mode에서 실행해주세요.');
      return;
    }
    
    const btn = document.getElementById('shn-settings-save');
    btn.disabled = true;
    btn.textContent = '💾 저장 중...';
    
    try {
      await setApiKey(apiKey, model);
      
      // 성공 피드백
      btn.textContent = '✅ Firestore에 저장됨!';
      btn.style.background = 'var(--success, #4ecca3)';
      setTimeout(() => modal.remove(), 1200);
    } catch (error) {
      console.error('설정 저장 실패:', error);
      alert(`저장 실패: ${error.message}`);
      btn.disabled = false;
      btn.textContent = '💾 Firestore에 저장';
      btn.style.background = 'var(--accent, #ffd700)';
    }
  };
  
  // 세션 새로고침 이벤트
  document.getElementById('shn-refresh-sessions').onclick = loadSessionsList;
}

/**
 * 세션 목록 로드 (Firebase에서)
 */
async function loadSessionsList() {
  const statusEl = document.getElementById('shn-session-status');
  const listEl = document.getElementById('shn-sessions-list');
  
  // Firebase 설정 확인
  if (!initFirebase()) {
    listEl.innerHTML = '<p style="padding: 20px; color: var(--error, #ff6b6b); text-align: center;">⚠️ Firebase 설정이 필요합니다.</p>';
    return;
  }
  
  statusEl.textContent = '로딩 중...';
  listEl.innerHTML = '<p style="padding: 20px; color: var(--text-dim, #888); text-align: center;">⏳ 세션 로딩 중...</p>';
  
  try {
    // 세션 목록 조회 (shn-sessions 컬렉션)
    const sessions = await firestoreList('shn-sessions');
    
    // updatedAt으로 정렬 (최신순)
    sessions.sort((a, b) => {
      const aTime = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : 0;
      const bTime = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : 0;
      return bTime - aTime;
    });
    
    sessionsCache = sessions;
    
    if (sessions.length === 0) {
      listEl.innerHTML = '<p style="padding: 20px; color: var(--text-dim, #888); text-align: center;">저장된 세션이 없습니다.</p>';
      statusEl.textContent = '0개 세션';
      return;
    }
    
    statusEl.textContent = `${sessions.length}개 세션`;
    
    // 세션 목록 렌더링
    listEl.innerHTML = sessions.map((session, idx) => `
      <div class="shn-session-item" data-idx="${idx}" style="
        padding: 12px 15px;
        border-bottom: 1px solid var(--border, #2a2a4a);
        cursor: pointer;
        transition: background 0.2s;
      " onmouseover="this.style.background='rgba(255,215,0,0.1)'" onmouseout="this.style.background='transparent'">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="color: var(--text, #e8e8e8); font-weight: 500; margin-bottom: 4px;">
              ${escapeHtml(session.title || session.theme || 'Untitled')}
            </div>
            <div style="color: var(--text-dim, #888); font-size: 0.8rem;">
              ${session.turnCount || 0} 턴 · ${formatDate(session.updatedAt)}
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="shn-session-export" data-idx="${idx}" title="JSON 내보내기" style="
              padding: 6px 10px;
              background: var(--bg-card, #1a1a2e);
              color: var(--accent, #ffd700);
              border: 1px solid var(--accent, #ffd700);
              border-radius: 4px;
              cursor: pointer;
              font-size: 0.85rem;
            ">📥</button>
          </div>
        </div>
      </div>
    `).join('');
    
    // 내보내기 버튼 이벤트
    listEl.querySelectorAll('.shn-session-export').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        await exportSessionAsJSON(sessionsCache[idx]);
      };
    });
    
    // 세션 클릭 이벤트 (상세 보기)
    listEl.querySelectorAll('.shn-session-item').forEach(item => {
      item.onclick = async () => {
        const idx = parseInt(item.dataset.idx);
        await showSessionDetail(sessionsCache[idx]);
      };
    });
    
  } catch (error) {
    console.error('세션 로드 실패:', error);
    listEl.innerHTML = `<p style="padding: 20px; color: var(--error, #ff6b6b); text-align: center;">❌ 로드 실패: ${error.message}</p>`;
    statusEl.textContent = '오류';
  }
}

/**
 * 세션 상세 보기
 */
async function showSessionDetail(session) {
  const listEl = document.getElementById('shn-sessions-list');
  const statusEl = document.getElementById('shn-session-status');
  
  statusEl.textContent = '턴 로딩 중...';
  
  try {
    // 세션의 턴들 조회 (하위 컬렉션)
    const turns = await firestoreList(`shn-sessions/${session._id}/turns`, 'turnNumber', 100);
    
    // 기존 추출 데이터 확인
    let existingExtraction = null;
    try {
      existingExtraction = await firestoreGet('extractions', session._id + '_micro');
    } catch (e) { /* 없으면 무시 */ }
    
    listEl.innerHTML = `
      <div style="padding: 15px;">
        <button id="shn-back-to-list" style="
          padding: 8px 12px;
          background: transparent;
          color: var(--text-dim, #888);
          border: 1px solid var(--border, #2a2a4a);
          border-radius: 4px;
          cursor: pointer;
          margin-bottom: 15px;
        ">← 목록으로</button>
        
        <h3 style="color: var(--accent, #ffd700); margin-bottom: 10px;">
          ${escapeHtml(session.title || session.theme || 'Untitled')}
        </h3>
        <p style="color: var(--text-dim, #888); font-size: 0.85rem; margin-bottom: 15px;">
          ${session.turnCount || 0} 턴 · 생성: ${formatDate(session.createdAt)}
          ${existingExtraction ? ' · <span style="color: var(--success, #4ecca3);">✓ 추출됨</span>' : ''}
        </p>
        
        <!-- 내보내기 옵션 -->
        <div style="margin-bottom: 20px; padding: 15px; background: var(--bg-card, #1a1a2e); border-radius: 8px; border: 1px solid var(--border, #2a2a4a);">
          <h4 style="color: var(--text, #e8e8e8); margin-bottom: 12px; font-size: 0.9rem;">📥 내보내기</h4>
          
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
            <button id="shn-export-raw" style="
              padding: 8px 14px;
              background: var(--bg-secondary, #12121e);
              color: var(--text, #e8e8e8);
              border: 1px solid var(--border, #2a2a4a);
              border-radius: 6px;
              cursor: pointer;
              font-size: 0.85rem;
            ">📄 Raw JSON</button>
            <button id="shn-export-extracted" style="
              padding: 8px 14px;
              background: ${existingExtraction ? 'var(--accent, #ffd700)' : 'var(--bg-secondary, #12121e)'};
              color: ${existingExtraction ? '#000' : 'var(--text-dim, #888)'};
              border: 1px solid ${existingExtraction ? 'var(--accent, #ffd700)' : 'var(--border, #2a2a4a)'};
              border-radius: 6px;
              cursor: pointer;
              font-size: 0.85rem;
            " ${existingExtraction ? '' : 'disabled'}>🧠 추출 데이터</button>
          </div>
          
          <p style="font-size: 0.75rem; color: var(--text-dim, #888);">
            ${existingExtraction ? 
              `마지막 추출: ${formatDate(existingExtraction.extractedAt)}` : 
              'LLM 추출을 먼저 실행하세요.'
            }
          </p>
        </div>
        
        <!-- LLM 추출 -->
        <div style="margin-bottom: 20px; padding: 15px; background: var(--bg-card, #1a1a2e); border-radius: 8px; border: 1px solid var(--border, #2a2a4a);">
          <h4 style="color: var(--text, #e8e8e8); margin-bottom: 12px; font-size: 0.9rem;">🧠 데이터 정제 (Narrative Data Refiner)</h4>
          
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
            <button id="shn-extract-micro" style="
              padding: 10px 18px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              border: none;
              border-radius: 6px;
              cursor: pointer;
              font-size: 0.9rem;
              font-weight: 500;
            ">⚙️ 데이터 정제 시작</button>
          </div>
          
          <p style="font-size: 0.75rem; color: var(--text-dim, #888); line-height: 1.5;">
            턴 단위로 Markdown 데이터를 SHN JSON으로 변환합니다.<br>
            청킹 크기를 입력하면 순차적으로 처리됩니다.
          </p>
          </div>
          
          <p style="font-size: 0.75rem; color: var(--text-dim, #888); line-height: 1.5;">
            턴 단위로 Markdown 데이터를 SHN JSON으로 변환합니다.<br>
            청킹 크기를 입력하면 순차적으로 처리됩니다. (예: 10턴씩)
          </p>
          
          <div id="shn-extraction-progress" style="display: none; margin-top: 12px; padding: 12px; background: rgba(102, 126, 234, 0.1); border-radius: 6px; border: 1px solid rgba(102, 126, 234, 0.3);">
            <p id="shn-progress-text" style="font-size: 0.85rem; color: var(--text, #e8e8e8); margin-bottom: 8px;">처리 중...</p>
            <div style="background: var(--bg-secondary, #12121e); border-radius: 4px; height: 8px; overflow: hidden;">
              <div id="shn-progress-bar" style="background: linear-gradient(90deg, #667eea 0%, #764ba2 100%); height: 100%; width: 0%; transition: width 0.3s;"></div>
            </div>
          </div>
        </div>
        
        <!-- 턴 목록 -->
        <h4 style="color: var(--text, #e8e8e8); margin-bottom: 10px;">턴 목록</h4>
        <div id="shn-turns-list" style="
          max-height: 200px;
          overflow-y: auto;
          border: 1px solid var(--border, #2a2a4a);
          border-radius: 6px;
        ">
          ${turns.length === 0 ? 
            '<p style="padding: 15px; color: var(--text-dim, #888); text-align: center;">턴 데이터 없음</p>' :
            turns.map((turn, idx) => `
              <div style="padding: 10px 15px; border-bottom: 1px solid var(--border, #2a2a4a); color: var(--text, #e8e8e8); font-size: 0.9rem;">
                <strong>턴 ${turn.turnNumber || idx + 1}</strong>
                ${turn.sceneTitle ? ` - ${escapeHtml(turn.sceneTitle)}` : ''}
              </div>
            `).join('')
          }
        </div>
      </div>
    `;
    
    statusEl.textContent = `${turns.length} 턴`;
    
    // 뒤로가기
    document.getElementById('shn-back-to-list').onclick = loadSessionsList;
    
    // Raw JSON 내보내기
    document.getElementById('shn-export-raw').onclick = () => exportSessionAsJSON(session, turns, 'raw');
    
    // 추출 데이터 내보내기
    const exportExtractedBtn = document.getElementById('shn-export-extracted');
    if (existingExtraction) {
      exportExtractedBtn.onclick = () => exportSessionAsJSON(session, turns, 'extracted', existingExtraction);
    }
    
    // LLM 추출 버튼 이벤트 (단일 버튼)
    document.getElementById('shn-extract-micro').onclick = () => runExtraction(session, turns);
    
  } catch (error) {
    console.error('세션 상세 로드 실패:', error);
    listEl.innerHTML = `<p style="padding: 20px; color: var(--error, #ff6b6b);">❌ 로드 실패: ${error.message}</p>`;
  }
}

/**
 * Narrative Data Refiner 프롬프트 템플릿 (bundle.js TEMPLATE_NARRATIVE_DATA_REFINER 참조)
 */
const NARRATIVE_DATA_REFINER_PROMPT = `You are a 'State Reconstruction Engine'. Your sole purpose is to convert one or more narrative turn logs, written in Markdown, back into complete, minified SHN (State History Narrative) JSON objects.

**ABSOLUTE LAW:** Your final output MUST be a single code block. Inside this block, each generated JSON object must be separated by a comma. There must be NO other text or explanation.

---
### **Core Task: Multiple Markdown Logs -> Multiple SHN JSON Objects**

You will receive a Markdown text containing one or more 'turn' blocks, each starting with \`## [턴 N]\`. Your task is to:
1.  Identify each individual \`## [턴 N]\` block.
2.  For **EACH** block, parse it and construct one complete SHN JSON object representing the state at the end of that specific turn.
3.  Combine all the generated JSON objects into a single response, separating each object with a comma.

---
### **SHN Schema & Rules (MANDATORY)**

For each turn block, you MUST construct a JSON object with the following structure:
1.  **Root Structure:** The JSON root must have: \`m\`, \`p\`, \`s\`, \`x\`, \`h\`, \`z\`. Populate them with plausible data inferred from the log.
2.  **Chronicle (\`h\`):** Must be an array with one object for the turn. This object must contain:
    *   \`nt\` (narrative_text): From the "### 생성된 서사" section.
    *   \`sc\` (selected_choice): From the "### 사용자 선택" section.
    *   \`pc\` (presented_choices): An array of strings from the "### 제시된 선택지" section.
    *   \`ss\` (state_snapshot): An object reconstructed from "### 상태 정보" and "### 주변 탐색". Use the minified keys below.
3.  **Last Snapshot (\`z\`):** The \`z.ss\` key must be a direct copy of the \`ss\` object you just constructed for that turn.
4.  **World State (\`x\`):** The \`x.tn\` key must be the turn number from that turn's \`## [턴 N]\` heading.
5.  **Headers (\`ss\`):** Identify the **very last** \`## [턴 N]\` block within the entire input you receive. **ONLY** for this last block, scan for \`### @mainTitle: ...\` and \`### @mainSubtitle: ...\`. If found, their content MUST be stored in that turn's \`ss\` object with the keys \`mt\` and \`mst\` respectively. All other preceding turn blocks MUST NOT include these keys.

---
### **[CRITICAL] Minified Key Dictionary (Label -> Key)**

*   "생명력" / "체력": "hp"
*   "@mainTitle": "mt"
*   "@mainSubtitle": "mst"
*   "정신력": "sp"
*   "허기": "hg"
*   "갈증": "th"
*   "피로": "fg"
*   "체온": "tp"
*   "희망": "ho"
*   "주변 온도": "at"
*   "날씨": "we"
*   "달의 위상" / "월령": "lp"
*   "장소" / "현재 위치": "lc"
*   "이름": "nm"
*   "나이": "ag"
*   "상태": "st"
*   "🚨 CRITICAL" / "위험": "cs"
*   "현재 날짜": "dt"
*   "현재 시간": "tm"
*   "경과": "el"
*   "감각": "sn"
*   "바람": "wd"
*   "소지품": "iv"
*   "진행중인 사건": "ev"
*   The full Markdown table from "### 주변 탐색" -> value for the "scan" key.`;

// ============================================
// LLM API 호출 (Gemini)
// ============================================

/**
 * Gemini API 호출 함수
 */
async function callLLM(userMessage, systemPrompt = '') {
  const apiConfig = getApiConfig();
  
  if (!apiConfig.apiKey) {
    throw new Error('API 키가 설정되지 않았습니다.');
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${apiConfig.model}:generateContent?key=${apiConfig.apiKey}`;
  
  // 시스템 프롬프트와 사용자 메시지 결합
  const fullPrompt = systemPrompt 
    ? `${systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage;
  
  const requestBody = {
    contents: [{
      parts: [{ text: fullPrompt }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API 호출 실패: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
    throw new Error('응답 형식이 올바르지 않습니다.');
  }
  
  const textParts = data.candidates[0].content.parts || [];
  const resultText = textParts.map(p => p.text || '').join('');
  
  // 코드 블록 제거 (```json ... ``` 또는 ```...```)
  const codeBlockMatch = resultText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  
  return resultText.trim();
}

/**
 * LLM 추출 실행 (bundle.js 방식 - 청킹 + 순차 처리)
 */
async function runExtraction(session, turns) {
  const apiConfig = getApiConfig();
  if (!apiConfig.apiKey) {
    alert('Gemini API 키가 필요합니다.\nFirebase에 저장하려면 아래 함수를 사용하세요:\nwindow.SHNCanvas.setApiKey("YOUR_API_KEY")');
    return;
  }
  
  // 턴 수 입력 프롬프트
  const chunkSizeStr = prompt('몇 개의 턴을 한 묶음으로 처리할까요?\n(기본값: 10, 최대 100)', '10');
  if (!chunkSizeStr) return; // 취소
  
  const chunkSize = Math.max(1, Math.min(100, parseInt(chunkSizeStr, 10) || 10));
  
  const progressEl = document.getElementById('shn-extraction-progress');
  const progressBar = document.getElementById('shn-progress-bar');
  const progressText = document.getElementById('shn-progress-text');
  const statusEl = document.getElementById('shn-session-status');
  
  progressEl.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = '추출 준비 중...';
  
  try {
    // 1. 모든 턴을 Markdown 형식으로 변환
    const allMarkdown = turns.map(t => {
      const content = t.content || t.narrative || '';
      // 이미 "## [턴 N]" 형식이면 그대로, 아니면 추가
      if (content.trim().startsWith('## [턴')) {
        return content;
      } else {
        return `## [턴 ${t.turnNumber}]\n\n${content}`;
      }
    }).join('\n\n');
    
    // 2. "## [턴" 기준으로 분리
    const turnBlocks = allMarkdown.split(/(?=## \[턴)/).filter(b => b.trim());
    
    // 3. chunkSize만큼 묶기
    const chunks = [];
    for (let i = 0; i < turnBlocks.length; i += chunkSize) {
      chunks.push(turnBlocks.slice(i, i + chunkSize).join('\n\n'));
    }
    
    if (chunks.length === 0) {
      throw new Error('처리할 턴 데이터가 없습니다.');
    }
    
    // 4. 순차 처리
    const accumulatedResults = [];
    for (let i = 0; i < chunks.length; i++) {
      progressText.textContent = `데이터 정제 중... (${i + 1}/${chunks.length})`;
      progressBar.style.width = `${((i + 1) / chunks.length) * 100}%`;
      
      const userMessage = `--- 데이터 시작 ---\n${chunks[i]}\n--- 데이터 끝 ---`;
      
      // LLM API 호출
      const result = await callLLM(userMessage, NARRATIVE_DATA_REFINER_PROMPT);
      accumulatedResults.push(result);
      
      // API 과부하 방지 (마지막 청크 제외)
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2초 대기
      }
    }
    
    // 5. 결과 병합 (쉼표로 구분된 JSON 객체들)
    const finalResult = accumulatedResults.filter(r => r.trim()).join(',\n');
    
    progressBar.style.width = '100%';
    progressText.textContent = '✅ 추출 완료!';
    
    // 6. Firebase에 저장 (선택 사항)
    if (db && currentSessionId) {
      try {
        const extractionRef = sessionsCollectionRef.doc(currentSessionId)
          .collection('extractions')
          .doc(`extraction_${Date.now()}`);
        
        await extractionRef.set({
          chunkSize,
          totalChunks: chunks.length,
          result: finalResult,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        statusEl.textContent = '✅ 추출 결과가 Firestore에 저장되었습니다.';
      } catch (saveError) {
        console.warn('Firebase 저장 실패:', saveError);
        statusEl.textContent = '⚠️ 추출 완료 (저장 실패)';
      }
    } else {
      statusEl.textContent = '✅ 추출 완료!';
    }
    
    // 7. 결과 표시 (콘솔)
    console.log('=== 추출 결과 ===');
    console.log(finalResult);
    console.log('================');
    
    // 8. 다운로드 옵션 제공
    const shouldDownload = confirm('추출 결과를 JSON 파일로 다운로드하시겠습니까?');
    if (shouldDownload) {
      const blob = new Blob([`[${finalResult}]`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename(session.title || session.subject || 'session')}_refined_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    
    setTimeout(() => {
      progressEl.style.display = 'none';
      statusEl.textContent = '';
    }, 3000);
    
  } catch (error) {
    console.error('추출 실패:', error);
    progressText.textContent = '❌ 추출 실패';
    statusEl.textContent = `❌ 오류: ${error.message}`;
    setTimeout(() => {
      progressEl.style.display = 'none';
      statusEl.textContent = '';
    }, 3000);
  }
}

/**
 * 세션을 SHN JSON 파일로 내보내기
 * @param {object} session - 세션 데이터
 * @param {array} turns - 턴 데이터
 * @param {string} exportType - 'raw' 또는 'extracted'
 * @param {object} extractionData - 추출 데이터 (optional)
 */
async function exportSessionAsJSON(session, turns, exportType, extractionData) {
  if (exportType === undefined) exportType = 'raw';
  
  const statusEl = document.getElementById('shn-session-status');
  
  try {
    statusEl.textContent = '내보내기 준비 중...';
    
    // 턴 데이터가 없으면 로드
    if (!turns) {
      turns = await firestoreList(`sessions/${session._id}/turns`, 'turnNumber', 100);
    }
    
    let shnData;
    let filenamePrefix;
    
    if (exportType === 'extracted' && extractionData) {
      // 추출 데이터 포맷
      filenamePrefix = 'shn_extracted';
      
      // 모든 추출 레벨 데이터 가져오기
      let microData = null, mesoData = null, macroData = null;
      
      try {
        microData = await firestoreGet('extractions', session._id + '_micro');
      } catch (e) { /* 없으면 무시 */ }
      
      try {
        mesoData = await firestoreGet('extractions', session._id + '_meso');
      } catch (e) { /* 없으면 무시 */ }
      
      try {
        macroData = await firestoreGet('extractions', session._id + '_macro');
      } catch (e) { /* 없으면 무시 */ }
      
      shnData = {
        meta: {
          version: "shn-lite-1.0",
          format: "extracted",
          exportedAt: new Date().toISOString(),
          sessionId: session._id,
          title: session.title || session.theme || 'Untitled',
          theme: session.theme,
          turnCount: session.turnCount || turns.length
        },
        extraction: {
          micro: microData ? {
            extractedAt: microData.extractedAt,
            data: microData.data
          } : null,
          meso: mesoData ? {
            extractedAt: mesoData.extractedAt,
            data: mesoData.data
          } : null,
          macro: macroData ? {
            extractedAt: macroData.extractedAt,
            data: macroData.data
          } : null
        },
        // 원본 데이터도 포함 (선택적)
        rawTurns: turns.map(t => ({
          turnNumber: t.turnNumber,
          sceneTitle: t.sceneTitle,
          timestamp: t.timestamp
        }))
      };
      
    } else {
      // Raw 데이터 포맷
      filenamePrefix = 'shn_raw';
      
      shnData = {
        meta: {
          version: "shn-lite-1.0",
          format: "raw",
          exportedAt: new Date().toISOString(),
          sessionId: session._id,
          title: session.title || session.theme || 'Untitled',
          theme: session.theme,
          turnCount: session.turnCount || turns.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        },
        session: {
          ...session,
          _id: undefined
        },
        turns: turns.map(t => ({
          ...t,
          _id: undefined
        }))
      };
    }
    
    // JSON 파일 다운로드
    const blob = new Blob([JSON.stringify(shnData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}_${sanitizeFilename(session.title || session.theme || 'session')}_${session._id || Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    statusEl.textContent = '✅ 내보내기 완료!';
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2000);
    
  } catch (error) {
    console.error('내보내기 실패:', error);
    statusEl.textContent = '❌ 내보내기 실패';
  }
}

/**
 * 유틸: HTML 이스케이프
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 유틸: 날짜 포맷
 */
function formatDate(dateValue) {
  if (!dateValue) return '-';
  try {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    return date.toLocaleDateString('ko-KR', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  } catch {
    return '-';
  }
}

/**
 * 유틸: 파일명 정리
 */
function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 50);
}

// ============================================
// 전역 노출
// ============================================
global.renderAppShell = renderAppShell;
global.SHNCanvas = {
  // 앱 렌더링
  renderAppShell: renderAppShell,
  
  // Firebase 초기화 및 인증
  initFirebase: initFirebase,
  
  // API 설정 관리 (bundle.js 패턴)
  getApiKey: getApiKey,
  getApiConfig: getApiConfig,
  setApiKey: setApiKey,
  loadUserSettingsFromFirebase: loadUserSettingsFromFirebase,
  saveUserSettingsToFirebase: saveUserSettingsToFirebase,
  
  // 세션 관리
  loadSessions: loadSessions,
  createSession: createSession,
  saveSession: saveSession,
  loadSession: loadSession,
  
  // 세션 UI
  loadSessionsList: loadSessionsList,
  showSessionDetail: showSessionDetail,
  
  // 데이터 추출
  runExtraction: runExtraction,
  exportSessionAsJSON: exportSessionAsJSON,
  
  // 설정 UI
  openSettingsModal: openSettingsModal,
  createSettingsButton: createSettingsButton,
  
  // 내부 상태 접근 (디버깅용)
  _getState: () => ({
    db: db,
    currentUser: currentUser,
    currentSessionId: currentSessionId,
    userApiSettings: userApiSettings
  })
};

// 자동 초기화
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async function() {
      console.log('📜 SHN Canvas 로드됨 (Google Gemini Canvas Mode)');
      
      // Firebase 자동 초기화 시도
      const initialized = await initFirebase();
      if (initialized) {
        console.log('✅ Firebase 자동 초기화 완료');
      } else {
        console.warn('⚠️ Firebase 초기화 실패 - Google Gemini Canvas Mode에서만 작동합니다');
      }
      
      createSettingsButton();
    });
  } else {
    console.log('📜 SHN Canvas 로드됨 (Google Gemini Canvas Mode)');
    initFirebase().then(initialized => {
      if (initialized) {
        console.log('✅ Firebase 자동 초기화 완료');
      } else {
        console.warn('⚠️ Firebase 초기화 실패 - Google Gemini Canvas Mode에서만 작동합니다');
      }
    });
    createSettingsButton();
  }
}

})(typeof window !== 'undefined' ? window : this);
