// ==UserScript==
// @name         더망고 상품업데이트 런처
// @namespace    solddeul.tmg
// @version      1.2
// @description  상품업데이트&마켓전송 화면의 설정(수집사이트/업데이트항목/전송마켓/변동일/범위)을 프리셋으로 저장해 두고, 범위를 구간으로 나눠 여러 창을 한꺼번에 띄운다. 구간마다 전송마켓을 따로 지정할 수 있다. 새로 열린 창은 프리셋과 실제 화면을 대조해 일치할 때만 시작 버튼을 열어 준다. 시작 클릭은 사람이 한다.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_goods_update.php*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function(){
'use strict';

// ────────────────────────────────────────────────────────────
// 사전 (2026-08-01 실측)
//  · 업데이트항목·마켓 체크박스는 name이 없다(id만). selected_market()이 모아서
//    hidden s_market에 JSON 배열로 넣는다 → URL은 s_market 하나로 둘 다 표현한다.
//  · start_limit/end_limit(범위)은 URL로 안 실린다 → 자식 창에서 DOM에 직접 넣는다.
//  · ★ ps_status/ps_chd 셀렉트는 <form> 바깥(DIV)에 있다. form.elements에는 들어 있지만
//    'form select[name=…]' 같은 자손 선택자로는 절대 찾히지 않는다 (v1.0의 버그).
//    → 반드시 document.search_form.<name> 으로 접근할 것.
// ────────────────────────────────────────────────────────────
var SITES = [
  {v:'a_rt',               t:'ABCmart.a-rt.com'},
  {v:'zara_de',            t:'Zara.com/de (독일자라)'},
  {v:'zara_kr',            t:'Zara.com/kr (국내자라)'},
  {v:'coupang_mystore',    t:'쿠팡(내스토어)'},
  {v:'smartstore_mystore', t:'스마트스토어(내스토어)'}
];
// ALL('모든정보')은 나머지 4개와 배타 관계다 — 화면 동작과 동일하게 맞춘다.
var ITEM_ALL = 'all';
var ITEMS = [
  {v:'all',    t:'모든정보', id:'chk_all_update_yn'},
  {v:'price',  t:'가격',     id:'chk_price_update_yn'},
  {v:'stock',  t:'재고',     id:'chk_stock_update_yn'},
  {v:'image',  t:'이미지',   id:'chk_image_update_yn'},
  {v:'detail', t:'상세설명', id:'chk_detail_update_yn'}
];
var MARKETS = [
  {v:'AUC20',   t:'옥션2.0',       id:'chk_auction20_yn'},
  {v:'GMK20',   t:'G마켓2.0',      id:'chk_gmarket20_yn'},
  {v:'11ST',    t:'11번가',        id:'chk_11st_yn'},
  {v:'SMART',   t:'스마트스토어',  id:'chk_smartstore_yn'},
  {v:'COUP',    t:'쿠팡',          id:'chk_coupang_yn'},
  {v:'LTON',    t:'롯데ON',        id:'chk_lotteon_yn'},
  {v:'LFMALL',  t:'LFMall',        id:'chk_lfmall_yn'},
  {v:'MUSTIT',  t:'머스트잇',      id:'chk_mustit_yn'},
  {v:'SHOPEE',  t:'쇼피',          id:'chk_shopee_yn'},
  {v:'QOO10JP', t:'큐텐(일본)',    id:'chk_qoo10jp_yn'},
  {v:'SHOPIFY', t:'쇼피파이',      id:'chk_shopify_yn'},
  {v:'CAFE24',  t:'카페24',        id:'chk_cafe24_yn'},
  {v:'GODO',    t:'고도몰',        id:'chk_godomall_yn'},
  {v:'IMWEB',   t:'아임웹',        id:'chk_imweb_yn'},
  {v:'PLAYAUTO',t:'플레이오토(EMP)',id:'chk_playauto_yn'}
];

// 정렬은 uid_asc(상품수집 날짜순 과거순) 고정.
// uid 기준이라 회차마다 순서가 흔들리지 않는다 → 구간이 매번 같은 대상을 가리킨다.
var ORDER = 'uid_asc';
// 상품상태는 화면 기본값과 같은 '판매상품(재고+품절)' 고정. 패널에서 다루지 않는다.
var STATUS = 'sale';

var KEY_STORE = 'tmg_update_launcher_v1';
var KEY_JOB   = 'tmg_update_job_';
var PAGE      = location.pathname.replace(/[^/]+$/,'') + 'admin_goods_update.php';

function q(s){ return document.querySelector(s); }
function qa(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function nameOf(list, v){ var f = list.filter(function(x){ return x.v === v; })[0]; return f ? f.t : v; }

// ────────────────────────────────────────────────────────────
// 저장
// ────────────────────────────────────────────────────────────
function load(){
  try{
    var o = JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
    if(!o.presets) o.presets = [];
    return o;
  }catch(e){ return {presets:[]}; }
}
function save(o){ localStorage.setItem(KEY_STORE, JSON.stringify(o)); }

function blank(){
  return {
    id: uid(), name:'새 프리셋',
    site: SITES[0].v,
    items:['price','stock'],     // 기본값 = 가격 + 재고
    markets:[],                  // 구간 기본 마켓
    cmk:{},                      // 구간별 마켓 override { 구간번호: [마켓코드] }
    chd:'',
    useRange:true, total:0, first:450, size:500, skip:[]
  };
}

// ────────────────────────────────────────────────────────────
// 업데이트 항목 — '모든정보'는 나머지와 배타
// ────────────────────────────────────────────────────────────
function normalizeItems(list, justClicked){
  list = (list || []).slice();
  if(justClicked === ITEM_ALL) return [ITEM_ALL];
  if(justClicked) return list.filter(function(v){ return v !== ITEM_ALL; });
  if(list.indexOf(ITEM_ALL) >= 0 && list.length > 1) return [ITEM_ALL];
  return list;
}

// ────────────────────────────────────────────────────────────
// 구간 분할 — 첫 구간 450, 이후 500 (둘 다 프리셋에서 변경 가능)
// ────────────────────────────────────────────────────────────
function chunks(p){
  var total = parseInt(p.total,10) || 0;
  var first = parseInt(p.first,10) || 450;
  var size  = parseInt(p.size,10)  || 500;
  var out = [], s = 1;
  if(total <= 0 || first <= 0 || size <= 0) return out;
  while(s <= total){
    var len = out.length === 0 ? first : size;
    var e = Math.min(s + len - 1, total);
    out.push({no: out.length + 1, start: s, end: e});
    s = e + 1;
  }
  return out;
}
function chunkMarkets(p, no){
  if(p.cmk && p.cmk[no]) return p.cmk[no].slice();
  return (p.markets || []).slice();
}

// ────────────────────────────────────────────────────────────
// 참고용 동시창 안내 (강의 3-24 / 3-35) — 열린 창 배너에만 표시한다.
//  · 업데이트(수집사이트→더망고): 수집사이트당 5창. 창 수만큼 실제로 빨라진다.
//  · 마켓전송(더망고→마켓): 창을 늘려도 리소스가 나뉘어 효과 미미 → 권고 1창.
//  · 스마트스토어 단독 등록/덮어쓰기: 과속 오류 때문에 3창 제한.
// ────────────────────────────────────────────────────────────
function hintOf(items, markets){
  var hasItem   = (items   || []).length > 0;
  var hasMarket = (markets || []).length > 0;
  if(hasMarket && markets.length === 1 && markets[0] === 'SMART')
    return '스마트스토어 단독 전송 — 과속 오류 방지로 3창 제한';
  if(hasItem && !hasMarket)
    return '업데이트 전용 — 수집사이트당 5창까지, 창 수만큼 빨라짐';
  if(!hasItem && hasMarket)
    return '전송 전용 — 창을 늘려도 리소스가 나뉘어 효과가 미미(강의 권고 1창)';
  if(!hasItem && !hasMarket)
    return '⚠ 업데이트 항목도 마켓도 없습니다 — 아무 일도 하지 않습니다';
  return '업데이트+전송 혼합 — 전송 쪽이 병목';
}

// ────────────────────────────────────────────────────────────
// URL 빌더 — 마켓은 구간별로 달라지므로 인자로 받는다
// ────────────────────────────────────────────────────────────
function buildUrl(p, markets){
  var qs = [];
  function add(k,v){ qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
  add('amode','detail_search');
  add('pg','1');
  add('search_order', ORDER);
  add('ps_status', STATUS);
  add('ps_chd', p.chd || '');
  add('s_market', JSON.stringify((markets || []).concat(p.items || [])));
  add('du_market', '[]');
  if(p.site) qs.push('ps_site_id%5B%5D=' + encodeURIComponent(p.site));
  return PAGE + '?' + qs.join('&');
}

// ────────────────────────────────────────────────────────────
// 검색결과 건수 조회 — 프리셋 조건 그대로 fetch해서 읽는다.
// (현재 화면 건수를 쓰면 조건이 다를 때 조용히 틀린 구간이 만들어진다)
// ────────────────────────────────────────────────────────────
async function fetchTotal(p){
  var html = await fetch(buildUrl(p, p.markets), {credentials:'same-origin'}).then(function(r){ return r.text(); });
  var text = html.replace(/<[^>]+>/g,' ');
  var m = text.match(/총\s*([\d,]+)\s*개의\s*상품/);
  if(!m) throw new Error('건수 문구를 찾지 못했습니다');
  return parseInt(m[1].replace(/,/g,''), 10);
}

// ────────────────────────────────────────────────────────────
// 실행 — 프리셋을 작업(창) 목록으로 전개
//  no/of는 "실제로 열리는 작업" 기준. 8구간 중 5개를 골랐으면 1/5 … 5/5.
// ────────────────────────────────────────────────────────────
function expand(p){
  var base = {
    pid:p.id, name:p.name, site:p.site,
    items:(p.items||[]).slice(),
    status:STATUS, chd:p.chd||'', order:ORDER
  };
  if(!p.useRange){
    var mk = (p.markets||[]).slice();
    return [Object.assign({}, base, {jid:uid(), useRange:false, markets:mk, url:buildUrl(p,mk), no:1, of:1})];
  }
  var skip = p.skip || [];
  var picked = chunks(p).filter(function(c){ return skip.indexOf(c.no) < 0; });
  return picked.map(function(c, i){
    var m = chunkMarkets(p, c.no);
    return Object.assign({}, base, {
      jid:uid(), useRange:true, markets:m, url:buildUrl(p, m),
      start:c.start, end:c.end, no:i+1, of:picked.length, srcNo:c.no
    });
  });
}

// 선택한 작업을 전부 연다. 팝업이 차단되면 남은 것을 돌려준다.
async function openAll(jobs){
  var opened = 0;
  for(var i=0; i<jobs.length; i++){
    var j = jobs[i];
    localStorage.setItem(KEY_JOB + j.jid, JSON.stringify(j));
    var w = window.open(j.url + '#tmglauncher=' + j.jid, '_blank');
    if(!w) return {opened:opened, blocked:true, rest:jobs.slice(i)};
    opened++;
    stat('창 여는 중... ' + opened + '/' + jobs.length);
    await sleep(1200);
  }
  return {opened:opened, blocked:false, rest:[]};
}

// ────────────────────────────────────────────────────────────
// 자식 창 모드 — 대조 → 범위 주입 → 배너
// ────────────────────────────────────────────────────────────
function actualState(){
  var f = document.search_form;
  var sites = [];
  qa('input[name="ps_site_id[]"]').forEach(function(e){ if(e.checked) sites.push(e.value); });
  function picked(list){
    return list.filter(function(x){ var e = document.getElementById(x.id); return e && e.checked; })
               .map(function(x){ return x.v; });
  }
  return {
    sites: sites,
    items: picked(ITEMS),
    markets: picked(MARKETS),
    order: (f && f.search_order) ? f.search_order.value : '',
    status: (f && f.ps_status) ? f.ps_status.value : ''
  };
}

function diff(job, act){
  var bad = [];
  function cmp(label, want, got){
    var a = want.slice().sort().join(','), b = got.slice().sort().join(',');
    if(a !== b) bad.push(label + ' — 요청 [' + (a||'없음') + '] / 실제 [' + (b||'없음') + ']');
  }
  cmp('수집사이트', job.site ? [job.site] : [], act.sites);
  cmp('업데이트항목', job.items, act.items);
  cmp('전송마켓', job.markets, act.markets);
  if(job.order !== act.order) bad.push('정렬 — 요청 [' + job.order + '] / 실제 [' + act.order + ']');
  if((job.status||'') !== (act.status||'')) bad.push('상품상태 — 요청 [' + (job.status||'전체') + '] / 실제 [' + (act.status||'전체') + ']');
  return bad;
}

function lockStart(id, msg){
  var e = document.getElementById(id);
  if(!e) return;
  e.removeAttribute('onclick');
  e.onclick = function(ev){ ev.preventDefault(); alert(msg); return false; };
  e.style.opacity = '.35';
  e.title = msg;
}

function injectRange(job){
  var sl = document.getElementById('start_limit'), el = document.getElementById('end_limit');
  if(!sl || !el) return '범위 입력칸을 찾지 못했습니다';
  if(sl.offsetParent === null && typeof set_limit_num === 'function'){
    try{ set_limit_num(); }catch(e){ return '범위 UI를 열지 못했습니다: ' + e.message; }
  }
  sl.value = String(job.start);
  el.value = String(job.end);
  if(sl.value !== String(job.start) || el.value !== String(job.end)) return '범위 값이 반영되지 않았습니다';
  return null;
}

function banner(html, color){
  var b = document.getElementById('tmgLaunchBanner');
  if(!b){
    b = document.createElement('div');
    b.id = 'tmgLaunchBanner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 14px;'
      + 'font:13px/1.6 "맑은 고딕",sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.appendChild(b);
    document.body.style.paddingTop = '58px';
  }
  b.style.background = color;
  b.innerHTML = html;
}

function childMode(jid){
  var raw = localStorage.getItem(KEY_JOB + jid);
  if(!raw){ banner('⚠ 런처 작업 정보를 찾지 못했습니다. 이 창은 수동으로 확인하고 쓰세요.', '#e0a800'); return; }
  var job;
  try{ job = JSON.parse(raw); }catch(e){ banner('⚠ 런처 작업 정보가 깨졌습니다.', '#e0a800'); return; }

  var bad = diff(job, actualState());
  var rangeErr = job.useRange ? injectRange(job) : null;

  var head = '[' + esc(job.name) + '] '
    + (job.useRange ? ('구간 ' + job.no + '/' + job.of + ' · ' + job.start + '~' + job.end) : '검색결과 전체');

  if(bad.length || rangeErr){
    var msg = '런처: 설정 대조에 실패해 시작을 잠갔습니다. 배너 내용을 확인하세요.';
    lockStart('update_start', msg);
    lockStart('update_start_limit', msg);
    var lines = bad.concat(rangeErr ? ['범위 — ' + rangeErr] : []);
    banner('⛔ ' + head + ' — <b>설정이 프리셋과 다릅니다. 시작을 잠갔습니다.</b><br>'
      + lines.map(function(x){ return '&nbsp;&nbsp;· ' + esc(x); }).join('<br>'), '#c9302c');
    return;
  }

  if(job.useRange){
    // 범위 전용 창에서 '검색결과모든상품' 버튼을 잘못 누르면 전량이 돈다 → 잠근다.
    lockStart('update_start', '런처: 이 창은 구간 ' + job.start + '~' + job.end + ' 전용입니다. 아래 범위설정 시작 버튼을 쓰세요.');
  }
  banner('✅ ' + head + ' · 준비완료 — <b>아래 시작 버튼을 직접 누르세요.</b>'
    + '<br>&nbsp;&nbsp;· 마켓: ' + esc(job.markets.map(function(v){ return nameOf(MARKETS,v); }).join(', ') || '없음(업데이트만)')
    + ' / 항목: ' + esc(job.items.map(function(v){ return nameOf(ITEMS,v); }).join(', ') || '없음(전송만)')
    + '<br>&nbsp;&nbsp;· ' + esc(hintOf(job.items, job.markets))
    + '<br>&nbsp;&nbsp;· ⚠ 더망고 설정(auto_repeat)에 의해 완료 후 스스로 재시작합니다. 끝나면 창을 닫으세요.', '#1f7a3d');
}

// ────────────────────────────────────────────────────────────
// 런처 패널
// ────────────────────────────────────────────────────────────
var store = load();
var cur = null;
var pending = [];   // 팝업 차단으로 못 연 작업

// ★ ps_chd 셀렉트는 form 바깥에 있다 → form.elements로 접근한다
function pageOptions(name, sel, fallback){
  var f = document.search_form;
  var src = f ? f[name] : null;
  if(!src || !src.options) return fallback;
  return Array.prototype.slice.call(src.options).map(function(o){
    return '<option value="' + esc(o.value) + '"' + (o.value === sel ? ' selected' : '') + '>'
      + esc((o.text||'').trim()) + '</option>';
  }).join('');
}

function stat(m){ var s = q('#tmgLStat'); if(s) s.innerHTML = m; }

function checkRow(list, sel, kind){
  return list.map(function(x){
    var on = sel.indexOf(x.v) >= 0 ? ' checked' : '';
    return '<label style="display:inline-block;width:calc(50% - 4px);white-space:nowrap;overflow:hidden">'
      + '<input type="checkbox" data-kind="' + kind + '" value="' + x.v + '"' + on + '> ' + esc(x.t) + '</label>';
  }).join('');
}

function mkSummary(mk){
  if(!mk.length) return '마켓없음(업데이트만)';
  var names = mk.map(function(v){ return nameOf(MARKETS, v); });
  return names.length <= 2 ? names.join(', ') : (names.slice(0,2).join(', ') + ' 외 ' + (names.length-2));
}

function chunkList(p){
  var cs = chunks(p);
  if(!cs.length) return '<div style="color:#888">건수를 조회하면 구간이 만들어집니다.</div>';
  var skip = p.skip || [];
  return '<div style="margin-bottom:3px"><a href="javascript:;" id="tmgLAll">전체선택</a> · '
    + '<a href="javascript:;" id="tmgLNone">전체해제</a></div>'
    + cs.map(function(c){
    var on = skip.indexOf(c.no) < 0;
    var mk = chunkMarkets(p, c.no);
    var open = (p._open === c.no);
    var over = (p.cmk && p.cmk[c.no]) ? ' style="color:#c9302c"' : ' style="color:#337ab7"';
    return '<div style="border-bottom:1px solid #f2f2f2;padding:2px 0">'
      + '<label><input type="checkbox" data-chunk="' + c.no + '"' + (on?' checked':'') + '> '
      + c.no + '. ' + c.start.toLocaleString() + '~' + c.end.toLocaleString() + '</label> '
      + '<a href="javascript:;" data-open="' + c.no + '"' + over + '>[' + esc(mkSummary(mk)) + ' ▾]</a>'
      + (open
          ? '<div style="background:#f6f9fc;border:1px solid #dde6ef;padding:4px 6px;margin:3px 0">'
            + checkRow(MARKETS, mk, 'cmk:' + c.no)
            + '<div style="margin-top:4px"><button data-applyall="' + c.no + '">이 마켓을 전 구간에 적용</button></div>'
            + '</div>'
          : '')
      + '</div>';
  }).join('');
}

function runLabel(){
  var b = q('#tmgLRun');
  if(b) b.textContent = '실행 (' + expand(cur).length + '창)';
}

// 구간 목록만 다시 그린다 — 패널 전체를 다시 그리면 스크롤이 맨 위로 튄다
function renderChunks(){
  var box = q('#tmgLChunks');
  if(!box) return;
  var top = box.scrollTop;
  box.innerHTML = cur.useRange ? chunkList(cur) : '<div style="color:#888">범위 분할을 사용하지 않습니다.</div>';
  bindChunks();
  box.scrollTop = top;
  runLabel();
}

function render(){
  var panel = q('#tmgLPanel');
  var top = panel ? panel.scrollTop : 0;

  q('#tmgLBody').innerHTML =
    '<div style="margin-bottom:6px">이름 <input id="tmgLName" value="' + esc(cur.name) + '" style="width:150px"></div>'
  + '<div style="margin-bottom:6px">수집사이트 <select id="tmgLSite">'
      + SITES.map(function(s){ return '<option value="' + s.v + '"' + (s.v===cur.site?' selected':'') + '>' + esc(s.t) + '</option>'; }).join('')
      + '</select></div>'
  + '<fieldset style="border:1px solid #ddd;padding:4px 6px;margin:0 0 6px"><legend style="font-size:11px">업데이트 항목 (모든정보는 배타)</legend>'
      + checkRow(ITEMS, cur.items, 'item') + '</fieldset>'
  + '<fieldset style="border:1px solid #ddd;padding:4px 6px;margin:0 0 6px"><legend style="font-size:11px">'
      + (cur.useRange ? '전송 마켓 (구간 기본값)' : '전송 마켓') + '</legend>'
      + checkRow(MARKETS, cur.markets, 'market')
      + (cur.useRange ? '<div style="color:#888;font-size:11px;margin-top:2px">구간별로 다르게 하려면 아래 구간 목록에서 [마켓 ▾]을 누르세요.</div>' : '')
    + '</fieldset>'
  + '<div style="margin-bottom:6px">변동일 <select id="tmgLChd">' + pageOptions('ps_chd', cur.chd, '<option value="">전체</option>') + '</select></div>'
  + '<div style="margin-bottom:6px;color:#555">정렬: <b>상품수집 날짜순(과거순)</b> 고정</div>'
  + '<fieldset style="border:1px solid #ddd;padding:4px 6px;margin:0 0 6px"><legend style="font-size:11px">범위 분할</legend>'
      + '<label><input type="checkbox" id="tmgLUse"' + (cur.useRange?' checked':'') + '> 사용</label>'
      + ' <button id="tmgLCount" style="float:right">건수 조회</button>'
      + '<div style="margin-top:4px">총 <input id="tmgLTotal" type="number" value="' + (cur.total||0) + '" style="width:70px">건'
      + ' · 첫 <input id="tmgLFirst" type="number" value="' + (cur.first||450) + '" style="width:52px">'
      + ' · 이후 <input id="tmgLSize" type="number" value="' + (cur.size||500) + '" style="width:52px"></div>'
      + '<div id="tmgLChunks" style="max-height:220px;overflow:auto;margin-top:4px;border-top:1px solid #eee;padding-top:4px">'
      + (cur.useRange ? chunkList(cur) : '<div style="color:#888">범위 분할을 사용하지 않습니다.</div>') + '</div>'
    + '</fieldset>'
  + '<div style="margin-top:8px"><button id="tmgLSave">저장</button> '
      + '<button id="tmgLRun" style="font-weight:bold">실행</button>'
      + '<span id="tmgLPendWrap"></span></div>';

  bindMain();
  bindChunks();
  runLabel();
  renderPending();
  if(panel) panel.scrollTop = top;
}

// 체크박스·입력값을 cur로 걷어온다. 접혀 있는 구간의 마켓은 건드리지 않는다.
function collect(clickedItem){
  if(!q('#tmgLName')) return;
  cur.name    = q('#tmgLName').value.trim() || '이름없음';
  cur.site    = q('#tmgLSite').value;
  cur.chd     = q('#tmgLChd').value;
  cur.useRange= q('#tmgLUse').checked;
  cur.total   = parseInt(q('#tmgLTotal').value,10) || 0;
  cur.first   = parseInt(q('#tmgLFirst').value,10) || 450;
  cur.size    = parseInt(q('#tmgLSize').value,10) || 500;

  var items = [], markets = [], perChunk = {};
  qa('#tmgLBody input[data-kind]').forEach(function(e){
    if(!e.checked) return;
    var k = e.getAttribute('data-kind');
    if(k === 'item') items.push(e.value);
    else if(k === 'market') markets.push(e.value);
    else if(k.indexOf('cmk:') === 0){
      var no = k.slice(4);
      (perChunk[no] = perChunk[no] || []).push(e.value);
    }
  });
  cur.items   = normalizeItems(items, clickedItem);
  cur.markets = markets;
  if(cur._open != null){
    cur.cmk = cur.cmk || {};
    cur.cmk[cur._open] = perChunk[cur._open] || [];
  }
  collectSkip();
}

function collectSkip(){
  cur.skip = [];
  qa('#tmgLBody input[data-chunk]').forEach(function(e){
    if(!e.checked) cur.skip.push(parseInt(e.getAttribute('data-chunk'),10));
  });
}

function bindMain(){
  ['tmgLName','tmgLSite','tmgLChd','tmgLUse','tmgLTotal','tmgLFirst','tmgLSize'].forEach(function(id){
    var e = q('#' + id); if(e) e.onchange = function(){ collect(); render(); };
  });
  qa('#tmgLBody input[data-kind=item],#tmgLBody input[data-kind=market]').forEach(function(e){
    e.onchange = function(){
      var clicked = (e.getAttribute('data-kind') === 'item' && e.checked) ? e.value : null;
      collect(clicked); render();
    };
  });

  q('#tmgLCount').onclick = async function(){
    collect(); stat('건수 조회 중...');
    try{
      cur.total = await fetchTotal(cur);
      stat('검색결과 <b>' + cur.total.toLocaleString() + '</b>건 → 구간 ' + chunks(cur).length + '개');
      render();
    }catch(e){ stat('<span style="color:#c9302c">건수 조회 실패: ' + esc(e.message) + '</span>'); }
  };

  q('#tmgLSave').onclick = function(){
    collect();
    var copy = JSON.parse(JSON.stringify(cur)); delete copy._open;
    var i = store.presets.findIndex(function(p){ return p.id === cur.id; });
    if(i < 0) store.presets.push(copy); else store.presets[i] = copy;
    save(store); head(); stat('저장했습니다.');
  };

  q('#tmgLRun').onclick = async function(){
    collect();
    var jobs = expand(cur);
    if(!jobs.length){ stat('<span style="color:#c9302c">열 작업이 없습니다.</span>'); return; }
    var r = await openAll(jobs);
    pending = r.rest;
    stat((r.blocked ? '<span style="color:#c9302c">팝업이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 아래 버튼을 누르세요.</span><br>' : '')
      + '창 ' + r.opened + '개를 열었습니다. 각 창에서 <b>시작 버튼을 직접</b> 누르세요.');
    renderPending();
  };
}

function renderPending(){
  var w = q('#tmgLPendWrap');
  if(!w) return;
  w.innerHTML = pending.length ? ' <button id="tmgLPend">남은 ' + pending.length + '개 열기</button>' : '';
  var b = q('#tmgLPend');
  if(b) b.onclick = async function(){
    var r = await openAll(pending);
    pending = r.rest;
    stat('창 ' + r.opened + '개를 추가로 열었습니다.');
    renderPending();
  };
}

function bindChunks(){
  // 구간 체크박스는 다시 그리지 않는다 → 연속으로 해제해도 스크롤이 튀지 않는다
  qa('#tmgLChunks input[data-chunk]').forEach(function(e){
    e.onchange = function(){ collectSkip(); runLabel(); };
  });
  qa('#tmgLChunks input[data-kind]').forEach(function(e){
    e.onchange = function(){ collect(); renderChunks(); };
  });
  qa('#tmgLChunks a[data-open]').forEach(function(a){
    a.onclick = function(){
      var no = parseInt(a.getAttribute('data-open'),10);
      collect();
      cur._open = (cur._open === no) ? null : no;
      renderChunks();
    };
  });
  qa('#tmgLChunks button[data-applyall]').forEach(function(b){
    b.onclick = function(){
      collect();
      var no = parseInt(b.getAttribute('data-applyall'),10);
      cur.markets = chunkMarkets(cur, no);
      cur.cmk = {};
      cur._open = null;
      render(); stat('전 구간 마켓을 [' + esc(mkSummary(cur.markets)) + ']로 맞췄습니다.');
    };
  });
  var all = q('#tmgLAll'), none = q('#tmgLNone');
  if(all)  all.onclick  = function(){ qa('#tmgLChunks input[data-chunk]').forEach(function(e){ e.checked = true; });  collectSkip(); runLabel(); };
  if(none) none.onclick = function(){ qa('#tmgLChunks input[data-chunk]').forEach(function(e){ e.checked = false; }); collectSkip(); runLabel(); };
}

function head(){
  q('#tmgLPick').innerHTML = '<option value="">-- 선택 안함 --</option>'
    + store.presets.map(function(p){
        return '<option value="' + p.id + '"' + (cur && p.id === cur.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      }).join('');
}

function panel(){
  if(q('#tmgLPanel')) return;
  store = load();
  cur = blank();     // 처음에는 프리셋을 고르지 않은 상태로 시작한다

  var p = document.createElement('div');
  p.id = 'tmgLPanel';
  p.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483646;background:#fff;border:2px solid #337ab7;'
    + 'border-radius:8px;padding:10px 12px;width:330px;max-height:90vh;overflow:auto;'
    + 'font:12px/1.6 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML = '<div style="font-weight:bold;margin-bottom:6px">상품업데이트 런처</div>'
    + '<div style="margin-bottom:6px"><select id="tmgLPick" style="width:150px"></select> '
    + '<button id="tmgLNew">새로</button> <button id="tmgLDel">삭제</button></div>'
    + '<div id="tmgLBody"></div>'
    + '<div id="tmgLStat" style="margin-top:8px;color:#333;min-height:32px;border-top:1px solid #eee;padding-top:6px">대기중</div>'
    + '<div style="margin-top:4px;color:#888;font-size:11px">※ 시작 버튼은 사람이 누릅니다. 런처는 창을 열고 설정을 대조만 합니다.</div>';
  document.body.appendChild(p);

  q('#tmgLPick').onchange = function(){
    var id = this.value;
    if(!id){ cur = blank(); render(); stat('선택 안함 — 새 설정으로 시작합니다.'); return; }
    var f = store.presets.filter(function(x){ return x.id === id; })[0];
    if(f){ cur = JSON.parse(JSON.stringify(f)); cur.items = normalizeItems(cur.items); render(); stat('프리셋 불러옴'); }
  };
  q('#tmgLNew').onclick = function(){ cur = blank(); head(); render(); stat('새 프리셋'); };
  q('#tmgLDel').onclick = function(){
    var exists = store.presets.some(function(x){ return x.id === cur.id; });
    if(!exists){ stat('저장된 프리셋이 아닙니다.'); return; }
    if(!confirm('프리셋 "' + cur.name + '" 을(를) 삭제할까요?')) return;
    store.presets = store.presets.filter(function(x){ return x.id !== cur.id; });
    save(store);
    cur = blank();
    head(); render(); stat('삭제했습니다.');
  };
  head(); render();
}

// ────────────────────────────────────────────────────────────
function boot(){
  var m = (location.hash || '').match(/tmglauncher=([a-z0-9]+)/i);
  if(m) childMode(m[1]);   // 런처가 연 창 — 대조·범위주입만 하고 패널은 띄우지 않는다
  else  panel();
}
if(document.readyState === 'complete') boot(); else window.addEventListener('load', boot);
})();
