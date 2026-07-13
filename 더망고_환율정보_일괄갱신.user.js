// ==UserScript==
// @name         더망고 환율정보 일괄갱신(시장환율+마진)
// @namespace    solddeul.tmg
// @version      1.0
// @description  admin_config.php의 "환율정보 등록"(exchange_rate_*) 12개 통화(USD,EUR,CNY,JPY,GBP,AUD,SGD,CAD,HKD,TRY,NZD,PLN)를 무료 환율 API에서 가져와 마진%(기본 4)를 더한 값으로 채우고, 환율 섹션 "설정저장"(config_save(1)→morning 폼 POST admin_config_ok.php)까지 자동 저장한다. 페이지의 다른 섹션은 건드리지 않음(menu_id=1로 환율 섹션만 저장). 미리보기·값만채우기(저장X)·마진조정 지원. 저장 전 확인창.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_config.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

// ---- 대상 통화(입력칸 순서와 동일) ----
var CODES = ['USD','EUR','CNY','JPY','GBP','AUD','SGD','CAD','HKD','TRY','NZD','PLN'];
var LABEL = {USD:'달러',EUR:'유로',CNY:'위안',JPY:'엔',GBP:'파운드',AUD:'호주달러',SGD:'싱가폴달러',CAD:'캐나다달러',HKD:'홍콩달러',TRY:'리라',NZD:'뉴질랜드달러',PLN:'즈워티'};
var DEFAULT_MARGIN = 4;          // %
var EXCHANGE_MENU_ID = '1';      // 환율 섹션 저장 menu_id (config_save(1))

// ---- 환율 소스: USD 기준(1 USD 당 각 통화). 원화값 = krwPerUsd / (해당통화 per USD) ----
// 무료·키불필요·CORS 허용 소스들을 순서대로 시도.
var SOURCES = [
  { name:'currency-api(jsdelivr)',
    url:'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json',
    parse:function(j){ return usdMapFromFawaz(j); } },
  { name:'currency-api(pages.dev)',
    url:'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json',
    parse:function(j){ return usdMapFromFawaz(j); } },
  { name:'open.er-api.com',
    url:'https://open.er-api.com/v6/latest/USD',
    parse:function(j){ return usdMapFromErApi(j); } }
];

function usdMapFromFawaz(j){
  // j = { date, usd:{ krw, eur, cny, ... (소문자) } }
  var m = j && j.usd; if(!m || !m.krw) return null;
  var o = { _date:(j.date||''), krwPerUsd:Number(m.krw) };
  CODES.forEach(function(c){ o[c] = (c==='USD') ? 1 : Number(m[c.toLowerCase()]); });
  return o;
}
function usdMapFromErApi(j){
  // j = { rates:{ KRW, EUR, CNY, ... (대문자) }, time_last_update_utc }
  var r = j && j.rates; if(!r || !r.KRW) return null;
  var o = { _date:(j.time_last_update_utc||''), krwPerUsd:Number(r.KRW) };
  CODES.forEach(function(c){ o[c] = (c==='USD') ? 1 : Number(r[c]); });
  return o;
}

// =========================================================================
// 유틸
// =========================================================================
function q(s){ return document.querySelector(s); }
function inp(code){ return document.querySelector('input[name="exchange_rate_'+code.toLowerCase()+'"]'); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function nf(n){ // 정수부 콤마
  var s=String(n), neg=s.charAt(0)==='-'?'-':'', body=neg?s.slice(1):s;
  var parts=body.split('.'); parts[0]=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return neg+parts.join('.');
}

// 값 크기별 반올림: 100 이상 → 정수, 100 미만 → 소수 2자리
function roundBySize(v){
  if(!isFinite(v)) return null;
  if(v>=100) return Math.round(v);
  return Math.round(v*100)/100;
}
function fmtValue(v){
  if(v===null) return '';
  if(v>=100) return nf(Math.round(v));
  return v.toFixed(2); // 소수 2자리(콤마 불필요한 소액)
}

// 환율 계산: 시장환율(원) = krwPerUsd / (통화 per USD), 마진 적용, 반올림
function computeRates(usdMap, marginPct){
  var factor = 1 + (Number(marginPct)||0)/100;
  var rows = [];
  CODES.forEach(function(c){
    var perUsd = usdMap[c];
    var market = (perUsd && isFinite(perUsd)) ? (usdMap.krwPerUsd / perUsd) : null;
    var withMargin = (market!==null) ? market*factor : null;
    var rounded = (withMargin!==null) ? roundBySize(withMargin) : null;
    var el = inp(c);
    rows.push({
      code:c,
      market: market,
      withMargin: withMargin,
      value: rounded,
      current: el ? (el.value||'') : '(칸없음)',
      hasInput: !!el
    });
  });
  return rows;
}

// =========================================================================
// 환율 가져오기(소스 순차 시도)
// =========================================================================
async function fetchUsdMap(logFn){
  for(var i=0;i<SOURCES.length;i++){
    var s=SOURCES[i];
    try{
      logFn && logFn('· 시도: '+s.name);
      var r=await fetch(s.url,{cache:'no-store'});
      if(!r.ok) throw new Error('HTTP '+r.status);
      var j=await r.json();
      var m=s.parse(j);
      if(m && m.krwPerUsd){
        logFn && logFn('· 성공: '+s.name+' (기준일 '+(m._date||'?')+', 1USD='+m.krwPerUsd.toFixed(2)+'원)');
        return { map:m, source:s.name };
      }
      throw new Error('파싱 실패');
    }catch(e){
      logFn && logFn('· 실패: '+s.name+' ('+String(e.message||e).slice(0,50)+')');
    }
  }
  throw new Error('모든 환율 소스 실패');
}

// =========================================================================
// 입력칸 채우기
// =========================================================================
function fillInputs(rows){
  var filled=0, missing=[];
  rows.forEach(function(row){
    var el=inp(row.code);
    if(!el){ missing.push(row.code); return; }
    if(row.value===null) return;
    el.value = fmtValue(row.value);
    ['input','keyup','change','blur'].forEach(function(ev){
      el.dispatchEvent(new Event(ev,{bubbles:true}));
    });
    filled++;
  });
  return { filled:filled, missing:missing };
}

// =========================================================================
// 저장: 환율 섹션만 저장(menu_id=1) → morning 폼 POST(admin_config_ok.php)
//   config_save(1)이 있으면 사이트 자체 전처리를 실행한 뒤(그 함수의 submit은 사이트에서 비활성),
//   확실히 저장되도록 폼을 직접 제출한다. 다른 섹션은 menu_id=1이라 서버가 저장하지 않음.
// =========================================================================
async function doSave(logFn){
  var f=document.forms['morning'];
  if(!f){ throw new Error('morning 폼을 찾을 수 없음'); }
  var mi=f.querySelector('input[name="menu_id"]');
  if(mi) mi.value = EXCHANGE_MENU_ID;
  if(typeof window.config_save === 'function'){
    logFn && logFn('· config_save('+EXCHANGE_MENU_ID+') 전처리 실행');
    try{ await Promise.resolve(window.config_save(EXCHANGE_MENU_ID)); }
    catch(e){ logFn && logFn('· config_save 경고: '+String(e.message||e).slice(0,50)); }
    // config_save가 menu_id를 다시 세팅하므로 한 번 더 보정
    if(mi) mi.value = EXCHANGE_MENU_ID;
  }
  logFn && logFn('· morning 폼 제출 → admin_config_ok.php');
  await sleep(60);
  f.submit();
}

// =========================================================================
// 패널 UI
// =========================================================================
var state = { rows:null, source:'' };

function log(msg){
  var box=q('#tmgFxLog'); if(!box) return;
  var t=new Date().toTimeString().slice(0,8);
  box.textContent += '['+t+'] '+msg+'\n';
  box.scrollTop=box.scrollHeight;
}
function setStat(m){ var s=q('#tmgFxStat'); if(s) s.textContent=m; }

function renderPreview(rows, marginPct){
  var host=q('#tmgFxPrev'); if(!host) return;
  var html='<table style="width:100%;border-collapse:collapse;font-size:11px">'
    +'<tr style="background:#eee"><th style="padding:2px 3px;text-align:left">통화</th>'
    +'<th style="padding:2px 3px;text-align:right">시장환율</th>'
    +'<th style="padding:2px 3px;text-align:right">+'+marginPct+'%</th>'
    +'<th style="padding:2px 3px;text-align:right">반영값</th>'
    +'<th style="padding:2px 3px;text-align:right">현재값</th></tr>';
  rows.forEach(function(r){
    var warn = !r.hasInput ? ' style="color:#c00"' : '';
    html+='<tr'+warn+'>'
      +'<td style="padding:1px 3px">'+r.code+'<span style="color:#999">('+LABEL[r.code]+')</span></td>'
      +'<td style="padding:1px 3px;text-align:right">'+(r.market!==null?nf(Math.round(r.market*100)/100):'-')+'</td>'
      +'<td style="padding:1px 3px;text-align:right;color:#888">'+(r.withMargin!==null?nf(Math.round(r.withMargin*100)/100):'-')+'</td>'
      +'<td style="padding:1px 3px;text-align:right;font-weight:bold">'+(r.value!==null?fmtValue(r.value):'-')+'</td>'
      +'<td style="padding:1px 3px;text-align:right;color:#999">'+r.current+'</td>'
      +'</tr>';
  });
  html+='</table>';
  host.innerHTML=html;
}

function getMargin(){
  var v=parseFloat((q('#tmgFxMargin')||{}).value);
  return isFinite(v)?v:DEFAULT_MARGIN;
}

async function onPreview(){
  setStat('환율 불러오는 중…'); log('환율 불러오기 시작');
  try{
    var got=await fetchUsdMap(log);
    state.source=got.source;
    var rows=computeRates(got.map, getMargin());
    state.rows=rows;
    renderPreview(rows, getMargin());
    var miss=rows.filter(function(r){return !r.hasInput;}).map(function(r){return r.code;});
    setStat('미리보기 완료 ('+got.source+')'+(miss.length?(' · 없는칸:'+miss.join(',')):''));
    log('미리보기 완료. 마진 '+getMargin()+'%');
  }catch(e){
    setStat('실패: '+String(e.message||e));
    log('오류: '+String(e.message||e));
  }
}

function ensureRows(){
  if(!state.rows){ setStat('먼저 "① 환율 불러오기·미리보기"를 눌러주세요'); return false; }
  // 마진이 바뀌었을 수 있으니 재계산은 미리보기에서. 여기선 현재 state.rows 사용.
  return true;
}

function onFillOnly(){
  if(!ensureRows()) return;
  var r=fillInputs(state.rows);
  renderPreview(computeRates0(), getMargin()); // 현재값 갱신 위해 재렌더
  setStat('입력칸 채움: '+r.filled+'개'+(r.missing.length?(' · 없는칸:'+r.missing.join(',')):'')+' (저장 안 함)');
  log('값만 채우기 완료: '+r.filled+'개. 저장은 하지 않았습니다.');
}
// 채운 뒤 현재값 다시 읽어 미리보기 표의 '현재값' 갱신
function computeRates0(){
  return state.rows.map(function(r){
    var el=inp(r.code);
    return Object.assign({},r,{current: el?(el.value||''):'(칸없음)'});
  });
}

async function onFillSave(){
  if(!ensureRows()) return;
  var lines=state.rows.filter(function(r){return r.hasInput && r.value!==null;})
    .map(function(r){return r.code+': '+(r.current||'(비어있음)')+' → '+fmtValue(r.value);});
  var ok=window.confirm('환율정보 등록을 아래 값으로 저장합니다.\n(마진 '+getMargin()+'% · 소스 '+state.source+')\n\n'
    +lines.join('\n')+'\n\n환율 섹션(menu_id=1)만 저장되며 다른 설정은 변경되지 않습니다.\n진행할까요?');
  if(!ok){ setStat('저장 취소됨'); log('사용자가 저장을 취소함'); return; }
  var r=fillInputs(state.rows);
  log('입력칸 채움: '+r.filled+'개. 저장 실행…');
  setStat('저장 중…');
  try{ await doSave(log); }
  catch(e){ setStat('저장 실패: '+String(e.message||e)); log('저장 오류: '+String(e.message||e)); }
}

function buildPanel(){
  if(q('#tmgFxPanel')) return;
  var p=document.createElement('div');
  p.id='tmgFxPanel';
  p.style.cssText='position:fixed;top:10px;right:10px;z-index:999999;width:340px;'
    +'background:#fff;border:2px solid #2d6cdf;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);'
    +'font-family:"맑은 고딕",sans-serif;font-size:12px;color:#222';
  p.innerHTML=
    '<div style="background:#2d6cdf;color:#fff;padding:6px 10px;border-radius:6px 6px 0 0;font-weight:bold;cursor:move" id="tmgFxHead">환율정보 일괄갱신 <span style="float:right;cursor:pointer" id="tmgFxMin">_</span></div>'
    +'<div id="tmgFxBody" style="padding:8px 10px">'
    +'  <div style="margin-bottom:6px">마진 <input id="tmgFxMargin" type="number" step="0.1" value="'+DEFAULT_MARGIN+'" style="width:56px;padding:2px 4px;text-align:right"> %'
    +'    <span style="color:#888;font-size:11px">&nbsp;시장환율에 더할 비율</span></div>'
    +'  <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">'
    +'    <button id="tmgFxBtnPrev" style="flex:1;min-width:150px;padding:5px;background:#2d6cdf;color:#fff;border:0;border-radius:4px;cursor:pointer">① 환율 불러오기·미리보기</button>'
    +'  </div>'
    +'  <div id="tmgFxPrev" style="max-height:230px;overflow:auto;border:1px solid #ddd;border-radius:4px;margin-bottom:6px;min-height:24px"></div>'
    +'  <div style="display:flex;gap:4px;margin-bottom:6px">'
    +'    <button id="tmgFxBtnFill" style="flex:1;padding:5px;background:#fff;color:#2d6cdf;border:1px solid #2d6cdf;border-radius:4px;cursor:pointer">② 값만 채우기</button>'
    +'    <button id="tmgFxBtnSave" style="flex:1;padding:5px;background:#e5484d;color:#fff;border:0;border-radius:4px;cursor:pointer">② 채우고 저장</button>'
    +'  </div>'
    +'  <div id="tmgFxStat" style="font-size:11px;color:#2d6cdf;min-height:15px;margin-bottom:4px">준비됨. ① 부터 눌러주세요.</div>'
    +'  <pre id="tmgFxLog" style="margin:0;height:80px;overflow:auto;background:#f6f7f9;border:1px solid #e2e2e2;border-radius:4px;padding:4px;font-size:10px;white-space:pre-wrap"></pre>'
    +'</div>';
  document.body.appendChild(p);

  q('#tmgFxBtnPrev').addEventListener('click', onPreview);
  q('#tmgFxBtnFill').addEventListener('click', onFillOnly);
  q('#tmgFxBtnSave').addEventListener('click', onFillSave);
  q('#tmgFxMin').addEventListener('click', function(){
    var b=q('#tmgFxBody'); b.style.display = (b.style.display==='none'?'block':'none');
  });
  // 드래그 이동
  (function(){
    var head=q('#tmgFxHead'), dragging=false, ox=0, oy=0;
    head.addEventListener('mousedown', function(e){ if(e.target.id==='tmgFxMin') return; dragging=true; ox=e.clientX-p.offsetLeft; oy=e.clientY-p.offsetTop; e.preventDefault(); });
    document.addEventListener('mousemove', function(e){ if(!dragging) return; p.style.left=(e.clientX-ox)+'px'; p.style.top=(e.clientY-oy)+'px'; p.style.right='auto'; });
    document.addEventListener('mouseup', function(){ dragging=false; });
  })();
}

// 환율 등록 화면일 때만 패널 표시(입력칸 존재 확인)
function init(){
  if(!inp('USD')){
    // admin_config.php의 다른 탭일 수 있음 — 버튼만 두고 안내
  }
  buildPanel();
  if(!inp('USD')){
    setStat('환율(exchange_rate_usd) 입력칸을 못 찾음. "환율정보 등록" 화면인지 확인하세요.');
  }
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
