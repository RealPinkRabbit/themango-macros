// ==UserScript==
// @name         더망고 신규상품수집 - 개별 진행(필터 순차 자동수집)
// @namespace    solddeul.tmg
// @version      1.0
// @description  신규상품등록(getGoodsCategory.php) 필터 목록을 필터이름순(고정 정렬)으로 순회하며, 필터 1개 체크→"선택필터 신규상품수집" 실행→완료 로그 확인→새로고침을 모든 페이지/필터에 반복 적용. 저장상품수가 임계값을 초과한 필터는 건너뜀. 팝업창은 건드리지 않음.
// @match        https://tmg4682.mycafe24.com/mall/admin/shop/getGoodsCategory.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

var LS_RUN   = 'tmg_ind_run_v1';    // {running, idx, ok, fail}
var LS_QUEUE = 'tmg_ind_queue_v1';  // [{id, site, label, name, saved}]
var SORT = 'title_asc';             // 필터이름순 고정: 수집 중 최근수집일이 바뀌어도 목록 순서가 변하지 않음
var PAGE_SIZE = 100;
var POLL_MS = 1500;
var TIMEOUT_MS = 10*60*1000;        // 필터당 최대 대기(페이지 많은 필터 고려)
var DONE_TEXT = '신규상품수집이 모두 완료되었습니다';
var ERR_HINTS = ['오류가 발생', '실패하였습니다'];

var DIR = location.pathname.replace(/[^/]+$/,'');
var LIST_URL = DIR + 'getGoodsCategory.php';

var stopFlag = false;

function q(s){ return document.querySelector(s); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function gr(){ try{ return JSON.parse(localStorage.getItem(LS_RUN)) || null; }catch(e){ return null; } }
function sr(s){ localStorage.setItem(LS_RUN, JSON.stringify(s)); }
function gq(){ try{ return JSON.parse(localStorage.getItem(LS_QUEUE)) || []; }catch(e){ return []; } }
function sq(list){ localStorage.setItem(LS_QUEUE, JSON.stringify(list)); }
function clearRun(){ localStorage.removeItem(LS_RUN); localStorage.removeItem(LS_QUEUE); }

function pageOf(idx){ return Math.floor(idx / PAGE_SIZE) + 1; }
function buildUrl(pg){ return LIST_URL + '?ft_sort=' + SORT + '&ft_num=' + PAGE_SIZE + '&pg=' + pg + '&_ts=' + Date.now(); }
function onCorrectPage(pg){
  var p = new URLSearchParams(location.search);
  return p.get('ft_sort') === SORT && String(p.get('ft_num')) === String(PAGE_SIZE) && String(p.get('pg') || '1') === String(pg);
}

// ---------- 목록 조회(fetch, 읽기 전용) ----------
async function fetchPageRows(pg){
  var url = LIST_URL + '?ft_sort=' + SORT + '&ft_num=' + PAGE_SIZE + '&pg=' + pg;
  var html = await fetch(url, {credentials:'same-origin'}).then(function(r){ return r.text(); });
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var cbs = Array.prototype.slice.call(doc.querySelectorAll('input[name=chk_value]'));
  return cbs.map(function(cb){
    var tr = cb.closest('tr');
    var tds = tr.children;
    var siteLabel = tds[1] ? tds[1].textContent.trim() : '';
    var nameInput = tr.querySelector('input[type=text]');
    var name = nameInput ? nameInput.value : '';
    var cntText = tds[4] ? tds[4].textContent : '';
    var m = cntText.match(/(\d+)\s*개\s*\/\s*(\d+)\s*개/);   // "저장상품 N개 / 휴지통 M개"
    var saved = m ? parseInt(m[1], 10) : 0;
    var parts = cb.value.split('|');
    return { id: parts[0], site: parts[1] || '', label: siteLabel, name: name, saved: saved };
  });
}

async function buildQueue(siteFilter, threshold){
  var all = [];
  for(var pg=1; pg<300; pg++){
    var rows = await fetchPageRows(pg);
    if(!rows.length) break;
    all = all.concat(rows);
    if(rows.length < PAGE_SIZE) break;
  }
  return all.filter(function(r){
    if(siteFilter && r.site !== siteFilter) return false;
    return r.saved <= threshold;   // 저장상품수가 임계값 초과인 필터는 건너뜀
  });
}

// ---------- 실행(라이브 페이지 조작) ----------
async function waitForCompletion(){
  var t0 = Date.now();
  while(Date.now() - t0 < TIMEOUT_MS){
    if(stopFlag) return 'stopped';
    var el = q('#layer_page');
    var txt = el ? el.textContent : '';
    if(txt.indexOf(DONE_TEXT) >= 0) return 'ok';
    for(var i=0;i<ERR_HINTS.length;i++){ if(txt.indexOf(ERR_HINTS[i]) >= 0) return 'error'; }
    await sleep(POLL_MS);
  }
  return 'timeout';
}

async function advance(state, queue){
  state.idx++;
  sr(state);
  if(state.idx >= queue.length){
    setStat('전체 완료 — 총 ' + queue.length + ' | 완료 ' + state.ok + ' · 실패 ' + state.fail);
    setBtns(false);
    clearRun();
    return;
  }
  await sleep(600);
  location.href = buildUrl(pageOf(state.idx));
}

async function processCurrentItem(state, queue){
  var item = queue[state.idx];
  setStat('진행 ' + (state.idx+1) + '/' + queue.length + ' — ' + item.name + ' 처리 중...');

  var cb = document.querySelector('input[name=chk_value][value^="' + item.id + '|"]');
  if(!cb){
    state.fail++;
    return advance(state, queue);
  }
  Array.prototype.slice.call(document.querySelectorAll('input[name=chk_value]')).forEach(function(c){ c.checked = false; });
  cb.checked = true;

  var btn = q('#start_button');
  if(!btn){
    state.fail++;
    return advance(state, queue);
  }
  btn.click();   // ※ 팝업(스크래퍼 창)은 건드리지 않고 로그만 확인

  var result = await waitForCompletion();
  if(result === 'stopped'){
    sr(state);
    setStat('정지됨 (' + state.idx + '/' + queue.length + ') 완료 ' + state.ok + ' · 실패 ' + state.fail);
    setBtns(false);
    return;
  }
  if(result === 'ok') state.ok++; else state.fail++;
  return advance(state, queue);
}

async function resume(){
  var state = gr();
  if(!state || !state.running) return;
  var queue = gq();
  if(!queue.length){ clearRun(); return; }
  if(state.idx >= queue.length){
    setStat('전체 완료 — 총 ' + queue.length + ' | 완료 ' + state.ok + ' · 실패 ' + state.fail);
    setBtns(false);
    clearRun();
    return;
  }
  var pg = pageOf(state.idx);
  if(!onCorrectPage(pg)){
    location.href = buildUrl(pg);
    return;
  }
  stopFlag = false;
  setBtns(true);
  setStat('진행 ' + (state.idx+1) + '/' + queue.length + ' 준비 중...');
  await processCurrentItem(state, queue);
}

async function start(){
  var threshold = parseInt((q('#tmgIndThreshold') && q('#tmgIndThreshold').value) || '3', 10);
  if(!(threshold >= 0)){ alert('건너뛸 기준 값을 올바르게 입력하세요.'); return; }
  var siteFilter = (q('#tmgIndSite') && q('#tmgIndSite').value) || '';

  setBtns(true);
  setStat('대상 필터 조회 중...');
  var queue;
  try{ queue = await buildQueue(siteFilter, threshold); }
  catch(e){ setStat('대상 조회 실패: ' + e.message); setBtns(false); return; }
  if(!queue.length){ setStat('대상 필터가 없습니다.(모두 임계값 초과 또는 조건에 맞는 필터 없음)'); setBtns(false); return; }

  sq(queue);
  sr({ running:true, idx:0, ok:0, fail:0 });
  stopFlag = false;
  location.href = buildUrl(pageOf(0));
}

function stop(){
  stopFlag = true;
  var state = gr();
  if(state){ state.running = false; sr(state); }
  setStat('정지 요청됨 — 현재 항목 완료 후 멈춥니다.');
}

// ---------- UI ----------
function setStat(m){ var el = q('#tmgIndStat'); if(el) el.textContent = m; }
function setBtns(running){
  var go = q('#tmgIndGo'), sb = q('#tmgIndStop');
  if(go){ go.disabled = running; go.textContent = running ? '실행중...' : '시작'; }
  if(sb) sb.style.display = running ? '' : 'none';
}
function ui(){
  if(q('#tmgIndPanel')) return;
  var p = document.createElement('div');
  p.id = 'tmgIndPanel';
  p.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:2147483647;background:#fff;border:2px solid #5cb85c;border-radius:8px;padding:10px 12px;width:280px;font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML = '<div style="font-weight:bold;margin-bottom:6px">신규상품수집 개별 진행</div>'
   +'<div style="margin-bottom:4px">건너뛸 기준(저장상품수 초과): <input id="tmgIndThreshold" type="number" value="3" min="0" style="width:50px"> 개</div>'
   +'<div style="margin-bottom:4px">대상: <select id="tmgIndSite"><option value="">전체</option><option value="a_rt">ABCmart</option><option value="zara_de">Zara.com/de</option></select></div>'
   +'<button id="tmgIndGo">시작</button> <button id="tmgIndStop" style="display:none;color:#d9534f">정지</button>'
   +'<div id="tmgIndStat" style="margin-top:8px;color:#333;min-height:32px">대기중</div>'
   +'<div style="margin-top:6px;color:#888;font-size:11px">※ 진행 중 페이지가 계속 새로고침됩니다. 팝업창은 건드리지 마세요.</div>';
  document.body.appendChild(p);
  q('#tmgIndGo').onclick = start;
  q('#tmgIndStop').onclick = stop;
}

function init(){ ui(); resume(); }
if(document.readyState === 'complete') init(); else window.addEventListener('load', init);
})();
