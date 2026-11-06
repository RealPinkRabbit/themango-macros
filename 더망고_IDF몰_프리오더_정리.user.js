// ==UserScript==
// @name         더망고 IDF몰 프리오더 정리
// @namespace    solddeul.tmg
// @version      1.0.0
// @description  상품관리에서 IDF몰 상품을 전부 읽고, IDF몰 목록에서 PRE-ORDER(예약판매) 상품을 판정한다. 예약 상품이면 상품품절처리(더망고가 재고업데이트를 OFF로 바꿈) + 상품메모에 [프리오더] 표시. 표시가 있는 상품이 예약에서 풀려 일반 판매로 바뀌면 재고업데이트를 ON으로 되돌리고 표시를 지운다(다음 상품업데이트 때 재고 복원). [미리보기]는 아무것도 바꾸지 않고 CSV만 낸다.
// @match        https://tmg4682.mycafe24.com/mall/admin/admin_goods.php*
// @grant        GM_xmlhttpRequest
// @connect      www.idfmall.co.kr
// @connect      idfmall.co.kr
// @run-at       document-idle
// ==/UserScript==
(function(){
'use strict';

// ────────────────────────────────────────────────────────────
// 실측 근거 (2026-09-17, CLAUDE.md 3-14)
//  · 목록: admin_goods.php GET, search_form 값 + ps_site_id={SITE} + ps_page=N + ps_num=10.
//    ★화면은 ps_num과 무관하게 10개만 그리지만 쪽 넘김은 ps_num 단위 → ps_num=10을 꼭 보낸다(아니면 대부분 누락).
//    결과 건수 = 본문의 두 번째 '총 N개'. 카드 머리글 '[ 상품번호 : uid / … / 상태 : 재고상품|품절상품 ]',
//    본문 'MUSINSA.com (사이트상품번호 : goodsNo)', 메모 textarea#admin_memo_{uid},
//    재고업데이트 select#uid_stock_update_yn_{uid}(Y/N).
//  · 품절처리: POST admin_goods_ok.php amode=goods_soldout&uid&site_id={SITE} → 'ok' (재고업데이트 자동 OFF)
//  · 재고업데이트: POST amode=modify_stock2&uid&stock_update_yn=Y|N → 빈 응답
//  · 메모: POST amode=admin_memo&pmode=save|remove&uid&memo_text → '저장이/삭제가 완료' (메모는 상품당 한 칸, 저장=덮어쓰기)
//  · 판정(IDF몰, 2026-10-24 실측): 목록 list.html?cate_no=N&page=P(20개씩). 상품 카드 id="anchorBoxId_{product_no}",
//    예약 상품은 카드 안 배지 <span …>PRE-ORDER</span>. 예약 상품 모음 카테고리 3538 '겨울 프리오더'.
//    예약 = 주력 5개(157·159·160·156·155)에서 PRE-ORDER 배지 ∪ 3538 소속 (10-24: 배지 140 · 3538 154 · 합 157).
//    목록에 있는데 예약이 아니면 '일반 판매'. 어느 목록에도 없으면 판정하지 않는다(판매종료 등).
//    더망고 origin에서는 CORS → GM_xmlhttpRequest. IDF 요청 간격 1.2초.
//  · ★미검증: 더망고 IDF 카드의 '사이트상품번호'가 IDF product_no인지(무신사는 goodsNo였다). 첫 [미리보기]의
//    'IDF 목록 대조 성공' 수로 확인한다. 0이면 멈추도록 막아 두었다.
//  · 위 '목록·품절처리·재고업데이트·메모' 요청은 무신사 무배당발 정리 v1.0(2026-09-17 실측)과 같고 site_id만 다르다.
//  · 더망고 요청 제한: 연속 ~20회 → 200 응답에 'Access Denied … 과도한 접속', 약 40초 후 해제.
// ────────────────────────────────────────────────────────────
var SITE = 'idfmall_kr';
var MARK = '[프리오더]';
var IDF = 'https://www.idfmall.co.kr/product/list.html';
var IDF_MAIN = [157, 159, 160, 156, 155];   // 수집 엑셀의 주력 5개
var IDF_PRE_CATE = 3538;                     // 겨울 프리오더
var IDF_GAP_MS = 1200;
var GAP_MS = 900;            // 더망고 요청 간격
var BLOCK_WAIT_MS = 45000;   // 차단 감지 시 대기
var BLOCK_RETRY = 5;
var BLOCKED = /과도한\s*접속|비정상적인\s*접속|Access\s*Denied/i;

var stopReq = false;
var running = false;

function q(s){ return document.querySelector(s); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
function setStat(m){ var e = q('#tmgIdfPreStat'); if(e) e.textContent = m; }
function checkStop(){ if(stopReq) throw new Error('정지됨'); }
function stamp(){ var d=new Date(), p=function(n){return String(n).padStart(2,'0');}; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes()); }

// ── 더망고 요청(차단 감지·재시도) ─────────────────────────────
async function tmgText(url, opt){
  for(var t=0;;t++){
    checkStop();
    var txt = await fetch(url, Object.assign({credentials:'same-origin'}, opt||{})).then(function(r){ return r.text(); });
    if(!BLOCKED.test(txt)){ await sleep(GAP_MS); return txt; }
    if(t >= BLOCK_RETRY) throw new Error('더망고 요청 제한이 풀리지 않습니다 — 몇 분 뒤 다시 실행하세요');
    setStat('더망고 요청 제한 감지 — ' + (BLOCK_WAIT_MS/1000) + '초 대기 후 재시도 (' + (t+1) + '/' + BLOCK_RETRY + ')');
    await sleep(BLOCK_WAIT_MS);
  }
}
function tmgPost(fields){
  return tmgText('admin_goods_ok.php', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
    body:new URLSearchParams(fields).toString()
  });
}

// ── 목록 읽기 ────────────────────────────────────────────────
function listUrl(page, extra){
  var fd = new FormData(document.search_form);   // 화면 폼의 기본값을 그대로 쓰고 필요한 것만 덮는다
  var base = {amode:'detail_search', ps_site_id:SITE, ps_status:'sale', search_type:'goods_name', ps_subject:'',
              ps_sort:'datedown', ps_fn:'all', ps_market_id:'', ps_category:'', ps_page:String(page),
              ps_num:'10'};   // ★반드시 10: 화면은 몇 개씩으로 두든 10개만 그리는데 쪽 넘김은 ps_num 단위라, 100이면 매 쪽의 11~100번째가 통째로 빠진다(2026-09-17 실측)
  Object.keys(base).forEach(function(k){ fd.set(k, base[k]); });
  fd.delete('ps_duse');                           // 날짜검색 끄기(체크박스가 있으면 기간이 걸린다)
  Object.keys(extra||{}).forEach(function(k){ fd.set(k, extra[k]); });
  return 'admin_goods.php?' + new URLSearchParams(fd).toString();
}
function selectedValue(sel){
  if(!sel) return '';
  for(var i=0;i<sel.options.length;i++){ if(sel.options[i].hasAttribute('selected')) return sel.options[i].value; }
  return sel.options.length ? sel.options[0].value : '';
}
function parseList(html){
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var body = (doc.body ? doc.body.textContent : '').replace(/\s+/g,' ');
  var tots = [], m, re = /총\s*([\d,]+)\s*개/g;
  while((m = re.exec(body))) tots.push(parseInt(m[1].replace(/,/g,''),10));
  var cbs = doc.querySelectorAll('input[name="uid_check[]"]');
  if(tots.length < 2 && !cbs.length) throw new Error('상품 목록을 읽지 못했습니다(로그인 만료?)');
  var items = [];
  for(var i=0;i<cbs.length;i++){
    var uid = cbs[i].value;
    // 카드 범위: 체크박스에서 올라가며 '사이트상품번호'가 들어 있고 체크박스가 하나뿐인 가장 작은 조상
    var box = cbs[i].parentElement, card = null;
    while(box && box !== doc.body){
      if(box.textContent.indexOf('사이트상품번호') >= 0){
        card = box.querySelectorAll('input[name="uid_check[]"]').length === 1 ? box : null;
        break;
      }
      box = box.parentElement;
    }
    var txt = (card ? card.textContent : body).replace(/\s+/g,' ');
    var st = txt.match(new RegExp('상품번호 : ' + uid + ' /[^\\]]*?상태 : ([^\\]]+?) \\]'));
    var gm = card ? txt.match(/사이트상품번호 : ([A-Za-z0-9_-]+)/) : null;
    var ta = doc.getElementById('admin_memo_' + uid);
    items.push({
      uid: uid,
      goodsNo: gm ? gm[1] : '',
      status: st ? st[1].trim() : '',
      stockUpd: selectedValue(doc.getElementById('uid_stock_update_yn_' + uid)),
      memo: ta ? ta.value : '',
      siteOk: /idfmall/i.test(txt)
    });
  }
  return {total: tots.length >= 2 ? tots[1] : 0, items: items};
}
async function scanAll(){
  var first = parseList(await tmgText(listUrl(1)));
  var total = first.total, per = first.items.length || 10;
  var pages = Math.ceil(total / per);
  var seen = {}, out = [];
  function add(list){ list.forEach(function(x){ if(!seen[x.uid]){ seen[x.uid] = 1; out.push(x); } }); }
  add(first.items);
  for(var p=2; p<=pages; p++){
    setStat('더망고 목록 읽는 중 ' + p + '/' + pages + '쪽 (' + out.length + '/' + total + '개)');
    var got = parseList(await tmgText(listUrl(p))).items;
    if(!got.length) throw new Error(p + '쪽이 비어 있습니다(읽은 ' + out.length + '/' + total + ') — 쪽 넘김이 어긋났습니다');
    add(got);
  }
  return {total: total, items: out};
}

// ── IDF몰 판정 ───────────────────────────────────────────────
function gmGetText(url){
  return new Promise(function(res, rej){
    GM_xmlhttpRequest({method:'GET', url:url, timeout:30000,
      onload:function(r){ if(r.status !== 200) return rej(new Error('IDF몰 HTTP ' + r.status)); res(r.responseText); },
      onerror:function(){ rej(new Error('IDF몰 연결 실패')); },
      ontimeout:function(){ rej(new Error('IDF몰 시간초과')); }});
  });
}
// 목록 한 쪽의 상품 카드: [{no, pre}]
function idfCards(html){
  var i = html.indexOf('xans-product-listnormal');
  if(i < 0) return [];
  var parts = html.slice(i).split('id="anchorBoxId_'), out = [];
  for(var k=1;k<parts.length;k++){
    var p = parts[k], no = p.slice(0, p.indexOf('"'));
    if(/^\d+$/.test(no)) out.push({no:no, pre:/>\s*PRE-ORDER\s*</.test(p)});
  }
  return out;
}
async function idfCate(cate, label, seen, pre, isPreCate){
  for(var page=1; page<=60; page++){
    checkStop();
    setStat('IDF몰 읽는 중 — ' + label + ' ' + page + '쪽 (상품 ' + Object.keys(seen.all).length + ' · 예약 ' + Object.keys(pre).length + ')');
    var html = null;
    for(var t=0; t<3 && html === null; t++){
      try{ html = await gmGetText(IDF + '?cate_no=' + cate + '&page=' + page); }
      catch(e){ if(t === 2) throw e; await sleep(5000); }
    }
    await sleep(IDF_GAP_MS);
    var cards = idfCards(html), fresh = 0, mine = seen[cate] = seen[cate] || {};
    for(var k=0;k<cards.length;k++){
      var c = cards[k];
      if(!mine[c.no]){ mine[c.no] = 1; fresh++; }
      seen.all[c.no] = 1;
      if(c.pre || isPreCate) pre[c.no] = 1;
    }
    if(!fresh) break;          // 마지막 쪽을 넘으면 같은 쪽이 다시 오거나 비어 있다
  }
}
async function fetchIdf(){
  var seen = {all:{}}, pre = {};
  for(var i=0;i<IDF_MAIN.length;i++) await idfCate(IDF_MAIN[i], 'cate ' + IDF_MAIN[i], seen, pre, false);
  await idfCate(IDF_PRE_CATE, '겨울 프리오더', seen, pre, true);
  return {present: seen.all, pre: pre};
}

// ── 판정 규칙 ────────────────────────────────────────────────
//  SOLDOUT  : 예약인데 재고상품이거나 재고업데이트가 ON → 품절처리(+표시)
//  KEEP     : 예약 · 표시 있음 · 이미 품절+OFF → 그대로
//  MANUAL   : 예약 · 표시 없음 · 이미 품절+OFF → 사람이 처리한 것으로 보고 건드리지 않음
//  RESTORE  : 일반 판매(IDF 목록에 있고 예약 아님) · 표시 있음 → 재고업데이트 ON + 표시 제거
//  OK       : 일반 판매 · 표시 없음 → 그대로
//  UNKNOWN  : IDF 목록에 없음(판매종료·아울렛 이동 등) / 목록에서 번호를 못 읽음 → 그대로
function hasMark(memo){ return String(memo||'').indexOf(MARK) >= 0; }
function addMark(memo){ memo = String(memo||'').trim(); return hasMark(memo) ? memo : (memo ? memo + ' ' + MARK : MARK); }
function delMark(memo){ return String(memo||'').split(MARK).join('').replace(/\s{2,}/g,' ').trim(); }
function decide(it, label){
  if(!it.goodsNo || !label) return 'UNKNOWN';
  var marked = hasMark(it.memo);
  if(label.pre){
    if(it.status === '재고상품' || it.stockUpd === 'Y') return 'SOLDOUT';
    return marked ? 'KEEP' : 'MANUAL';
  }
  return marked ? 'RESTORE' : 'OK';
}

// ── 처리 ────────────────────────────────────────────────────
async function saveMemo(uid, memo){
  var r = memo
    ? await tmgPost({amode:'admin_memo', pmode:'save', uid:uid, memo_text:memo})
    : await tmgPost({amode:'admin_memo', pmode:'remove', uid:uid, memo_text:''});
  if(!/완료/.test(r)) throw new Error('메모 응답 이상');
}
async function applyOne(it){
  if(it.action === 'SOLDOUT'){
    var r = await tmgPost({amode:'goods_soldout', uid:it.uid, site_id:SITE});
    if(String(r).trim() !== 'ok') throw new Error('품절처리 응답 이상');
    if(!hasMark(it.memo)) await saveMemo(it.uid, addMark(it.memo));
  } else if(it.action === 'RESTORE'){
    await tmgPost({amode:'modify_stock2', uid:it.uid, stock_update_yn:'Y'});
    await saveMemo(it.uid, delMark(it.memo));
  }
}
// 처리한 상품을 번호 검색(쉼표, 10개씩)으로 다시 읽어 실제 상태를 확인
async function verify(done){
  var byGoods = {};
  for(var i=0;i<done.length;i+=10){
    checkStop();
    setStat('결과 확인 중 ' + Math.min(i+10, done.length) + '/' + done.length);
    var part = done.slice(i, i+10);
    var res = parseList(await tmgText(listUrl(1, {search_type:'site_goods_id', ps_subject: part.map(function(x){ return x.goodsNo; }).join(','), ps_status:'sale'})));
    res.items.forEach(function(x){ byGoods[x.uid] = x; });
  }
  done.forEach(function(it){
    var now = byGoods[it.uid];
    if(!now){ it.check = '확인불가(목록에 없음)'; return; }
    var ok = it.action === 'SOLDOUT'
      ? (now.status === '품절상품' && now.stockUpd === 'N' && hasMark(now.memo))
      : (now.stockUpd === 'Y' && !hasMark(now.memo));
    it.check = ok ? '확인됨' : ('불일치: 상태=' + now.status + ' 재고업데이트=' + now.stockUpd + ' 표시=' + (hasMark(now.memo) ? '있음' : '없음'));
  });
}

// ── 결과 파일 ────────────────────────────────────────────────
var ACTION_KO = {SOLDOUT:'품절처리', KEEP:'유지(이미 처리됨)', MANUAL:'건너뜀(표시 없는 품절·OFF)', RESTORE:'복원(재고업데이트 ON)', OK:'정상', UNKNOWN:'판정불가(IDF 목록에 없음)'};
function csvq(s){ s = (s == null ? '' : String(s)); return '"' + s.replace(/"/g,'""') + '"'; }
function downloadCsv(name, rows){
  var head = ['더망고상품번호','IDF상품번호','상태(전)','재고업데이트(전)','표시(전)','IDF목록에 있음','PRE-ORDER','판정','처리결과','확인'];
  var text = '﻿' + head.map(csvq).join(',') + '\n' + rows.map(function(r){
    return [r.uid, r.goodsNo, r.status, r.stockUpd, hasMark(r.memo) ? '있음' : '', r.label ? 'Y' : 'N', r.label ? (r.label.pre ? 'Y' : 'N') : '',
            ACTION_KO[r.action] || r.action, r.result || '', r.check || ''].map(csvq).join(',');
  }).join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type:'text/csv;charset=utf-8'}));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
}

// ── 실행 ────────────────────────────────────────────────────
async function run(apply){
  if(running) return;
  running = true; stopReq = false;
  var rows = [];
  try{
    setStat('더망고 목록 읽는 중…');
    var scan = await scanAll();
    rows = scan.items;
    var bad = rows.filter(function(x){ return !x.goodsNo || !x.siteOk; }).length;
    var idf = await fetchIdf();
    var nPresent = Object.keys(idf.present).length, nPre = Object.keys(idf.pre).length;
    // 안전장치: IDF 화면 구조가 바뀌어 목록을 못 읽으면 표시된 상품이 전부 '판정불가'나 '복원'으로 잘못 갈 수 있다 → 멈춘다
    if(nPresent < 100) throw new Error('IDF몰 목록에서 상품을 ' + nPresent + '개밖에 못 읽었습니다 — IDF 화면 구조가 바뀌었는지 확인하세요');
    var cnt = {}, matched = 0;
    rows.forEach(function(it){
      it.label = idf.present[it.goodsNo] ? {pre: !!idf.pre[it.goodsNo]} : null;
      if(it.label) matched++;
      it.action = decide(it, it.label); cnt[it.action] = (cnt[it.action]||0) + 1;
    });
    if(rows.length && !matched) throw new Error('더망고 사이트상품번호가 IDF 상품번호와 하나도 맞지 않습니다(예: ' + (rows[0].goodsNo || '없음') + ') — 번호 형식을 확인해야 합니다');
    var summary = 'IDF몰 상품 ' + rows.length + '개(목록 총 ' + scan.total + ') · IDF 목록 대조 성공 ' + matched + ' · 예약(PRE-ORDER) ' + rows.filter(function(x){ return x.label && x.label.pre; }).length +
      ' → 품절처리 ' + (cnt.SOLDOUT||0) + ' · 복원 ' + (cnt.RESTORE||0) + ' · 유지 ' + (cnt.KEEP||0) + ' · 건너뜀 ' + (cnt.MANUAL||0) + ' · 판정불가(IDF 목록에 없음) ' + (cnt.UNKNOWN||0) + ' | IDF 목록 ' + nPresent + ' · 예약 ' + nPre +
      (bad ? ' · ⚠번호 못 읽음 ' + bad : '') + (rows.length !== scan.total ? ' · ⚠읽은 수≠총수' : '');
    var todo = rows.filter(function(x){ return x.action === 'SOLDOUT' || x.action === 'RESTORE'; });

    if(apply && todo.length){
      if(!window.confirm('IDF몰 프리오더 정리를 실행합니다.\n\n' + summary + '\n\n품절처리 ' + (cnt.SOLDOUT||0) + '개 · 복원 ' + (cnt.RESTORE||0) + '개를 지금 반영할까요?\n(진행 중에는 이 페이지를 닫거나 이동하지 마세요)')){
        apply = false; summary = '[취소됨] ' + summary;
      }
    }
    if(apply){
      var okN = 0, failN = 0;
      for(var i=0;i<todo.length;i++){
        checkStop();
        setStat('반영 중 ' + (i+1) + '/' + todo.length + ' — ' + ACTION_KO[todo[i].action] + ' ' + todo[i].goodsNo);
        try{ await applyOne(todo[i]); todo[i].result = '성공'; okN++; }
        catch(e){ todo[i].result = '실패: ' + e.message; failN++; if(/요청 제한|정지됨/.test(e.message)) throw e; }
      }
      await verify(todo.filter(function(x){ return x.result === '성공'; }));
      var mism = todo.filter(function(x){ return x.check && x.check !== '확인됨'; }).length;
      summary = '반영 완료 — 성공 ' + okN + ' · 실패 ' + failN + ' · 확인 불일치 ' + mism + ' | ' + summary;
    } else if(summary.indexOf('[취소됨]') !== 0){
      summary = '[미리보기 — 변경 없음] ' + summary;
    }
    downloadCsv('프리오더정리_' + (apply ? '실행' : '미리보기') + '_' + stamp() + '.csv', rows);
    setStat(summary);
  }catch(e){
    setStat('중단: ' + e.message + (rows.length ? ' (지금까지 결과를 CSV로 내려받습니다)' : ''));
    if(rows.length) downloadCsv('프리오더정리_중단_' + stamp() + '.csv', rows);
  }finally{
    running = false;
  }
}

// ── 패널 ────────────────────────────────────────────────────
function panel(){
  if(q('#tmgIdfPrePanel') || !document.search_form) return;
  var p = document.createElement('div');
  p.id = 'tmgIdfPrePanel';
  p.style.cssText = 'position:fixed;bottom:12px;right:330px;z-index:2147483646;background:#fff;border:2px solid #0b7285;border-radius:8px;padding:8px 10px;width:300px;font:12px/1.5 "맑은 고딕",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
  p.innerHTML = '<div style="font-weight:bold;margin-bottom:4px">IDF몰 프리오더 정리 v1.0</div>'
    + '<button id="tmgIdfPrePreview">미리보기(변경 없음)</button> '
    + '<button id="tmgIdfPreRun" style="color:#fff;background:#0b7285;border:0;padding:2px 8px">실행</button> '
    + '<button id="tmgIdfPreStop" style="color:#d9534f">정지</button>'
    + '<div id="tmgIdfPreStat" style="margin-top:6px;color:#333;min-height:32px;word-break:break-all">대기중 · IDF몰 목록 약 1분 + 더망고 상품 10개당 1초</div>'
    + '<div style="margin-top:4px;color:#888;font-size:11px">PRE-ORDER → 품절처리 + 메모 ' + MARK + ' / 예약이 풀려 일반 판매로 바뀌면 → 재고업데이트 ON + 표시 삭제. 결과는 CSV로 저장됩니다.</div>';
  document.body.appendChild(p);
  q('#tmgIdfPrePreview').onclick = function(){ run(false); };
  q('#tmgIdfPreRun').onclick = function(){ run(true); };
  q('#tmgIdfPreStop').onclick = function(){ stopReq = true; setStat('정지 요청됨 — 현재 요청 후 멈춥니다.'); };
}
panel();
})();
