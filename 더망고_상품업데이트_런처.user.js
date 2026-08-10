// ==UserScript==
// @name         더망고 상품업데이트 런처
// @namespace    solddeul.tmg
// @version      1.9.1
// @description  상품업데이트&마켓전송 화면의 설정(수집사이트/업데이트항목/전송마켓/변동일/범위)을 프리셋으로 저장해 두고, 범위를 구간으로 나눠 여러 창을 한꺼번에 띄운다. v1.6부터 구간은 최대 5개다(동시 5창 한도) — 1~4구간은 지정한 크기대로 끊고 5번째가 남은 전량을 맡는다. v1.7에 [실행+예약]을 추가했다 — 창을 미리 열어 두고 프리셋의 '예약' 시각이 되면 대조를 다시 한 뒤 스스로 시작한다. 구간마다 전송마켓을 따로 지정할 수 있다. 새로 열린 창은 프리셋과 실제 화면을 대조해 일치할 때만 시작 버튼을 열어 준다. [실행]은 창만 열고 사람이 시작을 누르며, [실행+자동시작]은 확인창 1회를 거쳐 각 창이 대조 통과 후 스스로 시작한다. v1.4부터 런처가 연 창에서는 더망고의 auto_repeat(자동 재시작)을 끈다. v1.5부터는 반복이 필요하면 런처가 직접 한다 — 프리셋에 '매일 HH:MM'을 지정하면 완료를 감지해 그 시각에 대조를 다시 하고 시작 버튼을 누른다. ★v1.9에서 반복 2회차가 늘 0건으로 끝나던 버그를 고쳤다 — 더망고의 회차 커서 초기화가 auto_repeat 블록 안에 들어 있어, v1.4가 반복을 끄면서 초기화까지 같이 꺼져 있었다. 시작 직전에 런처가 커서를 대신 되돌리고, 회차가 0건으로 끝나면 배너와 탭 제목으로 드러낸다.
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
//
// ── 자동시작 관련 실측 (v1.3에서 추가) ──────────────────────
//  · 시작 버튼 2개(#update_start '검색결과모든상품' / #update_start_limit '범위')는
//    ★둘 다 인자 없는 같은 함수 start_ini_all()을 호출한다. 어느 쪽을 눌렀는지는 전달되지 않는다.
//  · ★★ 범위 실행이냐 전량 실행이냐는 오직 #sp_limit_info 의 display 로 갈린다.
//    (start_ini_all 안: $('#sp_limit_info').css('display') != 'none' 이면 범위 모드)
//    → 범위 UI가 닫힌 채로 시작하면 검색결과 전량이 돈다. 자동 클릭 직전에 반드시 확인할 것.
//  · start_ini_all()의 첫 관문은 전역 boolean isLoaded 다. false면 '페이지 로딩중입니다' alert로 끝난다.
//    ★★ 이 변수는 `let isLoaded` 로 선언돼 있어 window 에 붙지 않는다 → window.isLoaded 는 항상 undefined.
//       v1.3.0이 이걸 몰라 자동시작이 매번 30초 대기 후 취소됐다. 반드시 맨이름으로 읽을 것(pageLoadedFlag).
//       실측: 창이 열리고 약 0.8초 뒤 true 가 된다.
//  · start_ini_all()에는 alert가 7개, confirm은 0개다. 전부 사전 검증 가능한 거부 사유다:
//    로딩중 / 범위 미입력 / 범위 순서 역전 / 사이트·마켓 없음 / 사이트 미선택 / 항목·마켓 미선택 /
//    확장 사용 사이트 다중선택. → 클릭을 alert 후킹으로 감싸 메시지를 잡아 배너에 그대로 띄운다.
//  · 시작 성공 신호 = update_btn_change('off')가 두 버튼 라벨을
//    '상품업데이트 & 마켓전송이 진행중입니다...' 로 바꾼다. 이걸 폴링해 시작 여부를 판정한다.
//  · ★ update_btn_change('on')은 attr('onclick','start_ini_all();')로 인라인 핸들러를 되살린다.
//    → onclick 프로퍼티만 덮어쓰는 잠금은 배치가 끝나면 조용히 풀린다(v1.2의 잠재 버그).
//      capture 단계 리스너로 잘라야 한다.
//
// ── ★★ auto_repeat 실측 (2026-08-02, v1.4의 근거) ───────────
//  scrapDetailParallel()의 끝은 이렇게 생겼다 (소스 확인함):
//      if (auto_repeat) {
//          setTimeout(function(){ … scrapDetailParallel(); }, seconds);   // ①
//          setTimeout(function(){ auto_restart_ini();      }, seconds);   // ②
//      } else { … }
//  그리고  auto_restart_ini() = update_page_load('1'); scrapDetailParallel();
//  게다가  update_page_load()의 ajax 콜백도 끝에서 scrapDetailParallel()을 무조건 부른다(조건 없음).
//
//  ★ 즉 재시작 1회마다 scrap 루프가 1개 → 3개로 늘어난다.
//    ①에서 1개 · ②가 직접 1개 · ②가 부른 update_page_load 콜백에서 1개.
//    scrapDetailParallel에는 재진입 가드가 없다(확인함) → 늘어난 3개가 각각 또 완료되면 또 3배.
//    실제 사고: 4시간이면 끝날 구간이 12시간 뒤에도 안 끝나고 창마다 진도가 뒤죽박죽이었다.
//
//  ★ 끄는 방법의 함정: 조건이 auto_repeat=='Y' 비교가 아니라 if(auto_repeat) 진리값이다.
//    서버는 "Y"를 심어 보내는데 "N"도 truthy라 값만 "N"으로 바꿔서는 안 꺼진다.
//    → 반드시 빈 문자열('')처럼 falsy 한 값으로 만들어야 한다. killAutoRepeat() 참조.
//
//  ★ 2026-08-02 런타임 실측에서는 ②만 걸리고 ①은 걸리지 않았다(①의 조건 미규명, 스크래퍼 팝업
//    상태로 추정). 그래서 배수는 상황에 따라 2~3배로 본다. 소스 형태만 보고 단정하지 말 것.
//  ★ 재시작 시각은 '완료 후 0~60분'이 아니다. auto_repeat_type="2" · auto_repeat_time="01"에서
//    실측 지연은 25,401,022ms(≈7시간 3분) = 다음 01시 + 랜덤. 즉 하루 1회 지정 시각이다.
//  ★ 반복이 켜져 있으면 완료해도 버튼이 '진행중'으로 굳는다 — update_btn_change('on')이 else 쪽에만
//    있기 때문이다. 그래서 완료 판정(awaitDone)은 반복을 끈 상태에서만 성립한다.
//  ★ 'auto_restart_ini만 죽이고 auto_repeat은 살린다'는 안(B안)은 기각됐다 — ②가 유일한 타이머라
//    재시작이 아예 사라지고, 버튼은 진행중으로 굳은 채 창이 7시간을 기다린다.
//
//  런처가 연 창에서는 자동/수동을 가리지 않고 더망고 반복을 끈다.
//  반복이 필요하면 런처가 직접 한다(v1.5, repeatLoop 참조) — 평소와 같은 시작 경로를 타므로 루프가 1개다.
//
// ── ★★ 회차 커서 (2026-08-07 런타임 실측, v1.9의 근거) ──────
//  증상: 예약(1회차)은 정상인데 다음 날 반복(2회차)은 마켓 로그인 체크만 하고
//        "모두 완료되었습니다"로 즉시 끝났다. 처리 건수 0. 창 5개 전부 같았다.
//
//  ★ 목록 재적재는 정상이었다(첫 가설은 틀렸다).
//    start_ini_all() 은 끝에서 update_page_load('all') 을 부르고(마켓이 있으면
//    market_login_check_shell() 을 거쳐 같은 곳으로 온다), 그 안에서
//    #all_update_market 에 shell 을 .load() 해 a_checked 를 다시 채운다.
//    #qry·#order_sql 은 load 대상 바깥이라 살아남는다 — 조건도 온전하다.
//
//  ★ 진짜 원인은 전역 커서 inter_idx 다. scrapDetailParallel()은 이렇게 생겼다:
//        if (inter_idx < a_checked.length) { ... a_checked[inter_idx] 처리 ... }
//        else {
//            ... 완료 로그 ...
//            if (auto_repeat && start_mode == '…') {      // ← 토큰 247~710
//                inter_idx = 0; show_idx = 0; send_count = 0;
//                st11_idx = 1; auction20_idx = 1; ... (마켓 순번 34개)
//                ... 재시작 타이머 ...
//            }
//        }
//    ★ 커서 초기화 37개가 예외 없이 if(auto_repeat …) 블록 안에 있다(중괄호 매칭 확인).
//      그 블록이 else 절의 거의 전부다(함수 전체 712토큰 중 247~710).
//    → v1.4가 auto_repeat 을 falsy 로 만들면 초기화도 같이 꺼진다.
//      1회차가 끝나면 inter_idx 는 450(=a_checked.length)에 멈춰 있고,
//      2회차는 450개를 정상적으로 다시 실어 오고도 450<450 이 거짓이라 곧장 완료로 빠진다.
//
//  ★ 즉 auto_repeat 은 '재시작 타이머'만이 아니라 '회차 간 상태 초기화'까지 겸하고 있었다.
//    3-9-1장은 이 플래그를 재시작 배수 문제로만 봤는데 책임이 하나 더 있었다.
//  ★ 실패가 조용했다 — 초록 배너 '▶ N회차를 시작했습니다', 탭 제목 [진행중],
//    완료 감지까지 전부 정상 동작했다. 그래서 v1.5 도입 이후 반복이 한 번도
//    제대로 돈 적이 없는데도 몰랐다. → v1.9가 처리 건수를 읽어 0건을 드러낸다.
//
//  대응(v1.9.1): resetCursors()가 시작 직전에 37개를 전부 되돌린다.
//    ★ v1.9.0은 진행 커서 3개만 되돌렸다가 로그가 [1] [501] [2] [502] 로 뒤섞이는
//      별개의 증상을 냈다 — 마켓 순번의 자가보정이 한 방향뿐이기 때문이다.
//      자세한 것은 resetCursors() 위 주석. '검증 안 된 것은 건드리지 않는다'가
//      이 경우엔 오히려 나빴다: 반쯤만 되돌린 상태가 아무것도 안 되돌린 것보다 나쁘다.
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
// 자동시작 창별 취소 유예(초). 부모에서 확인창을 이미 받았으므로 짧게 둔다.
var AUTO_DELAY = 5;

var KEY_STORE = 'tmg_update_launcher_v1';
var KEY_JOB   = 'tmg_update_job_';
var PAGE      = location.pathname.replace(/[^/]+$/,'') + 'admin_goods_update.php';

function q(s){ return document.querySelector(s); }
function qa(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function nameOf(list, v){ var f = list.filter(function(x){ return x.v === v; })[0]; return f ? f.t : v; }
function names(list, arr){ return (arr||[]).map(function(v){ return nameOf(list, v); }).join(', '); }

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
    rpt:'',                      // 반복 — '' = 안 함, 'H:M' = 매일 그 시각
    sch:'',                      // 예약 — '' = 바로 시작, 'H:M' = 그 시각에 1회차 시작 (v1.7)
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
// ★ 구간 수를 MAX_CHUNKS(5)로 제한한다 — 사이트당 동시 5창이 한도이기 때문이다(강의 3-24).
//   1~4구간은 first/size 그대로 끊고, 5번째 구간이 남은 전량을 흡수한다.
//   예) 총 9,159 · 450/500 → 1~450 / 451~950 / 951~1450 / 1451~1950 / 1951~9159
//   → 마지막 구간이 가장 커진다. 이건 의도한 동작이다(창 수 상한이 우선).
//   총건수가 작아 4구간 안에 끝나면 5번째 구간은 생기지 않는다.
// ────────────────────────────────────────────────────────────
var MAX_CHUNKS = 5;
function chunks(p){
  var total = parseInt(p.total,10) || 0;
  var first = parseInt(p.first,10) || 450;
  var size  = parseInt(p.size,10)  || 500;
  var out = [], s = 1;
  if(total <= 0 || first <= 0 || size <= 0) return out;
  while(s <= total){
    var isLast = (out.length === MAX_CHUNKS - 1);   // 마지막 구간은 끝까지 이어 붙인다
    var len = out.length === 0 ? first : size;
    var e = isLast ? total : Math.min(s + len - 1, total);
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
    status:STATUS, chd:p.chd||'', order:ORDER, rpt:p.rpt||'', sch:p.sch||''
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
// 자식 창 모드 — 대조 → 범위 주입 → 배너 → (자동시작이면) 시작 클릭
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

// ★ capture 단계에서 자른다.
//   더망고 update_btn_change('on')이 attr('onclick','start_ini_all();')로 인라인 핸들러를 되살리므로
//   onclick 프로퍼티만 덮어쓰면 배치가 끝난 뒤 잠금이 조용히 풀린다.
function lockStart(id, msg){
  var e = document.getElementById(id);
  if(!e || e.__tmgLocked) return;
  e.__tmgLocked = true;
  e.addEventListener('click', function(ev){
    ev.preventDefault();
    ev.stopImmediatePropagation();
    alert(msg);
  }, true);
  e.removeAttribute('onclick');
  e.onclick = null;
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

// ── 자동시작 ────────────────────────────────────────────────
function startBtnId(job){ return job.useRange ? 'update_start_limit' : 'update_start'; }

// update_btn_change('off')가 두 버튼 라벨을 '…진행중입니다…'로 바꾼다 → 시작 성공 신호
function startedYet(){
  var t = '';
  ['update_start','update_start_limit'].forEach(function(id){
    var e = document.getElementById(id); if(e) t += (e.textContent || '');
  });
  return t.indexOf('진행중') >= 0;
}

// 범위 모드 판정은 화면과 동일하게 #sp_limit_info 의 display 로 한다.
// 닫혀 있는데 시작하면 검색결과 전량이 돈다.
function rangeUiOpen(){
  var sp = document.getElementById('sp_limit_info');
  if(!sp) return false;
  return getComputedStyle(sp).display !== 'none';
}

// ★★ 페이지 로딩 플래그는 `let isLoaded` 로 선언돼 있다 (2026-08-01 실측).
//   전역 let/const 는 window 에 붙지 않는다 → window.isLoaded 는 영원히 undefined.
//   v1.3.0이 window.isLoaded를 보는 바람에 자동시작이 항상 30초를 기다린 뒤 취소됐다.
//   반드시 '맨이름'으로 읽는다. 선언 자체가 없거나 TDZ면 null을 돌려주고,
//   그때는 이 플래그로 판정하지 않고 페이지 자신의 응답(alert)에 맡긴다.
function pageLoadedFlag(){
  try{ return (typeof isLoaded === 'undefined') ? null : (isLoaded === true); }
  catch(e){ return null; }
}

// 자동시작 배너 — 취소 버튼은 딱 한 번만 만들고 다시 그리지 않는다.
// (1초마다 배너 전체를 다시 그리면 클릭이 유실되거나, 왜 취소됐는지 헷갈린다)
function autoPanel(head, onAbort){
  banner('⏳ <b>' + head + '</b><br>&nbsp;&nbsp;<span id="tmgAutoMsg">준비 중…</span>'
    + '<div style="margin-top:6px">'
    + '<button id="tmgAutoAbort" style="font:bold 12px/1.4 \'맑은 고딕\',sans-serif;padding:3px 10px;cursor:pointer">'
    + '자동 시작 취소</button>'
    + '<span style="margin-left:8px;opacity:.9">← 취소는 이 버튼으로만 됩니다 (배너를 눌러도 취소되지 않습니다)</span>'
    + '</div>', '#b8860b');
  var b = document.getElementById('tmgAutoAbort');
  if(b) b.addEventListener('click', function(ev){ ev.stopPropagation(); onAbort(); });
}
function autoMsg(html){
  var m = document.getElementById('tmgAutoMsg');
  if(m) m.innerHTML = html;
}

// 시작 버튼을 한 번 누르고 결과를 판정한다.
//  { started:true } | { alerts:'…' }  ← 더망고가 거부하면 그 alert 문구가 판정 근거다
async function pressStart(btn){
  var caught = [], orig = window.alert;
  window.alert = function(m){ caught.push(String(m)); };
  try{ btn.click(); }
  catch(e){ caught.push('클릭 예외: ' + e.message); }
  finally{ window.alert = orig; }
  // start_ini_all은 market_login_check(ajax)를 타므로 update_btn_change('off')가 몇 초 늦을 수 있다.
  // v1.3의 3초는 짧아서 '실제로는 시작했는데 아무 반응 없음'으로 오판할 여지가 있었다 → 15초로 늘렸다.
  var t = 0;
  while(t < 15000 && !startedYet()){ await sleep(200); t += 200; }
  return {started: startedYet(), alerts: caught.join(' | ')};
}

async function autoStart(job, head){
  var abort = false;
  function stop(reason){
    banner('⛔ ' + head + ' — <b>자동 시작을 하지 않았습니다.</b><br>&nbsp;&nbsp;· ' + esc(reason)
      + '<br>&nbsp;&nbsp;· 설정을 확인한 뒤 <b>시작 버튼을 직접</b> 누르세요.', '#c9302c');
  }
  var CANCEL_BY_USER = '[자동 시작 취소] 버튼을 눌렀습니다.';

  // 사전 차단 — start_ini_all의 '사이트·마켓 없음' alert 조건과 같다
  if(!(job.items||[]).length && !(job.markets||[]).length){
    stop('업데이트 항목도 전송 마켓도 없습니다. 아무 일도 하지 않습니다.'); return;
  }

  autoPanel(head, function(){ abort = true; autoMsg('취소 요청을 받았습니다. 곧 중단합니다…'); });

  var info = '마켓: ' + esc(names(MARKETS, job.markets) || '없음(업데이트만)')
           + ' / 항목: ' + esc(names(ITEMS, job.items) || '없음(전송만)');

  // ① 페이지 로딩 대기. 플래그를 못 읽으면(null) 이 관문은 건너뛰고 ④가 판정한다.
  var flag = pageLoadedFlag(), waited = 0;
  while(pageLoadedFlag() === false){
    if(abort){ stop(CANCEL_BY_USER); return; }
    if(waited >= 60000){ stop('더망고 페이지 로딩이 60초 안에 끝나지 않았습니다.'); return; }
    autoMsg('더망고 페이지 로딩을 기다리는 중… ' + Math.round(waited/1000) + '초');
    await sleep(500); waited += 500;
  }

  // ② 취소 유예
  for(var i = AUTO_DELAY; i > 0; i--){
    if(abort){ stop(CANCEL_BY_USER); return; }
    autoMsg('<b>' + i + '초 후 자동 시작</b>합니다. · ' + info
      + (flag === null ? '<br>&nbsp;&nbsp;<span style="opacity:.9">· 로딩 플래그를 읽을 수 없어 시작 응답으로 판정합니다.</span>' : ''));
    await sleep(1000);
  }
  if(abort){ stop(CANCEL_BY_USER); return; }

  // ③ 클릭 직전 재대조 — 대기 도중 화면이 바뀌었을 수 있다
  var bad = diff(job, actualState());
  if(bad.length){ stop('클릭 직전 재대조에서 어긋났습니다: ' + bad.join(' / ')); return; }

  if(job.useRange){
    var sl = document.getElementById('start_limit'), el = document.getElementById('end_limit');
    if(!sl || !el || sl.value !== String(job.start) || el.value !== String(job.end)){
      stop('범위 값이 유지되지 않았습니다 (요청 ' + job.start + '~' + job.end + ').'); return;
    }
    // ★ 이 검사를 빼면 범위 UI가 닫힌 채 시작돼 검색결과 전량이 돈다
    if(!rangeUiOpen()){ stop('범위 입력 영역이 닫혀 있습니다. 이대로 시작하면 검색결과 전량이 실행됩니다.'); return; }
  }else if(rangeUiOpen()){
    stop('범위 분할을 쓰지 않는 프리셋인데 범위 입력 영역이 열려 있습니다.'); return;
  }

  var btn = document.getElementById(startBtnId(job));
  if(!btn){ stop('시작 버튼을 찾지 못했습니다.'); return; }

  // ④ 클릭. 성공/실패 판정은 더망고 자신에게 맡긴다.
  //    · 시작 신호가 뜨면 성공
  //    · '페이지 로딩중' alert면 아직 이르다 → 재시도 (최대 60초)
  //    · 그 밖의 alert면 사람이 고쳐야 하는 거부다 → 즉시 중단하고 문구를 그대로 보여 준다
  //    · alert도 없고 시작도 안 됐으면 버튼이 죽은 것이다 → 즉시 중단 (조용히 반복하지 않는다)
  var deadline = Date.now() + 60000, tries = 0;
  while(true){
    if(abort){ stop(CANCEL_BY_USER); return; }
    tries++;
    autoMsg('시작을 요청하는 중… (' + tries + '회)');
    var r = await pressStart(btn);

    if(r.started){
      banner('▶ ' + head + ' — <b>자동 시작했습니다.</b> (' + tries + '회 시도)'
        + '<br>&nbsp;&nbsp;· ' + info
        + '<br>&nbsp;&nbsp;· 끝나면 배너가 🏁 완료로 바뀝니다. 반복은 꺼져 있습니다.', '#1f7a3d');
      return;
    }
    if(!r.alerts){
      stop('시작 버튼이 아무 반응도 하지 않았습니다(더망고 메시지 없음). 화면 상태를 확인하세요.'); return;
    }
    if(r.alerts.indexOf('로딩') < 0){
      stop('더망고가 시작을 거부했습니다 — ' + r.alerts); return;
    }
    if(Date.now() >= deadline){
      stop('더망고가 60초 동안 계속 "로딩중"이라고 답했습니다 — ' + r.alerts); return;
    }
    autoMsg('더망고가 아직 로딩 중이라고 답했습니다. 다시 시도합니다… ('
      + tries + '회 · 남은 ' + Math.max(0, Math.round((deadline - Date.now())/1000)) + '초)');
    await sleep(1500);
  }
}

// ── ★ 더망고 자동 재시작(auto_repeat) 차단 — v1.4 ────────────
// 근거는 파일 위쪽 '실측' 주석. 재시작 1회마다 scrap 루프가 3배로 늘어난다.
// 조건이 if(auto_repeat) 진리값이라 "N"으로는 안 꺼진다 → falsy 로 만든다.
// 값이 안 꺼지는 경우에 대비해 auto_restart_ini 자체도 무력화한다(②만 막고 ①은 못 막는다 —
// 그래서 값 차단이 주(主)이고 함수 무력화는 보조다).
function killAutoRepeat(){
  var r = {before:null, off:false, wrapped:false};
  try{ r.before = (typeof auto_repeat === 'undefined') ? null : String(auto_repeat); }catch(e){}
  try{ window.auto_repeat = ''; }catch(e){}
  try{ r.off = (typeof auto_repeat !== 'undefined') && !auto_repeat; }catch(e){ r.off = false; }
  try{
    if(typeof window.auto_restart_ini === 'function'){
      window.auto_restart_ini = function(){ /* 런처: 자동 재시작을 막았습니다 */ };
      r.wrapped = true;
    }
  }catch(e){}
  return r;
}

// 차단 결과를 배너 한 줄로. 실패하면 조용히 넘기지 않고 경고를 남긴다.
function repText(r){
  if(r.off) return '🔒 더망고 자동 재시작(auto_repeat)을 껐습니다 — 이 구간을 <b>한 번만</b> 돕니다.';
  return '⚠ <b>자동 재시작을 끄지 못했습니다</b>(auto_repeat 전역을 찾지 못함'
       + (r.wrapped ? ', auto_restart_ini만 무력화' : '')
       + '). 끝나면 창을 <b>반드시 닫으세요</b> — 방치하면 같은 구간이 여러 겹으로 다시 돕니다.';
}

// ── 완료 감지 ────────────────────────────────────────────────
// 판정은 시작 판정과 같은 신호(버튼 라벨의 '진행중')를 쓴다 — 진행중이 됐다가 풀리면 완료.
// ★ 이 판정은 더망고 반복을 껐을 때만 성립한다. 켜져 있으면 완료해도 버튼이 '진행중'으로 굳는다
//   (update_btn_change('on')이 else 쪽에만 있다 — 2026-08-02 실측). killAutoRepeat()이 전제다.
async function awaitDone(){
  while(!startedYet()) await sleep(2000);
  while(startedYet())  await sleep(5000);
}

function setTitle(tag){
  try{
    var base = document.title.replace(/^\[[^\]]*\]\s*/, '');
    document.title = tag ? ('[' + tag + '] ' + base) : base;
  }catch(e){}
}

function doneBanner(head, info, c){
  banner('🏁 ' + head + ' — <b>이 구간이 끝났습니다.</b>' + cntTail(c)
    + '<br>&nbsp;&nbsp;· ' + info
    + zeroWarn(c)
    + '<br>&nbsp;&nbsp;· 런처가 자동 반복을 껐으므로 이 창은 더 이상 아무것도 하지 않습니다. 닫으셔도 됩니다.',
    (c && c.zero) ? '#c9302c' : '#2e6da4');
  setTitle((c && c.zero) ? '완료·0건' : '완료');
}

// ── ★ 반복 실행 — 더망고 기능을 쓰지 않고 런처가 직접 재시작한다 (v1.5) ──
// 더망고의 auto_repeat은 재시작 경로에서 워커를 2~3갈래로 불러 루프를 겹치게 만든다(파일 위 실측).
// 그래서 반복은 런처가 맡는다. 완료를 감지해 지정한 시각에 '시작 버튼을 다시 누르는' 방식이라
// 평소와 똑같은 start_ini_all() 경로를 타고, 루프는 정확히 1개다.
// 게다가 회차마다 프리셋↔화면 대조를 다시 한다 — 더망고 자체 반복은 이걸 하지 않는다.
// ★ 다음 시각은 '직전 회차가 끝난 뒤'에만 계산한다.
//   실행 중에는 타이머가 아예 돌지 않으므로 회차가 겹치거나 밀려 쌓이는 일이 구조적으로 없다.
//   지정 시각을 넘긴 채 끝났으면 그날은 건너뛰고 다음 날로 간다.
function nextRunAt(hour, minute){
  var d = new Date();
  d.setHours(hour, minute, 0, 0);
  if(d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}
function pad2(n){ return (n < 10 ? '0' : '') + n; }
function clockOf(d){ return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
// ★ 1시간 미만이면 분·초로 보여 준다. 예약 카운트다운의 마지막 1분이 '0시간 0분'으로
//   굳어 버리면 멈춘 것처럼 보인다(반복 대기 배너에도 같이 적용된다).
function leftOf(ms){
  var s = Math.max(0, Math.round(ms / 1000));
  if(s >= 3600) return Math.floor(s / 3600) + '시간 ' + Math.floor((s % 3600) / 60) + '분';
  return Math.floor(s / 60) + '분 ' + (s % 60) + '초';
}

// ── ★ 대기 루프 계측 · 지각 판정 (v1.8, 2026-08-05) ──
// 배경: Modern Standby 기기에서 화면을 끄면 창의 JS가 통째로 멈춰, 예약이 '지정 시각'이 아니라
//   '화면을 켠 시각'에 시작되는 사고가 있었다(CLAUDE.md 6-1장).
//   ★ 대기 산식에는 버그가 없었다 — `while(Date.now() < target)`은 벽시계라 틱이 늦어도 자기 보정된다.
//     루프가 '아예 한 번도 돌지 않은' 것이라 고칠 산식이 없었다. 그래서 두 가지를 덧댄다.
//   ① 틱 계측 — 실제로 몇 초마다 도는지 배너에 드러낸다(억제를 추측이 아니라 관측으로).
//   ② 지각 유예 — 예정 시각을 크게 넘겨 깨어났으면 시작하지 않는다(조용한 오작동 방지).
var GRACE_MS = 30 * 60 * 1000;    // 이만큼 넘게 늦으면 시작하지 않는다

function tickMeter(){
  var last = Date.now();
  return { tick: function(){ var d = Date.now() - last; last = Date.now(); return d; } };
}
// 정상은 1초. 크롬 백그라운드 스로틀링은 60초 근처, 저전력 진입은 그보다 훨씬 크게 벌어진다.
function tickNote(d){
  if(!d || d < 3000) return '';
  return '<br>&nbsp;&nbsp;<b>⚠ 최근 틱 ' + Math.round(d / 1000) + '초 — 이 창이 억제되고 있습니다. '
       + '화면을 껐다면 켜 두고 밝기만 낮추세요(CLAUDE.md 6-1).</b>';
}
// 예정 시각을 유예 이상 지나 깨어났으면 사유 문자열, 아니면 null.
function lateCheck(target){
  var late = Date.now() - target.getTime();
  if(late <= GRACE_MS) return null;
  return '예정 시각 ' + clockOf(target) + '을(를) ' + leftOf(late) + ' 지나서야 깨어났습니다 — '
       + '대기 중에 이 창이 멈춰 있었다는 뜻입니다(CLAUDE.md 6-1장). '
       + '유예 ' + Math.round(GRACE_MS / 60000) + '분을 넘겨 <b>시작하지 않았습니다.</b>';
}

// ── ★ 회차 커서 초기화 · 처리 건수 판정 (v1.9, 2026-08-07 / v1.9.1, 2026-08-08) ──
// 근거는 파일 위쪽 '회차 커서' 실측 주석. 더망고의 초기화가 auto_repeat 블록 안에 있어
// v1.4가 반복을 끄면서 같이 꺼졌다 → 2회차부터 늘 0건이었다.
//
// ★★ v1.9.0은 진행 커서 3개만 되돌렸다가 다른 증상을 냈다 (2026-08-08 실측).
//   마켓 전송 함수는 전부 이렇게 시작한다:
//       function api_coupang(uid){ if (coupang_idx <= show_idx) coupang_idx = eval(show_idx); … }
//   (api_11st · api_auction20 · api_gmarket20 · api_smartstore 전부 동일 — 5개 마켓 실측 확인)
//   ★ 자가보정이 '한 방향'이다. 마켓 순번이 show_idx보다 뒤처지면 따라 올라오지만,
//     앞서 있으면 절대 내려오지 않는다.
//   → show_idx만 0으로 되돌리면 마켓 순번은 1회차 끝값(501…)을 그대로 들고 간다.
//     로그가 [1] [501] [2] [502] … 로 뒤섞여 한 탭에서 두 작업이 도는 것처럼 보인다.
//     (작업 배열을 걷는 커서는 inter_idx 하나뿐이라 상품 처리 자체는 1갈래다.)
//   → v1.9.1부터 더망고와 똑같이 37개를 전부 되돌린다.
//
// ★ 성격이 달라 취급도 나눈다.
//   · 진행 커서 3개 — 없으면 시작하지 않는다. 없다는 건 페이지 구조가 바뀌었다는 뜻이고,
//     그냥 대입하면 페이지가 쓰지 않는 전역을 새로 만들 뿐이라 또 조용히 0건으로 끝난다.
//   · 마켓 순번 34개 — 없으면 조용히 건너뛴다. ★ 더망고의 초기화 목록에는 test0_idx·test1_idx가
//     들어 있지만 이 페이지에는 그 전역이 없다(실제로 있는 것은 test_idx다). 없는 것을 이유로
//     시작을 막으면 런처가 아예 못 돈다.
var CURSORS = {inter_idx:0, show_idx:0, send_count:0};
var MARKET_IDX = ['st11','auction','auction20','gmarket','gmarket20','interpark','smartstore','coupang',
  'wemakeprice','tmon','tmon2','mustit','lotteon','ssg','ssgmall','lfmall','reebonz','melchi','cafe24',
  'godomall','imweb','hakyung','balaan','shopify','shopee','trenbe','playauto','ktalpha','qoo10jp',
  'toss','ebay','site','test0','test1'].map(function(m){ return m + '_idx'; });

// 성공하면 null, 문제가 있으면 사유 문자열.
function resetCursors(){
  var missing = [], failed = [];
  function put(n, v, required){
    var had;
    try{ had = (typeof window[n] !== 'undefined'); }catch(e){ had = false; }
    if(!had){ if(required) missing.push(n); return; }   // 마켓 순번은 없어도 그냥 넘어간다
    try{
      window[n] = v;
      if(window[n] !== v) failed.push(n);
    }catch(e){ failed.push(n); }
  }
  Object.keys(CURSORS).forEach(function(n){ put(n, CURSORS[n], true); });
  MARKET_IDX.forEach(function(n){ put(n, 1, false); });

  if(missing.length) return '더망고 회차 커서를 찾지 못했습니다 (' + missing.join(', ')
    + '). 페이지 구조가 바뀐 것 같습니다 — 이대로 시작하면 한 건도 처리하지 않고 끝날 수 있습니다.';
  if(failed.length) return '회차 커서를 되돌리지 못했습니다 (' + failed.join(', ') + ').';
  return null;
}

// 완료 시점의 inter_idx = 이번 회차가 실제로 처리한 건수.
// (시작 직전에 0으로 되돌렸으므로 완료 시 값이 곧 처리 건수다)
// ★ window.* 가 아니라 맨이름으로 읽는다 — isLoaded 건과 같은 이유.
function cursorNow(){
  try{ return (typeof inter_idx === 'undefined') ? null : Number(inter_idx); }
  catch(e){ return null; }
}
function targetNow(){
  try{ return (typeof a_checked === 'undefined' || !a_checked) ? null : a_checked.length; }
  catch(e){ return null; }
}
function countOf(){
  var n = cursorNow(), t = targetNow();
  if(n === null) return {zero:false, html:''};
  return {
    zero: n === 0,
    html: '처리 ' + n.toLocaleString() + '건' + (t === null ? '' : ' / 대상 ' + t.toLocaleString() + '건')
  };
}
function cntTail(c){ return (c && c.html) ? ' (' + c.html + ')' : ''; }
// ★ 경고형이다 — 반복을 멈추지 않는다.
//   구간이 검색결과 밖으로 밀려나면(총건수가 줄면 마지막 구간이 그렇다) 0건이 정당하기 때문이다.
function zeroWarn(c){
  if(!c || !c.zero) return '';
  return '<br>&nbsp;&nbsp;<b>⚠ 이 회차는 한 건도 처리하지 않았습니다.</b>'
       + ' 구간이 검색결과 밖이면 정상일 수 있습니다. 그게 아니라면 회차 커서가 되돌려지지 않은 것입니다'
       + '(파일 위 \'회차 커서\' 주석). <b>반복은 계속합니다.</b>';
}

// ── 대조 → 범위 확인 → 시작 클릭 (반복 회차·예약 시작 공용) ──
// 실패하면 사유 문자열을, 성공하면 null을 돌려준다.
// ★ 자동시작(autoStart)은 '로딩중' alert 재시도 루프가 따로 있어 이 함수를 쓰지 않는다.
//   반복·예약은 이미 페이지가 한참 전에 로딩을 마친 상태라 재시도가 필요 없다.
async function verifyAndStart(job){
  var bad = diff(job, actualState());
  if(bad.length) return '설정이 프리셋과 달라졌습니다 — ' + bad.join(' / ');
  if(job.useRange){
    var sl = document.getElementById('start_limit'), el = document.getElementById('end_limit');
    if(!sl || !el || sl.value !== String(job.start) || el.value !== String(job.end))
      return '범위 값이 유지되지 않았습니다 (요청 ' + job.start + '~' + job.end + ').';
    // ★ 이 검사를 빼면 범위 UI가 닫힌 채 시작돼 검색결과 전량이 돈다
    if(!rangeUiOpen()) return '범위 입력 영역이 닫혀 있습니다. 이대로 시작하면 검색결과 전량이 실행됩니다.';
  }else if(rangeUiOpen()){
    return '범위를 쓰지 않는 프리셋인데 범위 입력 영역이 열려 있습니다.';
  }
  var btn = document.getElementById(startBtnId(job));
  if(!btn) return '시작 버튼을 찾지 못했습니다.';
  // ★ 클릭 직전에 회차 커서를 되돌린다(v1.9). 이게 빠지면 2회차부터 0건으로 끝난다.
  var cerr = resetCursors();
  if(cerr) return cerr;
  var r = await pressStart(btn);
  if(!r.started) return '시작하지 못했습니다 — ' + (r.alerts || '더망고가 아무 메시지도 내지 않았습니다.');
  return null;
}

// ── ★ 예약 실행 — 지정한 시각까지 기다렸다가 시작한다 (v1.7) ──
// 자동시작(5초 뒤 시작)과 같은 계열이지만 대기가 길다. 그래서 다르게 두는 것이 셋 있다.
//  ① 대기 중에 사람이 시작 버튼을 직접 누르면 예약은 조용히 물러난다(이중 시작 방지).
//     시작 버튼을 잠그지 않는 이유이기도 하다 — '지금 바로 시작'을 막을 이유가 없다.
//  ② 시작 직전에 대조를 다시 한다(반복 회차와 같은 verifyAndStart).
//  ③ 예약 시각이 이미 지났으면 다음 날로 넘긴다(nextRunAt).
// ★ 대기는 창이 열려 있는 동안만 유효하다. 창을 닫거나 PC가 절전에 들어가면 예약도 사라진다.
async function scheduleStart(job, head, info){
  var at = parseRpt(job.sch);
  if(!at){ banner('⚠ ' + head + ' — 예약 시각을 읽지 못했습니다. 시작 버튼을 직접 누르세요.', '#e0a800'); return; }
  var target = nextRunAt(at.h, at.m);
  var cancelled = false;

  function bye(reason, color){
    banner('⛔ ' + head + ' — <b>예약을 실행하지 않았습니다.</b>'
      + '<br>&nbsp;&nbsp;· ' + esc(reason)
      + '<br>&nbsp;&nbsp;· 확인한 뒤 <b>시작 버튼을 직접</b> 누르세요.', color || '#c9302c');
    setTitle('예약취소');
  }

  banner('⏰ <b>' + head + '</b> — <b>' + clockOf(target) + '</b>에 자동으로 시작합니다.'
    + '<br>&nbsp;&nbsp;· ' + info
    + '<br>&nbsp;&nbsp;· <span id="tmgSchMsg">…</span>'
    + '<div style="margin-top:6px"><button id="tmgSchStop" '
    + 'style="font:bold 12px/1.4 \'맑은 고딕\',sans-serif;padding:3px 10px;cursor:pointer">예약 취소</button>'
    + '<span style="margin-left:8px;opacity:.9">← 예약을 무르는 버튼입니다. '
    + '지금 바로 돌리려면 그냥 <b>시작 버튼</b>을 누르세요 — 예약은 알아서 물러납니다.</span></div>', '#b8860b');
  var sb = document.getElementById('tmgSchStop');
  if(sb) sb.addEventListener('click', function(ev){ ev.stopPropagation(); cancelled = true; });
  setTitle('예약');

  function msg(html){ var m = document.getElementById('tmgSchMsg'); if(m) m.innerHTML = html; }

  var meter = tickMeter(), lastTick = 0;
  while(Date.now() < target.getTime()){
    if(cancelled){ bye('[예약 취소] 버튼을 눌렀습니다.', '#6c757d'); return; }
    // ★ 사람이 먼저 시작했으면 예약은 물러난다. 그대로 두면 예약 시각에 또 누르게 된다.
    if(startedYet()){
      banner('▶ ' + head + ' — 예약 시각 전에 <b>이미 시작된 것을 확인했습니다. 예약은 취소합니다.</b>'
        + '<br>&nbsp;&nbsp;· ' + info, '#1f7a3d');
      setTitle('진행중');
      return;
    }
    msg('시작 예정 <b>' + clockOf(target) + '</b> · 남은 시간 ' + leftOf(target.getTime() - Date.now())
      + '<br>&nbsp;&nbsp;<span style="opacity:.9">· 창을 닫거나 <b>화면을 끄면</b> 예약이 멈춥니다 — '
      + '이 PC는 화면 끄기가 곧 저전력 진입이다. <b>밝기만 최저로</b> 낮출 것.</span>'
      + tickNote(lastTick));
    await sleep(1000);
    lastTick = meter.tick();
  }
  if(cancelled){ bye('[예약 취소] 버튼을 눌렀습니다.', '#6c757d'); return; }

  // ★ 지각 판정(v1.8) — 유예를 넘겨 깨어났으면 시작하지 않는다.
  //   그냥 시작하면 '엉뚱한 시각에 조용히 도는' 상태가 된다(실제로 겪었다).
  var lateWhy = lateCheck(target);
  if(lateWhy){ bye(lateWhy); return; }
  var lateMs = Date.now() - target.getTime();

  msg('예약 시각이 됐습니다. 대조 후 시작을 요청하는 중…');
  var err = await verifyAndStart(job);
  if(err){ bye('예약 시각이 됐지만 시작하지 못했습니다 — ' + err); return; }

  banner('▶ ' + head + ' — <b>예약 시각(' + clockOf(target) + ')에 시작했습니다.</b>'
    + (lateMs > 60000 ? ' <b style="color:#ffd">(예정보다 ' + leftOf(lateMs) + ' 늦음)</b>' : '')
    + '<br>&nbsp;&nbsp;· ' + info
    + '<br>&nbsp;&nbsp;· ' + (parseRpt(job.rpt)
        ? '🔁 끝나면 <b>' + esc(rptLabel(job.rpt)) + '</b>에 다시 시작합니다.'
        : '끝나면 배너가 🏁 완료로 바뀝니다. 반복은 꺼져 있습니다.'), '#1f7a3d');
  setTitle('진행중');
}

async function repeatLoop(job, head, info, last){
  var at = parseRpt(job.rpt);
  if(!at) return;                       // 여기까지 왔는데 못 읽으면 반복하지 않는다
  var when = rptLabel(job.rpt);
  var stopped = false, round = 1;

  // 중지 버튼은 배너를 다시 그릴 때마다 새로 만든다. 대신 상태는 바깥 변수 하나로만 본다.
  var STOP = '<div style="margin-top:6px"><button id="tmgRptStop" '
    + 'style="font:bold 12px/1.4 \'맑은 고딕\',sans-serif;padding:3px 10px;cursor:pointer">반복 중지</button>'
    + '<span style="margin-left:8px;opacity:.9">← 중지는 이 버튼으로만 됩니다</span></div>';
  function bindStop(){
    var b = document.getElementById('tmgRptStop');
    if(b) b.addEventListener('click', function(ev){ ev.stopPropagation(); stopped = true; });
  }
  function msg(html){ var m = document.getElementById('tmgRptMsg'); if(m) m.innerHTML = html; }
  function halt(reason, color){
    banner('⏹ ' + head + ' — <b>반복을 멈췄습니다.</b> (' + round + '회차까지 실행)'
      + '<br>&nbsp;&nbsp;· ' + esc(reason), color || '#c9302c');
    setTitle('반복중지');
  }
  function bye(){ halt('[반복 중지] 버튼을 눌렀습니다.', '#6c757d'); }

  while(true){
    var target = nextRunAt(at.h, at.m);
    setTitle((last && last.zero) ? '대기·0건' : '대기');
    banner('🔁 <b>' + head + '</b> — ' + round + '회차 완료' + cntTail(last) + '. <b>' + when + '</b>에 다시 시작합니다.'
      + '<br>&nbsp;&nbsp;· ' + info
      + zeroWarn(last)
      + '<br>&nbsp;&nbsp;· <span id="tmgRptMsg">…</span>' + STOP, (last && last.zero) ? '#c9302c' : '#2e6da4');
    bindStop();

    var meter = tickMeter(), lastTick = 0;
    while(Date.now() < target.getTime()){
      if(stopped){ bye(); return; }
      msg('다음 시작 <b>' + clockOf(target) + '</b> · 남은 시간 ' + leftOf(target.getTime() - Date.now())
        + tickNote(lastTick));
      await sleep(1000);
      lastTick = meter.tick();
    }
    if(stopped){ bye(); return; }

    // ★ 지각 판정(v1.8) — 반복은 회차 사이 대기가 가장 길어 노출이 크다.
    //   유예를 넘겼으면 조용히 엉뚱한 시각에 돌지 말고 멈춘다.
    var lateWhy = lateCheck(target);
    if(lateWhy){ halt(lateWhy); return; }

    // ★ 회차마다 다시 대조한다 (예약 시작과 같은 절차 — verifyAndStart)
    msg('시작을 요청하는 중…');
    var err = await verifyAndStart(job);
    if(err){ halt(err); return; }

    round++;
    setTitle('진행중');
    banner('▶ ' + head + ' — <b>' + round + '회차를 시작했습니다.</b> (' + when + ' 반복)'
      + '<br>&nbsp;&nbsp;· ' + info + STOP, '#1f7a3d');
    bindStop();
    await awaitDone();
    last = countOf();                   // ★ 이번 회차가 실제로 몇 건을 처리했는지 (v1.9)
    if(stopped){ bye(); return; }
  }
}

// 1회차 완료를 기다린 뒤, 반복 설정이 있으면 반복으로 넘긴다.
async function runWatcher(job, head, info){
  await awaitDone();
  var c = countOf();
  if(parseRpt(job.rpt)) await repeatLoop(job, head, info, c);
  else doneBanner(head, info, c);
}

function childMode(jid){
  var raw = localStorage.getItem(KEY_JOB + jid);
  if(!raw){ banner('⚠ 런처 작업 정보를 찾지 못했습니다. 이 창은 수동으로 확인하고 쓰세요.', '#e0a800'); return; }
  var job;
  try{ job = JSON.parse(raw); }catch(e){ banner('⚠ 런처 작업 정보가 깨졌습니다.', '#e0a800'); return; }

  // ★ 자동 재시작부터 끈다 (대조 실패로 중간에 return 하더라도 꺼진 채로 남아야 한다)
  var rep = killAutoRepeat();

  // ★ auto/sched 는 1회용이다. 이 값을 남겨 두면 창을 새로고침하는 것만으로
  //   확인창 없이 또 자동 시작·예약한다(#tmglauncher 해시는 리로드를 넘어 살아남는다).
  if(job.auto || job.sched){
    try{ localStorage.setItem(KEY_JOB + jid, JSON.stringify(Object.assign({}, job, {auto:false, sched:false}))); }catch(e){}
  }

  var bad = diff(job, actualState());
  var rangeErr = job.useRange ? injectRange(job) : null;

  var head = '[' + esc(job.name) + '] '
    + (job.useRange ? ('구간 ' + job.no + '/' + job.of + ' · ' + job.start + '~' + job.end) : '검색결과 전체');

  if(bad.length || rangeErr){
    var msg = '런처: 설정 대조에 실패해 시작을 잠갔습니다. 배너 내용을 확인하세요.';
    lockStart('update_start', msg);
    lockStart('update_start_limit', msg);
    var lines = bad.concat(rangeErr ? ['범위 — ' + rangeErr] : []);
    banner('⛔ ' + head + ' — <b>설정이 프리셋과 다릅니다. 시작을 잠갔습니다.</b>'
      + (job.auto ? ' (자동 시작도 취소했습니다)' : job.sched ? ' (예약도 취소했습니다)' : '') + '<br>'
      + lines.map(function(x){ return '&nbsp;&nbsp;· ' + esc(x); }).join('<br>')
      + '<br>&nbsp;&nbsp;· ' + repText(rep), '#c9302c');
    return;
  }

  if(job.useRange){
    // 범위 전용 창에서 '검색결과모든상품' 버튼을 잘못 누르면 헷갈리므로 잠근다.
    // (실제 실행 범위는 버튼이 아니라 #sp_limit_info 의 display 가 정하지만, 표시를 명확히 하기 위해 유지)
    lockStart('update_start', '런처: 이 창은 구간 ' + job.start + '~' + job.end + ' 전용입니다. 아래 범위설정 시작 버튼을 쓰세요.');
  }
  var info = '마켓: ' + esc(names(MARKETS, job.markets) || '없음(업데이트만)')
           + ' / 항목: ' + esc(names(ITEMS, job.items) || '없음(전송만)');

  var startMsg = job.auto  ? '잠시 후 자동으로 시작합니다.'
               : job.sched ? ('예약 시각 <b>' + esc(hhmm(job.sch)) + '</b>에 자동으로 시작합니다.')
               :             '아래 시작 버튼을 직접 누르세요.';

  banner('✅ ' + head + ' · 준비완료 — <b>' + startMsg + '</b>'
    + '<br>&nbsp;&nbsp;· ' + info
    + '<br>&nbsp;&nbsp;· ' + esc(hintOf(job.items, job.markets))
    + '<br>&nbsp;&nbsp;· ' + repText(rep)
    + (parseRpt(job.rpt) ? '<br>&nbsp;&nbsp;· 🔁 끝나면 <b>' + esc(rptLabel(job.rpt)) + '</b>에 런처가 다시 시작합니다(회차마다 대조 재확인).' : ''), '#1f7a3d');

  runWatcher(job, head, info);
  if(job.auto) autoStart(job, head);
  else if(job.sched) scheduleStart(job, head, info);
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

// 시각 선택 UI — 시/분 두 개의 셀렉트. 저장값은 'H:M' 문자열 하나로 둔다.
// ★ 반복(rpt)과 예약(sch)이 같은 형식·같은 파서를 쓴다. pfx로 id만 갈라 준다('Rpt' / 'Sch').
// ★ v1.5.0은 시만 저장했다(예 '1'). 그 프리셋도 그대로 읽히게 분이 없으면 0분으로 본다.
function timeSelects(pfx, val, offLabel, onLabel){
  var t = parseRpt(val), on = !!t;
  var h = t ? t.h : 1, m = t ? t.m : 0;   // 켤 때의 기본값 = 01:00
  function opts(n, sel, suffix){
    var s = '';
    for(var i = 0; i < n; i++)
      s += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + pad2(i) + suffix + '</option>';
    return s;
  }
  var dis = on ? '' : ' disabled';
  return '<select id="tmgL' + pfx + 'On">'
       +   '<option value=""' + (on ? '' : ' selected') + '>' + offLabel + '</option>'
       +   '<option value="1"' + (on ? ' selected' : '') + '>' + onLabel + '</option>'
       + '</select> '
       + '<select id="tmgL' + pfx + 'H"' + dis + '>' + opts(24, h, '시') + '</select> '
       + '<select id="tmgL' + pfx + 'M"' + dis + '>' + opts(60, m, '분') + '</select>';
}

// 'H:M' → {h,m}. 못 읽으면 null(=안 함)을 준다 — 조용히 0시로 떨어지지 않게.
// 반복·예약 공용.
function parseRpt(rpt){
  if(!rpt && rpt !== 0) return null;
  var p = String(rpt).split(':');
  var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if(isNaN(h) || h < 0 || h > 23) return null;
  if(isNaN(m) || m < 0 || m > 59) m = 0;
  return {h: h, m: m};
}
function hhmm(v){ var t = parseRpt(v); return t ? (pad2(t.h) + ':' + pad2(t.m)) : ''; }
function rptLabel(rpt){ var s = hhmm(rpt); return s ? ('매일 ' + s) : ''; }

function checkRow(list, sel, kind){
  return list.map(function(x){
    var on = sel.indexOf(x.v) >= 0 ? ' checked' : '';
    return '<label style="display:inline-block;width:calc(50% - 4px);white-space:nowrap;overflow:hidden">'
      + '<input type="checkbox" data-kind="' + kind + '" value="' + x.v + '"' + on + '> ' + esc(x.t) + '</label>';
  }).join('');
}

function mkSummary(mk){
  if(!mk.length) return '마켓없음(업데이트만)';
  var nm = mk.map(function(v){ return nameOf(MARKETS, v); });
  return nm.length <= 2 ? nm.join(', ') : (nm.slice(0,2).join(', ') + ' 외 ' + (nm.length-2));
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
  var n = expand(cur).length;
  var b = q('#tmgLRun');     if(b) b.textContent = '실행 (' + n + '창)';
  var a = q('#tmgLRunAuto'); if(a) a.textContent = '실행+자동시작 (' + n + '창)';
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
  + '<div style="margin-bottom:6px">예약 ' + timeSelects('Sch', cur.sch, '예약 안 함 (바로 시작)', '지정 시각에 시작')
      + (parseRpt(cur.sch) ? '<div style="color:#b8860b;font-size:11px">[실행+예약]으로 열면 창이 <b>'
          + esc(hhmm(cur.sch)) + '</b>까지 기다렸다가 스스로 시작합니다.</div>' : '')
    + '</div>'
  + '<div style="margin-bottom:6px">반복 ' + timeSelects('Rpt', cur.rpt, '반복 안 함 (1회만)', '매일')
      + (parseRpt(cur.rpt) ? '<div style="color:#2e6da4;font-size:11px">창이 열려 있는 동안 매일 '
          + esc(hhmm(cur.rpt)) + '에 다시 시작합니다.</div>' : '')
    + '</div>'
  + '<div style="margin-bottom:6px;color:#555">정렬: <b>상품수집 날짜순(과거순)</b> 고정</div>'
  + '<fieldset style="border:1px solid #ddd;padding:4px 6px;margin:0 0 6px"><legend style="font-size:11px">범위 분할</legend>'
      + '<label><input type="checkbox" id="tmgLUse"' + (cur.useRange?' checked':'') + '> 사용</label>'
      + ' <button id="tmgLCount" style="float:right">건수 조회</button>'
      + '<div style="margin-top:4px">총 <input id="tmgLTotal" type="number" value="' + (cur.total||0) + '" style="width:70px">건'
      + ' · 첫 <input id="tmgLFirst" type="number" value="' + (cur.first||450) + '" style="width:52px">'
      + ' · 이후 <input id="tmgLSize" type="number" value="' + (cur.size||500) + '" style="width:52px"></div>'
      + '<div style="color:#888;font-size:11px;margin-top:2px">구간은 <b>최대 ' + MAX_CHUNKS + '개</b>입니다(동시 ' + MAX_CHUNKS
      + '창 한도). 마지막 구간이 남은 전량을 맡으므로 가장 커집니다.</div>'
      + '<div id="tmgLChunks" style="max-height:220px;overflow:auto;margin-top:4px;border-top:1px solid #eee;padding-top:4px">'
      + (cur.useRange ? chunkList(cur) : '<div style="color:#888">범위 분할을 사용하지 않습니다.</div>') + '</div>'
    + '</fieldset>'
  + '<div style="margin-top:8px"><button id="tmgLSave">저장</button>'
      + '<span id="tmgLPendWrap"></span></div>'
  + '<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">'
      + '<button id="tmgLRun" style="font-weight:bold">실행</button>'
      + '<button id="tmgLRunAuto" style="font-weight:bold;color:#a94442;border-color:#a94442">실행+자동시작</button>'
      + '<button id="tmgLRunSch" style="font-weight:bold;color:#8a6d0b;border-color:#8a6d0b">실행+예약</button>'
    + '</div>'
  + '<div style="color:#888;font-size:11px;margin-top:3px">실행 = 창만 연다 · 실행+자동시작 = 확인 후 각 창이 대조를 통과하면 '
      + AUTO_DELAY + '초 뒤 스스로 시작 · 실행+예약 = 위 <b>예약</b> 시각까지 기다렸다가 시작</div>';

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
  cur.rpt     = q('#tmgLRptOn').value ? (q('#tmgLRptH').value + ':' + q('#tmgLRptM').value) : '';
  cur.sch     = q('#tmgLSchOn').value ? (q('#tmgLSchH').value + ':' + q('#tmgLSchM').value) : '';
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

// 자동시작·예약 확인창 문구 — 되돌리기 어려운 작업이므로 무엇이 나가는지 한 화면에 모은다
function confirmText(jobs, mode){
  var sets = jobs.map(function(j){ return j.markets.slice().sort().join(','); });
  var same = sets.every(function(x){ return x === sets[0]; });
  var mk = same ? (names(MARKETS, jobs[0].markets) || '없음 (업데이트만)') : '★ 구간별로 다름';
  var chdEl = q('#tmgLChd');
  var chd = (chdEl && chdEl.selectedIndex >= 0) ? chdEl.options[chdEl.selectedIndex].text.trim() : '';
  var sched = (mode === 'sch');
  var lines = [
    '[' + cur.name + '] ' + (sched ? '예약 실행' : '자동 시작'),
    '',
    '· 수집사이트 : ' + nameOf(SITES, cur.site),
    '· 업데이트항목 : ' + (names(ITEMS, cur.items) || '없음 (전송만)'),
    '· 전송마켓 : ' + mk,
    '· 변동일 : ' + (chd || '전체'),
    '· 정렬 : 상품수집 날짜순(과거순)',
    '· 시작 : ' + (sched ? ('★ ' + schWhen() + ' — 그때까지 창을 열어 둬야 합니다')
                         : (AUTO_DELAY + '초 뒤 바로')),
    '· 반복 : ' + (parseRpt(cur.rpt) ? ('★ ' + rptLabel(cur.rpt) + ' — 창을 닫을 때까지 계속 반복합니다') : '없음 (1회만)')
  ];
  if(jobs[0].useRange){
    var cnt = jobs.reduce(function(a,j){ return a + (j.end - j.start + 1); }, 0);
    lines.push('· 창 ' + jobs.length + '개 · 대상 ' + cnt.toLocaleString() + '건 ('
      + jobs[0].start.toLocaleString() + ' ~ ' + jobs[jobs.length-1].end.toLocaleString() + ')');
  }else{
    lines.push('· 창 1개 · ★검색결과 전체');
  }
  if(sched){
    lines.push('', '창을 지금 열어 두고, ' + schWhen() + '에 각 창이 대조를 다시 한 뒤 시작합니다.',
      '(창마다 [예약 취소] 버튼이 뜹니다. 대조에 실패한 창은 시작하지 않습니다.)',
      '★ 창을 닫거나 PC가 절전/종료되면 예약도 함께 사라집니다.');
  }else{
    lines.push('', '각 창은 설정 대조를 통과하면 ' + AUTO_DELAY + '초 뒤 스스로 시작합니다.',
      '(창마다 취소 버튼이 뜹니다. 대조에 실패한 창은 시작하지 않습니다.)');
  }
  lines.push('', '마켓에 전송된 내용은 되돌리기 어렵습니다. 진행할까요?');
  return lines.join('\n');
}

// 예약 시각을 사람이 읽는 형태로 — '오늘 01:00 (약 3시간 뒤)' / '내일 01:00 (약 7시간 뒤)'
// 창은 몇 초 뒤에 열리며 각자 다시 계산하지만, 그 차이는 표시상 무의미하다.
function schWhen(){
  var t = parseRpt(cur.sch);
  if(!t) return '';
  var d = nextRunAt(t.h, t.m);
  var today = (d.getDate() === new Date().getDate());
  return (today ? '오늘 ' : '내일 ') + clockOf(d) + ' (약 ' + leftOf(d.getTime() - Date.now()) + ' 뒤)';
}

// mode: '' = 창만 열기 · 'auto' = 5초 뒤 자동시작 · 'sch' = 예약 시각에 시작
async function doRun(mode){
  collect();
  var jobs = expand(cur);
  if(!jobs.length){ stat('<span style="color:#c9302c">열 작업이 없습니다.</span>'); return; }

  if(mode === 'sch' && !parseRpt(cur.sch)){
    stat('<span style="color:#c9302c">예약 시각이 없습니다. 위 <b>예약</b>을 '
       + '[지정 시각에 시작]으로 바꾸고 시·분을 고르세요.</span>');
    return;
  }

  if(mode){
    if(!cur.items.length && !cur.markets.length
       && jobs.every(function(j){ return !j.markets.length; })){
      stat('<span style="color:#c9302c">업데이트 항목도 전송 마켓도 없습니다. '
         + (mode === 'sch' ? '예약할' : '자동 시작할') + ' 수 없습니다.</span>');
      return;
    }
    if(!confirm(confirmText(jobs, mode))){
      stat(mode === 'sch' ? '예약을 취소했습니다.' : '자동 시작을 취소했습니다.'); return;
    }
    jobs = jobs.map(function(j){
      return Object.assign({}, j, mode === 'sch' ? {sched:true} : {auto:true});
    });
  }

  var r = await openAll(jobs);
  pending = r.rest;
  var tail = mode === 'sch'  ? '각 창이 <b>' + esc(hhmm(cur.sch)) + '</b>까지 기다렸다가 스스로 시작합니다. '
                             + '<b>창을 닫지 마세요.</b>'
           : mode === 'auto' ? '각 창이 대조를 통과하면 <b>스스로 시작</b>합니다.'
           :                   '각 창에서 <b>시작 버튼을 직접</b> 누르세요.';
  stat((r.blocked ? '<span style="color:#c9302c">팝업이 차단됐습니다. 이 사이트의 팝업을 허용한 뒤 아래 버튼을 누르세요.</span><br>' : '')
    + '창 ' + r.opened + '개를 열었습니다. ' + tail);
  renderPending();
}

function bindMain(){
  ['tmgLName','tmgLSite','tmgLChd','tmgLSchOn','tmgLSchH','tmgLSchM','tmgLRptOn','tmgLRptH','tmgLRptM',
   'tmgLUse','tmgLTotal','tmgLFirst','tmgLSize'].forEach(function(id){
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

  q('#tmgLRun').onclick     = function(){ doRun(''); };
  q('#tmgLRunAuto').onclick = function(){ doRun('auto'); };
  q('#tmgLRunSch').onclick  = function(){ doRun('sch'); };
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
    + '<div style="margin-top:4px;color:#888;font-size:11px">※ 자동시작·예약은 대조를 통과한 창만 시작합니다. '
    + '런처가 연 창은 더망고의 자동 반복(auto_repeat)을 꺼서 구간을 한 번만 돕니다(v1.4). '
    + '예약 대기 중에는 <b>창을 닫지 마세요</b> — 예약도 함께 사라집니다.</div>';
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
  if(m) childMode(m[1]);   // 런처가 연 창 — 대조·범위주입(·자동시작)만 하고 패널은 띄우지 않는다
  else  panel();
}
if(document.readyState === 'complete') boot(); else window.addEventListener('load', boot);
})();
